import { z } from 'zod';

export const localProjectId = z.number().int().positive().brand<'LocalProjectId'>();
export const remoteProjectId = z.number().int().positive().brand<'MetaprojectProjectId'>();
export const accountId = z.number().int().positive().brand<'MetaprojectAccountId'>();
export const epoch = z.number().int().nonnegative();
const token = z.uuid();
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const originInput = z.string().trim().min(1).max(2048);

type LocalProjectId = z.output<typeof localProjectId>;
type RemoteProjectId = z.output<typeof remoteProjectId>;
type AccountId = z.output<typeof accountId>;
type Origin = string & { readonly __brand: 'MetaprojectOrigin' };
export type { LocalProjectId, RemoteProjectId, AccountId, Origin as MetaprojectOrigin };

/** WHATWG normalizes the URL; raw authority also gates the dev-only HTTP exception. */
export function parseMetaprojectOrigin(input: unknown, allowLoopbackHttp: boolean): Origin | null {
  const parsed = originInput.safeParse(input);
  if (!parsed.success) return null;
  const text = parsed.data;
  if (/[\\\s\u0000-\u001f\u007f]/u.test(text)) return null;
  const absolute = /^https?:\/\//i.test(text) ? text : `https://${text}`;
  const parts = /^https?:\/\/([^/?#]+)\/?$/i.exec(absolute);
  const authority = parts?.[1];
  if (!authority || authority.includes('@') || authority.endsWith(':')) return null;
  const url = URL.parse(absolute);
  if (url === null || !url.hostname) return null;
  const literalLoopback = /^(?:127\.0\.0\.1|\[::1\])(?::[0-9]+)?$/.test(authority);
  if (url.protocol !== 'https:' && !(allowLoopbackHttp && literalLoopback && url.protocol === 'http:')) return null;
  // Exact serialized origin from the validated URL, not the input authority.
  return url.origin as Origin;
}

export const metaprojectRemoteProject = z.object({
  id: remoteProjectId,
  name: z.string().min(1).max(1024),
  identifier: z.string().max(256).nullable().optional(),
});
export const metaprojectActor = z.object({
  id: accountId,
  username: z.string().min(1).max(254),
  display_name: z.string().max(254).nullish(),
});
export type MetaprojectActor = z.output<typeof metaprojectActor>;
export type MetaprojectRemoteProject = z.output<typeof metaprojectRemoteProject>;

export type MetaprojectFailure =
  | 'invalid-input' | 'invalid-origin' | 'signed-out' | 'rejected' | 'expired'
  | 'denied' | 'not-found' | 'network' | 'throttled' | 'protocol' | 'stale'
  | 'conflict' | 'invalid-file' | 'unavailable' | 'origin-mismatch';
export type PersistenceWarning = 'not-remembered' | 'keychain-not-cleared' | 'forget-incomplete';
export type MetaprojectResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: MetaprojectFailure };

type SessionScope = { readonly epoch: number; readonly configuredOrigin: string; readonly origin: Origin | null };
export type MetaprojectSessionSnapshot = SessionScope & (
  | { readonly phase: 'signed-out'; readonly reason?: MetaprojectFailure; readonly retryRestore?: boolean; readonly warning?: PersistenceWarning }
  | { readonly phase: 'restoring' | 'signing-in'; readonly attemptId: string }
  | { readonly phase: 'signed-in'; readonly actor: MetaprojectActor; readonly connected: boolean; readonly remembered: boolean; readonly warning?: PersistenceWarning }
);

type AssignmentTarget = { readonly projectId: number; readonly localName: string; readonly localPath: string };
type VersionedAssignment = AssignmentTarget & { readonly revision: string };
export type MetaprojectAssignment =
  | (VersionedAssignment & { readonly kind: 'unlinked' })
  | (VersionedAssignment & { readonly kind: 'linked' | 'origin-mismatch'; readonly remoteId: RemoteProjectId; readonly origin: Origin })
  | (VersionedAssignment & { readonly kind: 'unconfirmed'; readonly remoteId: RemoteProjectId })
  | (AssignmentTarget & { readonly kind: 'invalid' | 'unavailable' });

type BoardContext = { readonly projectId: number; readonly revision: string; readonly viewId: string; readonly epoch: number };
export type MetaprojectBoardState = BoardContext & (
  | { readonly phase: 'loading' | 'ready' }
  | { readonly phase: 'error'; readonly reason: MetaprojectFailure }
);
export type MetaprojectExternalCandidate = BoardContext & { readonly candidateId: string; readonly label: string };

const context = { projectId: localProjectId, revision };
const assignmentMutation = { ...context, operationId: token };
const projectType = z.enum(['kanban', 'sprint', 'dcad']);
const createRemote = { name: z.string().trim().min(1).max(255), description: z.string().max(32768).optional(), projectType: projectType.optional() };
const boardLease = { viewId: token };
const rect = z.strictObject({ x: z.number(), y: z.number(), width: z.number().nonnegative(), height: z.number().nonnegative() });
export const metaprojectRequests = {
  'metaproject:session-status': z.undefined(),
  'metaproject:session-login': z.strictObject({ attemptId: token, epoch, username: z.string().trim().min(1).max(254), password: z.string().min(1).max(256), remember: z.boolean() }),
  'metaproject:session-cancel': z.strictObject({ attemptId: token }),
  'metaproject:session-retry': z.strictObject({ epoch }),
  'metaproject:session-logout': z.strictObject({ epoch }),
  'metaproject:session-origin': z.strictObject({ epoch, origin: originInput }),
  'metaproject:assignment-get': z.strictObject({ projectId: localProjectId }),
  'metaproject:assignment-list': z.strictObject({ epoch }),
  'metaproject:assignment-save': z.strictObject({ ...assignmentMutation, epoch, remoteId: remoteProjectId }),
  'metaproject:assignment-remove': z.strictObject(assignmentMutation),
  'metaproject:assignment-create': z.strictObject({ ...assignmentMutation, epoch, ...createRemote }),
  'metaproject:assignment-cancel': z.strictObject({ operationId: token }),
  'metaproject:board-open': z.strictObject({ ...context, ...boardLease, epoch }),
  'metaproject:board-layout': z.strictObject({ ...boardLease, bounds: rect.nullable() }),
  'metaproject:board-focus': z.strictObject(boardLease),
  'metaproject:board-close': z.strictObject(boardLease),
  'metaproject:board-browser': z.strictObject(context),
  'metaproject:board-external': z.strictObject({ ...boardLease, candidateId: token }),
  'metaproject:board-dismiss-external': z.strictObject({ ...boardLease, candidateId: token }),
};

export type AssignmentMutationOutcome =
  | { readonly kind: 'assigned'; readonly assignment: MetaprojectAssignment }
  | { readonly kind: 'committed-reload'; readonly projectId: number };

export type AssignmentCreateOutcome =
  | AssignmentMutationOutcome
  | { readonly kind: 'created-not-assigned'; readonly project: MetaprojectRemoteProject; readonly reason: MetaprojectFailure };

interface Responses {
  'metaproject:session-status': MetaprojectSessionSnapshot;
  'metaproject:session-login': MetaprojectResult<MetaprojectSessionSnapshot>;
  'metaproject:session-cancel': MetaprojectSessionSnapshot;
  'metaproject:session-retry': MetaprojectResult<MetaprojectSessionSnapshot>;
  'metaproject:session-logout': MetaprojectResult<MetaprojectSessionSnapshot>;
  'metaproject:session-origin': MetaprojectResult<MetaprojectSessionSnapshot>;
  'metaproject:assignment-get': MetaprojectResult<MetaprojectAssignment>;
  'metaproject:assignment-list': MetaprojectResult<{ epoch: number; projects: MetaprojectRemoteProject[] }>;
  'metaproject:assignment-save': MetaprojectResult<AssignmentMutationOutcome>;
  'metaproject:assignment-remove': MetaprojectResult<AssignmentMutationOutcome>;
  'metaproject:assignment-create': MetaprojectResult<AssignmentCreateOutcome>;
  'metaproject:assignment-cancel': MetaprojectResult<undefined>;
  'metaproject:board-open': MetaprojectResult<MetaprojectBoardState>;
  'metaproject:board-layout': MetaprojectResult<undefined>;
  'metaproject:board-focus': MetaprojectResult<undefined>;
  'metaproject:board-close': MetaprojectResult<undefined>;
  'metaproject:board-browser': MetaprojectResult<undefined>;
  'metaproject:board-external': MetaprojectResult<undefined>;
  'metaproject:board-dismiss-external': MetaprojectResult<undefined>;
}

export type MetaprojectChannel = keyof typeof metaprojectRequests;
export type ValidMetaprojectRequest<C extends MetaprojectChannel> = z.output<typeof metaprojectRequests[C]>;
export type MetaprojectIpc = {
  [C in MetaprojectChannel]: { request: z.input<typeof metaprojectRequests[C]>; response: Responses[C] };
};

export interface MetaprojectEvents {
  'metaproject:session-changed': MetaprojectSessionSnapshot;
  'metaproject:assignment-changed': { projectId: number };
  'metaproject:board-state': MetaprojectBoardState;
  'metaproject:board-external-candidate': MetaprojectExternalCandidate;
  'metaproject:board-return-focus': { viewId: string };
}
