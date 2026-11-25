/**
 * Pick a Story window big enough to narrate.
 *
 * "Catch me up" defaults to auto: a 15-minute window is right for a busy
 * agent but tells the reader nothing in a project that's been quiet since
 * yesterday. We expand through a fixed ladder (15m → 1h → 4h → 1d → 3d →
 * 7d) and stop at the first step where the window holds enough signal
 * to write a real story.
 *
 * "Enough" (per operator choice, see CLAUDE.md feedback 2026-11-25):
 *   at least 50 activity events, OR at least 5 chat messages.
 *
 * Caps at 7 days so a long-dormant project still produces *something* —
 * the narrator and the reader both see the honest span.
 */
import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { readRecentActivity } from '../activity/log';

/** The expansion ladder, newest first. Order matters — the picker stops
 *  at the first step that meets the threshold. */
export const WINDOW_LADDER_MINUTES = [15, 60, 240, 1440, 4320, 10080] as const;

export const MIN_EVENTS_FOR_STORY = 50;
export const MIN_CHAT_FOR_STORY = 5;

export interface WindowPickOptions {
  projectPath: string;
  /** Injectable clock for tests. */
  now?: () => Date;
  /** Override the ladder (tests). */
  ladder?: readonly number[];
}

export interface WindowPick {
  /** The window Catch-me-up should use, in minutes. */
  minutes: number;
  /** Signal counts inside that window — used in logs / subtitles. */
  events: number;
  chat: number;
  /** True when the picker expanded past the first step. */
  expanded: boolean;
  /** True when we reached the cap without meeting the threshold —
   *  the narrator should still produce a chunk and the subtitle should
   *  say the span. */
  sawCap: boolean;
}

/**
 * Walk the ladder. Return the first window that meets the threshold,
 * or the largest window if nothing does.
 */
export function pickStoryWindowMinutes(opts: WindowPickOptions): WindowPick {
  const ladder = opts.ladder ?? WINDOW_LADDER_MINUTES;
  const now = opts.now ? opts.now() : new Date();

  // Read once with a generous cap — larger ladder steps re-filter from
  // the same in-memory list rather than re-reading the file each step.
  // 10 000 is well above a day of a busy project and still cheap to walk.
  const allActivity = readRecentActivity(opts.projectPath, 10_000);
  const allChat = readRecentChat(opts.projectPath, 2_000);

  let last: WindowPick = {
    minutes: ladder[0] ?? 15,
    events: 0,
    chat: 0,
    expanded: false,
    sawCap: false,
  };

  for (let i = 0; i < ladder.length; i += 1) {
    const minutes = ladder[i]!;
    const since = new Date(now.getTime() - minutes * 60_000);
    const events = allActivity.filter((e) => new Date(e.ts) >= since).length;
    const chat = allChat.filter((c) => new Date(c.ts) >= since).length;
    const expanded = i > 0;
    last = { minutes, events, chat, expanded, sawCap: i === ladder.length - 1 };
    if (events >= MIN_EVENTS_FOR_STORY || chat >= MIN_CHAT_FOR_STORY) {
      // Clear the cap flag — we met the threshold before hitting the cap.
      return { ...last, sawCap: false };
    }
  }
  // Nothing on the ladder met the threshold. Return the largest window —
  // the caller will still narrate it, honestly.
  return last;
}

/** Lightweight tail reader — kept here to avoid importing narrator.ts just
 *  for the chat helper (which would pull in template rendering). */
function readRecentChat(projectPath: string, limit: number): Array<{ ts: string }> {
  const path = `${projectPath}/.metaide/chat.jsonl`;
  if (!existsSync(path)) return [];
  try {
    const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.length > 0);
    const out: Array<{ ts: string }> = [];
    for (const line of lines.slice(-limit)) {
      try {
        const obj = JSON.parse(line) as { ts?: string };
        if (typeof obj.ts === 'string') out.push({ ts: obj.ts });
      } catch { /* skip malformed */ }
    }
    return out;
  } catch { return []; }
}
