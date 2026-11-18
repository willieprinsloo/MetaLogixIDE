/**
 * Shared agent chat bus. Each project has a `.metaide/chat.jsonl` file
 * holding one `ChatEntry` per line. Humans and agents post through the
 * same `chat:append` IPC; messages `@`-tagged at a shell's agent are
 * stdin-injected into that shell's PTY. Sibling of
 * [[./activity.ts]] — one is a log, this one is a two-way bus.
 */

/** A target of a chat message. Omitting a field matches any value. */
export interface ChatMention {
  /** metaIDE deviceId; undefined = any device (including this one). */
  device?: string;
  /** shellIndex; undefined = any shell matching the other filters. */
  shell?: number;
  /** CLI family — "claude" | "codex" | "ollama" | "human" | "all" | custom. */
  agent?: string;
}

/** One line of the chat log. */
export interface ChatEntry {
  /** Monotonic within a project — `<ts base36>-<deviceId>-<counter base36>`. */
  id: string;
  /** ISO-8601, writer-clock at the moment the entry was stamped. */
  ts: string;
  /** Who posted it. */
  from: {
    device: string;
    shell: number;
    agent: string;
    label?: string;
  };
  /** Zero or more targets. Empty = broadcast (logged, not injected). */
  to: ChatMention[];
  /** Plain text body; the writer truncates with an ellipsis over `CHAT_BODY_MAX`. */
  body: string;
  /** Another entry's `id` — threads the reply. */
  reply_in?: string;
  /** Delivery metadata set by the injector / cap gate, never by posters. */
  meta?: {
    /** True when the reply cap held delivery — the UI shows a red badge. */
    cap_held?: boolean;
    /** True when every mention resolved to an offline agent — the UI
     *  shows "not delivered" so the human knows the message wasn't
     *  injected into any CLI. */
    undelivered?: boolean;
  };
}

/** Hard cap on an entry's `body`; the writer trims before serialising. */
export const CHAT_BODY_MAX = 8 * 1024;

/** Hard cap on how many entries the list IPC returns in one page. */
export const CHAT_PAGE_MAX = 500;

/** Consecutive agent replies allowed in one thread without a human post. */
export const CHAT_REPLY_CAP = 5;

/** Rolling-window length for per-shell agent-message rate limiting. */
export const CHAT_RATE_WINDOW_MS = 1000;

/** Max agent messages per shell in one `CHAT_RATE_WINDOW_MS` window. */
export const CHAT_RATE_MAX = 3;

/** Directory inside the project that holds `.metaide/*`. */
export const CHAT_DIR = '.metaide';

/** Filename of the chat log inside `CHAT_DIR`. */
export const CHAT_FILE = 'chat.jsonl';
