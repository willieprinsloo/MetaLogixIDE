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

export interface ChatMessageUser {
  id: number;
  username: string;
  display_name?: string;
  avatar_url?: string | null;
}

export interface ChatMessage {
  id: number;
  channel_id: number;
  project_id: number | null;
  user_id: number;
  user_name?: string;
  user?: ChatMessageUser;
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
  private userId: number | null = null;

  isConnected(): boolean { return !!this.cookie && !!this.socket && this.socket.connected; }
  isLoggedIn(): boolean { return this.cookie != null; }
  currentUserName(): string | null { return this.userName; }
  currentUserId(): number | null { return this.userId; }

  async login(cfg: MetaprojectConfig): Promise<{ userId: number; userName: string }> {
    // Normalise: strip trailing slash and prepend https:// when the user
    // saved a bare host. fetch() only accepts fully qualified URLs.
    const trimmed = cfg.baseUrl.trim().replace(/\/+$/, '');
    this.base = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

    // Step 1: GET the login page to obtain the Flask-WTF CSRF token +
    // an anonymous session cookie. Flask-WTF's CSRFProtect rejects any
    // POST that lacks a matching X-CSRFToken. The token is in a
    // <meta name="csrf-token" content="…"> tag in base.html.
    const g = await fetch(`${this.base}/auth/login`, { redirect: 'manual' });
    const preCookies = readSetCookies(g);
    const csrf = readCsrfToken(await g.text());
    if (!csrf) throw new Error('no CSRF token on /auth/login (server layout changed?)');

    // Step 2: POST with the token in the header, both anon cookies in
    // the Cookie jar, and a Referer that satisfies Flask-WTF's HTTPS
    // referrer check.
    const res = await fetch(`${this.base}/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-CSRFToken': csrf,
        'Cookie': serializeCookies(preCookies),
        'Referer': `${this.base}/auth/login`,
        'Origin': this.base,
      },
      body: JSON.stringify({ username: cfg.username, password: cfg.password }),
      redirect: 'manual',
    });
    if (res.status === 401 || res.status === 400) {
      let msg = 'invalid credentials';
      try {
        const body = await res.json() as { message?: string };
        if (body?.message) msg = body.message;
      } catch { /* leave default */ }
      throw new Error(msg);
    }
    const postCookies = readSetCookies(res);
    // On successful login Flask rotates the session cookie. Prefer the
    // fresh one; fall back to the anon session if the server didn't
    // issue a new one (unlikely).
    const merged = new Map([...preCookies, ...postCookies]);
    const session = merged.get('session');
    if (!session) throw new Error(`login failed (${res.status})`);
    // We'll send BOTH csrf_token and session on subsequent requests. The
    // csrf_token cookie is only needed for POSTs that CSRFProtect gates,
    // but including it is harmless on GETs.
    this.cookie = serializeCookies(merged);
    // Parse the login response to capture the real user id + canonical
    // username. Users may sign in with an email; the messages coming back
    // over chat use the canonical username / display_name, and we need the
    // id to match "my messages" reliably (username comparison is fragile).
    let userId = 0;
    let userName = cfg.username;
    try {
      const body = await res.json() as { user?: { id?: number; username?: string; display_name?: string } };
      if (body?.user?.id) userId = body.user.id;
      if (body?.user?.username) userName = body.user.display_name || body.user.username;
    } catch { /* server didn't return JSON; keep defaults */ }
    this.userId = userId || null;
    this.userName = userName;
    return { userId, userName };
  }

  disconnect(): void {
    this.socket?.disconnect();
    this.socket = null;
    this.cookie = null;
    this.userName = null;
    this.userId = null;
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
    // The Flask-SocketIO backend enforces a same-origin check on the
    // handshake Origin header. socket.io-client on Node doesn't send one
    // by default, but engine.io-client's polling transport does — and
    // it uses the request URL host, which is what the backend rejects.
    // We give it an Origin that matches this.base so the CORS allowlist
    // has something explicit to match on.
    const originHost = new URL(this.base).origin;
    // Polling first, then upgrade to websocket: this is the default and it
    // matters for Flask-Login. The polling GET carries our Cookie header,
    // Flask attaches the session, and the subsequent WS upgrade inherits
    // the already-authenticated engine.io session. Forcing websocket first
    // means the auth cookie has to survive the upgrade handshake, which
    // engine.io-client on Node does inconsistently and leaves current_user
    // unauthenticated on the server → immediate `io server disconnect`.
    this.socket = io(this.base, {
      transports: ['polling', 'websocket'],
      extraHeaders: {
        Cookie: this.cookie,
        Origin: originHost,
      },
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
    // Lifecycle logging so failed handshakes are visible in the main
    // console instead of silently reconnecting forever.
    this.socket.on('connect', () => {
      console.log('[metaproject] socket connected', this.socket?.id);
    });
    this.socket.on('connect_error', (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[metaproject] socket connect_error:', msg);
    });
    this.socket.on('disconnect', (reason: string) => {
      console.log('[metaproject] socket disconnected:', reason);
    });
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
  editChannelMessage(channelId: number, messageId: number, message: string): void {
    this.socket?.emit('edit_channel_message', {
      channel_id: channelId,
      message_id: messageId,
      message,
    });
  }
  deleteChannelMessage(channelId: number, messageId: number): void {
    this.socket?.emit('delete_channel_message', {
      channel_id: channelId,
      message_id: messageId,
    });
  }
}

// ────────────────────────── Cookie / CSRF helpers ──────────────────────────
// Node 20+ / undici exposes getSetCookie() which returns each Set-Cookie
// header as its own string. Fall back to a manual split of the joined
// header in case we ever run on a runtime without it.
function readSetCookies(res: Response): Map<string, string> {
  const jar = new Map<string, string>();
  const list: string[] =
    'getSetCookie' in res.headers && typeof (res.headers as { getSetCookie?: () => string[] }).getSetCookie === 'function'
      ? (res.headers as { getSetCookie: () => string[] }).getSetCookie()
      : (res.headers.get('set-cookie') ?? '').split(/,(?=[^ ;]+=)/);
  for (const c of list) {
    const m = /^\s*([^=;\s]+)=([^;]*)/.exec(c);
    if (m && m[1]) jar.set(m[1], m[2] ?? '');
  }
  return jar;
}

// Flask-WTF renders the CSRF token in a <meta> tag in base.html; some
// pages also carry it as a hidden form input. Try both.
function readCsrfToken(html: string): string | null {
  const meta = /<meta\s+name=["']csrf-token["']\s+content=["']([^"']+)["']/i.exec(html);
  if (meta && meta[1]) return meta[1];
  const input = /<input[^>]*name=["']csrf_token["'][^>]*value=["']([^"']+)["']/i.exec(html);
  return input && input[1] ? input[1] : null;
}

function serializeCookies(jar: Map<string, string>): string {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}
