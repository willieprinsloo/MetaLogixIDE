# Agent Chat Bus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a per-project, fleet-wide agent-to-agent chat bus so agents in different shells can talk to each other through `@`-tagged messages the IDE injects into target PTYs.

**Architecture:** An append-only `.metaide/chat.jsonl` log is the local source of truth per device. The main process serialises writes behind one IPC (`chat:append`), watches the file for `chat:changed` events, and runs a PTY stdin injector that writes `[metaide-chat …] <body>\n` lines to recipient shells. Fleet-wide delivery rides the existing P2P RPC channel with three new verbs (`chat.append`, `chat.sync_since`, `chat.roster`). A new activity-bar entry `Agents` renders the thread, roster and composer.

**Tech Stack:** Electron 32 main + preload + React 18 renderer + TypeScript, mirroring the existing `src/main/activity/` pattern. Node fs for log IO, `node-pty` write for injection, zod for RPC schemas, vitest + jsdom for unit tests.

**Spec:** `docs/superpowers/specs/2026-11-18-metaide-agent-chat-bus-design.md`

## Global Constraints

- Log file path: `<projectRoot>/.metaide/chat.jsonl` — sibling of `activity.jsonl`; `.metaide/` dir reused.
- Max body size per message: `CHAT_BODY_MAX = 8 * 1024` bytes; the writer truncates with `…` suffix.
- Max roster page: `CHAT_PAGE_MAX = 500` entries (parity with `ACTIVITY_PAGE_MAX`).
- Reply-cap default: `CHAT_REPLY_CAP = 5` consecutive agent replies per root thread without a human post.
- In-cap debounce: at most 3 agent messages per rolling 1 s window on one shell (`CHAT_RATE_WINDOW_MS = 1000`, `CHAT_RATE_MAX = 3`).
- Injection prefix contract: `[metaide-chat from=<mention> reply=<msgId|-> ] <body>\n` — the trailing space before `]` is required by the parser in Task 6.
- Addressable agent handle = lowercase CLI family (e.g. `claude`, `codex`, `ollama`); device-qualified form `@claude@<device>`; shell-qualified form `@<agent>#<shellIndex>`.
- `@human` is always logged, never injected.
- Supported platforms: darwin + win32 (every new path uses `path.join` and never a hard-coded `/`).
- File writes swallow I/O errors (match activity log's `console.warn` + continue policy).
- Attribution line for every git commit from this plan: `Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>`.

## Review Focus

- **Body with embedded newlines and `\r`** — injector strips them so one chat line stays one PTY line (Task 6).
- **Body with ANSI escape bytes (`\x1b[31m…`)** — stripped before injection so a hostile peer cannot repaint the terminal (Task 6).
- **Mention of an offline agent** — message is logged with `meta.cap_held: false` and surfaced as "undelivered" in the pane; never dropped silently (Task 4).
- **Cap held, then a human posts** — queued messages are released in timestamp order with injection resumed (Task 6).
- **P2P peer reconnects with a clock 30 s behind** — `chat.sync_since(last_seen_ts)` still returns the gap because the local file's ordering key is `(ts, device, counter)`, not `ts` alone (Task 7).

---

### Task 1: Shared types + log module

**Files:**
- Create: `src/shared/chat.ts`
- Create: `src/main/chat/log.ts`
- Create: `tests/unit/main/chat/log.test.ts`

**Interfaces:**
- Consumes: none.
- Produces:
  - `type ChatMention = { device?: string; shell?: number; agent?: string }`
  - `interface ChatEntry { id: string; ts: string; from: { device: string; shell: number; agent: string; label?: string }; to: ChatMention[]; body: string; reply_in?: string; meta?: { cap_held?: boolean } }`
  - Constants: `CHAT_BODY_MAX = 8192`, `CHAT_PAGE_MAX = 500`, `CHAT_REPLY_CAP = 5`, `CHAT_RATE_WINDOW_MS = 1000`, `CHAT_RATE_MAX = 3`, `CHAT_DIR = '.metaide'`, `CHAT_FILE = 'chat.jsonl'`.
  - `chatPath(projectPath: string): string`
  - `appendChat(projectPath: string, entry: ChatEntry): void`
  - `readRecentChat(projectPath: string, limit: number): ChatEntry[]`
  - `nextChatId(deviceId: string): string` — `<ts base36>-<deviceId>-<counter base36>`.

- [ ] **Step 1: Write failing tests**

```ts
// tests/unit/main/chat/log.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendChat, readRecentChat, chatPath, nextChatId } from '@main/chat/log';
import { CHAT_BODY_MAX } from '@shared/chat';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'chat-log-')); });

it('appends then reads one entry', () => {
  const entry = { id: 'a', ts: '2026-11-18T10:00:00Z', from: { device: 'd1', shell: 1, agent: 'claude' }, to: [], body: 'hi' };
  appendChat(dir, entry);
  expect(readRecentChat(dir, 10)).toEqual([entry]);
});

it('truncates bodies over CHAT_BODY_MAX with an ellipsis', () => {
  const big = 'x'.repeat(CHAT_BODY_MAX + 500);
  appendChat(dir, { id: 'b', ts: '', from: { device: 'd1', shell: 1, agent: 'claude' }, to: [], body: big });
  const [got] = readRecentChat(dir, 10);
  expect(got.body.length).toBe(CHAT_BODY_MAX + 1); // +1 for ellipsis
  expect(got.body.endsWith('…')).toBe(true);
});

it('readRecentChat returns at most `limit` entries, newest wins', () => {
  for (let i = 0; i < 20; i++) appendChat(dir, { id: `e${i}`, ts: '', from: { device: 'd1', shell: 1, agent: 'claude' }, to: [], body: String(i) });
  const out = readRecentChat(dir, 5);
  expect(out.map((e) => e.body)).toEqual(['15','16','17','18','19']);
});

it('nextChatId embeds the device id', () => {
  expect(nextChatId('mac-mini')).toMatch(/^[a-z0-9]+-mac-mini-[a-z0-9]+$/);
});

it('chatPath points to <project>/.metaide/chat.jsonl', () => {
  expect(chatPath('/p')).toBe(join('/p', '.metaide', 'chat.jsonl'));
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `pnpm test -- tests/unit/main/chat/log.test.ts`
Expected: FAIL with "Cannot find module '@main/chat/log'".

- [ ] **Step 3: Implement `src/shared/chat.ts`**

Mirror `src/shared/activity.ts`. Export the types and constants listed in **Produces**.

- [ ] **Step 4: Implement `src/main/chat/log.ts`**

Mirror `src/main/activity/log.ts` byte-for-byte for the JSONL append + tail-read logic. Replace `ACTIVITY_*` constants with `CHAT_*`. Trim `entry.body` (not `entry.text`) when over `CHAT_BODY_MAX`. `nextChatId(deviceId)` composes `<Date.now() base36>-<deviceId>-<counter base36>`.

- [ ] **Step 5: Run tests, verify they pass**

Run: `pnpm test -- tests/unit/main/chat/log.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add src/shared/chat.ts src/main/chat/log.ts tests/unit/main/chat/log.test.ts
git commit -m "$(cat <<'EOF'
feat(chat): shared types and append-only .metaide/chat.jsonl log

Mirrors the activity log so one project holds one chat stream humans
and agents can tail.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: IPC contract + main-side append/list/event

**Files:**
- Modify: `src/shared/ipc-contract.ts` (add 3 keys)
- Modify: `src/main/ipc/register.ts` (register 2 handlers + fanout)
- Create: `src/main/chat/service.ts`
- Create: `tests/unit/main/chat/service.test.ts`

**Interfaces:**
- Consumes: `appendChat`, `readRecentChat`, `nextChatId`, `ChatEntry` from Task 1.
- Produces:
  - IPC `chat:append`: `{ projectId: number; from: Omit<ChatEntry['from'], 'device'>; to?: ChatMention[]; body: string; reply_in?: string }` → `{ entry: ChatEntry }`.
  - IPC `chat:list`: `{ projectId: number; limit?: number }` → `{ entries: ChatEntry[] }`.
  - Event `chat:changed`: `{ projectId: number; entry: ChatEntry }` — broadcast to every window.
  - `createChatService(deps: { projects: ProjectsRepo; deviceId: string; broadcast: (ch: 'chat:changed', p: unknown) => void }): { append(req): Promise<{ entry }>; list(req): Promise<{ entries }> }`.
  - The service stamps `id` + `ts` + `from.device = deviceId`, writes the file, broadcasts the event.

- [ ] **Step 1: Write failing tests**

```ts
// tests/unit/main/chat/service.test.ts
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { createChatService } from '@main/chat/service';
import { readRecentChat } from '@main/chat/log';

const makeDeps = (projectPath: string) => {
  const projects = { get: vi.fn().mockReturnValue({ id: 7, path: projectPath }) } as never;
  const broadcast = vi.fn();
  return { projects, deviceId: 'dev-a', broadcast };
};

it('append writes the entry and broadcasts chat:changed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-svc-'));
  const deps = makeDeps(dir);
  const svc = createChatService(deps);
  const { entry } = await svc.append({ projectId: 7, from: { shell: 1, agent: 'claude' }, body: 'hi' });
  expect(entry.from.device).toBe('dev-a');
  expect(entry.id).toMatch(/dev-a/);
  expect(entry.ts).toMatch(/^\d{4}-/);
  expect(deps.broadcast).toHaveBeenCalledWith('chat:changed', { projectId: 7, entry });
  expect(readRecentChat(dir, 10)).toEqual([entry]);
});

it('list reads back the log', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-svc-'));
  const svc = createChatService(makeDeps(dir));
  await svc.append({ projectId: 7, from: { shell: 1, agent: 'claude' }, body: 'one' });
  await svc.append({ projectId: 7, from: { shell: 2, agent: 'codex' }, body: 'two' });
  const { entries } = await svc.list({ projectId: 7, limit: 10 });
  expect(entries.map((e) => e.body)).toEqual(['one', 'two']);
});

it('append rejects unknown projectId', async () => {
  const deps = makeDeps('/x'); (deps.projects.get as never as { mockReturnValue: Function }).mockReturnValue(null);
  await expect(createChatService(deps).append({ projectId: 99, from: { shell: 1, agent: 'claude' }, body: 'x' })).rejects.toThrow(/unknown project/);
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `pnpm test -- tests/unit/main/chat/service.test.ts`
Expected: FAIL ("Cannot find module '@main/chat/service'").

- [ ] **Step 3: Add the three IPC keys**

In `src/shared/ipc-contract.ts`, under the request/response map add:
- `'chat:append'` with the request/response shapes in **Produces**.
- `'chat:list'` with the same shape style as `'activity:list'`.

Under the event map add `'chat:changed': { projectId: number; entry: import('./chat').ChatEntry }`.

- [ ] **Step 4: Implement `src/main/chat/service.ts`**

Export `createChatService` with signature in **Produces**. On `append`: look up the project via `projects.get`; throw `Error('unknown project ' + projectId)` on miss; stamp `id = nextChatId(deviceId)`, `ts = new Date().toISOString()`, `from.device = deviceId`; call `appendChat(project.path, entry)`; call `broadcast('chat:changed', { projectId, entry })`; return `{ entry }`. On `list`: call `readRecentChat(project.path, Math.min(limit ?? 100, CHAT_PAGE_MAX))`.

- [ ] **Step 5: Register handlers in `src/main/ipc/register.ts`**

Hand the two IPC handlers to the existing `ipcMain.handle` wiring. The `broadcast` dep passed to `createChatService` is the same per-window broadcaster `activity:changed` uses. Export the service on the `services` object so Task 6 can call `append` from inside the main process.

- [ ] **Step 6: Run tests, verify they pass**

Run: `pnpm test -- tests/unit/main/chat/service.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add src/shared/ipc-contract.ts src/main/ipc/register.ts src/main/chat/service.ts tests/unit/main/chat/service.test.ts
git commit -m "$(cat <<'EOF'
feat(chat): chat:append and chat:list IPC with chat:changed fanout

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Mention parser

**Files:**
- Create: `src/shared/chat-mention.ts`
- Create: `tests/unit/shared/chat-mention.test.ts`

**Interfaces:**
- Consumes: `ChatMention` from Task 1.
- Produces:
  - `parseMentions(body: string): ChatMention[]` — scans for `@<agent>` with optional `#<shell>` and `@<device>` modifiers, returns the mention list.
  - `formatMention(m: ChatMention): string` — inverse (`@claude#2@mac-mini`).

- [ ] **Step 1: Write failing tests**

```ts
// tests/unit/shared/chat-mention.test.ts
import { it, expect } from 'vitest';
import { parseMentions, formatMention } from '@shared/chat-mention';

it('bare agent', () => { expect(parseMentions('@claude hi')).toEqual([{ agent: 'claude' }]); });
it('shell-qualified', () => { expect(parseMentions('hey @codex#2')).toEqual([{ agent: 'codex', shell: 2 }]); });
it('device-qualified', () => { expect(parseMentions('@claude@mac-mini?')).toEqual([{ agent: 'claude', device: 'mac-mini' }]); });
it('shell + device', () => { expect(parseMentions('@claude#1@laptop here')).toEqual([{ agent: 'claude', shell: 1, device: 'laptop' }]); });
it('@all expands to the broadcast marker (empty agent)', () => { expect(parseMentions('@all go')).toEqual([{ agent: 'all' }]); });
it('@human is addressable', () => { expect(parseMentions('@human ok')).toEqual([{ agent: 'human' }]); });
it('no mention ⇒ empty list (broadcast is logged, never injected)', () => { expect(parseMentions('just text')).toEqual([]); });
it('duplicate mentions dedupe', () => { expect(parseMentions('@claude @claude@laptop @claude')).toEqual([{ agent: 'claude' }, { agent: 'claude', device: 'laptop' }]); });
it('formatMention inverse', () => { expect(formatMention({ agent: 'codex', shell: 2, device: 'mac-mini' })).toBe('@codex#2@mac-mini'); });
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `pnpm test -- tests/unit/shared/chat-mention.test.ts`
Expected: FAIL ("Cannot find module '@shared/chat-mention'").

- [ ] **Step 3: Implement `src/shared/chat-mention.ts`**

One regex: `/@([a-z][a-z0-9-]*)(?:#(\d+))?(?:@([a-z0-9][a-z0-9.-]*))?/gi`. Lowercase captures. Walk matches, dedupe by `formatMention(m)` key. `formatMention` joins `@<agent>` + optional `#<shell>` + optional `@<device>`.

- [ ] **Step 4: Run tests, verify they pass**

Run: `pnpm test -- tests/unit/shared/chat-mention.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/chat-mention.ts tests/unit/shared/chat-mention.test.ts
git commit -m "$(cat <<'EOF'
feat(chat): @-mention parser with shell + device qualifiers

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Roster builder

**Files:**
- Create: `src/main/chat/roster.ts`
- Create: `tests/unit/main/chat/roster.test.ts`

**Interfaces:**
- Consumes: `AliveShellSummary` from `@shared/types`; `ShellInfoT` from `@shared/p2p-contract`.
- Produces:
  - `interface RosterRow { device: string; shell: number; agent: string; label: string; state: 'idle' | 'busy' | 'blocked' | null; mention: string }`
  - `buildRoster(input: { local: AliveShellSummary[]; remote: Array<{ device: string; shells: ShellInfoT[] }>; agentLabels: Record<number, string>; agentStates: Record<number, 'idle'|'busy'|'blocked'|null>; selfDevice: string }): RosterRow[]` — sorted self-first then device name; omits rows whose `agent` is empty/null.

- [ ] **Step 1: Write failing tests**

```ts
// tests/unit/main/chat/roster.test.ts
import { it, expect } from 'vitest';
import { buildRoster } from '@main/chat/roster';

const row = (p: Partial<any> = {}) => ({ projectId: 1, shellIndex: p.shellIndex ?? 1, model: null, launchArgv: [], startedAt: '', lastActiveAt: '', pinned: false, projectName: 'p', projectPath: '/p', ...p });

it('self first, then alphabetical device', () => {
  const r = buildRoster({
    local: [row({ shellIndex: 1 }), row({ shellIndex: 2 })],
    remote: [{ device: 'zeta', shells: [{ projectId: 1, shellIndex: 1, agentState: 'idle' }] }, { device: 'alpha', shells: [{ projectId: 1, shellIndex: 1, agentState: 'busy' }] }],
    agentLabels: { 1: 'claude', 2: 'codex' },
    agentStates: { 1: 'idle', 2: 'busy' },
    selfDevice: 'laptop',
  });
  expect(r.map((x) => `${x.device}#${x.shell}`)).toEqual(['laptop#1', 'laptop#2', 'alpha#1', 'zeta#1']);
});

it('omits shells with no agent label', () => {
  const r = buildRoster({ local: [row({ shellIndex: 3 })], remote: [], agentLabels: {}, agentStates: {}, selfDevice: 'x' });
  expect(r).toHaveLength(0);
});

it('mention is shell-qualified when the same agent appears twice on one device', () => {
  const r = buildRoster({ local: [row({ shellIndex: 1 }), row({ shellIndex: 2 })], remote: [], agentLabels: { 1: 'claude', 2: 'claude' }, agentStates: {}, selfDevice: 'x' });
  expect(r.map((x) => x.mention)).toEqual(['@claude#1', '@claude#2']);
});

it('mention is bare agent when it is unique on its device', () => {
  const r = buildRoster({ local: [row({ shellIndex: 1 })], remote: [{ device: 'laptop', shells: [{ projectId: 1, shellIndex: 5, agentState: null }] }], agentLabels: { 1: 'claude', 5: 'codex' }, agentStates: {}, selfDevice: 'self' });
  expect(r.map((x) => x.mention)).toEqual(['@claude', '@codex@laptop']);
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `pnpm test -- tests/unit/main/chat/roster.test.ts`
Expected: FAIL ("Cannot find module '@main/chat/roster'").

- [ ] **Step 3: Implement `src/main/chat/roster.ts`**

For each `local` row look up `agentLabels[shellIndex]`; skip when empty. For `remote`, only rows whose shell carries a non-empty `agent` label (derived from `model` if the P2P contract carries one; otherwise skip — see the Task 7 extension of `ShellInfo`). Compute `mention`: bare `@<agent>` for unique (agent, device), `@<agent>#<shell>` when another shell on the same device shares the agent, suffix `@<device>` for non-self devices. Sort: self device first, then by device name ascending, then by shell index ascending.

- [ ] **Step 4: Run tests, verify they pass**

Run: `pnpm test -- tests/unit/main/chat/roster.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/chat/roster.ts tests/unit/main/chat/roster.test.ts
git commit -m "$(cat <<'EOF'
feat(chat): roster builder from local alive shells + remote peers

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Reply-cap counter

**Files:**
- Create: `src/main/chat/cap.ts`
- Create: `tests/unit/main/chat/cap.test.ts`

**Interfaces:**
- Consumes: `ChatEntry` from Task 1.
- Produces:
  - `createReplyCap(now: () => number = Date.now): { admit(entry: ChatEntry): 'pass' | 'cap' | 'rate'; release(threadRoot: string): string[] }` — `admit` is called for every entry; it returns `'cap'` when the thread's agent-reply count hit `CHAT_REPLY_CAP` without an intervening human, `'rate'` when the sender's 1 s window has already carried `CHAT_RATE_MAX`. `release` empties a thread's queue and returns the queued entry ids in order.

- [ ] **Step 1: Write failing tests**

```ts
// tests/unit/main/chat/cap.test.ts
import { it, expect } from 'vitest';
import { createReplyCap } from '@main/chat/cap';

const mk = (p: Partial<any>) => ({ id: p.id, ts: '', from: { device: 'd', shell: p.shell ?? 1, agent: p.agent ?? 'claude' }, to: [], body: '', reply_in: p.reply_in, ...p });

it('admits human messages without counting', () => {
  const cap = createReplyCap();
  for (let i = 0; i < 10; i++) expect(cap.admit(mk({ id: `h${i}`, agent: 'human', reply_in: 'root' }))).toBe('pass');
});

it('caps at CHAT_REPLY_CAP agent replies in one thread', () => {
  const cap = createReplyCap();
  for (let i = 0; i < 5; i++) expect(cap.admit(mk({ id: `a${i}`, agent: 'claude', reply_in: 'root' }))).toBe('pass');
  expect(cap.admit(mk({ id: 'a5', agent: 'claude', reply_in: 'root' }))).toBe('cap');
});

it('human reset: a human post releases the cap', () => {
  const cap = createReplyCap();
  for (let i = 0; i < 5; i++) cap.admit(mk({ id: `a${i}`, agent: 'claude', reply_in: 'root' }));
  cap.admit(mk({ id: 'h', agent: 'human', reply_in: 'root' }));
  expect(cap.admit(mk({ id: 'a6', agent: 'claude', reply_in: 'root' }))).toBe('pass');
});

it('rate-limits 3 agent msgs/sec from one shell', () => {
  let t = 1000; const cap = createReplyCap(() => t);
  expect(cap.admit(mk({ id: 'r1', agent: 'claude', reply_in: 'x' }))).toBe('pass');
  expect(cap.admit(mk({ id: 'r2', agent: 'claude', reply_in: 'x' }))).toBe('pass');
  expect(cap.admit(mk({ id: 'r3', agent: 'claude', reply_in: 'x' }))).toBe('pass');
  expect(cap.admit(mk({ id: 'r4', agent: 'claude', reply_in: 'x' }))).toBe('rate');
  t = 2001;
  expect(cap.admit(mk({ id: 'r5', agent: 'claude', reply_in: 'x' }))).toBe('pass');
});

it('release returns queued ids and clears them', () => {
  const cap = createReplyCap();
  for (let i = 0; i < 5; i++) cap.admit(mk({ id: `a${i}`, agent: 'claude', reply_in: 'root' }));
  cap.admit(mk({ id: 'q1', agent: 'claude', reply_in: 'root' }));
  cap.admit(mk({ id: 'q2', agent: 'claude', reply_in: 'root' }));
  expect(cap.release('root')).toEqual(['q1', 'q2']);
  expect(cap.release('root')).toEqual([]);
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `pnpm test -- tests/unit/main/chat/cap.test.ts`
Expected: FAIL ("Cannot find module '@main/chat/cap'").

- [ ] **Step 3: Implement `src/main/chat/cap.ts`**

Keep a `Map<threadRoot, number>` of consecutive agent replies and a `Map<threadRoot, string[]>` of queued entry ids. Keep a `Map<shellKey, number[]>` of send timestamps for the rate window. `threadRoot` = `entry.reply_in ?? entry.id`. `shellKey` = `${from.device}#${from.shell}`. Human entries reset the count to 0 and empty the queue (the ids are returned on the next `release(root)` call, so the queue is kept keyed per root until drained).

- [ ] **Step 4: Run tests, verify they pass**

Run: `pnpm test -- tests/unit/main/chat/cap.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/chat/cap.ts tests/unit/main/chat/cap.test.ts
git commit -m "$(cat <<'EOF'
feat(chat): reply-cap + rate-limit gate

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: PTY injector wire-up

**Files:**
- Create: `src/main/chat/inject.ts`
- Modify: `src/main/index.ts` (wire `wireChatInjector` next to `wireActivityLog`)
- Create: `tests/unit/main/chat/inject.test.ts`

**Interfaces:**
- Consumes: `ChatEntry`, `RosterRow` (Task 4), `createReplyCap` (Task 5), `appendChat` (Task 1), `PtyManager.write` from `@main/pty/manager`.
- Produces:
  - `wireChatInjector(deps: { pty: Pick<PtyManager, 'write'>; roster: () => RosterRow[]; service: ChatService; cap: ReturnType<typeof createReplyCap>; onCapHeld: (projectId: number, entry: ChatEntry) => void; hooks: { onChatChanged: (cb: (p: { projectId: number; entry: ChatEntry }) => void) => void } }): void`
  - `formatInjectionLine(entry: ChatEntry, selfDevice: string): string` — returns `[metaide-chat from=<mention> reply=<id|-> ] <sanitised body>\n` with `\r`, `\n`, and ANSI escapes (`\x1b[...m`) stripped from the body.

- [ ] **Step 1: Write failing tests**

```ts
// tests/unit/main/chat/inject.test.ts
import { it, expect, vi } from 'vitest';
import { formatInjectionLine, wireChatInjector } from '@main/chat/inject';
import { createReplyCap } from '@main/chat/cap';

const base = (p: Partial<any> = {}) => ({ id: 'e1', ts: '', from: { device: 'laptop', shell: 1, agent: 'claude' }, to: [{ agent: 'codex' }], body: 'hi there', reply_in: undefined, ...p });

it('formatInjectionLine strips \\r \\n and ANSI, keeps prefix contract', () => {
  const line = formatInjectionLine(base({ body: 'red\x1b[31mX\x1b[0m\r\nend' }), 'laptop');
  expect(line).toBe('[metaide-chat from=@claude@laptop reply=- ] redXend\n');
});

it('reply=<msgId> when reply_in is set', () => {
  expect(formatInjectionLine(base({ reply_in: 'root-7' }), 'laptop')).toMatch(/reply=root-7 /);
});

it('wire fires PtyManager.write for the first local recipient only', () => {
  const pty = { write: vi.fn() };
  const roster = () => [{ device: 'laptop', shell: 2, agent: 'codex', label: '', state: null, mention: '@codex' }];
  const subs: Array<(p: any) => void> = [];
  const hooks = { onChatChanged: (cb: (p: any) => void) => { subs.push(cb); } };
  wireChatInjector({ pty, roster, service: { append: vi.fn() } as never, cap: createReplyCap(), onCapHeld: vi.fn(), hooks });
  subs[0]!({ projectId: 42, entry: base({ to: [{ agent: 'codex' }] }) });
  expect(pty.write).toHaveBeenCalledWith(42, 2, expect.stringContaining('[metaide-chat'));
});

it('cap=cap triggers onCapHeld and does NOT write', () => {
  const pty = { write: vi.fn() };
  const cap = { admit: () => 'cap', release: () => [] } as never;
  const onCapHeld = vi.fn();
  const subs: Array<(p: any) => void> = [];
  const hooks = { onChatChanged: (cb: (p: any) => void) => { subs.push(cb); } };
  wireChatInjector({ pty, roster: () => [{ device: 'laptop', shell: 2, agent: 'codex', label: '', state: null, mention: '@codex' }], service: { append: vi.fn() } as never, cap, onCapHeld, hooks });
  subs[0]!({ projectId: 1, entry: base() });
  expect(onCapHeld).toHaveBeenCalled();
  expect(pty.write).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `pnpm test -- tests/unit/main/chat/inject.test.ts`
Expected: FAIL ("Cannot find module '@main/chat/inject'").

- [ ] **Step 3: Implement `src/main/chat/inject.ts`**

`formatInjectionLine`: compose `[metaide-chat from=<formatMention(from)> reply=<reply_in ?? '-'> ] <body>\n`. `body` is sanitised with `body.replace(/\x1b\[[^m]*m/g, '').replace(/[\r\n]+/g, ' ')`. `wireChatInjector` subscribes to `hooks.onChatChanged`, filters entries whose `to` resolves to a local recipient via the roster (match device === selfDevice via a passed getter), calls `cap.admit(entry)`:
- `pass` → `pty.write(projectId, shell, formatInjectionLine(entry, selfDevice))`
- `cap`  → `onCapHeld(projectId, entry)` (the UI uses this to show a red badge; the service separately re-appends the entry with `meta.cap_held: true` — out of scope for this task's tests, but the hook must fire).
- `rate` → silently drop with a `console.debug`.

- [ ] **Step 4: Wire into `src/main/index.ts`**

After `wireActivityLog(...)` add:

```ts
const chatCap = createReplyCap();
wireChatInjector({
  pty: services.pty,
  roster: () => currentRoster(services, hub),
  service: services.chat,
  cap: chatCap,
  onCapHeld: (projectId, entry) => broadcast('chat:changed', { projectId, entry: { ...entry, meta: { cap_held: true } } }),
  hooks: { onChatChanged: (cb) => ipcMain.on('chat:changed', (_e, p) => cb(p)) },
});
```

`currentRoster` is a one-liner helper in `src/main/chat/roster.ts` that already exists after Task 4; it reads local alive shells, local agent labels/states, and the hub's cached remote shells.

- [ ] **Step 5: Run tests, verify they pass**

Run: `pnpm test -- tests/unit/main/chat/inject.test.ts && pnpm typecheck`
Expected: PASS (4 tests), typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/main/chat/inject.ts src/main/index.ts tests/unit/main/chat/inject.test.ts
git commit -m "$(cat <<'EOF'
feat(chat): PTY stdin injector with reply-cap gate

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: P2P fan-out and sync

**Files:**
- Modify: `src/shared/p2p-contract.ts` (add 3 RPC verbs)
- Modify: `src/main/p2p/rpc.ts` (handlers)
- Modify: `src/main/p2p/hub.ts` (fan-out on local append + sync on connect)
- Create: `tests/unit/main/p2p/chat-rpc.test.ts`

**Interfaces:**
- Consumes: `ChatEntry`, `appendChat`, `readRecentChat`, `nextChatId`, `createChatService`, roster builder.
- Produces: 3 new RPC verbs on `RpcMethods`:
  - `'chat.append'`: params `{ entry: ChatEntry }`, result `{ ok: true }`.
  - `'chat.sync_since'`: params `{ projectId: number; since_ts: string }`, result `{ entries: ChatEntry[] }`.
  - `'chat.roster'`: params `{ projectId: number }`, result `{ rows: RosterRow[] }`.

- [ ] **Step 1: Write failing tests**

```ts
// tests/unit/main/p2p/chat-rpc.test.ts
import { it, expect, vi } from 'vitest';
import { RpcMethods } from '@shared/p2p-contract';
import { handleChatAppend, handleChatSyncSince, handleChatRoster } from '@main/p2p/rpc';

it('chat.append is in the catalogue', () => { expect(RpcMethods['chat.append']).toBeDefined(); });
it('chat.sync_since is in the catalogue', () => { expect(RpcMethods['chat.sync_since']).toBeDefined(); });
it('chat.roster is in the catalogue', () => { expect(RpcMethods['chat.roster']).toBeDefined(); });

it('chat.append writes to the local log via the service', async () => {
  const chat = { append: vi.fn().mockResolvedValue({ entry: {} }) };
  await handleChatAppend({ chat } as never, { entry: { id: 'x', ts: '2026-01', from: { device: 'remote', shell: 1, agent: 'claude' }, to: [], body: 'hi' } });
  expect(chat.append).toHaveBeenCalled();
});

it('chat.sync_since returns entries newer than since_ts', async () => {
  const chat = { listSince: vi.fn().mockResolvedValue({ entries: [{ id: 'y', ts: '2026-02' }] }) };
  const res = await handleChatSyncSince({ chat } as never, { projectId: 1, since_ts: '2026-01' });
  expect(res.entries).toHaveLength(1);
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `pnpm test -- tests/unit/main/p2p/chat-rpc.test.ts`
Expected: FAIL (missing RPC entries).

- [ ] **Step 3: Extend `src/shared/p2p-contract.ts`**

Export a `ChatEntryZ` zod shape mirroring the Task 1 `ChatEntry` interface (with `.passthrough()` on nested objects). Add three entries to `RpcMethods` with the shapes in **Produces**.

- [ ] **Step 4: Extend `src/main/chat/service.ts`**

Add `listSince(projectId: number, sinceTs: string): Promise<{ entries: ChatEntry[] }>` — reads tail entries, filters by `ts > sinceTs`.

- [ ] **Step 5: Implement handlers in `src/main/p2p/rpc.ts`**

- `handleChatAppend(deps, params)` → `deps.chat.append({ projectId: ..., from: params.entry.from, to: params.entry.to, body: params.entry.body, reply_in: params.entry.reply_in })`. `projectId` resolves by matching the remote peer's `projectPath` against the local project table; drop silently when unknown.
- `handleChatSyncSince(deps, params)` → `deps.chat.listSince(params.projectId, params.since_ts)`.
- `handleChatRoster(deps, params)` → return `deps.roster()`.

- [ ] **Step 6: Fan-out on local append in `src/main/p2p/hub.ts`**

In the existing `broadcast` of `chat:changed`, also iterate over `hub.connectedPeers()` and call `peer.rpc('chat.append', { entry })` for every peer that holds the same project (identified by matching project path on the peer, from the existing projects.list cache). Ignore send errors (the `chat.sync_since` reconnect handler catches up).

- [ ] **Step 7: Sync on connect in `src/main/p2p/hub.ts`**

In the "peer connected" hook, for every shared project (existing cache), call `peer.rpc('chat.sync_since', { projectId: remoteProjectId, since_ts: last_seen_ts_for(peer, project) })` and feed every returned entry through `services.chat.append({ ...entry })`. Persist `last_seen_ts` in memory per (peer, project); initialise to the current local log's newest `ts`.

- [ ] **Step 8: Run tests, verify they pass**

Run: `pnpm test -- tests/unit/main/p2p/chat-rpc.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/shared/p2p-contract.ts src/main/p2p/rpc.ts src/main/p2p/hub.ts src/main/chat/service.ts tests/unit/main/p2p/chat-rpc.test.ts
git commit -m "$(cat <<'EOF'
feat(chat): P2P fan-out and chat.sync_since on reconnect

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Companion CLI `metaide chat`

**Files:**
- Create: `bin/metaide-chat.ts` (built to `out/bin/metaide-chat.js`)
- Modify: `electron.vite.config.ts` (new entry for the bin)
- Modify: `src/main/ipc/register.ts` (install the shim on PATH per shell via `.metaide/env`)
- Create: `tests/unit/bin/metaide-chat.test.ts`

**Interfaces:**
- Consumes: IPC `chat:append`, `chat:list` (via a Unix domain socket the main process owns at `~/Library/Application Support/metaide/sockets/<pid>.sock` on darwin, `\\.\pipe\metaide-<pid>` on win32).
- Produces: CLI `metaide chat send <body> [--to @m] [--reply-in <id>] [--project <id>] [--shell <n>]`, `metaide chat recent [--limit N]`, `metaide chat roster`.

- [ ] **Step 1: Write failing tests**

```ts
// tests/unit/bin/metaide-chat.test.ts
import { it, expect, vi } from 'vitest';
import { parseCliArgs } from '@bin/metaide-chat';

it('send captures --to and --reply-in', () => {
  expect(parseCliArgs(['send', 'hello world', '--to', '@codex', '--reply-in', 'r1'])).toEqual({ cmd: 'send', body: 'hello world', to: '@codex', reply_in: 'r1' });
});
it('recent default limit', () => { expect(parseCliArgs(['recent'])).toEqual({ cmd: 'recent', limit: 20 }); });
it('roster', () => { expect(parseCliArgs(['roster'])).toEqual({ cmd: 'roster' }); });
it('bad cmd throws', () => { expect(() => parseCliArgs(['grok'])).toThrow(/usage/i); });
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `pnpm test -- tests/unit/bin/metaide-chat.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `bin/metaide-chat.ts`**

Export `parseCliArgs(argv: string[]): Cmd` where `Cmd` is one of `{cmd:'send', body, to?, reply_in?}` | `{cmd:'recent', limit}` | `{cmd:'roster'}`. Main entry reads the env vars `METAIDE_SOCKET`, `METAIDE_PROJECT_ID`, `METAIDE_SHELL_INDEX`, `METAIDE_AGENT` (the main process exports these into each spawn through `.metaide/env` layering — see Task 2's spawn-env wiring), connects to the socket, sends `{ ipc: 'chat:append', payload: {…} }` and prints the server's `entry.id`.

- [ ] **Step 4: Spawn-env wiring**

In `src/main/ipc/register.ts`'s `projectSpawnEnv` (already used for `.metaide/env`), merge in `METAIDE_SOCKET`, `METAIDE_PROJECT_ID`, `METAIDE_SHELL_INDEX`, `METAIDE_AGENT`, and prepend `out/bin/` to `PATH` so `metaide` is callable from inside a shell. The socket server is started once per main process at `app.whenReady` in `src/main/index.ts` and routes messages to the existing IPC handlers.

- [ ] **Step 5: Run tests, verify they pass**

Run: `pnpm test -- tests/unit/bin/metaide-chat.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add bin/metaide-chat.ts electron.vite.config.ts src/main/ipc/register.ts src/main/index.ts tests/unit/bin/metaide-chat.test.ts
git commit -m "$(cat <<'EOF'
feat(chat): metaide chat companion CLI + per-shell socket env

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Renderer `Agents` pane

**Files:**
- Create: `src/renderer/components/AgentChatTab.tsx`
- Modify: `src/renderer/components/ActivityBar.tsx` (add `'agents'` to `ActivityView`, new rail button)
- Modify: `src/renderer/App.tsx` (render `AgentChatTab` on `activeView === 'agents'`)
- Create: `src/renderer/hooks/useAgentChat.ts`
- Create: `tests/unit/renderer/agent-chat-tab.test.tsx`
- Create: `tests/unit/renderer/activity-bar-agents-entry.test.tsx`

**Interfaces:**
- Consumes: IPC `chat:list`, event `chat:changed`; from Task 7 — RPC-mediated remote roster via `chat.roster`.
- Produces:
  - `useAgentChat(projectId: number): { entries: ChatEntry[]; roster: RosterRow[]; send(body: string, to?: string, replyIn?: string): Promise<void> }`
  - React component `AgentChatTab({ projectId, selfDevice }: { projectId: number; selfDevice: string })`.

- [ ] **Step 1: Write failing tests**

```tsx
// tests/unit/renderer/agent-chat-tab.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AgentChatTab } from '@renderer/components/AgentChatTab';

vi.mock('@renderer/api', () => ({ api: {
  invoke: vi.fn().mockImplementation((ch: string) => {
    if (ch === 'chat:list') return Promise.resolve({ entries: [{ id: 'e1', ts: '2026-11-18T10:00:00Z', from: { device: 'laptop', shell: 1, agent: 'claude', label: 'Claude' }, to: [], body: 'hello' }] });
    return Promise.resolve({});
  }),
  on: vi.fn().mockReturnValue(() => {}),
}}));

it('renders the initial entries', async () => {
  render(<AgentChatTab projectId={1} selfDevice="laptop" />);
  expect(await screen.findByText('hello')).toBeInTheDocument();
});

it('composer sends via chat:append', async () => {
  const { api } = await import('@renderer/api');
  render(<AgentChatTab projectId={1} selfDevice="laptop" />);
  const box = screen.getByRole('textbox');
  fireEvent.change(box, { target: { value: '@codex hi' } });
  fireEvent.keyDown(box, { key: 'Enter' });
  expect(api.invoke).toHaveBeenCalledWith('chat:append', expect.objectContaining({ body: '@codex hi' }));
});
```

```tsx
// tests/unit/renderer/activity-bar-agents-entry.test.tsx
// @vitest-environment jsdom
import { it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ActivityBar } from '@renderer/components/ActivityBar';

it('selecting the Agents icon fires onSelect("agents")', () => {
  const onSelect = vi.fn();
  render(<ActivityBar active="projects" onSelect={onSelect} onToggleSidebar={() => {}} sidebarOpen={true} />);
  fireEvent.click(screen.getByTestId('ab-agents'));
  expect(onSelect).toHaveBeenCalledWith('agents');
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `pnpm test -- tests/unit/renderer/agent-chat-tab.test.tsx tests/unit/renderer/activity-bar-agents-entry.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Extend `ActivityBar.tsx`**

Add `'agents'` to the `ActivityView` union and `MAIN_TABS`-style list. Add a new `<ABButton …>` with `label="Agents"`, `data-testid="ab-agents"` and an `AgentsIcon` (speech-bubble pair; mirror the existing `ChatIcon` style). The existing `'chat'` entry (metaproject) is untouched.

- [ ] **Step 4: Implement `useAgentChat`**

Hook returns `entries`, `roster`, `send`. On mount call `chat:list`; subscribe to `chat:changed` and append matching entries. `send(body, to, replyIn)` calls `chat:append`. `roster` comes from a second effect that calls a new IPC `chat:roster` (add to Task 2's service) and refreshes every 5 s.

- [ ] **Step 5: Implement `AgentChatTab.tsx`**

Two-column layout per the spec's ASCII sketch (left: roster list with online dot + mention; right: threaded stream + composer). Composer is one `<textarea>` with `@`-autocomplete sourced from the roster. `Enter` sends, `Shift+Enter` newlines. Cap-held entries render with a red dot and a "Release" button that calls `chat:release-thread` (new IPC pass-through to `cap.release`).

- [ ] **Step 6: Render in `App.tsx`**

In the render switch for the right pane, add `{activeView === 'agents' && <AgentChatTab projectId={selected?.id ?? 0} selfDevice={selfDeviceName} />}`. `selfDeviceName` reuses the existing `useSelfDeviceName()` hook.

- [ ] **Step 7: Run tests, verify they pass**

Run: `pnpm test -- tests/unit/renderer/agent-chat-tab.test.tsx tests/unit/renderer/activity-bar-agents-entry.test.tsx && pnpm typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/components/AgentChatTab.tsx src/renderer/components/ActivityBar.tsx src/renderer/App.tsx src/renderer/hooks/useAgentChat.ts tests/unit/renderer/agent-chat-tab.test.tsx tests/unit/renderer/activity-bar-agents-entry.test.tsx
git commit -m "$(cat <<'EOF'
feat(chat): Agents pane with roster, thread, composer

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Agent onboarding stanza

**Files:**
- Create: `src/main/chat/onboard.ts`
- Modify: `src/main/index.ts` (call `onFirstChat(projectPath)` once per project)
- Create: `tests/unit/main/chat/onboard.test.ts`

**Interfaces:**
- Consumes: project path, selected CLI label.
- Produces:
  - `ensureAgentStanza(projectPath: string, cli: 'claude' | 'codex' | 'ollama'): { file: string; appended: boolean }` — appends a short stanza explaining the `[metaide-chat ...]` prefix and `metaide chat send` CLI to `CLAUDE.md` / `AGENTS.md` / `.metaide/ollama-system.md` if the file doesn't already contain the marker `# metaide-chat-bus@v1`.

- [ ] **Step 1: Write failing tests**

```ts
// tests/unit/main/chat/onboard.test.ts
import { it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { ensureAgentStanza } from '@main/chat/onboard';

it('creates CLAUDE.md with the stanza and the marker', () => {
  const dir = mkdtempSync(join(tmpdir(), 'onb-'));
  const res = ensureAgentStanza(dir, 'claude');
  expect(res.appended).toBe(true);
  const txt = readFileSync(res.file, 'utf8');
  expect(txt).toContain('# metaide-chat-bus@v1');
  expect(txt).toContain('[metaide-chat');
  expect(txt).toContain('metaide chat send');
});

it('is idempotent — second call does not duplicate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'onb-'));
  ensureAgentStanza(dir, 'claude');
  const res2 = ensureAgentStanza(dir, 'claude');
  expect(res2.appended).toBe(false);
});

it('codex writes to AGENTS.md', () => {
  const dir = mkdtempSync(join(tmpdir(), 'onb-'));
  const res = ensureAgentStanza(dir, 'codex');
  expect(res.file).toBe(join(dir, 'AGENTS.md'));
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `pnpm test -- tests/unit/main/chat/onboard.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/main/chat/onboard.ts`**

Target file per CLI: `CLAUDE.md`, `AGENTS.md`, `.metaide/ollama-system.md`. If the file already contains `# metaide-chat-bus@v1`, return `{ appended: false, file }`. Otherwise append the stanza:

```
# metaide-chat-bus@v1
When you see a line like `[metaide-chat from=@claude@laptop reply=- ] <body>` on your input, it is a message from another agent or a human in this project.
To reply, run `metaide chat send "..." --to @<agent>` (e.g. `metaide chat send "on it" --to @human`). Use `metaide chat roster` to see who is online.
```

Return `{ appended: true, file }`.

- [ ] **Step 4: Wire into `src/main/index.ts`**

When a shell is launched (`PtyManager.spawn` callback that `.metaide/env` is read from — see existing hook in `register.ts`), after the spawn, resolve the CLI label (`claude` / `codex` / `ollama`), call `ensureAgentStanza(project.path, label)`, and if `appended`, log an info line. No user approval prompt — the stanza is a doc fragment inside an agent-conventions file the agent itself owns.

- [ ] **Step 5: Run tests, verify they pass**

Run: `pnpm test -- tests/unit/main/chat/onboard.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Full suite + build check**

Run: `pnpm test && pnpm typecheck`
Expected: all green, zero typecheck errors.

- [ ] **Step 7: Commit**

```bash
git add src/main/chat/onboard.ts src/main/index.ts tests/unit/main/chat/onboard.test.ts
git commit -m "$(cat <<'EOF'
feat(chat): auto-onboard stanza in CLAUDE.md / AGENTS.md / Ollama sys prompt

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Open items the implementer should surface, not decide

- If `pnpm test` reveals the bin-entry Vite config doesn't ship `metaide-chat.js` into `out/`, Task 8 needs an `electron.vite.config.ts` adjustment — call it out in the task's report.
- If `AliveShellSummary` grows an `agent` field as part of this plan (needed by roster but not yet present), extend `src/shared/types.ts` and update the two P2P hub tests that spy on `shells:alive-list`.
