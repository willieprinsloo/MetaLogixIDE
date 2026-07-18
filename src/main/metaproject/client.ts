/**
 * Metaproject HTTP + Socket.IO client, main-process.
 *
 * Auth model (verified against the metaproject codebase at
 * ~/Documents/Projects/markdown-editor):
 *   • POST /login with JSON { username, password } → Flask-Login session
 *     cookie in Set-Cookie. Same endpoint the browser hits.
 *   • The Socket.IO gate checks current_user.is_authenticated, so the
 *     same session cookie authenticates the socket. We forward it as
 *     `Cookie:` in the WS handshake extraHeaders.
 *   • REST channels/messages live under /api/web-chat/... with the same
 *     cookie auth.
 *
 * We keep everything in the main process — the renderer never sees the
 * cookie, and we forward socket events over IPC.
 */
import { io, type Socket } from 'socket.io-client';

export interface MetaprojectConfig {
  baseUrl: string;     // e.g. https://projects.metalogix.solutions
  username: string;
  password: string;
}

export interface Channel {
  id: number;
  project_id: number;
  name: string;
  is_private: boolean;
}

export interface ChatMessage {
  id: number;
  channel_id: number;
  project_id: number | null;
  user_id: number;
  user_name?: string;
  message: string;
  created_at: string;
  parent_message_id: number | null;
}

type EventHandler = (payload: unknown) => void;

export class MetaprojectClient {
  private cookie: string | null = null;
  private socket: Socket | null = null;
  private base = '';
  private handlers = new Map<string, Set<EventHandler>>();
  private userName: string | null = null;

  isConnected(): boolean { return !!this.cookie && !!this.socket && this.socket.connected; }
  isLoggedIn(): boolean { return this.cookie != null; }
  currentUserName(): string | null { return this.userName; }

  async login(cfg: MetaprojectConfig): Promise<{ userId: number; userName: string }> {
    // Normalise: strip trailing slash and prepend https:// when the user
    // saved a bare host. fetch() only accepts fully qualified URLs.
    const trimmed = cfg.baseUrl.trim().replace(/\/+$/, '');
    this.base = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const res = await fetch(`${this.base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ username: cfg.username, password: cfg.password }),
      redirect: 'manual',
    });
    // Flask returns a session cookie on success. On a 302 redirect (the
    // normal happy path — Flask sends the browser to the dashboard) the
    // Set-Cookie header is still present. Failed logins return 200 with
    // the login HTML and no fresh session cookie.
    const setCookie = res.headers.get('set-cookie') ?? '';
    const sessionMatch = /(?:^|;\s*|,\s*)(session=[^;,\s]+)/i.exec(setCookie);
    if (!sessionMatch) {
      let msg = 'login failed';
      try {
        const body = await res.json() as { message?: string };
        if (body?.message) msg = body.message;
      } catch { /* HTML response — leave the default message */ }
      throw new Error(msg);
    }
    this.cookie = sessionMatch[1]!;
    // No JSON /me endpoint exists on this deployment; use the submitted
    // credential as the display name until a real one arrives (chat
    // messages carry user_name populated by the socket handler).
    this.userName = cfg.username;
    return { userId: 0, userName: this.userName };
  }

  disconnect(): void {
    this.socket?.disconnect();
    this.socket = null;
    this.cookie = null;
    this.userName = null;
    this.handlers.clear();
  }

  // ────────────────────────── HTTP helpers ──────────────────────────

  private async get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }
  private async post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.cookie) throw new Error('not authenticated');
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        'Cookie': this.cookie,
        'Accept': 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}`);
    return await res.json() as T;
  }

  // ────────────────────────── REST surface ──────────────────────────

  async listChannels(projectId: number): Promise<Channel[]> {
    // Per app/routes/web_chat.py: the per-project blueprint is mounted at
    // /api/projects/<int:project_id>/chat and its GET /channels/ returns
    // the channel list. Responses use the standard {success, data} envelope.
    const raw = await this.get<{ success?: boolean; data?: { channels?: Channel[] } | Channel[] } | Channel[]>(
      `/api/projects/${projectId}/chat/channels/`,
    );
    const list = Array.isArray(raw) ? raw
      : Array.isArray(raw?.data) ? raw.data
      : raw?.data?.channels
      ?? (raw as { channels?: Channel[] })?.channels
      ?? [];
    return list;
  }

  async listMessages(channelId: number, limit = 50, projectId?: number): Promise<ChatMessage[]> {
    // Messages live under the per-project blueprint too; if we know the
    // project_id use that path, otherwise fall back to the workspace bp.
    const path = projectId != null
      ? `/api/projects/${projectId}/chat/channels/${channelId}/messages/?limit=${limit}`
      : `/api/chat/channels/${channelId}/messages/?limit=${limit}`;
    const raw = await this.get<{ success?: boolean; data?: { messages?: ChatMessage[] } | ChatMessage[] } | ChatMessage[]>(path);
    const list = Array.isArray(raw) ? raw
      : Array.isArray(raw?.data) ? raw.data
      : raw?.data?.messages
      ?? (raw as { messages?: ChatMessage[] })?.messages
      ?? [];
    return list;
  }

  // ────────────────────────── Socket surface ─────────────────────────

  connectSocket(): void {
    if (!this.cookie) throw new Error('not authenticated');
    if (this.socket && this.socket.connected) return;
    this.socket = io(this.base, {
      transports: ['websocket', 'polling'],
      // Cookie won't ride along in the browser policy, but on Node the
      // socket.io-client honours extraHeaders for both transports.
      extraHeaders: { Cookie: this.cookie },
      // withCredentials only matters for browsers; harmless here.
      withCredentials: true,
      reconnection: true,
      reconnectionDelay: 1500,
      reconnectionDelayMax: 15_000,
    });
    // Re-fire every server event as a generic "*" that we translate to
    // our IPC 'metaproject:event' channel. We keep the raw event name.
    const forward = (event: string) => (payload: unknown) => {
      for (const h of this.handlers.get(event) ?? []) h(payload);
      for (const h of this.handlers.get('*')       ?? []) h({ event, payload });
    };
    for (const ev of [
      'connect', 'disconnect', 'connect_error',
      'channel_message', 'chat_error',
      'channel_message_edited', 'channel_message_deleted',
      'channel_message_reaction', 'channel_read',
      'presence_update', 'user_joined_channel', 'user_left_channel',
    ]) {
      this.socket.on(ev, forward(ev));
    }
  }

  onEvent(event: string, handler: EventHandler): () => void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
    return () => { this.handlers.get(event)?.delete(handler); };
  }

  joinChannel(channelId: number): void {
    this.socket?.emit('join_channel', { channel_id: channelId });
  }
  leaveChannel(channelId: number): void {
    this.socket?.emit('leave_channel', { channel_id: channelId });
  }
  sendChannelMessage(channelId: number, message: string, parentMessageId?: number | null): void {
    this.socket?.emit('send_channel_message', {
      channel_id: channelId,
      message,
      parent_message_id: parentMessageId ?? null,
    });
  }
  markRead(channelId: number, lastMessageId: number): void {
    this.socket?.emit('mark_channel_read', { channel_id: channelId, last_message_id: lastMessageId });
  }
}
