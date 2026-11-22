/**
 * Agent → chat-bus outbox watcher.
 *
 * Agents (Claude Code, Codex, opencode, …) can't call the chat IPC from
 * inside their shell. The lightest-weight channel they *can* use is their
 * ordinary file-write tool: appending one JSON line per message to
 *   `<projectRoot>/.metaide/chat-outbox.jsonl`
 * is picked up here, routed through `chat.append`, and fanned out to
 * every listener + injected into any `@`-mentioned peer.
 *
 * Shape of each line (one JSON object per line):
 *   {"from":{"agent":"claude","shell":0},"to":[{"agent":"human"}],"body":"on it"}
 *
 * The watcher is tail-only: on start it seeks to EOF so a project's
 * historical outbox never re-plays. Offsets are kept in memory; a crash
 * loses at most the lines written while main was down, which is the same
 * behaviour as every other volatile pipe we run.
 */
import { existsSync, mkdirSync, renameSync, statSync, unlinkSync, watch, type FSWatcher, createReadStream } from 'node:fs';
import { join } from 'node:path';
import log from 'electron-log/main';
import type { ChatService } from './service';
import type { ChatMention } from '@shared/chat';

export const OUTBOX_RELPATH = '.metaide/chat-outbox.jsonl';

/**
 * Hard cap on the outbox file we keep online. Chosen large enough that a
 * day of chatter from several agents fits comfortably (one JSON line is
 * typically ~200 B; 1 MB ≈ 5000 messages), small enough that reading the
 * full file for debug never hurts. Larger files are rotated to `.old` so
 * exactly one previous generation stays around.
 */
export const OUTBOX_MAX_BYTES = 1 << 20; // 1 MiB

/**
 * If the outbox has grown past `maxBytes`, move it to a sibling `.old`
 * file (overwriting any prior `.old`) and let the next appender create a
 * fresh one. Returns `true` when a rotation happened. The watcher is
 * tail-only so this never loses unread content: `add()` already sets the
 * offset to the current size, so the bytes in the rotated file were
 * never going to be re-ingested.
 */
export function maybeRotateOutbox(path: string, maxBytes: number = OUTBOX_MAX_BYTES): boolean {
  try {
    if (!existsSync(path)) return false;
    const size = statSync(path).size;
    if (size <= maxBytes) return false;
    const old = `${path}.old`;
    if (existsSync(old)) { try { unlinkSync(old); } catch { /* best-effort */ } }
    renameSync(path, old);
    return true;
  } catch (err) {
    log.warn('[chat-outbox] rotation failed', { path, err });
    return false;
  }
}

export interface OutboxDeps {
  chat: ChatService;
  /** Projects to watch; call `addProject` later for newly-opened ones. */
  projects: ReadonlyArray<{ id: number; path: string }>;
}

export interface OutboxWatcher {
  addProject(project: { id: number; path: string }): void;
  removeProject(projectId: number): void;
  stop(): void;
}

interface Slot {
  projectId: number;
  path: string;        // absolute file path to the outbox
  offset: number;      // bytes already consumed
  watcher: FSWatcher | null;
  dirWatcher: FSWatcher | null; // watches `.metaide/` so we notice the file appearing
  draining: boolean;   // reentry guard for overlapping change events
}

export function startOutboxWatcher(deps: OutboxDeps): OutboxWatcher {
  const slots = new Map<number, Slot>();

  const add = (project: { id: number; path: string }): void => {
    if (slots.has(project.id)) return;
    const metaideDir = join(project.path, '.metaide');
    const outbox = join(project.path, OUTBOX_RELPATH);
    // Rotate oversized outboxes before deciding the starting offset — a
    // file left to grow across many sessions of unread agent chatter
    // would otherwise sit at hundreds of MB and keep growing. Tail-only
    // semantics mean the rotated bytes were never going to be ingested
    // anyway, so this is a pure disk-hygiene step.
    if (maybeRotateOutbox(outbox)) {
      log.info('[chat-outbox] rotated oversized outbox', { projectId: project.id, path: outbox });
    }
    const slot: Slot = {
      projectId: project.id,
      path: outbox,
      offset: existsSync(outbox) ? statSync(outbox).size : 0,
      watcher: null,
      dirWatcher: null,
      draining: false,
    };
    const attachFileWatcher = (): void => {
      try {
        slot.watcher = watch(outbox, { persistent: false }, () => void drain(slot));
      } catch (err) {
        log.debug('[chat-outbox] file watch failed', { projectId: project.id, err });
      }
    };
    if (existsSync(outbox)) {
      attachFileWatcher();
    } else {
      // Watch `.metaide/` so the first `touch chat-outbox.jsonl` from the
      // agent is picked up without another restart. Create the dir first
      // so `fs.watch` has something to watch.
      try { mkdirSync(metaideDir, { recursive: true }); } catch { /* nbd */ }
      try {
        slot.dirWatcher = watch(metaideDir, { persistent: false }, (_ev, name) => {
          if (name === 'chat-outbox.jsonl' && existsSync(outbox) && !slot.watcher) {
            slot.offset = 0;
            attachFileWatcher();
            void drain(slot);
          }
        });
      } catch (err) {
        log.debug('[chat-outbox] dir watch failed', { projectId: project.id, err });
      }
    }
    slots.set(project.id, slot);
  };

  const drain = async (slot: Slot): Promise<void> => {
    if (slot.draining) return;
    slot.draining = true;
    try {
      if (!existsSync(slot.path)) return;
      const size = statSync(slot.path).size;
      if (size < slot.offset) slot.offset = 0; // file truncated or replaced
      if (size === slot.offset) return;
      const stream = createReadStream(slot.path, { start: slot.offset, end: size - 1, encoding: 'utf8' });
      let buf = '';
      for await (const chunk of stream) buf += chunk;
      slot.offset = size;
      const lines = buf.split('\n');
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        await ingestLine(slot.projectId, line);
      }
    } catch (err) {
      log.warn('[chat-outbox] drain failed', { projectId: slot.projectId, err });
    } finally {
      slot.draining = false;
    }
  };

  const ingestLine = async (projectId: number, line: string): Promise<void> => {
    let parsed: unknown;
    try { parsed = JSON.parse(line); }
    catch { log.debug('[chat-outbox] non-JSON line ignored', { projectId, line: line.slice(0, 200) }); return; }
    const req = validateOutboxLine(parsed);
    if (!req) {
      log.debug('[chat-outbox] malformed line ignored', { projectId, line: line.slice(0, 200) });
      return;
    }
    try {
      await deps.chat.append({
        projectId,
        from: { agent: req.from.agent, shell: req.from.shell },
        to: req.to,
        body: req.body,
        ...(req.reply_in ? { reply_in: req.reply_in } : {}),
      });
    } catch (err) {
      log.warn('[chat-outbox] chat.append failed', { projectId, err });
    }
  };

  for (const p of deps.projects) add(p);

  return {
    addProject: add,
    removeProject(projectId) {
      const slot = slots.get(projectId);
      if (!slot) return;
      slot.watcher?.close();
      slot.dirWatcher?.close();
      slots.delete(projectId);
    },
    stop() {
      for (const slot of slots.values()) {
        slot.watcher?.close();
        slot.dirWatcher?.close();
      }
      slots.clear();
    },
  };
}

interface OutboxLine {
  from: { agent: string; shell: number };
  to?: ChatMention[];
  body: string;
  reply_in?: string;
}

function validateOutboxLine(raw: unknown): OutboxLine | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const from = o.from && typeof o.from === 'object' ? (o.from as Record<string, unknown>) : null;
  if (!from) return null;
  const agent = typeof from.agent === 'string' ? from.agent : null;
  const shell = typeof from.shell === 'number' ? from.shell : null;
  if (!agent || shell === null) return null;
  const body = typeof o.body === 'string' ? o.body : null;
  if (body === null) return null;
  const to = Array.isArray(o.to) ? (o.to as ChatMention[]) : undefined;
  const reply_in = typeof o.reply_in === 'string' ? o.reply_in : undefined;
  return { from: { agent, shell }, to, body, reply_in };
}

export const __test__ = { validateOutboxLine };
