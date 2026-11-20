# Group chats between agents — design

**Status:** Draft for approval
**Date:** 2026-11-19
**Owner:** Martin
**Source feature:** BotOffice group chats — `H:\GIT_DIZZY\BotOfice\docs\superpowers\specs\2026-11-18-group-chats-design.md`,
pure module `claude-discord-status/shared/dashboard/groups.js`, wiring in `shared/dashboard/server.js`
(`queueGroup`, `cancelMsg`, `stopGroup`, `relayAck`), engines in `claude-discord-status/windows/engines/`.

---

## 1. Intent

Martin works with a main Claude agent in a project's terminal tab. He wants to start a **group chat** from it, add
agents running other LLMs (GPT through Codex, Gemini, a local Ollama model), and have them **talk to each other and
to him in one conversation**: he writes once, everyone answers, they hear each other's answers and keep going on their
own, and he sees every message. BotOffice already has this feature and it works; this brings it into metaIDE.

The main Claude must take part **with its full context**: the group's message is the next turn of the conversation
Martin is already having with it, not a fresh Claude.

It must only run because Martin started it, it must end by itself, and he must be able to stop it at any moment.

## 2. Goals

- A project can have group chats (several per project). Each has members chosen from that project's agents.
- Members can be:
  - **Claude tabs**: a running interactive `claude` shell in that project (the main agent, with its context).
  - **Headless agents**: Codex (GPT), Gemini or Ollama agents created for the group in the group panel. Each keeps
    its own ongoing conversation across rounds and across messages.
- Martin adds and removes members at any time.
- Martin's message goes to every member at once (**round 1**). When every member has answered, each member gets the
  others' answers (**round 2**), and so on: a conversation in parallel rounds.
- It ends by itself after **N rounds per message from Martin** (default 4, settable 1–10 per group), when every member
  answers `PASS` in the same round, or when fewer than two members are left.
- **Stop** ends it at once.
- Martin can write mid-conversation: his message joins the next round and the round count restarts.
- Martin sees everything in the group panel, in order: his messages, every reply, round markers, who is still
  answering, failures, and why it ended.

## 3. Non-goals

- Members asking each other directly (BotOffice's `ask_agent` bridge). The rounds are the group's way of talking.
- Groups across projects, or with agents on another machine (P2P remote shells).
- Turn-taking (one member at a time). Parallel rounds were chosen in BotOffice and carry over.
- Locking files between members. Members share the project folder; the round message tells them so.
- Other CLIs from the profile list (Amp, Qwen, Aider, Cursor Agent, Cody, sgpt, Pi) and oh-my-pi tabs as members in
  v1. The member model must allow adding engines later (see §7.3).
- Driving Codex or Gemini **tabs** as members. Their interactive sessions have the same stale-history problem as
  Claude (§5) and no reliable reply signal; GPT and Gemini join as headless agents instead.

## 4. Anti-goals (a failure even if it "works")

- A conversation that keeps running or restarts unattended: overnight, after an app restart, after a failure.
- A round that never finishes because one member failed, hung, closed, or was cancelled.
- A group message typed into a Claude tab while Claude is busy or waiting on Martin, or over something Martin is
  typing.
- A Claude tab's reply to Martin's *own* prompt being taken as its group answer, or the other way round.
- A group from one project showing in another project.

## 5. Approaches considered

BotOffice runs **every** chat headless, Claude included: each message is one `claude -p --output-format stream-json
--resume <session>` run, so Claude keeps its context because the group message is simply the next turn of the same
saved session, and the reply comes from the stream-json result.

metaIDE is different: a Claude tab is a live interactive `claude` process that holds the conversation in memory.
A headless `claude -p --resume <tab's session>` would add turns the live process never sees, and the tab could
continue from stale history.

1. **Everyone joins as a terminal tab.** Type each round into each member's tab and read replies back. Reliable for
   Claude (Stop hook + transcript). Codex/Gemini replies would come from per-CLI session-log readers that break on
   format changes; Ollama only by screen-scraping. Rejected: fragile.
2. **Everyone headless, like BotOffice.** Port the engine adapters for all members. Reliable for every LLM, but the
   Claude in the group would be a separate conversation from Martin's Claude tab (or would fight the live process
   over one session). Rejected: loses the main agent's context, which is the point.
3. **Mixed — chosen.** Claude tabs join directly: the round message is typed into the tab when it is idle, and the
   reply comes from the Stop hook the app already receives plus Claude's transcript file. GPT, Gemini and Ollama join
   as headless members through the ported BotOffice adapters. Two delivery paths, but each LLM uses its most reliable
   channel, and the main Claude keeps its context. Confirmed by the BotOffice author's review.

## 6. Decided

- Group chats belong to a project; members are picked from that project; add and remove at any time.
- Parallel rounds, flowing like a conversation; Martin sees every message.
- Only Martin starts a conversation; it ends by itself; he can stop it at any time.
- Approach 3: Claude tabs typed into + Stop hook/transcript; Codex, Gemini, Ollama headless.
- Claude tabs in a running group are protected from keep-alive eviction (§7.5).
- Kept from BotOffice: the round logic as-is; **every cancellation answers the round**; one turn per member at a
  time; rounds driven only by Martin's message; Stop; the 30-minute fail-safe; a restart never resumes.

## 7. Design

### 7.1 Round logic (pure module)

Port `groups.js` to TypeScript as `src/main/group-chat/groups.ts`, behaviour unchanged, with its tests ported from
`groups.test.js` (vitest). It has no I/O; every mutating call returns deliveries `[{ member, round, text }]`.

- Model: `group = { id, projectId, name, members, maxRounds, status: 'idle'|'running'|'stopped', round: { n,
  waiting, answers } | null, k, seq, held, joined, log, createdAt, updatedAt }`;
  `entry = { at, kind: 'start'|'you'|'reply'|'fail'|'round'|'member'|'end', from?, text, round? }`.
- `say` (Martin) is the only call that starts a conversation. `answer(id, member, round, { text } | { failed })`
  ignores stale rounds and non-members. `PASS` = whole reply is `pass` (case-insensitive, optional `.`/`!`).
- Caps as in BotOffice: 4,000 chars per quoted reply, 16,000 per round message, 200 log entries per group.
- Round message (built by the module):
  ```
  [Group chat "<name>" in <project> · round 2 of 4 · members: Main (Claude), Reviewer (GPT)]
  Since your last message:
  Martin: review the login flow
  Reviewer (GPT): ...
  Reply to the group. Others work in this same folder at the same time: say which files you'll change before
  changing them. If you have nothing to add, reply with just PASS.
  ```
  Chat-only members (Ollama) get the tail without the files line.
- The "Martin" label is the user's name: the MetaProject display name when signed in, else "You".

### 7.2 Members

A member is identified by a stable member id and has a kind:

- `claude-tab`: bound to a **Claude conversation**, not a tab slot: `{ projectId, claudeSessionId }`, plus the tab's
  display title. The session id comes from the tab's hook events (`session_id`). Slot numbers are reused when tabs
  close and `claude --continue` can pick a different conversation after a restart, so a tab only counts as this
  member while its current Claude session id matches. While no open tab in the project has that session, the member
  is shown as unavailable and fails any round it is given ("its Claude tab isn't open"). Tabs that run Claude
  without the app's hooks (no session id) can't join; the picker says why. (My call.)
- `headless`: `{ engine: 'codex'|'gemini'|'ollama', name, model?, engineSession? }`, owned by the group, stored in
  the DB. `engineSession` is the Codex thread id / Gemini session id, kept so later turns resume the same
  conversation. Ollama has no session; the member's own history (its round messages and replies) is stored and sent
  with each turn, capped to the most recent turns that fit a builder-chosen budget.

Display name: `<title> (<Claude|GPT|Gemini|Ollama>)`.

### 7.3 Delivery — one turn per member at a time

A main-process `GroupChatService` owns the groups and a small **queue per member** (oldest first). Deliveries go into
the member's queue; a member runs at most one group turn at a time. Engines sit behind one interface so more can be
added later:

```
interface MemberTurn { start(text): void; stop(): void; onDone(cb: (r: { text } | { failed }) => void) }
```

**Claude tab**

1. Wait until the tab's agent state is `idle`, Martin has not typed into it for a short quiet period (builder
   picks, e.g. 3 s, using the PTY manager's last-input time), **and Claude's input box is empty** (read from the
   screen mirror; extend `claude-screen.ts`). The app never clears or edits Martin's own input: while a half-typed
   draft sits there, the status line says "waiting for you to send or clear your draft in <tab>". While the tab is
   `busy` or `blocked` the turn waits. The 30-minute fail-safe covers a tab that never frees up. (My call.)
2. Write the round message with submit, through `PtyManager.write` (as `prompts:paste` does). Multi-line text must
   arrive as one prompt (use bracketed paste so newlines don't submit early).
3. Wait for the tab's next `Stop` hook. Extend the hook parser to also keep `transcript_path` and `session_id`
   (validated: an absolute path to a `.jsonl` under the user's `~/.claude/projects/`). Read the transcript, find the
   **last user message that is our round message** (match on the exact header line), and take the assistant text
   after it, **up to the next user message**, as the answer. If Martin sends his own prompt after ours (Claude queues
   it), the answer is still the text between ours and his. (My call.)
4. If our round message isn't in the transcript yet, that Stop belongs to an earlier turn: keep waiting.
5. Only Stop hooks from the member's own session id count.
6. **Stop** of a Claude-tab turn sends Escape to the tab, only if the tab's current turn is the group's message.

**Headless (ported adapters)** — port `windows/engines/codex.js`, `gemini.js`, `ollama.js`, `cli.js`, `status.js`
and their tests to TypeScript under `src/main/group-chat/engines/`:

- Codex: `codex exec --json` in the project folder, message on stdin; later turns `codex exec resume <threadId>`;
  `sandbox_mode="workspace-write"` (and `windows.sandbox="unelevated"` on Windows).
- Gemini: `gemini --output-format stream-json --approval-mode auto_edit --skip-trust`, message on stdin, `--resume
  <sessionId>` on later turns.
- Ollama: `POST http://127.0.0.1:11434/api/chat` streaming, with the member's history.
- Spawn without a shell (`cli.js` resolves npm shims on Windows). Stop kills the process (Ollama: abort the fetch).
- `status.js` tells the Add-member picker which engines are ready and, if not, why and how to fix it.

When a turn ends, the service calls `groups.answer(...)` and queues the next round's deliveries.

### 7.4 Every cancellation answers the round

One helper, used by every path that ends a member's group turn without a reply, calls `answer(..., { failed:
reason })`:

- Stop (group), removing a member, deleting a group.
- A Claude tab exiting, respawning, or being closed; its project being closed.
- A headless process exiting non-zero or with no reply; an engine not installed / not signed in.
- No answer within **30 minutes** (fail-safe): the member fails its round and its turn is stopped. This timer only
  ever ends things; nothing starts on a timer.
- App quit / restart.

### 7.5 Persistence and restart

- New migration (`0005_group_chats.sql`): group chats, members (incl. headless engine session and Ollama history),
  and the log. Builder picks the exact schema.
- On startup every `running` group becomes `stopped` with the log entry "Stopped: the app restarted"; queued turns
  are dropped. A restart never resumes a conversation.
- **Eviction protection (Martin's decision):** while a group is `running`, the shells of its Claude-tab members are
  exempt from the keep-alive cap (`chooseEvictee` skips them at every call site in `register.ts`). The app may sit
  above the cap until the conversation ends; the protection lifts the moment the group is idle or stopped. If every
  candidate is protected, nothing is evicted.
- A Claude-tab member survives restarts as `{ projectId, claudeSessionId }`; it can take part again once a tab in
  that project is running that same Claude session.

### 7.6 IPC

New channels in `src/shared/ipc-contract.ts`, handled in `src/main/ipc/register.ts`:
`groups:list {projectId}` · `groups:create {projectId, name?, members}` · `groups:update {id, name?, maxRounds?}` ·
`groups:addMember` · `groups:removeMember` · `groups:say {id, text}` · `groups:stop {id}` · `groups:delete {id}`
(refused while running) · `groups:engines` (engine status) · and a broadcast `groups:changed` when a group changes,
so the panel updates live.

### 7.7 The group panel (renderer)

A new activity view **Group** beside Projects / Chat / Git / Tasks (`ActivityView` in `App.tsx`), matching
BotOffice's column:

```
┌ Group chat ──────────── [Group chat 1 ▾] [+ New] ┐
│ [Claude] Main ✕   [GPT] Reviewer ✕   [+ Add]     │
│ Round 2 of 4 · waiting for Reviewer (GPT) [■ Stop]│   rounds [4]
│ ─────────────── Round 1 of 4 ─────────────────── │
│ You: review the login flow                       │
│ [Claude] Main: …                                 │
│ [GPT] Reviewer: …                                │
│ ─────────────── Round 2 of 4 ─────────────────── │
│ …                                                │
│ [ Message everyone…                      ] [Send]│
└──────────────────────────────────────────────────┘
```

- Picker of the open project's groups; **+ New** starts a group with the focused Claude tab as first member.
- Member chips: engine badge + name + ✕. **+ Add** offers the project's Claude tabs and "New GPT / Gemini / Ollama
  agent…" (name, model); engines that aren't ready are shown disabled with the reason.
- Status line: "Round 2 of 4 · waiting for X and Y" + **Stop** while running; "Ready" when idle; the end reason.
- Transcript: Martin's messages, each reply with its engine colour, round dividers, failures, member joined/left.
  Replies render as markdown using the app's existing renderer if there is one.
- Text in the transcript is rendered as text (no HTML injection from model output).

## 8. Constraints

- Match the repo: TypeScript, electron-vite, React + Tailwind, better-sqlite3 migrations, vitest (TDD), the IPC
  contract pattern, docs in `docs/architecture.md`.
- No new runtime dependencies (BotOffice's adapters use only Node built-ins and `fetch`).
- **Cost:** rounds multiply turns (members × rounds). Defaults keep it bounded: 3 members × 4 rounds = 12 turns per
  message from Martin.
- **Privacy:** group logs and Ollama history stay in the local SQLite DB. Codex and Gemini send the round message
  (which quotes other members' replies) to OpenAI / Google, exactly as using those CLIs does today. No secrets in
  code; engine auth stays with each CLI's own login.
- **Permissions:** headless members can't answer prompts. Carried over from BotOffice (Martin's call there): Codex may
  write inside the project folder only; Gemini may read and edit files, and shell commands are refused. A Claude-tab
  member keeps its own permission mode, and a permission prompt holds its round (the 30-minute fail-safe applies).

## 9. My calls (Martin can change these)

- Several group chats per project; default name "Group chat N".
- Default 4 rounds, settable 1–10; everyone `PASS` ends early.
- Headless members are created in the group panel and belong to that group (not shared between groups).
- A Claude tab waits for idle + a few seconds without typing before a group message is typed in.
- Stop sends Escape to a Claude tab only when its current turn is the group's.
- A Claude-tab member is its Claude conversation (session id), not a tab slot.
- The app never touches Martin's half-typed input; a group turn waits for an empty input box.
- If Martin sends his own prompt right after a round message, the group answer is the reply to the round message.

## 10. Left to the builder

- DB schema details, the Ollama history budget, the typing-quiet period, exact UI styling.
- Whether `GroupChatService` lives in one file or a few; how the per-member queue is structured.
- Exact transcript-reading code (parse JSONL, tolerate a partially written last line).
