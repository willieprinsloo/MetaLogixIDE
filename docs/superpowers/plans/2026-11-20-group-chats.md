# Group Chats Between Agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Martin start a group chat in a project in which his Claude tab (with its full context) and headless GPT / Gemini / Ollama agents talk to each other in parallel rounds, ending by themselves or on Stop.

**Architecture:** A pure round state machine (`groups.ts`, ported from BotOffice) returns deliveries. A main-process `GroupChatService` turns each delivery into one turn on a member: a `ClaudeTabMember` types it into an idle Claude tab and reads the answer from the Stop hook + transcript; a `HeadlessMember` runs a ported BotOffice engine adapter (Codex / Gemini CLI, Ollama HTTP). Every way a turn can end without a reply answers the round as failed. State persists in SQLite; the renderer gets a new **Group** activity view over typed IPC.

**Tech Stack:** TypeScript, Electron 32 (electron-vite), React 18 + Tailwind, better-sqlite3, vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-19-group-chats-design.md`. BotOffice sources being ported live in `H:\GIT_DIZZY\BotOfice\claude-discord-status\` (paths below are relative to it as `BO/`).

## Global Constraints

- No new runtime dependencies; Node built-ins, `fetch`, `child_process` only.
- Rounds: default 4, clamp 1–10. Caps: 4,000 chars per quoted reply, 16,000 per round message, 200 log entries per group. `PASS_RE = /^\s*pass\s*[.!]?\s*$/i`.
- Member turn fail-safe: 30 minutes (`GROUP_TURN_MS = 30 * 60 * 1000`); this timer only ever ends things.
- Nothing starts a conversation except `groups:say`. A restart never resumes one ("Stopped: the app restarted").
- One group turn per member at a time; a Claude tab shared by two groups gets one queue per shell.
- The app never edits or clears Martin's input in a tab.
- Model output is rendered as text/markdown through the existing `MarkdownPreview`; never `dangerouslySetInnerHTML` with raw model text.
- Headless permissions: Codex `-c sandbox_mode="workspace-write"` (+ `-c windows.sandbox="unelevated"` on win32); Gemini `--approval-mode auto_edit --skip-trust`.
- Tests live under `tests/unit/main/group-chat/` and `tests/unit/renderer/`; run with `pnpm test` (`ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run`). Use `npx pnpm@11` if pnpm isn't on PATH.

## Review Focus

1. **`/clear` or `/resume` in a member tab changes its Claude session id.** Expected: the member shows "its Claude tab isn't open" and fails its round instead of answering from the wrong conversation. Test in Task 8.
2. **A Claude tab that hasn't sent any hook yet** (freshly opened, no prompt) has no known session id. Expected: the picker shows it disabled with "send it a message first". Test in Task 8 (`joinableClaudeTabs`).
3. **Multi-line round message on Windows ConPTY.** Expected: arrives as one prompt (bracketed paste), not one submit per line. Test asserts the exact bytes written in Task 7.
4. **Headless CLI not installed / not signed in when a round starts.** Expected: that member fails its round with the engine's fix-it text; the others carry on. Test in Task 6 and Task 8.
5. **App quit while a round is running.** Expected: headless children are killed, nothing is left running, and the next start shows "Stopped: the app restarted". Test in Task 8 (`dispose`) and Task 2.

---

### Task 1: Round state machine (`groups.ts`)

**Files:**
- Create: `src/main/group-chat/groups.ts`
- Test: `tests/unit/main/group-chat/groups.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type MemberId = string;
  export type LogKind = 'start' | 'you' | 'reply' | 'fail' | 'round' | 'member' | 'end';
  export interface LogEntry { at: string; kind: LogKind; from?: MemberId; text: string; round?: number }
  export interface Answer { text?: string; pass?: boolean; failed?: string }
  export interface Group {
    id: string; projectId: number; projectName: string; name: string; members: MemberId[];
    maxRounds: number; status: 'idle' | 'running' | 'stopped';
    round: { n: number; waiting: MemberId[]; answers: Record<MemberId, Answer> } | null;
    k: number; seq: number; held: string[]; joined: MemberId[]; log: LogEntry[];
    createdAt: string; updatedAt: string;
  }
  export interface Delivery { member: MemberId; round: number; text: string }
  export interface GroupsOptions { now?: () => number; list?: Group[]; nameOf?: (m: MemberId) => string; isChatOnly?: (m: MemberId) => boolean; userName?: () => string }
  export function createGroups(o?: GroupsOptions): {
    create(p: { projectId: number; projectName: string; members?: MemberId[]; name?: string }): Group;
    get(id: string): Group | null; view(): Group[];
    rename(id: string, name: string): Group | null; setMaxRounds(id: string, n: number): Group | null;
    addMember(id: string, m: MemberId): Delivery[]; removeMember(id: string, m: MemberId): Delivery[];
    say(id: string, text: string): Delivery[];
    answer(id: string, m: MemberId, round: number, r: { text: string } | { failed: string }): Delivery[];
    stop(id: string, who?: string): { stoppedMembers: MemberId[] };
    remove(id: string): boolean;
    waitingOn(m: MemberId): Array<{ id: string; round: number }>;
  };
  export const DEFAULT_ROUNDS = 4, MIN_ROUNDS = 1, MAX_ROUNDS = 10;
  export const PASS_RE: RegExp;
  ```

- [ ] **Step 1: Port the tests.** Translate every `test(...)` in `BO/shared/dashboard/test/groups.test.js` (177 lines, `node:test` + `assert`) to vitest `it(...)` in `groups.test.ts`, keeping names and assertions. Rename `bot` → `member`, `project` (path string) → `projectId` + `projectName`. Add:
  ```ts
  it('labels the user with userName()', () => {
    const g = createGroups({ userName: () => 'Martin' });
    const grp = g.create({ projectId: 1, projectName: 'demo', members: ['a', 'b'] });
    const d = g.say(grp.id, 'hello');
    expect(d[0]!.text).toContain('\nMartin: hello\n');
  });
  it('a list loaded with a running group comes back stopped', () => {
    const g0 = createGroups(); const grp = g0.create({ projectId: 1, projectName: 'p', members: ['a', 'b'] }); g0.say(grp.id, 'x');
    const g1 = createGroups({ list: g0.view() });
    expect(g1.get(grp.id)!.status).toBe('stopped');
    expect(g1.get(grp.id)!.log.at(-1)!.text).toBe('Stopped: the app restarted');
  });
  ```
- [ ] **Step 2: Run, expect fail** — `pnpm test tests/unit/main/group-chat/groups.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement `groups.ts`** as a line-for-line port of `BO/shared/dashboard/groups.js` with the renames above. Differences: `crypto.randomUUID()` from `node:crypto`; the round header says `in ${projectName}`; every `Martin:` label becomes `${userName()}:` (default `'You'`); the restart text is `Stopped: the app restarted`; `stop` default `who` is `userName()`.
- [ ] **Step 4: Run, expect pass** — same command → PASS.
- [ ] **Step 5: Commit** — `git add src/main/group-chat/groups.ts tests/unit/main/group-chat/groups.test.ts && git commit -m "feat(group-chat): round state machine ported from BotOffice"`

### Task 2: Persistence (`0005_group_chats.sql` + `GroupsRepo`)

**Files:**
- Create: `migrations/0005_group_chats.sql`, `src/main/repos/groups-repo.ts`
- Test: `tests/unit/main/repos/groups-repo.test.ts`

**Interfaces:**
- Consumes: `Group` (Task 1).
- Produces:
  ```ts
  export type MemberRecord =
    | { id: string; kind: 'claude-tab'; projectId: number; claudeSessionId: string; title: string }
    | { id: string; kind: 'headless'; engine: 'codex' | 'gemini' | 'ollama'; name: string; model: string | null;
        engineSession: string | null; history: Array<{ role: 'user' | 'assistant'; content: string }> };
  export interface StoredGroup { group: Group; members: Record<string, MemberRecord> }
  export class GroupsRepo {
    constructor(db: Database);
    loadAll(): StoredGroup[];          // newest first
    save(s: StoredGroup): void;        // upsert
    remove(id: string): void;
  }
  ```

Schema (one row per group; the whole group + member records as JSON, since the state machine owns the shape):
```sql
-- Group chats between agents (docs/superpowers/specs/2026-11-19-group-chats-design.md).
CREATE TABLE group_chats (
  id          TEXT PRIMARY KEY,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  state_json  TEXT NOT NULL,
  updated_at  DATETIME NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_group_chats_project ON group_chats(project_id);
```

- [ ] **Step 1: Write failing tests** (use the `fresh()` pattern from `tests/unit/main/repos/projects-repo.test.ts`, creating a project first for the FK):
  - `it('round-trips a group with its members')` — save then `loadAll()` deep-equals.
  - `it('removes a group')`.
  - `it('drops a row whose state_json is not valid JSON instead of throwing')` — insert a bad row with raw SQL, `loadAll()` returns `[]`.
  - `it('deleting the project deletes its groups')`.
- [ ] **Step 2: Run, expect fail.**
- [ ] **Step 3: Implement** the migration and `GroupsRepo` following `PromptsRepo` (prepared statements, `ON CONFLICT(id) DO UPDATE`).
- [ ] **Step 4: Run, expect pass.** Also run `pnpm test tests/unit/main/db` to confirm migrations still apply.
- [ ] **Step 5: Commit** — `feat(group-chat): persist group chats in SQLite`.

### Task 3: Hook payload carries Claude's session id and transcript path

**Files:**
- Modify: `src/main/claude-hooks/hook-event.ts` (`HookEvent`, `parseHookEvent`)
- Test: `tests/unit/main/claude-hooks/hook-event.test.ts`

**Interfaces:**
- Produces: `HookEvent` gains `claudeSessionId: string | null` and `transcriptPath: string | null`; plus
  `export function isClaudeTranscriptPath(p: string, homeDir: string): boolean` — true only for an absolute path ending in `.jsonl` that resolves inside `join(homeDir, '.claude', 'projects')`.

- [ ] **Step 1: Failing tests:**
  - `parseHookEvent({ hook_event_name: 'Stop', session_id: 'abc', transcript_path: '/h/.claude/projects/x/abc.jsonl' })` → `claudeSessionId === 'abc'`, `transcriptPath` set.
  - Non-string `session_id` / `transcript_path` → fields are `null` and the event is still returned (they are optional; existing rejection rules unchanged).
  - `isClaudeTranscriptPath('/h/.claude/projects/x/a.jsonl', '/h')` true; `'/h/.claude/projects/../secrets.jsonl'` false; `'/h/.claude/projects/x/a.txt'` false; relative path false. Use `path.join` so the test passes on win32.
  - Existing tests in the file still pass unchanged.
- [ ] **Step 2: Run, expect fail.**
- [ ] **Step 3: Implement.** Update the file's doc comment: these two fields are kept for group chats; nothing else is read.
- [ ] **Step 4: Run, expect pass** — `pnpm test tests/unit/main/claude-hooks`.
- [ ] **Step 5: Commit** — `feat(claude-hooks): keep session_id and transcript_path for group chats`.

### Task 4: Reading the group answer from a Claude transcript

**Files:**
- Create: `src/main/group-chat/transcript.ts`
- Test: `tests/unit/main/group-chat/transcript.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type TranscriptAnswer = { status: 'answered'; text: string } | { status: 'not-yet' };
  /** `jsonl` is the transcript text; `header` is the round message's first line. */
  export function findGroupAnswer(jsonl: string, header: string): TranscriptAnswer;
  export async function readGroupAnswer(path: string, header: string): Promise<TranscriptAnswer>; // fs/promises readFile + findGroupAnswer
  ```

Rules: parse line by line, skipping unparseable lines (a half-written last line is normal). A user message is a line with `type: 'user'` whose `message.content` is a string or an array of `{type:'text', text}` parts; ignore user lines that are only `tool_result`. Find the **last** user message whose text starts with `header`. Answer = concatenated `text` parts of `type: 'assistant'` lines after it, up to the next real user message, joined with `\n\n`. No such user message → `not-yet`. Found but no assistant text yet → `not-yet`.

- [ ] **Step 1: Failing tests** with small inline JSONL fixtures:
  - `answers with the assistant text after our message`.
  - `stops at Martin's own next prompt` — our msg, assistant "A", user "my own question", assistant "B" → `'A'`.
  - `tool_result user lines do not end the answer` — assistant "A", user tool_result, assistant "B" → `'A\n\nB'`.
  - `not-yet when our message is not in the transcript`.
  - `uses the latest occurrence of the header` (two rounds with the same header).
  - `skips a truncated last line`.
- [ ] **Step 2: Run, expect fail.**  **Step 3: Implement.**  **Step 4: Run, expect pass.**
- [ ] **Step 5: Commit** — `feat(group-chat): read a Claude tab's group answer from its transcript`.

### Task 5: Detect a draft in Claude's input box

**Files:**
- Modify: `src/main/agent-status/claude-screen.ts`
- Test: `tests/unit/main/agent-status/claude-screen.test.ts` (create if absent; else extend)

**Interfaces:**
- Produces: `export function claudeInputHasDraft(rows: readonly string[]): boolean` — finds the last prompt row (`/^\s*[│ ]?\s*[❯>]\s?(.*)$/`, inside the input box) and returns true when the text after the prompt marker, trimmed, is non-empty and is not the placeholder `Try "…"` hint. Unknown screen → `false`.

- [ ] **Step 1: Failing tests** using screen rows copied as literals: empty box `'│ > │'` → false; `'│ > fix the tests │'` → true; placeholder `'│ > Try "refactor foo.ts" │'` → false; no prompt row → false.
- [ ] **Step 2–4:** fail → implement → pass (`pnpm test tests/unit/main/agent-status`).
- [ ] **Step 5: Commit** — `feat(agent-status): detect a half-typed draft in Claude's input`.

### Task 6: Headless engine adapters (ported)

**Files:**
- Create: `src/main/group-chat/engines/cli.ts`, `codex.ts`, `gemini.ts`, `ollama.ts`, `status.ts`, `run-cli.ts`
- Test: `tests/unit/main/group-chat/engines/{cli,codex,gemini,ollama,status,run-cli}.test.ts`, fakes `tests/unit/main/group-chat/engines/fake-codex.mjs`, `fake-gemini.mjs`

**Interfaces:**
- Produces:
  ```ts
  export interface TurnItem { text: string; model?: string | null; engineSession?: string | null; history?: Array<{ role: 'user' | 'assistant'; content: string }> }
  export interface TurnResult { ok: boolean; reply: string; error?: string; engineSession?: string }
  // cli.ts
  export function npmCli(pkg: string, bin: string, o?: { platform?: NodeJS.Platform; npmDir?: string }): string[];
  // codex.ts / gemini.ts — ports of BO/windows/engines/codex.js, gemini.js (drop the MCP bridge option)
  export function codexArgs(item: TurnItem, o?: { platform?: NodeJS.Platform }): string[];
  export function codexProgress(): Progress; export function parseCodex(p: Progress, code: number | null): TurnResult;
  export function geminiArgs(item: TurnItem): string[];
  export function geminiProgress(): Progress; export function parseGemini(p: Progress, code: number | null): TurnResult;
  // ollama.ts
  export const OLLAMA_BASE = 'http://127.0.0.1:11434';
  export function runOllama(item: TurnItem & { model: string }, o: { base?: string; signal?: AbortSignal; fetch?: typeof fetch }): Promise<TurnResult>;
  // status.ts — EngineStatus is declared in src/shared/group-chat.ts (create the file here; Task 8 adds GroupView to it)
  export type EngineStatus = { ready: true; version?: string; models?: string[] } | { ready: false; why: string };
  export function detectEngines(o: { ollamaBase: string; codex: string[]; gemini: string[]; fetch: typeof fetch; version: (cmd: string[], args: string[]) => Promise<string> }): Promise<{ codex: EngineStatus; gemini: EngineStatus; ollama: EngineStatus }>;
  // run-cli.ts — spawns one CLI turn (no shell), message on stdin, feeds stdout lines to progress
  export function runCliTurn(o: { cmd: string[]; args: string[]; cwd: string; text: string; progress: Progress; parse: (p: Progress, code: number | null) => TurnResult; signal: AbortSignal }): Promise<TurnResult>;
  ```
  `Progress` is `{ feed(line: string): boolean }` plus the fields each adapter reads; type it per adapter.

- [ ] **Step 1: Port tests.** Translate `BO/windows/test/engine-cli.test.js`, `engine-codex.test.js`, `engine-gemini.test.js`, `engine-ollama.test.js`, `engine-status.test.js` and the fakes to vitest, dropping MCP-bridge cases. Add for `runCliTurn` (using `process.execPath` + the fake scripts as `cmd`):
  - `returns the fake codex reply and thread id` → `{ ok: true, reply: …, engineSession: … }`.
  - `a missing executable resolves to ok:false with an error, never throws`.
  - `abort kills the child and resolves ok:false 'stopped'`.
- [ ] **Step 2: Run, expect fail.**
- [ ] **Step 3: Implement** as typed ports. `runCliTurn` uses `spawn(cmd[0], [...cmd.slice(1), ...args], { cwd, windowsHide: true, stdio: ['pipe','pipe','pipe'] })`, writes `text` with `stdin.end(text)`, splits stdout on `\n`, keeps the last 2 KB of stderr for the error when `parse` reports no answer, and on `signal` abort calls `child.kill()`.
- [ ] **Step 4: Run, expect pass** — `pnpm test tests/unit/main/group-chat/engines`.
- [ ] **Step 5: Commit** — `feat(group-chat): Codex, Gemini and Ollama adapters ported from BotOffice`.

### Task 7: Member turn drivers

**Files:**
- Create: `src/main/group-chat/members.ts`
- Test: `tests/unit/main/group-chat/members.test.ts`

**Interfaces:**
- Consumes: `findGroupAnswer`/`readGroupAnswer` (Task 4), `claudeInputHasDraft` (Task 5), engine functions (Task 6), `AgentState` from `@shared/agent-state`.
- Produces:
  ```ts
  export type TurnOutcome = { text: string } | { failed: string };
  export type TurnPhase = 'queued' | 'waiting-idle' | 'waiting-draft' | 'running';
  export interface MemberTurn { start(text: string): void; stop(reason: string): void; phase(): TurnPhase; done: Promise<TurnOutcome> }

  export interface ClaudeTabPorts {
    shell: () => { projectId: number; shellIndex: number } | null;   // current tab for this member's session, or null
    state: (shell: { projectId: number; shellIndex: number }) => AgentState | null;
    screenRows: (shell: { projectId: number; shellIndex: number }) => Promise<string[]>;
    lastUserInputAt: (shell: { projectId: number; shellIndex: number }) => number;
    write: (shell: { projectId: number; shellIndex: number }, data: string) => void;
    onStop: (cb: (transcriptPath: string) => void) => () => void;    // Stop hooks from this member's Claude session only
    readAnswer: (path: string, header: string) => Promise<TranscriptAnswer>;
    now: () => number; setTimer: (fn: () => void, ms: number) => () => void;
  }
  export function claudeTabTurn(ports: ClaudeTabPorts, o?: { quietMs?: number; pollMs?: number }): MemberTurn;

  export interface HeadlessPorts {
    run: (item: TurnItem, signal: AbortSignal) => Promise<TurnResult>;  // chosen engine, bound to the project cwd
  }
  export function headlessTurn(ports: HeadlessPorts, item: Omit<TurnItem, 'text'>): MemberTurn & { result(): TurnResult | null };
  export const QUIET_MS = 3000; export const POLL_MS = 500;
  export const BRACKETED = (text: string) => `\x1b[200~${text}\x1b[201~`;
  ```

Claude tab algorithm: on `start`, poll every `pollMs`: no `shell()` → resolve `{ failed: "its Claude tab isn't open" }`; state not `idle` → phase `waiting-idle`; `now() - lastUserInputAt < quietMs` → wait; `claudeInputHasDraft(rows)` → phase `waiting-draft`; else `write(shell, BRACKETED(text))`, then `write(shell, '\r')`, phase `running`. While running, on each `onStop(path)`: `readAnswer(path, firstLine(text))` → `answered` resolves `{ text }`; `not-yet` keeps waiting. `stop(reason)`: if phase `running` and the shell still exists, `write(shell, '\x1b')`; resolve `{ failed: reason }`. A tab that disappears while running resolves `{ failed: 'its Claude tab was closed' }`.

- [ ] **Step 1: Failing tests** (fake ports, fake timers):
  - `waits while busy, then pastes once idle and quiet` — asserts writes are exactly `['\x1b[200~line1\nline2\x1b[201~', '\r']`.
  - `waits while a draft is in the input box and reports waiting-draft`.
  - `answers from the transcript on the next Stop`.
  - `a Stop whose transcript does not contain our message is ignored`.
  - `stop while running sends Escape and fails with the reason`; `stop while waiting sends nothing`.
  - `fails when the tab is not open`.
  - headless: `resolves the reply and exposes engineSession via result()`; `stop aborts the run and fails`; `an engine error fails with its message`.
- [ ] **Step 2–4:** fail → implement → pass.
- [ ] **Step 5: Commit** — `feat(group-chat): Claude-tab and headless member turns`.

### Task 8: `GroupChatService`

**Files:**
- Create: `src/main/group-chat/service.ts`
- Test: `tests/unit/main/group-chat/service.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 2, 7.
- Produces:
  ```ts
  export interface GroupView extends Group { members: MemberId[]; memberInfo: Record<MemberId, { name: string; kind: 'claude-tab' | 'headless'; engine: 'claude' | 'codex' | 'gemini' | 'ollama'; available: boolean; phase: TurnPhase | null }> }
  export interface GroupChatDeps {
    repo: GroupsRepo; userName: () => string; projectName: (projectId: number) => string; projectPath: (projectId: number) => string;
    claudePorts: (member: MemberRecord & { kind: 'claude-tab' }) => ClaudeTabPorts;
    runHeadless: (member: MemberRecord & { kind: 'headless' }, cwd: string, item: TurnItem, signal: AbortSignal) => Promise<TurnResult>;
    claudeSessionOf: (shell: ShellKey) => string | null;  // latest Claude session id seen in this shell's hooks
    liveClaudeShells: (projectId: number) => Array<ShellKey & { title: string }>;
    onChange: (projectId: number) => void; turnMs?: number; setTimer?: (fn: () => void, ms: number) => () => void;
  }
  export class GroupChatService {
    constructor(deps: GroupChatDeps);                     // loads repo; running groups become stopped (Task 1) and are saved
    list(projectId: number): GroupView[];
    create(projectId: number, o: { name?: string; claudeShell?: ShellKey }): GroupView;
    update(id: string, o: { name?: string; maxRounds?: number }): GroupView;
    addClaudeTab(id: string, shell: ShellKey): GroupView;    // throws "send it a message first" when claudeSessionOf(shell) is null
    addHeadless(id: string, o: { engine: 'codex' | 'gemini' | 'ollama'; name: string; model?: string | null }): GroupView;
    removeMember(id: string, member: MemberId): GroupView;
    say(id: string, text: string): GroupView;
    stop(id: string): GroupView;
    remove(id: string): void;                               // throws while running
    joinableClaudeTabs(projectId: number): Array<ShellKey & { title: string; joinable: boolean; why?: string }>;
    protectedShells(): ShellKey[];                          // Claude-tab shells of members of running groups
    shellGone(shell: ShellKey): void;                       // tab exited/evicted/closed → its running turn fails
    dispose(): void;                                        // app quit: stop every running group, kill turns, save
  }
  ```

`GroupView` is added to `src/shared/group-chat.ts` (next to `EngineStatus` from Task 6) so Task 10/11 share them. The service builds `createGroups` with `nameOf = member display name` ("Main (Claude)", "Reviewer (GPT)"), `isChatOnly = engine === 'ollama'`, and `userName` from deps.

Behaviour: one FIFO queue per **delivery target** (Claude tab: `claude:<claudeSessionId>`; headless: member id). Every `Delivery[]` from `groups` goes to `enqueue`; a queue starts its next turn only when its current one has settled. Each turn's `done` → `groups.answer(...)` → enqueue the returned deliveries → save → `onChange`. A turn gets a `turnMs` (default 30 min) timer → `turn.stop('no answer in 30 minutes')`. Headless replies append `{user: text}` / `{assistant: reply}` to the member's `history` (Ollama only; keep the last 40 entries) and store `engineSession` from the result. `stop`/`removeMember`/`remove`/`dispose` stop that group's running turns and drop its queued ones, each **answering its round as failed** through one helper `failTurn(groupId, member, round, reason)`. Headless members can't be shared: removing one deletes its record.

- [ ] **Step 1: Failing tests** with fake deps (fake repo in memory, fake member turns that resolve on demand):
  - `say starts round 1 for every member and round 2 carries the others' answers`.
  - `a member turn failing answers its round and the round completes`.
  - `stop fails running turns, drops queued ones, and nothing starts afterwards`.
  - `two groups sharing one Claude tab run its turns one at a time`.
  - `the 30-minute fail-safe fails a silent member and stops its turn`.
  - `shellGone fails the running Claude turn with 'its Claude tab was closed'`.
  - `addClaudeTab refuses a tab with no Claude session yet` (Review Focus 2) and `joinableClaudeTabs marks it not joinable with 'send it a message first'`.
  - `a member whose session moved (after /clear) is unavailable and fails its round` (Review Focus 1).
  - `a headless engine failure fails only that member` (Review Focus 4).
  - `protectedShells lists member tabs only while the group is running`.
  - `dispose stops running groups and the reloaded service shows them stopped` (Review Focus 5).
- [ ] **Step 2–4:** fail → implement → pass.
- [ ] **Step 5: Commit** — `feat(group-chat): service that queues member turns and drives rounds`.

### Task 9: Protect group members from keep-alive eviction

**Files:**
- Modify: `src/main/pty/keep-alive.ts`, `src/main/ipc/register.ts` (the four `chooseEvictee(alive, cap, projectId, new Date())` call sites at ~438, ~514, ~570, ~1375)
- Test: `tests/unit/main/pty/keep-alive.test.ts`

**Interfaces:**
- Produces: `chooseEvictee(shells, cap, justSpawnedProjectId, now, isProtected?: (s: { projectId: number; shellIndex: number }) => boolean)`; protected shells are filtered out like pinned ones. Existing `'all-pinned'` reason covers "every candidate is protected".

- [ ] **Step 1: Failing tests:** `skips a protected shell and evicts the next oldest`; `returns all-pinned when only protected shells are candidates`; existing tests unchanged.
- [ ] **Step 2–4:** fail → implement → pass. At each call site pass `(sh) => s.groupChat?.protectedShells().some(p => p.projectId === sh.projectId && p.shellIndex === sh.shellIndex) ?? false`. Where an evicted shell is killed, also call `s.groupChat?.shellGone(evictee)`.
- [ ] **Step 5: Commit** — `feat(keep-alive): never evict a Claude tab in a running group chat`.

### Task 10: IPC, services and startup wiring

**Files:**
- Modify: `src/shared/ipc-contract.ts`, `src/main/ipc/register.ts`, `src/main/services.ts`, `src/main/index.ts`, `src/main/pty/manager.ts`
- Create: `src/main/group-chat/install.ts`
- Test: `tests/unit/main/group-chat/install.test.ts`, extend `tests/unit/main/pty/manager.test.ts`

**Interfaces:**
- Consumes: `GroupChatService` (Task 8), engines (Task 6), `ReceivedHook` (`src/main/claude-hooks/receiver.ts`), `HookSource` (`hook-fanout.ts`), `AgentStatusTracker.list()`, `PtyManager` events `'exit'` / `'input'` and `liveStatus()`.
- Produces:
  - `Services.groupChat: GroupChatService | null` (set by `installGroupChat`, like `agentStatus`).
  - `PtyManager.lastInputAt(projectId, shellIndex): number` — time of the last `write()` that did **not** come from the group service. Implement by tracking every `write()` and exposing `writeFromApp(projectId, shellIndex, data)` that writes without updating `lastInputAt`. Test: `writeFromApp does not move lastInputAt; write does`.
  - `installGroupChat(o: { services: Services; hooks: HookSource; broadcast: (ch: string, p: unknown) => void }): { service: GroupChatService; stop(): void }` — builds each member's `ClaudeTabPorts` (`write` → `ptyManager.writeFromApp`, `lastUserInputAt` → `ptyManager.lastInputAt`, `state` → `agentStatus.list()` entry, `screenRows` → `ptyManager.liveStatus().rows`), the session map (`shellKey → claudeSessionId`, updated from every hook with a non-null `claudeSessionId`), the `onStop` fan-out (Stop hooks whose `transcriptPath` passes `isClaudeTranscriptPath(path, services.homeDir)`), the headless runner (Codex/Gemini via `runCliTurn` with `npmCli('@openai/codex','codex')` / `npmCli('@google/gemini-cli','gemini')`, Ollama via `runOllama`), `userName` (MetaProject display name if signed in, else `'You'`), wires PTY `'exit'` → `service.shellGone`, and broadcasts `groups:changed` `{ projectId }` on change.
  - IPC channels (request → response):
    ```ts
    'groups:list':         { projectId: number } → { groups: GroupView[] }
    'groups:create':       { projectId: number; name?: string; claudeShell?: { projectId: number; shellIndex: number } } → { group: GroupView }
    'groups:update':       { id: string; name?: string; maxRounds?: number } → { group: GroupView }
    'groups:add-claude':   { id: string; shell: { projectId: number; shellIndex: number } } → { group: GroupView }
    'groups:add-headless': { id: string; engine: 'codex' | 'gemini' | 'ollama'; name: string; model?: string | null } → { group: GroupView }
    'groups:remove-member':{ id: string; member: string } → { group: GroupView }
    'groups:say':          { id: string; text: string } → { group: GroupView }
    'groups:stop':         { id: string } → { group: GroupView }
    'groups:delete':       { id: string } → { ok: true }
    'groups:joinable':     { projectId: number } → { tabs: Array<{ projectId: number; shellIndex: number; title: string; joinable: boolean; why?: string }> }
    'groups:engines':      {} → { codex: EngineStatus; gemini: EngineStatus; ollama: EngineStatus }
    // event
    'groups:changed': { projectId: number }
    ```
    `GroupView`/`EngineStatus` come from `src/shared/group-chat.ts` (Task 8).
- [ ] **Step 1: Failing tests** for `installGroupChat` with fake services/hooks: `a Stop hook with a bad transcript path is ignored`; `hooks update the shell's Claude session id`; `PTY exit calls shellGone`; `changes broadcast groups:changed with the project id`. Handlers: add one test per handler in the existing IPC test style (`tests/unit/main/ipc/`) for `groups:say` refusing empty text and `groups:delete` refusing a running group.
- [ ] **Step 2–4:** fail → implement → pass. In `index.ts`, call `installGroupChat` after `attachAgentStatus(services)` using `createHookFanout(services.hookReceiver)` (add a listener, do not replace existing ones), and call its `stop()` (→ `service.dispose()`) in `stopOnQuit`'s `before-quit`.
- [ ] **Step 5:** `pnpm typecheck` passes; `pnpm test` passes.
- [ ] **Step 6: Commit** — `feat(group-chat): IPC, services and startup wiring`.

### Task 11: The Group panel (renderer)

**Files:**
- Modify: `src/renderer/components/ActivityBar.tsx` (`ActivityView` gains `'group'`, a Group icon button), `src/renderer/App.tsx` (persisted-state guard at ~180 accepts `'group'`; render the panel like the `'chat'` block at ~805 with its own resizable width, default 400, min 300, max 640)
- Create: `src/renderer/group-chat/group-view.ts` (pure), `src/renderer/components/GroupChatPanel.tsx`
- Test: `tests/unit/renderer/group-view.test.ts`, `tests/unit/renderer/group-chat-panel.test.tsx`

**Interfaces:**
- Consumes: IPC from Task 10, `GroupView` from `@shared/group-chat`, `MarkdownPreview`.
- Produces (`group-view.ts`, port of `BO/shared/dashboard/public/group-view.js` minus folder matching):
  ```ts
  export function statusLine(g: GroupView): string;   // "Round 2 of 4 · waiting for A and B" | last end text | "Ready"
                                                        // a waiting Claude member in phase 'waiting-draft' reads "waiting for you to send or clear your draft in <name>"
  export function lines(g: GroupView): Array<{ kind: 'you' | 'reply' | 'fail' | 'round' | 'note'; from?: string; text: string; at: string; round?: number }>;
  export const ENGINE_LABEL: Record<'claude' | 'codex' | 'gemini' | 'ollama', string>; // Claude, GPT, Gemini, Ollama
  ```

Panel (matches the spec §7.7 sketch): header with group picker + **+ New** (seeds the focused Claude tab via `claudeShell`); member chips (engine badge, name, ✕; unavailable members greyed with a tooltip); **+ Add** menu listing `groups:joinable` tabs (disabled with `why`) and "New GPT / Gemini / Ollama agent…" (name + model fields; Ollama model is a select of `groups:engines().ollama.models`; engines not ready are disabled with `why`); status line with **■ Stop** while running; rounds input (1–10); transcript with round dividers, engine-coloured replies via `MarkdownPreview`, failures in the error colour; "Message everyone…" textarea, Enter sends, Shift+Enter newline. Refetch `groups:list` on `groups:changed` for the open project. Scroll stays pinned to the newest message unless the user scrolled up.

- [ ] **Step 1: Failing tests:** `group-view.test.ts` — port `BO/shared/dashboard/test/group-view.test.js` cases for `statusLine`/`lines`, plus `waiting-draft phase reads "waiting for you to send or clear your draft in Main (Claude)"`. `group-chat-panel.test.tsx` (pattern from `tests/unit/renderer/git-panel.test.tsx`, mocked `window.api`): `sends the typed message with groups:say`; `shows Stop only while running and calls groups:stop`; `renders model output as text, not HTML` (a reply `'<img src=x onerror=alert(1)>'` produces no `img` element).
- [ ] **Step 2–4:** fail → implement → pass.
- [ ] **Step 5:** `pnpm typecheck` and `pnpm lint` pass.
- [ ] **Step 6: Commit** — `feat(group-chat): the Group panel`.

### Task 12: End-to-end check in the running app and docs

**Files:**
- Modify: `docs/architecture.md` (new "Group chats" section: module map — `groups.ts`, `service.ts`, `members.ts`, `transcript.ts`, `engines/`, `install.ts`, `GroupChatPanel.tsx` — and the every-cancellation-answers-the-round rule)

- [ ] **Step 1:** `pnpm test` (all green) and `pnpm typecheck`.
- [ ] **Step 2:** Launch with `npx electron-vite dev` (see the session's run notes: unset `NoDefaultCurrentDirectoryInExePath`; node-pty uses its prebuilt binary). Open a project, start a Claude tab, send it one message, open **Group**, **+ New**, add an Ollama agent (if Ollama runs) or a GPT agent, send "Say hello to each other in one line, then PASS." Expected: round 1 typed into the Claude tab once it is idle, both answers appear, round 2 runs, the group ends with "Ended: everyone had nothing to add" or after 4 rounds. Press Stop mid-round once: the Claude tab gets Escape and the status shows "Stopped by …".
- [ ] **Step 3:** Write the architecture section.
- [ ] **Step 4: Commit** — `docs: group chats in architecture.md`.
