/**
 * Agent intent / "status badge" bus. Each shell has a short "what I'm
 * doing now" label that metaIDE renders beside the agent so a human
 * scanning the window can tell what each agent is on without opening
 * the chat pane.
 *
 * Agents set their own intent by appending one JSON line to
 * `.metaide/intent-outbox.jsonl`. The watcher tails it, keeps the
 * latest entry per `(agent, shell)`, and broadcasts to the renderer.
 * Sibling of [[./chat.ts]] — chat is addressed communication; intent
 * is ambient status.
 */

/** One state entry per live shell — the agent's current activity. */
export interface IntentUpdate {
  /** CLI family — matches `ChatEntry.from.agent` (e.g. `claude`, `codex`). */
  agent: string;
  /** Shell index that owns this intent. */
  shell: number;
  /** Short label; the watcher trims to [[INTENT_TEXT_MAX]] on ingest. */
  text: string;
  /** ISO-8601, writer-clock at the moment the line was tailed. */
  ts: string;
}

/** Soft cap on `text` — trimmed by the watcher so a stray paragraph
 *  from a chatty agent can't blow up the sidebar. Six words is roughly
 *  40 chars; 80 gives headroom without losing the glanceable form. */
export const INTENT_TEXT_MAX = 80;

/** Hard cap on the intent file we keep online. Same contract as the
 *  chat outbox: tail-only, so rotation never loses unread state. */
export const INTENT_MAX_BYTES = 1 << 20; // 1 MiB

/** Directory inside the project that holds `.metaide/*`. */
export const INTENT_DIR = '.metaide';

/** Filename of the intent outbox inside `INTENT_DIR`. Deliberately
 *  separate from `chat-outbox.jsonl` so an agent can post an intent
 *  without also posting a chat message. */
export const INTENT_FILE = 'intent-outbox.jsonl';

/** After this many ms with no update, the renderer dims the badge —
 *  "still the current task, just a while ago". */
export const INTENT_DIM_MS = 30_000;

/** After this many ms with no update, the renderer swaps the badge for
 *  "idle" — the agent has gone quiet and the previous text is stale. */
export const INTENT_IDLE_MS = 120_000;
