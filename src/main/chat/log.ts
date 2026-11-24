/**
 * Append-only JSONL chat bus per project. Sibling of [[../activity/log.ts]]:
 * one line per `ChatEntry`, lives at `<projectRoot>/.metaide/chat.jsonl`,
 * every participating device writes every entry it sees so the log
 * converges without any central server.
 *
 * The file can grow unbounded; readers paginate from the end. Rotation
 * matches the activity log's policy — whatever that becomes later.
 */
import { appendFileSync, existsSync, mkdirSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ChatEntry } from '@shared/chat';
import { CHAT_BODY_MAX, CHAT_DIR, CHAT_FILE } from '@shared/chat';

export function chatPath(projectPath: string): string {
  return join(projectPath, CHAT_DIR, CHAT_FILE);
}

/** Writes one entry; swallows I/O errors — log misses must never break the IDE. */
export function appendChat(projectPath: string, entry: ChatEntry): void {
  try {
    const path = chatPath(projectPath);
    mkdirSync(dirname(path), { recursive: true });
    const trimmed: ChatEntry = entry.body && entry.body.length > CHAT_BODY_MAX
      ? { ...entry, body: entry.body.slice(0, CHAT_BODY_MAX) + '…' }
      : entry;
    appendFileSync(path, JSON.stringify(trimmed) + '\n');
  } catch (err) {
    console.warn('[chat] write failed', { projectPath, err });
  }
}

/**
 * Returns the last `limit` entries, oldest-first. Reads the file tail in
 * 64 KB chunks so a 10 MB log doesn't force parsing every line to show
 * the last 100 messages.
 */
export function readRecentChat(projectPath: string, limit: number): ChatEntry[] {
  const path = chatPath(projectPath);
  if (!existsSync(path)) return [];
  let fd: number | null = null;
  try {
    const st = statSync(path);
    const size = st.size;
    if (size === 0) return [];
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
    const out: ChatEntry[] = [];
    for (const line of tail) {
      try {
        out.push(JSON.parse(line) as ChatEntry);
      } catch {
        /* skip malformed line */
      }
    }
    return out;
  } catch (err) {
    console.warn('[chat] read failed', { projectPath, err });
    return [];
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* best-effort */ }
    }
  }
}

let counter = 0;
/** Generates a unique id for a chat entry — `<ts base36>-<deviceId>-<counter base36>`. */
export function nextChatId(deviceId: string): string {
  counter = (counter + 1) & 0xffffffff;
  return `${Date.now().toString(36)}-${deviceId}-${counter.toString(36)}`;
}
