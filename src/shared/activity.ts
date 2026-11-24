/**
 * Shared agent-memory log. Each project has a `.metaide/activity.jsonl`
 * file holding one `ActivityEntry` per line. Every CLI agent that reports
 * events through hooks writes here; the renderer tails the file so multiple
 * shells + humans share one timeline.
 */

export type ActivityKind =
  | 'tool'            // PreToolUse / PostToolUse — the useful signal (Edit, Write, Bash, Read, etc.)
  | 'prompt'          // UserPromptSubmit — a human typed to the agent
  | 'notification'    // the agent asked for input
  | 'turn-end'        // the agent finished a turn (Stop)
  ;

export interface ActivityEntry {
  /** Monotonic within a project — the file's byte offset plus a per-process counter. */
  id: string;
  /** ISO-8601, main-process clock. */
  ts: string;
  /** Which agent reported this. "claude" for Claude Code. Future: "codex", "pi", … */
  agent: string;
  /** The shell this event came from — matches shellIndex on the pty manager. */
  shellIndex: number;
  kind: ActivityKind;
  /** For `tool`: the tool name (e.g. "Edit", "Bash"). */
  tool?: string;
  /** For `tool` Edit/Write/Read: the file path. For Bash: the command. */
  target?: string;
  /** For `tool` PostToolUse: whether it succeeded. */
  ok?: boolean;
  /** Free-text — the Notification message or a short Bash output snippet. Bounded to 400 chars. */
  text?: string;
}

/** Hard cap on an entry's text field; the writer trims before serialising. */
export const ACTIVITY_TEXT_MAX = 400;

/** Hard cap on how many entries the "list" IPC returns in one page. */
export const ACTIVITY_PAGE_MAX = 500;
