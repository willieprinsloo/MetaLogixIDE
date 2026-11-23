/** Protected Metaproject REST and identity-verified direct Chat WebSocket. */
import { io, NodeWebSocket, type Socket } from 'socket.io-client';
import type { Session } from 'electron';
import { z } from 'zod';
import { accountId, metaprojectRemoteProject, type MetaprojectOrigin, type RemoteProjectId } from '@shared/metaproject-contract';
import { projectList, projectListCap, requireWebBody, webJson, WebFailure, type WebMutation, type WebRequest } from './web-session';
import { mutateChat, type ChatMutation } from './chat-mutations';

const id = z.number().int().positive();
const channel = z.object({ id, project_id: id.nullable(), name: z.string().max(1024), is_private: z.boolean() });
const user = z.object({ id, username: z.string().max(254), display_name: z.string().nullish().transform(value => value ?? undefined), avatar_url: z.string().max(4096).nullish().transform(value => value ?? null) });
const message = z.object({ id, channel_id: id, project_id: id.nullish(), user_id: id, user_name: z.string().optional(), user: user.nullable().optional().transform(value => value ?? undefined), message: z.string().max(64 * 1024), created_at: z.string().max(128), parent_message_id: id.nullable(), is_deleted: z.boolean().optional(), attachments: z.array(z.object({ id, filename: z.string().max(1024), file_size: z.number().int().nonnegative(), mime_type: z.string().max(256).nullish() })).optional() });
const channels = z.object({ success: z.literal(true), channels: z.array(channel) });
const messages = z.object({ success: z.literal(true), messages: z.array(message) });
const users = z.object({ success: z.literal(true), users: z.array(user.pick({ id: true, username: true })) });
const project = z.object({ success: z.literal(true), project: metaprojectRemoteProject });
const identity = z.object({ status: z.literal('success'), user_id: accountId });
const socketMessage = z.object({ channel_id: id, message });
const socketDeleted = z.object({ channel_id: id, message_id: id });
const channelJoined = z.object({ channel_id: id });
type Join = { result: Promise<{ ok: true }>; finish(error?: WebFailure): void };
export interface CreateRemote { name: string; description?: string; projectType?: 'kanban' | 'sprint' | 'dcad' }
interface ClientOptions {
  origin: MetaprojectOrigin;
  jar: Pick<Session, 'getUserAgent'> & { cookies: Pick<Session['cookies'], 'get'> };
  request: WebRequest;
  signal: AbortSignal;
  userId: number;
  changed(connected: boolean): void;
  rejected(): void;
  forward(event: string, payload: unknown): void;
}

/** Connects only while its lease is alive and samples the current jar on every handshake. */
export class MetaprojectClient {
  private socket: Socket | null = null;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private backoff = 1500;
  private probeAt = 0;
  private verified = false;
  private readonly joins = new Map<number, Join>();

  constructor(private readonly options: ClientOptions) {
    options.signal.addEventListener('abort', () => this.stop(), { once: true });
  }

  /** Start the single owned direct Chat connection. */
  start(): void { void this.connect(); }

  private stop(): void {
    clearTimeout(this.retry);
    clearTimeout(this.timer);
    this.verified = false;
    const socket = this.socket;
    this.socket = null;
    for (const join of this.joins.values()) join.finish(new WebFailure('network'));
    socket?.disconnect();
  }

  private async connect(): Promise<void> {
    const { jar, signal, origin } = this.options;
    if (signal.aborted) return;
    try {
      const cookies = await jar.cookies.get({ url: `${origin}/socket.io/?EIO=4&transport=websocket`, name: 'session' });
      if (signal.aborted) return;
      const [cookie] = cookies;
      if (cookies.length !== 1 || !cookie?.httpOnly || !/^[\x21-\x3a\x3c-\x7e]+$/.test(cookie.value)) throw new WebFailure('protocol');
      this.bind(io(origin, {
        autoConnect: false, forceNew: true, transports: [NodeWebSocket], upgrade: false, reconnection: false, timeout: 10_000,
        extraHeaders: { Cookie: `session=${cookie.value}`, Origin: origin, 'User-Agent': jar.getUserAgent() },
      }));
    } catch { this.reconnect(); }
  }

  private bind(socket: Socket): void {
    this.socket = socket;
    const disconnect = (): void => {
      if (this.socket !== socket) return;
      const wasVerified = this.verified;
      this.stop();
      this.options.changed(false);
      if (wasVerified) this.options.forward('disconnect', undefined);
      this.reconnect();
    };
    const ready = (): void => this.verify(socket);
    socket.on('connected', (raw: unknown) => {
      const result = identity.safeParse(raw);
      if (this.socket !== socket || !result.success) return;
      if (result.data.user_id !== this.options.userId) { this.options.rejected(); return; }
      if (socket.connected) ready();
      else socket.once('connect', ready);
    });
    socket.on('disconnect', disconnect);
    socket.on('connect_error', disconnect);
    socket.on('channel_joined', (raw: unknown) => {
      if (this.socket !== socket || !this.verified) return;
      const joined = channelJoined.safeParse(raw);
      if (joined.success) this.joins.get(joined.data.channel_id)?.finish();
    });
    this.forwardSocket(socket);
    this.timer = setTimeout(disconnect, 10_000);
    socket.connect();
  }

  private verify(socket: Socket): void {
    if (this.socket !== socket || this.verified) return;
    clearTimeout(this.timer);
    this.verified = true;
    this.backoff = 1500;
    this.options.changed(true);
    this.options.forward('connect', undefined);
  }

  private forwardSocket(socket: Socket): void {
    const events = { channel_message: socketMessage, channel_message_edited: socketMessage, channel_message_deleted: socketDeleted };
    for (const [event, schema] of Object.entries(events)) {
      socket.on(event, (payload: unknown) => {
        if (this.socket !== socket || !this.verified) return;
        const valid = schema.safeParse(payload);
        if (valid.success) this.options.forward(event, valid.data);
      });
    }
    socket.on('chat_error', () => {
      if (this.socket === socket && this.verified) this.options.forward('chat_error', { error: 'Chat operation failed' });
    });
  }

  private reconnect(): void {
    if (this.options.signal.aborted) return;
    if (Date.now() >= this.probeAt) {
      this.probeAt = Date.now() + 20_000;
      void this.listProjects().catch(() => undefined);
    }
    const delay = Math.min(15_000, this.backoff + Math.random() * 500);
    this.backoff = Math.min(15_000, this.backoff * 2);
    this.retry = setTimeout(() => this.start(), delay);
  }

  /** Wait for the reference's room-specific confirmation on the current verified socket. */
  async joinChannel(channelId: number): Promise<{ ok: true }> {
    const socket = this.socket;
    if (!this.verified || !socket?.connected) throw new WebFailure('network');
    const pending = this.joins.get(channelId);
    if (pending) return pending.result;
    if (this.joins.size >= 256) throw new WebFailure('conflict');
    const join = this.pendingJoin(channelId);
    this.joins.set(channelId, join);
    try { socket.emit('join_channel', { channel_id: channelId }); }
    catch { join.finish(new WebFailure('network')); }
    return join.result;
  }

  private pendingJoin(channelId: number): Join {
    let finish: Join['finish'] = () => undefined;
    const result = new Promise<{ ok: true }>((resolve, reject) => {
      const timer = setTimeout(() => finish(new WebFailure('network')), 5_000);
      finish = error => {
        clearTimeout(timer);
        this.joins.delete(channelId);
        if (error) reject(error);
        else resolve({ ok: true });
      };
    });
    return { result, finish: error => finish(error) };
  }

  /** Return acceptance only from one origin-bound, protected Chat mutation. */
  mutateChat(input: ChatMutation): Promise<{ ok: true }> {
    return mutateChat((path, schema, mutation) => this.read(path, schema, mutation), input);
  }

  private async read<T>(path: string, schema: z.ZodType<T>, mutation?: WebMutation): Promise<T> {
    const { jar, origin, request, signal } = this.options;
    try {
      let csrf: string | undefined;
      if (mutation) {
        const values = await jar.cookies.get({ url: new URL(path, origin).href, name: 'csrf_token' });
        csrf = values.length === 1 ? values[0]?.value : undefined;
        if (!csrf || !/^[a-zA-Z0-9._-]{1,2048}$/.test(csrf)) throw new WebFailure('protocol');
      }
      return webJson(await request({ path, signal, ...mutation, csrf, limit: projectListCap }), origin, schema);
    } catch (error) {
      if (error instanceof WebFailure && error.reason === 'expired') this.options.rejected();
      throw error;
    }
  }

  /** Read the current account's accessible project list. */
  async listProjects(): Promise<z.output<typeof projectList>['projects']> { return (await this.read('/api/projects', projectList)).projects; }
  /** Check current access and verify the project returned by the fixed route. */
  async checkProject(remoteId: RemoteProjectId): Promise<void> {
    if ((await this.read(`/api/projects/${remoteId}`, project)).project.id !== remoteId) throw new WebFailure('protocol');
  }
  /** Create one remote project; never retry automatically. */
  async createProject(input: CreateRemote): Promise<z.output<typeof project>['project']> {
    return (await this.read('/api/projects', project, { json: { name: input.name, description: input.description ?? '', project_type: input.projectType ?? 'kanban' } })).project;
  }
  /** Read workspace or scoped Chat channels. */
  async listAllChannels(scope: 'all' | 'global' | number): Promise<z.output<typeof channels>['channels']> { return (await this.read(`/api/chat/channels/?scope=${scope}`, channels)).channels; }
  /** Read Chat channels belonging to a remote project. */
  async listChannels(projectId: number): Promise<Array<z.output<typeof channel> & { project_id: number }>> {
    return (await this.read(`/api/projects/${projectId}/chat/channels/`, channels)).channels.map(item => ({ ...item, project_id: item.project_id ?? projectId }));
  }
  /** Read Chat history with the required per-project route. */
  async listMessages(projectId: number, channelId: number, limit: number): Promise<z.output<typeof messages>['messages']> { return (await this.read(`/api/projects/${projectId}/chat/channels/${channelId}/messages/?limit=${limit}`, messages)).messages; }
  /** Read user summaries for Chat mentions. */
  async listUsers(): Promise<z.output<typeof users>['users']> { return (await this.read('/api/users', users)).users; }
  /** Download bounded binary data without following redirects. */
  async fetchAttachment(projectId: number, attachmentId: number): Promise<Buffer> {
    const { origin, request, signal } = this.options;
    try {
      const reply = await request({ path: `/api/projects/${projectId}/chat/attachments/${attachmentId}/download`, signal, limit: 25 * 1024 * 1024 });
      return requireWebBody(reply, origin, true);
    } catch (error) {
      if (error instanceof WebFailure && error.reason === 'expired') this.options.rejected();
      throw error;
    }
  }
}
