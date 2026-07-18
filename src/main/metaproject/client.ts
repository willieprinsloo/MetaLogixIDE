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
    this.base = cfg.baseUrl.replace(/\/$/, '');
    const res = await fetch(`${this.base}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ username: cfg.username, password: cfg.password }),
      redirect: 'manual',
    });
    // Flask returns a session cookie on success. On redirect (302) it's
    // still there — capture regardless of status.
    const setCookie = res.headers.get('set-cookie') ?? '';
    const sessionMatch = /(?:^|;\s*|,\s*)(session=[^;,\s]+)/i.exec(setCookie);
    if (!sessionMatch) {
      let msg = 'login failed';
      try {
        const body = await res.json() as { message?: string };
        if (body?.message) msg = body.message;
      } catch { /* not JSON */ }
      throw new Error(msg);
    }
    this.cookie = sessionMatch[1]!;

    // Verify + fetch user info via a cheap authenticated call.
    const me = await this.get<{ id: number; username: string; name?: string }>('/api/me');
    this.userName = me.name ?? me.username;
    return { userId: me.id, userName: this.userName };
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
    // web_chat blueprint is mounted at /api/web-chat/ per the routes file.
    const raw = await this.get<{ channels?: Channel[] } | Channel[]>(
      `/api/web-chat/channels/?project_id=${projectId}`,
    );
    return Array.isArray(raw) ? raw : raw.channels ?? [];
  }

  async listMessages(channelId: number, limit = 50): Promise<ChatMessage[]> {
    const raw = await this.get<{ messages?: ChatMessage[] } | ChatMessage[]>(
      `/api/web-chat/channels/${channelId}/messages/?limit=${limit}`,
    );
    return Array.isArray(raw) ? raw : raw.messages ?? [];
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
