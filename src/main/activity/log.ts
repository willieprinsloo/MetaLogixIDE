/**
 * Append-only JSONL activity log per project. One line per `ActivityEntry`.
 * Lives at `<projectRoot>/.metaide/activity.jsonl` — on disk so agents in
 * other shells (even on other machines after a git pull) can see what was
 * done, and so a `tail -f` works from any terminal outside the IDE.
 *
 * The file can grow unbounded; readers paginate from the end. Rotation is a
 * future problem (10 MB is ~100k entries which already covers months of work).
 */
import { appendFileSync, existsSync, mkdirSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ActivityEntry } from '@shared/activity';
import { ACTIVITY_TEXT_MAX } from '@shared/activity';

export const ACTIVITY_DIR = '.metaide';
export const ACTIVITY_FILE = 'activity.jsonl';

export function activityPath(projectPath: string): string {
  return join(projectPath, ACTIVITY_DIR, ACTIVITY_FILE);
}

/** Writes one entry; swallows I/O errors (log misses must never break the IDE). */
export function appendActivity(projectPath: string, entry: ActivityEntry): void {
  try {
    const path = activityPath(projectPath);
    mkdirSync(dirname(path), { recursive: true });
    // Trim text up front so every line stays small.
    const trimmed: ActivityEntry = entry.text && entry.text.length > ACTIVITY_TEXT_MAX
      ? { ...entry, text: entry.text.slice(0, ACTIVITY_TEXT_MAX) + '…' }
      : entry;
    appendFileSync(path, JSON.stringify(trimmed) + '\n');
  } catch (err) {
    console.warn('[activity] write failed', { projectPath, err });
  }
}

/**
 * Returns the last `limit` entries, oldest-first. Reads the file tail so a
 * 10 MB log doesn't force parsing every line to show the last 100 events.
 */
export function readRecentActivity(projectPath: string, limit: number): ActivityEntry[] {
  const path = activityPath(projectPath);
  if (!existsSync(path)) return [];
  let fd: number | null = null;
  try {
    const st = statSync(path);
    const size = st.size;
    if (size === 0) return [];
    // Scan back from EOF in 64 KB chunks until we have more than `limit` newlines
    // or we hit the start of the file.
    const chunkSize = 64 * 1024;
    const bufs: Buffer[] = [];
    let pos = size;
    let newlines = 0;
    fd = openSync(path, 'r');
    while (pos > 0 && newlines <= limit) {
      const read = Math.min(chunkSize, pos);
      pos -= read;
      const b = Buffer.alloc(read);
      readSync(fd, b, 0, read, pos);
      bufs.unshift(b);
      for (const byte of b) if (byte === 0x0a) newlines++;
    }
    const text = Buffer.concat(bufs).toString('utf8');
    const lines = text.split('\n').filter((l) => l.length > 0);
    const tail = lines.slice(-limit);
    const out: ActivityEntry[] = [];
    for (const line of tail) {
      try { out.push(JSON.parse(line) as ActivityEntry); } catch { /* skip malformed */ }
    }
    return out;
  } catch (err) {
    console.warn('[activity] read failed', { projectPath, err });
    return [];
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* best-effort */ } }
  }
}

let counter = 0;
/** Generates a unique id for an activity entry (`<ts>-<counter>`). */
export function nextActivityId(): string {
  counter = (counter + 1) & 0xffffffff;
  return `${Date.now().toString(36)}-${counter.toString(36)}`;
}
