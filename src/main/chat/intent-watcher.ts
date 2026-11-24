/**
 * Agent → status-badge intent watcher.
 *
 * Agents append one JSON line per task-shift to
 *   `<projectRoot>/.metaide/intent-outbox.jsonl`
 * and the watcher tails that file, keeps the latest entry per
 * `(agent, shell)` in memory, and tells subscribers whenever any
 * shell's intent changes. The renderer shows that text as a short
 * "what I'm doing" label beside the agent.
 *
 * Shape of each line (one JSON object per line):
 *   {"from":{"agent":"claude","shell":0},"text":"writing tests for the rate badge"}
 *
 * Tail-only on start, same reasoning as the chat outbox: historical
 * intent is stale by the time we read it. Rotation at 1 MiB keeps the
 * file bounded across long-lived sessions.
 */
import { existsSync, mkdirSync, renameSync, statSync, unlinkSync, watch, type FSWatcher, createReadStream } from 'node:fs';
import { join } from 'node:path';
import log from 'electron-log/main';
import { INTENT_DIR, INTENT_FILE, INTENT_MAX_BYTES, INTENT_TEXT_MAX, type IntentUpdate } from '@shared/intent';

export const INTENT_RELPATH = `${INTENT_DIR}/${INTENT_FILE}`;

/**
 * Hard cap on the intent file we keep online — same rationale as the
 * chat outbox. Exported so tests can shrink it and prove rotation
 * without writing a megabyte of fixtures.
 */
export { INTENT_MAX_BYTES };

/**
 * Rotate an oversized intent file to a sibling `.old` so disk usage
 * stays bounded. The watcher is tail-only; rotated bytes were never
 * going to be ingested. Returns `true` when a rotation happened.
 */
export function maybeRotateIntent(path: string, maxBytes: number = INTENT_MAX_BYTES): boolean {
  try {
    if (!existsSync(path)) return false;
    const size = statSync(path).size;
    if (size <= maxBytes) return false;
    const old = `${path}.old`;
    if (existsSync(old)) { try { unlinkSync(old); } catch { /* best-effort */ } }
    renameSync(path, old);
    return true;
  } catch (err) {
    log.warn('[intent] rotation failed', { path, err });
    return false;
  }
}

export interface IntentChangedPayload {
  projectId: number;
  update: IntentUpdate;
}

export interface IntentWatcherDeps {
  projects: ReadonlyArray<{ id: number; path: string }>;
  /** Called every time a shell's intent changes. */
  onChanged: (payload: IntentChangedPayload) => void;
}

export interface IntentWatcher {
  addProject(project: { id: number; path: string }): void;
  removeProject(projectId: number): void;
  /** Snapshot of every live intent on a project, for UI bootstrap. */
  list(projectId: number): IntentUpdate[];
  stop(): void;
}

interface Slot {
  projectId: number;
  path: string;
  offset: number;
  watcher: FSWatcher | null;
  dirWatcher: FSWatcher | null;
  draining: boolean;
  /** Last intent per `agent#shell` on this project. Map value is the
   *  full `IntentUpdate` so a bootstrap `list()` is one-shot. */
  state: Map<string, IntentUpdate>;
}

function stateKey(agent: string, shell: number): string {
  return `${agent}#${shell}`;
}

export function startIntentWatcher(deps: IntentWatcherDeps): IntentWatcher {
  const slots = new Map<number, Slot>();

  const add = (project: { id: number; path: string }): void => {
    if (slots.has(project.id)) return;
    const metaideDir = join(project.path, INTENT_DIR);
    const intentPath = join(project.path, INTENT_RELPATH);
    if (maybeRotateIntent(intentPath)) {
      log.info('[intent] rotated oversized intent file', { projectId: project.id, path: intentPath });
    }
    const slot: Slot = {
      projectId: project.id,
      path: intentPath,
      offset: existsSync(intentPath) ? statSync(intentPath).size : 0,
      watcher: null,
      dirWatcher: null,
      draining: false,
      state: new Map(),
    };
    const attachFileWatcher = (): void => {
      try {
        slot.watcher = watch(intentPath, { persistent: false }, () => void drain(slot));
      } catch (err) {
        log.debug('[intent] file watch failed', { projectId: project.id, err });
      }
    };
    if (existsSync(intentPath)) {
      attachFileWatcher();
    } else {
      // Watch `.metaide/` so the first touch from the agent is picked
      // up without a metaIDE restart. Create the dir first so fs.watch
      // has something to watch.
      try { mkdirSync(metaideDir, { recursive: true }); } catch { /* nbd */ }
      try {
        slot.dirWatcher = watch(metaideDir, { persistent: false }, (_ev, name) => {
          if (name === INTENT_FILE && existsSync(intentPath) && !slot.watcher) {
            slot.offset = 0;
            attachFileWatcher();
            void drain(slot);
          }
        });
      } catch (err) {
        log.debug('[intent] dir watch failed', { projectId: project.id, err });
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
      if (size < slot.offset) slot.offset = 0;
      if (size === slot.offset) return;
      const stream = createReadStream(slot.path, { start: slot.offset, end: size - 1, encoding: 'utf8' });
      let buf = '';
      for await (const chunk of stream) buf += chunk;
      slot.offset = size;
      const lines = buf.split('\n');
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        ingestLine(slot, line);
      }
    } catch (err) {
      log.warn('[intent] drain failed', { projectId: slot.projectId, err });
    } finally {
      slot.draining = false;
    }
  };

  const ingestLine = (slot: Slot, line: string): void => {
    let parsed: unknown;
    try { parsed = JSON.parse(line); }
    catch { log.debug('[intent] non-JSON line ignored', { projectId: slot.projectId, line: line.slice(0, 200) }); return; }
    const req = validateIntentLine(parsed);
    if (!req) {
      log.debug('[intent] malformed line ignored', { projectId: slot.projectId, line: line.slice(0, 200) });
      return;
    }
    const update: IntentUpdate = {
      agent: req.from.agent,
      shell: req.from.shell,
      text: req.text.slice(0, INTENT_TEXT_MAX),
      ts: new Date().toISOString(),
    };
    const prev = slot.state.get(stateKey(update.agent, update.shell));
    // Dedupe: identical text from the same shell is just a retry; the
    // renderer doesn't need to re-render idle timers for nothing.
    if (prev && prev.text === update.text) return;
    slot.state.set(stateKey(update.agent, update.shell), update);
    try { deps.onChanged({ projectId: slot.projectId, update }); }
    catch (err) { log.warn('[intent] onChanged threw', { projectId: slot.projectId, err }); }
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
    list(projectId) {
      const slot = slots.get(projectId);
      if (!slot) return [];
      return Array.from(slot.state.values());
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

interface IntentLine {
  from: { agent: string; shell: number };
  text: string;
}

function validateIntentLine(raw: unknown): IntentLine | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const from = o.from && typeof o.from === 'object' ? (o.from as Record<string, unknown>) : null;
  if (!from) return null;
  const agent = typeof from.agent === 'string' ? from.agent : null;
  const shell = typeof from.shell === 'number' ? from.shell : null;
  if (!agent || shell === null) return null;
  const text = typeof o.text === 'string' ? o.text.trim() : null;
  if (!text) return null;
  return { from: { agent, shell }, text };
}

export const __test__ = { validateIntentLine };
