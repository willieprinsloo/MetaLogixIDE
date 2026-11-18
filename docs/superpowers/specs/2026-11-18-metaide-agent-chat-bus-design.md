# metaIDE Agent Chat Bus — Design

**Status:** Draft for approval
**Date:** 2026-11-18
**Owner:** Willie Prinsloo
**Related:** `.metaide/activity.jsonl` (shared agent memory) ·
P2P fleet (`docs/superpowers/specs/2026-10-26-metaide-p2p-design.md`) ·
`src/renderer/components/ActivityTab.tsx` · `src/main/activity/`

---

## 1. Intent

Today, two agents working the same project cannot talk to each other.
The user copies Claude's answer into Codex's prompt, or asks Claude to
`codex exec "..."` from Bash and read the stdout back. The activity log
closed half the gap — every shell sees every other shell's tool calls
and prompts — but it is one-way: hooks write, humans read. Agents
cannot address each other, and they cannot be addressed by anyone but
their own user.

The Agent Chat Bus closes the other half. One project, one shared,
append-only chat log, backed by `.metaide/chat.jsonl`. Humans and agents
post into it the same way. Any message `@`-tagged at a shell's agent is
injected into that shell's PTY stdin as if the human had typed it. The
receiving CLI reads it on its next turn and may reply through the same
primitive. The conversation becomes a visible thread the user can read,
join, or redirect.

The fleet already paired the owner's machines. The bus rides that
plumbing: Claude on the laptop and Codex on the Mac mini are two
members of the same chat room when both devices are online.

## 2. Non-goals

- **Not a substitute for the human.** The user remains the editor. The
  bus makes collaboration *possible*, not automatic. It never approves
  code, publishes, or spends on the user's behalf beyond what their
  CLIs already can.
- **Not an orchestrator.** The bus does not plan, delegate, or route
  work algorithmically. It carries messages. Protocols on top (a "lead
  agent" pattern, a review pattern) are future features that use it.
- **Not an audit log.** The activity log already is that. The chat log
  is for *in-band conversation*, not every tool call.
- **Not multi-user.** The chat bus is per-owner-fleet, like the rest of
  metaIDE P2P. Shared team channels come later, on the same rails.

## 3. Shape

### 3.1 The log

`<projectRoot>/.metaide/chat.jsonl` — sibling of `activity.jsonl`.
Append-only, one JSON object per line, written by the main process on
every post (local or received over P2P). Humans and agents read it,
nothing else writes it.

```ts
interface ChatEntry {
  id: string;              // `<ts>-<deviceId>-<counter>`
  ts: string;              // ISO-8601
  from: {
    device: string;        // metaIDE deviceId; "local" for this machine
    shell: number;         // shellIndex, or -1 for human
    agent: string;         // "claude" | "codex" | "ollama" | "human" | custom
    label?: string;        // human-readable, e.g. "Codex (mac-mini)"
  };
  to: Array<{              // empty = broadcast
    device?: string;       // omitted = any device
    shell?: number;        // omitted = any shell for that agent
    agent?: string;        // "human" is addressable
  }>;
  body: string;            // plain text, no markup; max 8 KiB per message
  reply_in?: string;       // another entry's id, for threading
  meta?: {
    cap_held?: boolean;    // delivery suppressed by reply cap (see 3.4)
  };
}
```

JSONL keeps parity with the activity log and lets any shell `tail -f`
the file. The file is **not** committed by default; the IDE writes a
one-line entry to the repo's `.gitignore` when the bus is first enabled.

### 3.2 Routing — the `@` grammar

Messages address peers in the `body`'s own text and in a parsed `to`
array built from it. The grammar is deliberately small:

| Syntax                 | Resolves to                                   |
|------------------------|-----------------------------------------------|
| `@claude`              | First online shell running Claude (any device) |
| `@codex#2`             | Shell index 2 running Codex on this device    |
| `@claude@mac-mini`     | First Claude shell on the device named mac-mini |
| `@all`                 | Every online agent (never `@human`)           |
| `@human`               | Every human viewer; never stdin-injected      |
| no `@` at all          | Broadcast — logged, shown, not injected       |

The parser is generous — `@claude@mac-mini#1` is valid, so is bare
`@codex`. Composer UI autocompletes from the live roster (3.5).

### 3.3 Delivery — PTY stdin injection

The main process watches `chat.jsonl` for new entries. For each entry
whose `to` names a shell on this device, and whose recipient shell is
*alive and running an interactive CLI*, it writes one line to that
shell's PTY stdin:

```
[metaide-chat from=@claude@laptop reply=msg_abc123] <body, newlines stripped>\n
```

The prefix is the contract. On first launch, the IDE drops a short
system note into each supported CLI's project memory (Claude's
`CLAUDE.md`, Codex's `AGENTS.md`, Ollama's system prompt template)
explaining what `[metaide-chat …]` lines mean and that replies travel
through the `metaide chat send` CLI (3.6). An agent needs no new
training — the contract is in-band.

Injection is **refused** when:

- The target shell is not running or not interactive (`codex exec` is
  one-shot — the message is queued and delivered the next time that
  shell runs interactively, or it falls through to `@human` if it never
  does).
- The target shell is on another device (the message hops the P2P
  bridge; see 4).
- The reply cap is held (3.4) — the message is still logged with
  `meta.cap_held: true`, so humans see it, agents do not.

Injection text is **sanitised**: control characters are stripped, the
prefix uses `[` not a CLI slash character, and the body is embedded as
a single argument-shaped blob so no CLI parses it as a slash command or
pastes an escape sequence into the TTY.

### 3.4 Reply cap — the loop guard

Two agents in a tight loop can burn a week's token budget in an
afternoon. The cap is simple:

> **An agent may send at most 5 consecutive replies that are *not*
> answered by a human. The counter resets whenever any human posts, or
> when an agent `@`-tags `@human`.**

The counter is kept per (`from.agent`, root reply thread). When held,
further agent messages in that thread are logged with
`meta.cap_held: true` but **not injected**. The UI shows a red badge
on the thread; a one-click "release" button resets the counter and
delivers queued messages.

Default is 5 per project; configurable in `.metaide/chat-config.json`
(same convention as `cli-profiles.json`).

A per-project toggle, `require_human_approval: true`, flips every
agent-to-agent message into an approval queue — opt-in strict mode for
expensive setups. Default is off; the cap alone is the normal gate.

### 3.5 Roster

The sidebar pane and composer need a roster — who is online, on which
device, in which shell. This is already computed:

- Local alive shells come from `PtyManager.alive` plus the per-shell
  agent label the status bar now reads (`activeShellAgentLabel`).
- Remote alive shells come from the existing `shells.alive` P2P RPC,
  which already carries `agent` and `agent_state` per the Nov 14
  `43191fe` change.

Roster rows: `{ device, shell, agent, label, state, mention }`, sorted
self-first then by device name. `mention` is the string the composer
should insert (`@codex#2`, `@claude@mac-mini`).

### 3.6 `metaide chat` — the companion CLI

A tiny shim the IDE installs on each shell's PATH (via the same
mechanism `.metaide/env` uses). Two subcommands:

```bash
metaide chat send "body"                # broadcast, from this shell
metaide chat send "body" --to @claude   # addressed
metaide chat send "body" --to @codex --reply-in msg_abc123
metaide chat recent --limit 20          # tail of the log, for cold starts
```

Send writes the entry to `chat.jsonl` via a short IPC call to the main
process (so the write is serialised, id-stamped, P2P-fanned, and
cap-checked in one place). Agents learn about this CLI from the same
project memory note that explains the injection prefix.

Humans can also use it from any terminal (`metaide chat send "hey
everyone, see you in 10"`), but the pane UI is the main entry point.

## 4. Fleet-wide operation

Chat is **fleet-wide by default**, since paired devices are already a
single owner's workspace. The bus reuses the typed RPC channel the P2P
design established.

### 4.1 New RPC verbs

| Verb                    | Direction        | Purpose                           |
|-------------------------|------------------|-----------------------------------|
| `chat.append(entry)`    | Any → any peer   | Deliver one entry to a peer       |
| `chat.sync_since(ts)`   | Any → any peer   | Replay entries since `ts` on reconnect |
| `chat.roster()`         | Any → any peer   | Ask for the peer's alive agent list |

Each metaIDE instance owns its device's slice of `chat.jsonl` and
writes **all** entries it sees (local or received) into its local file
in canonical order (ts, device, counter). This gives every device the
same log eventually, with offline writes flushed on reconnect.

### 4.2 Ordering + offline

Entries carry `ts` plus `device` plus a monotonic per-device `counter`.
Ordering is `(ts, device, counter)` — a lexicographic triple. Clock
skew is tolerated: a late-arriving message lands where its timestamp
says, even if the file's end is further along; the UI sorts on read.

On P2P reconnect, each side calls `chat.sync_since(last_seen_ts)`.
Missed messages replay in order. Injection only fires for entries
received inside a 60-second freshness window — stale messages catch up
the log but do not wake dormant agents.

### 4.3 Security

The P2P channel is already authenticated + encrypted (MetaConnect
+ DTLS-SRTP, per the P2P spec). The bus adds no new network trust
assumptions. A compromised peer could post garbage — no different from
any other compromise. The chat body is treated as untrusted text on
both sides: never eval'd, never passed to a shell unquoted, only ever
written to a CLI's stdin as a single human-typed line.

## 5. UI

### 5.1 New Activity-bar entry — `Chat`

Sibling of Activity, Files, Fleet. Icon: a speech-bubble pair.

```
┌───────────────────────────────────────────────┐
│  Chat — project: metaIDE                      │  ← thread title, right-aligned actions
├─────────────────────┬─────────────────────────┤
│  Roster             │  Thread                 │
│                     │                         │
│  ● Claude (laptop)  │  09:14  @human: can we  │
│    shell-1          │        split the diff?  │
│                     │                         │
│  ● Codex (mac-mini) │  09:14  @claude@laptop  │
│    shell-2          │        → sure, hunk 2   │
│                     │        is independent   │
│  ○ Ollama           │                         │
│    offline          │  09:15  @codex: you     │
│                     │        up for hunk 3?   │
│                     │                         │
│                     │  [composer]  @          │
│                     │                         │
└─────────────────────┴─────────────────────────┘
```

Left column: roster, grouped by device, with the agent-state dot the
status bar already renders (amber/pulse/green). Click a row to insert
its mention into the composer.

Right column: threaded stream. Replies indent once; deeper nesting
flattens. Cap-held messages render with a red dot and a "release" link.

Composer: one text box with `@`-autocomplete (roster is the completion
source), a reply-in indicator when writing to a thread, and a device
scope picker for broadcasts (`this device` / `whole fleet`).

### 5.2 Notifications

A new agent-chat message addressed to the human raises an OS
notification through the existing notifier (`src/main/notifications/`),
alongside Claude's needs-input/finished signals. A message addressed to
an agent on this device raises no notification; the agent is its own
listener.

## 6. Build order

Each slice is end-to-end (contract + main + renderer + tests) so every
step produces a shippable increment:

1. **Schema + log writer + log reader**
   `src/shared/chat.ts`, `src/main/chat/log.ts` — mirror of
   `src/main/activity/log.ts`. IPC: `chat:append`, `chat:recent`,
   `chat:changed` event. No UI.

2. **Companion CLI**
   `scripts/metaide-chat` (Node shim) + `.metaide/env` PATH injection.
   `metaide chat send "..." [--to …]` shells into `chat:append` IPC
   over a per-session Unix socket.

3. **PTY stdin injection**
   `src/main/chat/inject.ts` — watches `chat:changed`, matches local
   recipients, writes the prefixed line to the target PTY. Interactive-
   shell check via existing `PtyManager` state. Reply-cap counter lives
   here.

4. **UI pane**
   `src/renderer/components/ChatTab.tsx` + roster, composer,
   `@`-autocomplete, cap badge, thread rendering. Hook into
   `ActivityBar.tsx` and `main-tab.ts`.

5. **Fleet integration**
   New RPC verbs on the existing typed channel. `chat.append` fan-out
   on every local write; `chat.sync_since` on reconnect. Local log is
   the source of truth per device; ordering by `(ts, device, counter)`.

6. **Project memory bootstrap**
   First time the bus is enabled for a project, the IDE writes a small
   stanza into `CLAUDE.md` / `AGENTS.md` / Ollama's project system
   prompt (opt-in diff the user approves) explaining the injection
   prefix and the `metaide chat send` CLI.

Steps 1–4 ship a usable local-only bus. Steps 5–6 light up the fleet
and the agent onboarding. Each step gets its own vitest + e2e coverage
in line with the project's standards.

## 7. Open questions (for owner to settle before plan)

1. **Agent-visible roster** — do we expose `metaide chat roster` so an
   agent can discover peers it did not already learn from the log? My
   call: yes; low cost, high leverage for lead-agent patterns. Reject if
   discovery feels like scope creep.
2. **Rate-limiting under the cap** — should the cap also debounce rapid
   replies (e.g. 3 messages/second) to stop a runaway while still
   inside the 5-reply budget? My call: yes, cheap safety.
3. **Message retention** — rotate `chat.jsonl` at some size? The
   activity log doesn't rotate yet. My call: match activity log's
   policy when it lands; do nothing new here.

---

Everything else — schema, routing, injection text, cap default, UI
slot, fleet verbs, security posture — is either settled above or has
my pick labelled. On approval of this doc I move to the implementation
plan under `docs/superpowers/plans/`.
