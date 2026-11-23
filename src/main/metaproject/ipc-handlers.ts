/** Scoped composition and transport handling for the trusted main renderer. */
import { app, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent, type Session } from 'electron';
import { writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { z } from 'zod';
import type { IpcContract, IpcEventName, IpcEvents } from '@shared/ipc-contract';
import { epoch, metaprojectRequests as requests, type MetaprojectOrigin, type MetaprojectResult } from '@shared/metaproject-contract';
import type { ProjectsRepo } from '@main/repos/projects-repo';
import type { RootsRepo } from '@main/repos/roots-repo';
import type { SettingsRepo } from '@main/repos/settings-repo';
import { AssignmentService } from './assignment-service';
import { AssignmentOperations } from './assignment-operations';
import { BoardController } from './board-controller';
import { createBoardGuest } from './board-view';
import { MetaprojectClient } from './client';
import { RememberedAccount } from './remembered-account';
import { failure, failureReason, SessionService, type SessionTransport } from './session-service';
import { authenticateWeb, chromiumRequest, createPartition, WebFailure } from './web-session';

export interface MetaprojectKeyring {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
}

export interface MetaprojectIpcOptions {
  readonly ipcMain: IpcMain;
  readonly settings: SettingsRepo;
  readonly projects: ProjectsRepo;
  readonly roots: RootsRepo;
  readonly allowLoopbackHttp: boolean;
  readonly keyring: MetaprojectKeyring;
  readonly owner: () => BrowserWindow | null;
  readonly authorize: (event: IpcMainInvokeEvent) => BrowserWindow | null;
  readonly send: <E extends IpcEventName>(channel: E, payload: IpcEvents[E]) => void;
  readonly openExternal: (url: string) => Promise<void>;
}

export interface MetaprojectLifecycle {
  start(): void;
  dispose(): void;
  detachBoard(): void;
  projectContextChanged(): void;
  projectAuthorityChanged(): void;
}

type Scope = { ownerId: number; frame: object; owns(): boolean; contextCurrent(): boolean };
type HandlerResult<T> = Promise<T> | T;

function sessionTransport(origin: MetaprojectOrigin, jars: WeakMap<SessionTransport, Session>): SessionTransport {
  const jar = createPartition(origin);
  const request = chromiumRequest(jar, origin);
  const transport: SessionTransport = {
    authenticate: (credentials, signal) => authenticateWeb(origin, request, credentials, signal),
    client: ({ actor, ...options }) => new MetaprojectClient({ ...options, origin, request, jar, userId: actor.id }),
    async retire(logout) {
      try { if (logout) await request({ path: '/auth/logout', signal: AbortSignal.timeout(2500) }); }
      finally { await Promise.allSettled([jar.clearStorageData(), jar.clearCache(), jar.closeAllConnections()]); }
    },
  };
  jars.set(transport, jar);
  return transport;
}

/** Register only the dedicated Metaproject channels and keep their owner checks independent of generic IPC. */
export function registerMetaprojectIpc(options: MetaprojectIpcOptions): MetaprojectLifecycle {
  const { settings, send } = options;
  const account = new RememberedAccount({
    read: () => settings.readMetaprojectPrivate('metaproject_restore_grant_v1'),
    write: (grant, origin) => settings.writeMetaprojectPrivate({ metaproject_restore_grant_v1: grant, ...(origin ? { metaproject_base_url: origin } : {}) }),
    legacyUsername: () => settings.get('metaproject_last_username'),
  }, options.keyring, options.allowLoopbackHttp);
  const jars = new WeakMap<SessionTransport, Session>();
  const session = new SessionService({
    configuredOrigin: String(settings.get('metaproject_base_url') ?? ''), allowLoopback: options.allowLoopbackHttp, account,
    transport: origin => sessionTransport(origin, jars),
    publish: state => { board.invalidate(state.epoch); send('metaproject:session-changed', state); },
    chat: (epoch, event, payload) => send('metaproject:chat-event', { epoch, event, payload }),
  });
  const assignment = new AssignmentService({
    projects: options.projects, roots: options.roots, settings, session, allowLoopback: options.allowLoopbackHttp,
    changed: projectId => { board.drop(projectId); send('metaproject:assignment-changed', { projectId }); },
  });
  const board = new BoardController({ assignments: assignment, session, openExternal: options.openExternal,
    guest(ownerId, live, events) {
      const owner = options.owner();
      const jar = jars.get(live.transport);
      if (!owner || owner.isDestroyed() || owner.id !== ownerId || !jar) throw new WebFailure('stale');
      return createBoardGuest(owner, jar, live.origin, events);
    },
    state: state => send('metaproject:board-state', state),
    candidate: candidate => send('metaproject:board-external-candidate', candidate),
    returnFocus: viewId => send('metaproject:board-return-focus', { viewId }),
  });
  let context = 0;
  const bound = bindOwner(options, () => context);
  registerSessionHandlers(bound, session);
  registerAssignmentHandlers(bound, assignment);
  registerBoardHandlers(bound, board);
  registerChatHandlers(bound, session);
  assignment.captureLegacy();
  return {
    start: () => session.start(),
    dispose: () => { board.drop(); session.dispose(); bound.dispose(); },
    detachBoard: () => { context += 1; board.drop(); },
    projectContextChanged: () => { context += 1; board.drop(); },
    projectAuthorityChanged: () => board.projectAuthorityChanged(),
  };
}

function bindOwner(options: MetaprojectIpcOptions, context: () => number) {
  const channels = new Set<string>();
  function raw<I, O>(channel: string, schema: z.ZodType<I>, handle: (input: I, scope: Scope) => HandlerResult<O>, reject?: (reason: 'invalid-input' | 'stale') => O): void {
    channels.add(channel);
    options.ipcMain.handle(channel, async (event, input: unknown) => {
      const owner = options.authorize(event);
      const frame = event.senderFrame;
      const parsed = schema.safeParse(input);
      if (!owner || !frame || !parsed.success) {
        const reason = owner && frame ? 'invalid-input' : 'stale';
        if (reject) return reject(reason);
        throw new WebFailure(reason);
      }
      const generation = context();
      const owns = (): boolean => options.authorize(event) === owner && event.senderFrame === frame;
      return handle(parsed.data, { ownerId: owner.id, frame, owns, contextCurrent: () => owns() && context() === generation });
    });
  }
  function result<I, O>(channel: string, schema: z.ZodType<I>, handle: (input: I, scope: Scope) => HandlerResult<MetaprojectResult<O>>): void {
    raw(channel, schema, async (input, scope) => {
      try { return await handle(input, scope); }
      catch (error) { return failure(failureReason(error)); }
    }, failure);
  }
  return { raw, result, dispose: () => { for (const channel of channels) options.ipcMain.removeHandler(channel); } };
}

type Binder = ReturnType<typeof bindOwner>;
function registerSessionHandlers({ raw, result }: Binder, session: SessionService): void {
  raw('metaproject:session-status', requests['metaproject:session-status'], () => session.snapshot());
  result('metaproject:session-login', requests['metaproject:session-login'], input => session.login(input));
  raw('metaproject:session-cancel', requests['metaproject:session-cancel'], ({ attemptId }) => session.cancel(attemptId));
  result('metaproject:session-retry', requests['metaproject:session-retry'], input => session.retry(input.epoch));
  result('metaproject:session-logout', requests['metaproject:session-logout'], input => session.logout(input.epoch));
  result('metaproject:session-origin', requests['metaproject:session-origin'], input => session.changeOrigin(input.epoch, input.origin));
}

function registerAssignmentHandlers({ result }: Binder, assignment: AssignmentService): void {
  const operations = new AssignmentOperations();
  result('metaproject:assignment-get', requests['metaproject:assignment-get'], input => assignment.get(input.projectId));
  result('metaproject:assignment-list', requests['metaproject:assignment-list'], input => assignment.list(input.epoch));
  result('metaproject:assignment-save', requests['metaproject:assignment-save'], (input, scope) => operations.run(input, scope, owns => assignment.save(input, owns)));
  result('metaproject:assignment-remove', requests['metaproject:assignment-remove'], (input, scope) => operations.run(input, scope, owns => assignment.remove(input, owns)));
  result('metaproject:assignment-create', requests['metaproject:assignment-create'], (input, scope) => operations.run(input, scope, owns => assignment.create(input, owns)));
  result('metaproject:assignment-cancel', requests['metaproject:assignment-cancel'], (input, scope) => operations.cancel(input, scope.frame));
}

function registerBoardHandlers({ result }: Binder, board: BoardController): void {
  result('metaproject:board-open', requests['metaproject:board-open'], (input, scope) => board.open(input, scope.ownerId));
  result('metaproject:board-layout', requests['metaproject:board-layout'], (input, scope) => board.layout(scope.ownerId, input.viewId, input.bounds));
  result('metaproject:board-focus', requests['metaproject:board-focus'], (input, scope) => board.focus(scope.ownerId, input.viewId));
  result('metaproject:board-close', requests['metaproject:board-close'], (input, scope) => board.close(scope.ownerId, input.viewId));
  result('metaproject:board-browser', requests['metaproject:board-browser'], input => board.browser(input));
  result('metaproject:board-external', requests['metaproject:board-external'], (input, scope) => board.external(scope.ownerId, input.viewId, input.candidateId));
  result('metaproject:board-dismiss-external', requests['metaproject:board-dismiss-external'], (input, scope) => board.dismissExternal(scope.ownerId, input.viewId, input.candidateId));
}

const positive = z.number().int().positive();
const chatMessage = z.string().min(1).max(64 * 1024);
const chatChannel = { epoch, channelId: positive };
const chatProject = { ...chatChannel, projectId: positive };
const chatWithMessage = { ...chatProject, messageId: positive };
const attachmentName = z.string().min(1).max(180).refine(name => !/[<>:"/\\|?*\x00-\x1f]/.test(name) && !/[. ]$/.test(name) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name));
type ChatChannel = Extract<keyof IpcContract, `metaproject:${string}`>;

function chatHandlers({ raw }: Binder, session: SessionService) {
  return <C extends ChatChannel, I extends { epoch: number }>(channel: C, schema: z.ZodType<I>, act: (client: MetaprojectClient, input: I, owns: () => boolean) => HandlerResult<IpcContract[C]['response']>): void => {
    raw(channel, schema, async (input, scope) => {
      const live = session.client(input.epoch);
      if (!live) throw new WebFailure(session.snapshot().epoch === input.epoch ? 'signed-out' : 'stale');
      const current = (): boolean => scope.owns() && session.client(input.epoch) === live;
      try {
        const value = await act(live.client, input, current);
        if (!current()) throw new WebFailure('stale');
        return value;
      } catch (error) { throw new WebFailure(failureReason(error)); }
    });
  };
}

function registerChatHandlers(binder: Binder, session: SessionService): void {
  const chat = chatHandlers(binder, session);
  chat('metaproject:list-channels', z.strictObject({ epoch, projectId: positive }), async (client, input) => ({ channels: await client.listChannels(input.projectId) }));
  chat('metaproject:list-all-channels', z.strictObject({ epoch, scope: z.union([z.enum(['all', 'global']), positive]) }), async (client, input) => ({ channels: await client.listAllChannels(input.scope) }));
  chat('metaproject:list-messages', z.strictObject({ ...chatChannel, projectId: positive, limit: positive.max(100).optional() }), async (client, input) => ({ messages: await client.listMessages(input.projectId, input.channelId, input.limit ?? 50) }));
  chat('metaproject:list-users', z.strictObject({ epoch }), async client => ({ users: await client.listUsers() }));
  registerAttachmentHandler(chat);
  registerChatMutations(chat);
}

function registerAttachmentHandler(chat: ReturnType<typeof chatHandlers>): void {
  chat('metaproject:download-attachment', z.strictObject({ epoch, projectId: positive, attachmentId: positive, filename: attachmentName }), async (client, input, current) => {
    const bytes = await client.fetchAttachment(input.projectId, input.attachmentId);
    if (!current()) throw new WebFailure('stale');
    return { path: writeAttachment(bytes, input.filename) };
  });
}

function registerChatMutations(chat: ReturnType<typeof chatHandlers>): void {
  chat('metaproject:join-channel', z.strictObject(chatChannel), (client, input) => client.joinChannel(input.channelId));
  chat('metaproject:send-message', z.strictObject({ ...chatProject, message: chatMessage, parentMessageId: positive.nullish() }), (client, input) => client.mutateChat({ ...input, kind: 'send' }));
  chat('metaproject:send-global-message', z.strictObject({ ...chatChannel, message: chatMessage, parentMessageId: positive.nullish() }), (client, input, current) => client.sendGlobalMessage(input, current));
  chat('metaproject:mark-read', z.strictObject({ ...chatProject, lastMessageId: positive }), (client, input) => client.mutateChat({ ...input, kind: 'mark-read' }));
  chat('metaproject:edit-message', z.strictObject({ ...chatWithMessage, message: chatMessage }), (client, input) => client.mutateChat({ ...input, kind: 'edit' }));
  chat('metaproject:delete-message', z.strictObject(chatWithMessage), (client, input) => client.mutateChat({ ...input, kind: 'delete' }));
}

function writeAttachment(bytes: Buffer, filename: string): string {
  const dir = app.getPath('downloads');
  const ext = extname(filename);
  const stem = filename.slice(0, filename.length - ext.length);
  for (let index = 1; index <= 100; index++) {
    const path = join(dir, index === 1 ? filename : `${stem} (${index})${ext}`);
    try { writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 }); return path; }
    catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw new WebFailure('unavailable');
    }
  }
  throw new WebFailure('conflict');
}
