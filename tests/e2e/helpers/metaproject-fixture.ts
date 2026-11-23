import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import type { Duplex } from 'node:stream';
import { z } from 'zod';

export const REMOTE_ID = 11;
export const CHANNEL_ID = 8;
export const LOGIN = '/auth/login';
export const LOGOUT = '/auth/logout';
export const EDIT = '/api/stories/71';
export const BOARD_ENTRY = `/projects/${REMOTE_ID}`;
export const BOARD_PATH = `${BOARD_ENTRY}/kanban`;
export const CHAT_PATH = `/api/projects/${REMOTE_ID}/chat/channels/${CHANNEL_ID}/messages/`;
export const HOST = '127.0.0.1';
const LIMIT = 256 * 1024;
const username = 'fixture-user';
const password = 'fixture-only-password';
const loginShape = z.object({
  username: z.literal(username),
  password: z.literal(password),
  remember: z.literal(false),
});
const draftShape = z.object({ is_draft: z.literal(true) });
const sendShape = z.object({ message: z.string().min(1), parent_message_id: z.null() });
const globalSend = z.tuple([
  z.literal('send_channel_message'),
  sendShape.extend({ channel_id: z.literal(CHANNEL_ID) }),
]);

// ws is already pinned by engine.io-client. Use its real WebSocket server,
// with the minimal Engine.IO v4 / Socket.IO namespace/event packets below.
interface FixtureSocket {
  send(data: string): void;
  terminate(): void;
  on(event: 'message', listener: (data: Buffer) => void): void;
  on(event: 'error' | 'close', listener: () => void): void;
}
interface FixtureWss {
  handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    accept: (ws: FixtureSocket) => void,
  ): void;
  close(): void;
}
type WsModule = {
  WebSocketServer: new (options: { noServer: true; maxPayload: number }) => FixtureWss;
};
const wsModule = z.custom<WsModule>(
  (value) =>
    ((typeof value === 'object' && value !== null) || typeof value === 'function') &&
    'WebSocketServer' in value &&
    typeof value.WebSocketServer === 'function',
);

function loadWebSocket(): FixtureWss {
  const require = createRequire(import.meta.url);
  const engineRequire = createRequire(require.resolve('socket.io-client/package.json'));
  const wsRequire = createRequire(engineRequire.resolve('engine.io-client/package.json'));
  const { WebSocketServer } = wsModule.parse(wsRequire('ws'));
  return new WebSocketServer({ noServer: true, maxPayload: LIMIT });
}

interface RequestRecord {
  path: string;
  method: string;
  authenticated: boolean;
}
interface UpgradeRecord {
  actor: number | null;
  transport: string | null;
  eio: string | null;
  exactOrigin: boolean;
  cookieCount: number;
}
type Redirects = { board?: string; login?: string };
export interface MetaprojectFixture {
  origin: string;
  name: string;
  actorId: number;
  credentials: { username: string; password: string };
  requests: RequestRecord[];
  upgrades: UpgradeRecord[];
  joined: number[];
  state: {
    edits: number;
    logins: number;
    logouts: number;
    polls: number;
    rejected: number;
    sockets: number;
    refuseChatSend: boolean;
    globalOnly: boolean;
    globalSubmissions: number;
    redirects: Redirects;
  };
  publishChat(text: string): void;
  expire(): void;
  close(): Promise<void>;
}

function token(): string {
  return randomBytes(24).toString('hex');
}

function value(req: IncomingMessage): string | undefined {
  return /(?:^|;\s*)session=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
}

async function body(req: IncomingMessage): Promise<unknown> {
  let bytes = 0;
  const parts: Buffer[] = [];
  for await (const chunk of req) {
    if (!Buffer.isBuffer(chunk)) throw new Error('Expected HTTP buffer');
    bytes += chunk.length;
    if (bytes > LIMIT) throw new Error('Fixture request exceeded cap');
    parts.push(chunk);
  }
  const data: unknown = JSON.parse(Buffer.concat(parts).toString('utf8'));
  return data;
}

function reply(res: ServerResponse, status: number, data: string, contentType: string): void {
  res.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
  res.end(data);
}

function json(res: ServerResponse, status: number, data: object): void {
  reply(res, status, JSON.stringify(data), 'application/json');
}

function redirect(res: ServerResponse, location: string, status = 302): void {
  res.setHeader('Location', location);
  reply(res, status, '<p>Redirecting</p>', 'text/html');
}

function html(res: ServerResponse, title: string, content: string, csrf = ''): void {
  reply(
    res,
    200,
    `<!doctype html><html><head><meta charset="utf-8">
    <meta name="csrf-token" content="${csrf}"><title>${title}</title></head>
    <body><h1>${title}</h1>${content}</body></html>`,
    'text/html; charset=utf-8',
  );
}

const boardScript = `document.getElementById('draft').addEventListener('click', async () => {
  const result = document.getElementById('draft-state');
  try {
    const response = await fetch('${EDIT}', {
      method: 'PUT', headers: {'Content-Type':'application/json',
        'X-CSRFToken':document.querySelector('meta[name="csrf-token"]').content},
      body: JSON.stringify({is_draft:true})
    });
    const value = await response.json();
    result.textContent = response.ok && value.success && value.story.is_draft ? 'Draft' : 'Failed';
  } catch { result.textContent = 'Failed'; }
});`;

function chatMessage(actor: number, id: number, text: string, projectId: number | null = REMOTE_ID): object {
  return {
    id,
    channel_id: CHANNEL_ID,
    project_id: projectId,
    user_id: actor,
    user_name: 'Fixture teammate',
    message: text,
    created_at: '2026-11-23T10:00:00Z',
    parent_message_id: null,
  };
}

/** Contract-derived fixture, not Flask. See the Phase 4 report for reference source citations. */
export async function startMetaprojectFixture(label: 'A' | 'B'): Promise<MetaprojectFixture> {
  const actorId = label === 'A' ? 42 : 52;
  const name = `Fixture ${label}`;
  const project = { id: REMOTE_ID, name, identifier: `${label}-${REMOTE_ID}` };
  const user = { id: actorId, username, display_name: `${name} Member` };
  const sessions = new Map<string, { csrf: string; authenticated: boolean }>();
  const requests: RequestRecord[] = [];
  const upgrades: UpgradeRecord[] = [];
  const joined: number[] = [];
  const history = [chatMessage(actorId + 1, 91, `${name} REST history`)];
  const state: MetaprojectFixture['state'] = {
    edits: 0,
    logins: 0,
    logouts: 0,
    polls: 0,
    rejected: 0,
    sockets: 0,
    refuseChatSend: false,
    globalOnly: false,
    globalSubmissions: 0,
    redirects: {},
  };
  const clients = new Map<FixtureSocket, { ready: boolean; joined: boolean }>();
  const wss = loadWebSocket();
  let origin = '';

  function publish(message: object): void {
    for (const [ws, entry] of clients) {
      if (entry.joined) {
        ws.send(`42${JSON.stringify(['channel_message', { channel_id: CHANNEL_ID, message }])}`);
      }
    }
  }

  function issue(res: ServerResponse, authenticated: boolean, csrf = token()): string {
    const id = token();
    sessions.set(id, { csrf, authenticated });
    res.setHeader('Set-Cookie', [
      `session=${id}; HttpOnly; Path=/; SameSite=Lax`,
      `csrf_token=${csrf}; Path=/; SameSite=Lax`,
    ]);
    return csrf;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', origin);
    const p = url.pathname;
    const method = req.method ?? '';
    const sid = value(req);
    const session = sid ? sessions.get(sid) : undefined;
    const authenticated = session?.authenticated === true;
    requests.push({ path: p, method, authenticated });
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    if (p === '/landing') return reply(res, 200, 'Second origin landing', 'text/plain');
    if (p === '/socket.io/') {
      state.polls++;
      return json(res, 400, { success: false });
    }
    if (p === '/static/fixture-board.js') return reply(res, 200, boardScript, 'text/javascript');
    if (p === LOGIN && method === 'GET') {
      const csrf = session?.csrf ?? issue(res, false);
      return html(res, 'Sign in', `<input type="hidden" name="csrf_token" value="${csrf}">`, csrf);
    }
    if (p === LOGIN && method === 'POST') {
      if (
        !sid ||
        !session ||
        session.csrf !== req.headers['x-csrftoken'] ||
        req.headers.origin !== origin ||
        req.headers.referer !== `${origin}${LOGIN}` ||
        req.headers['content-type'] !== 'application/json'
      ) {
        return json(res, 400, { success: false });
      }
      if (!loginShape.safeParse(await body(req)).success) return json(res, 401, { success: false });
      if (state.redirects.login) return redirect(res, state.redirects.login, 307);
      sessions.delete(sid);
      issue(res, true, session.csrf);
      state.logins++;
      return json(res, 200, { success: true, user });
    }
    if (!authenticated || !sid) {
      state.rejected++;
      return redirect(res, `${LOGIN}?next=${encodeURIComponent(p + url.search)}`);
    }
    if (p === LOGOUT && method === 'GET') {
      sessions.delete(sid);
      issue(res, false, session.csrf);
      state.logouts++;
      return redirect(res, '/?logout=success');
    }
    if (p === '/api/projects') return json(res, 200, { success: true, projects: state.globalOnly ? [] : [project] });
    if (p === `/api/projects/${REMOTE_ID}`) return json(res, 200, { success: true, project });
    if (p === '/api/users') return json(res, 200, { success: true, users: [user] });
    if (p === '/api/chat/channels/' || p === `/api/projects/${REMOTE_ID}/chat/channels/`) {
      const wantsGlobal = url.searchParams.get('scope') === 'global';
      const channel = { id: CHANNEL_ID, name: `${name} room`, project_id: state.globalOnly ? null : REMOTE_ID, is_private: false };
      return json(res, 200, {
        success: true,
        channels: wantsGlobal && !state.globalOnly ? [] : [channel],
      });
    }
    if (p === CHAT_PATH && method === 'GET')
      return json(res, 200, {
        success: true,
        messages: history,
      });
    if (p === CHAT_PATH && method === 'POST') {
      const sent = sendShape.safeParse(await body(req));
      if (
        !sent.success ||
        session.csrf !== req.headers['x-csrftoken'] ||
        req.headers.origin !== origin ||
        req.headers.referer !== `${origin}${CHAT_PATH}`
      ) {
        return json(res, 400, { success: false });
      }
      if (state.refuseChatSend) return json(res, 403, { success: false });
      const message = chatMessage(actorId, 100 + history.length, sent.data.message);
      history.push(message);
      publish(message);
      return json(res, 201, { success: true, message });
    }
    if (p === BOARD_ENTRY) return redirect(res, state.redirects.board ?? BOARD_PATH);
    if (p === BOARD_PATH)
      return html(
        res,
        `${name} Board`,
        `<details id="card"><summary>Fixture card</summary>
      <button id="draft">Mark as draft</button><output id="draft-state">${state.edits ? 'Draft' : 'Published'}</output></details>
      <a id="logout" href="${LOGOUT}">Log out</a><script defer src="/static/fixture-board.js"></script>`,
        session.csrf,
      );
    if (
      p === EDIT &&
      method === 'PUT' &&
      session.csrf === req.headers['x-csrftoken'] &&
      req.headers.referer === `${origin}${BOARD_PATH}` &&
      draftShape.safeParse(await body(req)).success
    ) {
      state.edits++;
      return json(res, 200, { success: true, story: { id: 71, is_draft: true } });
    }
    return json(res, 404, { success: false });
  }

  const http = createServer({ requestTimeout: 5_000, headersTimeout: 5_000 }, (req, res) => {
    void handle(req, res).catch(() => {
      if (res.headersSent) res.destroy();
      else json(res, 500, { success: false });
    });
  });
  http.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', origin);
    const transport = url.searchParams.get('transport');
    const eio = url.searchParams.get('EIO');
    const sid = value(req);
    const actor = sid && sessions.get(sid)?.authenticated ? actorId : null;
    upgrades.push({
      actor,
      transport,
      eio,
      exactOrigin: req.headers.origin === origin,
      cookieCount: req.headers.cookie?.split(';').length ?? 0,
    });
    if (
      url.pathname !== '/socket.io/' ||
      transport !== 'websocket' ||
      eio !== '4' ||
      url.searchParams.has('sid') ||
      req.headers.origin !== origin
    ) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const entry = { ready: false, joined: false };
      clients.set(ws, entry);
      const heartbeat = setInterval(() => {
        if (entry.ready) ws.send('2');
      }, 25_000);
      ws.on('error', () => ws.terminate());
      ws.on('close', () => {
        clearInterval(heartbeat);
        clients.delete(ws);
        if (entry.ready) state.sockets--;
      });
      ws.send(
        `0${JSON.stringify({ sid: token(), upgrades: [], pingInterval: 25_000, pingTimeout: 20_000, maxPayload: LIMIT })}`,
      );
      ws.on('message', (raw) => {
        const packet = raw.toString();
        if (packet === '40' && !entry.ready) {
          if (actor === null) {
            ws.send('44{"message":"Connection rejected by server"}');
            return;
          }
          entry.ready = true;
          state.sockets++;
          ws.send(`42${JSON.stringify(['connected', { status: 'success', user_id: actor }])}`);
          ws.send(`40${JSON.stringify({ sid: token() })}`);
        } else if (entry.ready && packet.startsWith('42')) {
          const event = z.tuple([
            z.literal('join_channel'),
            z.object({ channel_id: z.literal(CHANNEL_ID) }),
          ]);
          const incoming: unknown = JSON.parse(packet.slice(2));
          if (event.safeParse(incoming).success) {
            entry.joined = true;
            joined.push(CHANNEL_ID);
            ws.send(
              `42${JSON.stringify(['channel_joined', { channel_id: CHANNEL_ID, active_users: [] }])}`,
            );
          }
          const submission = globalSend.safeParse(incoming);
          if (entry.joined && state.globalOnly && submission.success) {
            state.globalSubmissions++;
            publish(chatMessage(actorId, 120 + state.globalSubmissions, submission.data[1].message, null));
          }
        }
      });
    });
  });
  const listening = once(http, 'listening');
  http.listen(0, HOST);
  await listening;
  const address = http.address();
  if (!address || typeof address === 'string' || address.address !== HOST)
    throw new Error('Expected literal loopback fixture');
  origin = `http://${HOST}:${address.port}`;
  let closing: Promise<void> | undefined;
  return {
    origin,
    name,
    actorId,
    credentials: { username, password },
    requests,
    upgrades,
    joined,
    state,
    publishChat(text) {
      publish(chatMessage(actorId + 1, 92, text));
    },
    expire() {
      sessions.clear();
    },
    close() {
      closing ??= new Promise<void>((resolve, reject) => {
        for (const ws of clients.keys()) ws.terminate();
        wss.close();
        http.close((err) => (err ? reject(err) : resolve()));
        http.closeAllConnections();
      });
      return closing;
    },
  };
}
