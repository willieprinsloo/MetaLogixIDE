/** Per-tab project default state; injected IO preserves confirmed choices and isolates late results. */
import { TERMINAL_AGENT_NAME, type ProjectDefaultAgentRequest, type ScopedCliProfile } from '@shared/project-default-agent';
import type { Project } from '@shared/types';
import type { ProjectSettingsTarget } from './project-settings-contract';

export type ProjectDefaultAgentFeedback =
  | { readonly status: 'idle' | 'saving' | 'saved' }
  | { readonly status: 'error'; readonly message: string };

export type ProjectDefaultAgentSnapshot =
  | { readonly status: 'loading'; readonly target: ProjectSettingsTarget }
  | { readonly status: 'error'; readonly target: ProjectSettingsTarget; readonly message: string }
  | {
    readonly status: 'ready';
    readonly target: ProjectSettingsTarget;
    readonly project: Project;
    readonly profiles: readonly ScopedCliProfile[];
    readonly confirmedName: string | null;
    readonly pendingName: string | null;
    readonly feedback: ProjectDefaultAgentFeedback;
  };

export interface ProjectDefaultAgentPorts {
  loadProject(projectId: number): Promise<Project>;
  loadProfiles(projectId: number): Promise<readonly ScopedCliProfile[]>;
  save(request: ProjectDefaultAgentRequest): Promise<Project>;
  onSaved(project: Project): void;
}

export interface ProjectDefaultAgentStore {
  getSnapshot(): ProjectDefaultAgentSnapshot;
  subscribe(listener: () => void): () => void;
  connect(): () => void;
  retry(): void;
  choose(name: string | null): void;
  replaceCustomCommands(): void;
}

/** Detects either legacy variant without treating an empty override object as an active command. */
export function hasCustomLaunchCommands(project: Project): boolean {
  return Boolean(project.config.launchCmd?.first || project.config.launchCmd?.subsequent);
}

class ProjectDefaultAgentSession implements ProjectDefaultAgentStore {
  private readonly target: ProjectSettingsTarget;
  private snapshot: ProjectDefaultAgentSnapshot;
  private connected = false;
  private version = 0;
  private readonly listeners = new Set<() => void>();

  constructor(opener: ProjectSettingsTarget, private readonly ports: ProjectDefaultAgentPorts) {
    this.target = { id: opener.id, name: opener.name, path: opener.path };
    this.snapshot = { status: 'loading', target: this.target };
  }

  getSnapshot = (): ProjectDefaultAgentSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  connect = (): (() => void) => {
    if (!this.connected) { this.connected = true; void this.load(); }
    return () => { this.connected = false; this.version += 1; };
  };

  retry = (): void => {
    if (this.connected && this.snapshot.status === 'error') void this.load();
  };

  choose = (name: string | null): void => {
    if (this.snapshot.status !== 'ready' || name === this.snapshot.confirmedName) return;
    if (name !== null && !isSelectable(this.snapshot.profiles, name)) return;
    void this.persist(name);
  };

  replaceCustomCommands = (): void => {
    if (this.snapshot.status !== 'ready' || !hasCustomLaunchCommands(this.snapshot.project)) return;
    const name = this.snapshot.confirmedName;
    if (name !== null && !isSelectable(this.snapshot.profiles, name)) return;
    void this.persist(name);
  };


  private publish(next: ProjectDefaultAgentSnapshot): void {
    this.snapshot = next;
    this.listeners.forEach((listener) => listener());
  }

  private async load(): Promise<void> {
    const ticket = ++this.version;
    const target = this.target;
    this.publish({ status: 'loading', target });
    try {
      const [project, profiles] = await Promise.all([
        this.ports.loadProject(target.id), this.ports.loadProfiles(target.id),
      ]);
      if (!this.connected || ticket !== this.version) return;
      if (project.id !== target.id) throw new Error('The target project is no longer available.');
      const name = project.config.defaultCliName ?? null;
      this.publish({ status: 'ready', target, project, profiles, confirmedName: name,
        pendingName: name, feedback: { status: 'idle' } });
    } catch (error) {
      if (!this.connected || ticket !== this.version) return;
      const message = error instanceof Error ? error.message.replace(/^Error:\s*/, '') : 'Please try again.';
      this.publish({ status: 'error', target, message });
    }
  }

  private async persist(name: string | null): Promise<void> {
    if (!this.connected || this.snapshot.status !== 'ready' || this.snapshot.feedback.status === 'saving') return;
    const confirmed = this.snapshot;
    const ticket = ++this.version;
    this.publish({ ...confirmed, pendingName: name, feedback: { status: 'saving' } });
    try {
      const project = await this.ports.save({ projectId: this.target.id, name });
      if (!this.connected || ticket !== this.version) return;
      if (project.id !== this.target.id) throw new Error('The saved project did not match the target. Choose again to retry.');
      const savedName = project.config.defaultCliName ?? null;
      this.publish({ ...confirmed, project, confirmedName: savedName, pendingName: savedName,
        feedback: { status: 'saved' } });
      this.ports.onSaved(project);
    } catch (error) {
      if (!this.connected || ticket !== this.version) return;
      const message = error instanceof Error ? error.message.replace(/^Error:\s*/, '') : 'Please try again.';
      this.publish({ ...confirmed, pendingName: confirmed.confirmedName, feedback: { status: 'error', message } });
    }
  }
}

/** Creates one captured-target session; disconnect invalidates async publications, not initiated database writes. */
export function createProjectDefaultAgentStore(
  opener: ProjectSettingsTarget,
  ports: ProjectDefaultAgentPorts,
): ProjectDefaultAgentStore {
  return new ProjectDefaultAgentSession(opener, ports);
}

/** A choosable default: a catalog profile or the built-in Terminal. */
function isSelectable(profiles: readonly ScopedCliProfile[], name: string): boolean {
  return name === TERMINAL_AGENT_NAME || profiles.some((profile) => profile.name === name);
}
