/** Resolves the canonical assignment and guards current remote access at local commit. */
import { z } from 'zod';
import type { Project } from '@shared/types';
import { parseRemoteProjectId } from '@shared/parse-metaproject';
import { parseMetaprojectOrigin, remoteProjectId, type AssignmentCreateOutcome, type AssignmentMutationOutcome, type MetaprojectAssignment, type MetaprojectOrigin, type MetaprojectRemoteProject, type MetaprojectResult, type RemoteProjectId, type ValidMetaprojectRequest } from '@shared/metaproject-contract';
import type { ProjectsRepo } from '@main/repos/projects-repo';
import type { RootsRepo } from '@main/repos/roots-repo';
import type { SettingsRepo } from '@main/repos/settings-repo';
import { commitAssignmentFile, readAssignmentFile } from './assignment-file';
import { failure, failureReason, ok, type SessionService } from './session-service';

const provenance = z.object({ origin: z.string().nullable(), entries: z.record(z.string(), z.object({ revision: z.string().regex(/^[0-9a-f]{64}$/), remoteId: remoteProjectId, kind: z.enum(['yaml', 'db']) })) });
type Evidence = z.output<typeof provenance>;
type EvidenceEntry = Evidence['entries'][string];
type Context = { projectId: number; revision: string };
type Load = ReturnType<typeof readAssignmentFile>;
type AssignmentFile = Extract<Load, { ok: true }>['value'];
type Live = NonNullable<ReturnType<SessionService['client']>>;
interface AssignmentOptions {
  projects: Pick<ProjectsRepo, 'get' | 'listByRoot' | 'clearLegacyMetaprojectLink'>;
  roots: Pick<RootsRepo, 'list'>;
  settings: Pick<SettingsRepo, 'readMetaprojectPrivate' | 'writeMetaprojectPrivate'>;
  session: Pick<SessionService, 'snapshot' | 'client'>;
  allowLoopback: boolean;
  changed(projectId: number): void;
}

/** Classify a valid ID by provenance, not merely its numeric equality. */
export function classifyAssignment(remoteId: RemoteProjectId, origin: MetaprojectOrigin | null, current: MetaprojectOrigin | null): { kind: 'unconfirmed'; remoteId: RemoteProjectId } | { kind: 'linked' | 'origin-mismatch'; remoteId: RemoteProjectId; origin: MetaprojectOrigin } {
  if (!origin) return { kind: 'unconfirmed', remoteId };
  return { kind: current === origin ? 'linked' : 'origin-mismatch', remoteId, origin };
}

function legacyHint(project: Project): RemoteProjectId | null {
  const raw = project.config.linkedMetaprojectProjectId ?? project.metaprojectProjectId;
  return typeof raw === 'string' ? parseRemoteProjectId(raw) : null;
}

/** Resolve one assignment per registered local project; the DB is only historical evidence. */
export class AssignmentService {
  private evidence: Evidence | null = null;

  constructor(private readonly options: AssignmentOptions) {}

  /** Capture originless pre-upgrade evidence once, before scanning or changing origin. */
  captureLegacy(): void {
    const key = 'metaproject_legacy_assignments_v1';
    try {
      const value = this.options.settings.readMetaprojectPrivate(key);
      if (value !== undefined) {
        this.evidence = provenance.safeParse(value).data ?? null;
        return;
      }
      const entries = this.legacyEntries();
      const evidence = { origin: this.options.session.snapshot().origin, entries };
      this.options.settings.writeMetaprojectPrivate({ [key]: evidence });
      this.evidence = evidence;
    } catch { this.evidence = null; }
  }

  private legacyEntries(): Evidence['entries'] {
    const entries: Evidence['entries'] = {};
    for (const root of this.options.roots.list()) {
      for (const project of this.options.projects.listByRoot(root.id)) {
        const file = readAssignmentFile(root.path, project.path);
        if (!file.ok || file.value.document.origin) continue;
        const remoteId = file.value.document.projectId ?? legacyHint(project);
        if (!remoteId) continue;
        entries[project.id] = { revision: file.value.revision, remoteId, kind: file.value.document.projectId ? 'yaml' : 'db' };
      }
    }
    return entries;
  }

  /** Report file state with the local path/name resolved by the DB, not IPC input. */
  get(projectId: number): MetaprojectResult<MetaprojectAssignment> {
    const project = this.options.projects.get(projectId);
    if (!project || project.hidden) return failure('not-found');
    return ok(this.describe(project, this.read(project)));
  }

  private read(project: Project): Load {
    const root = this.options.roots.list().find(item => item.id === project.rootId);
    return root ? readAssignmentFile(root.path, project.path) : failure('unavailable');
  }

  private describe(project: Project, result: Load): MetaprojectAssignment {
    const target = { projectId: project.id, localName: project.name, localPath: project.path };
    if (!result.ok) return { ...target, kind: result.reason === 'invalid-file' ? 'invalid' : 'unavailable' };
    const { document, revision } = result.value;
    const versioned = { ...target, revision };
    const matching = this.matchingEvidence(project, revision);
    if (!document.projectId) return matching?.kind === 'db' && legacyHint(project) === matching.remoteId
      ? { ...versioned, kind: 'unconfirmed', remoteId: matching.remoteId }
      : { ...versioned, kind: 'unlinked' };
    const origin = this.assignmentOrigin(document.origin, matching);
    if (document.origin && (!origin || !/^https?:\/\//i.test(document.origin))) return { ...target, kind: 'invalid' };
    return { ...versioned, ...classifyAssignment(document.projectId, origin, this.options.session.snapshot().origin) };
  }

  private matchingEvidence(project: Project, revision: string): EvidenceEntry | undefined {
    const evidence = this.evidence?.entries[project.id];
    return evidence?.revision === revision ? evidence : undefined;
  }

  private assignmentOrigin(persistedOrigin: string | null, matching: EvidenceEntry | undefined): MetaprojectOrigin | null {
    const rawOrigin = persistedOrigin ?? (matching?.kind === 'yaml' ? this.evidence?.origin : null);
    return parseMetaprojectOrigin(rawOrigin, this.options.allowLoopback);
  }

  /** Return the accessible list once per request, with an epoch fence after transport. */
  async list(epoch: number): Promise<MetaprojectResult<{ epoch: number; projects: MetaprojectRemoteProject[] }>> {
    const live = this.live(epoch);
    if (!live.ok) return live;
    try {
      const projects = await live.value.client.listProjects();
      return this.options.session.client(epoch) === live.value ? ok({ epoch, projects }) : failure('stale');
    } catch (error) { return failure(failureReason(error)); }
  }

  /** Save only after current membership and project-detail access both succeed. */
  async save(input: ValidMetaprojectRequest<'metaproject:assignment-save'>, owns: () => boolean): Promise<MetaprojectResult<AssignmentMutationOutcome>> {
    if (!owns()) return failure('stale');
    const target = this.target(input);
    if (!target.ok) return target;
    const live = this.live(input.epoch);
    if (!live.ok) return live;
    const current = (): boolean => owns() && this.options.session.client(input.epoch) === live.value;
    try {
      const projects = await live.value.client.listProjects();
      if (!current()) return failure('stale');
      if (!projects.some(project => project.id === input.remoteId)) return failure('denied');
      await live.value.client.checkProject(input.remoteId);
      return this.commit(target.value, { id: input.remoteId, origin: live.value.origin }, current);
    } catch (error) { return failure(failureReason(error)); }
  }

  /** Remove only the named local assignment; does not require or contact the server. */
  remove(input: Context, owns: () => boolean): MetaprojectResult<AssignmentMutationOutcome> {
    if (!owns()) return failure('stale');
    const epoch = this.options.session.snapshot().epoch;
    const target = this.target(input);
    return target.ok ? this.commit(target.value, null, () => owns() && this.options.session.snapshot().epoch === epoch) : target;
  }

  /** Preserve remote creation success if the local assignment cannot subsequently commit. */
  async create(input: ValidMetaprojectRequest<'metaproject:assignment-create'>, owns: () => boolean): Promise<MetaprojectResult<AssignmentCreateOutcome>> {
    const target = this.target(input);
    if (!target.ok) return target;
    const live = this.live(input.epoch);
    if (!live.ok) return live;
    if (!owns()) return failure('stale');
    let created: MetaprojectRemoteProject;
    try { created = await live.value.client.createProject(input); }
    catch (error) { return failure(failureReason(error)); }
    try {
      const assignment = await this.save({ ...input, remoteId: created.id }, owns);
      return assignment.ok ? assignment : ok({ kind: 'created-not-assigned', project: created, reason: assignment.reason });
    } catch (error) { return ok({ kind: 'created-not-assigned', project: created, reason: failureReason(error) }); }
  }

  private live(epoch: number): MetaprojectResult<Live> {
    const snapshot = this.options.session.snapshot();
    if (snapshot.epoch !== epoch) return failure('stale');
    if (!snapshot.origin) return failure('invalid-origin');
    const live = this.options.session.client(epoch);
    return live ? ok(live) : failure('signed-out');
  }

  private target(input: Context): MetaprojectResult<{ project: Project; file: AssignmentFile }> {
    const project = this.options.projects.get(input.projectId);
    if (!project || project.hidden) return failure('not-found');
    const file = this.read(project);
    if (!file.ok) return file;
    if (file.value.revision !== input.revision) return failure('conflict');
    if (this.describe(project, file).kind === 'invalid') return failure('invalid-file');
    return ok({ project, file: file.value });
  }

  private commit(target: { project: Project; file: AssignmentFile }, link: { id: RemoteProjectId; origin: MetaprojectOrigin } | null, owns: () => boolean): MetaprojectResult<AssignmentMutationOutcome> {
    const { project, file } = target;
    const result = commitAssignmentFile(file, link, () => {
      return owns() && this.ownsTarget(project, file.root);
    });
    if (!result.ok) return result;
    try { this.options.projects.clearLegacyMetaprojectLink(project.id); }
    catch { console.warn('[metaproject] could not clear obsolete assignment projection'); }
    try { this.options.changed(project.id); }
    catch { console.warn('[metaproject] could not publish assignment change'); }
    try { return ok(this.readback(project.id, link)); }
    catch { return ok({ kind: 'committed-reload', projectId: project.id }); }
  }

  private ownsTarget(project: Project, root: string): boolean {
    const row = this.options.projects.get(project.id);
    return !!row && !row.hidden && row.path === project.path && row.rootId === project.rootId
      && this.options.roots.list().some(item => item.id === project.rootId && item.path === root);
  }

  private readback(projectId: number, link: { id: RemoteProjectId; origin: MetaprojectOrigin } | null): AssignmentMutationOutcome {
    const result = this.get(projectId);
    if (!result.ok) return { kind: 'committed-reload', projectId };
    const assignment = result.value;
    const matches = link ? assignment.kind === 'linked' && assignment.remoteId === link.id && assignment.origin === link.origin : assignment.kind === 'unlinked';
    return matches ? { kind: 'assigned', assignment } : { kind: 'committed-reload', projectId };
  }
}
