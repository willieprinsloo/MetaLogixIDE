/**
 * Agent → feedback outbox watcher.
 *
 * Agents in a metaIDE shell can't open the Report-a-bug dialog, but
 * they can write one JSON line per report to
 *   `<projectRoot>/.metaide/feedback-outbox.jsonl`
 * and this watcher picks each line up, builds a full `FeedbackReport`
 * (filling in platform context the main side can trust), and runs it
 * through the same `submitReport` pipeline the UI uses.
 *
 * Tail-only on start, same reasoning as the chat and intent outboxes:
 * a historical report has already been seen (and probably actioned)
 * by the time we come back online.
 */

import { createReadStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync, watch, type FSWatcher } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import log from 'electron-log/main';
import { FEEDBACK_LIMITS, FEEDBACK_OUTBOX_RELPATH, type FeedbackOutboxEntry, type FeedbackReport } from '@shared/feedback';
import type { RateLimiter } from './rate-limit';
import { submitReport, type SubmittedReport } from './reporter';

/** Hard cap for rotation. Each report is a small JSON line; a megabyte
 *  would be thousands. If an agent spams past the rate limiter, rotate
 *  so disk usage stays bounded. */
const FEEDBACK_MAX_BYTES = 1024 * 1024;

export { FEEDBACK_MAX_BYTES };

export interface FeedbackWatcherDeps {
  readonly projects: ReadonlyArray<{ id: number; path: string }>;
  /** Supplies the app version + the live metaproject origin at the
   *  moment a line is processed. Called per report, so a version bump
   *  or sign-in state change applies to the next report. */
  readonly runtime: () => { appVersion: string; metaprojectOrigin: string | null };
  /** Called after each report is submitted so the renderer can show a
   *  toast ("Agent claude filed a bug: …"). Omittable in tests. */
  readonly onSubmitted?: (payload: { projectId: number; submitted: SubmittedReport }) => void;
  /** Called after each rejection so the renderer can warn the user. */
  readonly onRejected?: (payload: { projectId: number; reason: string }) => void;
  /** Injectable for tests. */
  readonly limiter?: RateLimiter;
}

export interface FeedbackWatcher {
  addProject(project: { id: number; path: string }): void;
  removeProject(projectId: number): void;
  stop(): void;
}

interface Slot {
  projectId: number;
  path: string;
  offset: number;
  watcher: FSWatcher | null;
  dirWatcher: FSWatcher | null;
  draining: boolean;
  carry: string;
}

export function maybeRotateFeedback(path: string, maxBytes: number = FEEDBACK_MAX_BYTES): boolean {
  try {
    if (!existsSync(path)) return false;
    if (statSync(path).size <= maxBytes) return false;
    const old = `${path}.old`;
    if (existsSync(old)) { try { unlinkSync(old); } catch { /* best-effort */ } }
    renameSync(path, old);
    return true;
  } catch (err) {
    log.warn('[feedback] rotation failed', { path, err });
    return false;
  }
}

export function startFeedbackWatcher(deps: FeedbackWatcherDeps): FeedbackWatcher {
  const slots = new Map<number, Slot>();

  const add = (project: { id: number; path: string }): void => {
    if (slots.has(project.id)) return;
    const metaideDir = join(project.path, '.metaide');
    const feedbackPath = join(project.path, FEEDBACK_OUTBOX_RELPATH);
    if (maybeRotateFeedback(feedbackPath)) {
      log.info('[feedback] rotated oversized outbox', { projectId: project.id, path: feedbackPath });
    }
    const slot: Slot = {
      projectId: project.id,
      path: feedbackPath,
      offset: existsSync(feedbackPath) ? statSync(feedbackPath).size : 0,
      watcher: null,
      dirWatcher: null,
      draining: false,
      carry: '',
    };
    slots.set(project.id, slot);
    try { mkdirSync(metaideDir, { recursive: true }); } catch { /* ignore */ }
    try {
      slot.dirWatcher = watch(metaideDir, (_type, name) => {
        if (name === 'feedback-outbox.jsonl' && !slot.watcher) attachFileWatcher(slot);
        drain(slot);
      });
    } catch (err) {
      log.warn('[feedback] dir watch failed', { projectId: project.id, err });
    }
    if (existsSync(feedbackPath)) attachFileWatcher(slot);
  };

  function attachFileWatcher(slot: Slot): void {
    if (slot.watcher) return;
    try {
      slot.watcher = watch(slot.path, () => drain(slot));
    } catch (err) {
      log.warn('[feedback] file watch failed', { projectId: slot.projectId, err });
    }
  }

  function drain(slot: Slot): void {
    if (slot.draining) return;
    slot.draining = true;
    try {
      if (!existsSync(slot.path)) {
        slot.draining = false;
        return;
      }
      const size = statSync(slot.path).size;
      if (size < slot.offset) {
        // Truncation / rotation. Start over from the top.
        slot.offset = 0;
        slot.carry = '';
      }
      if (size === slot.offset) {
        slot.draining = false;
        return;
      }
      const stream = createReadStream(slot.path, { start: slot.offset, end: size - 1, encoding: 'utf8' });
      let acc = slot.carry;
      stream.on('data', (chunk) => { acc += chunk; });
      stream.on('end', () => {
        slot.offset = size;
        const lines = acc.split(/\r?\n/);
        slot.carry = lines.pop() ?? '';
        for (const raw of lines) {
          const line = raw.trim();
          if (!line) continue;
          handleLine(slot, line);
        }
        slot.draining = false;
        if (maybeRotateFeedback(slot.path)) {
          slot.offset = 0;
          slot.carry = '';
        }
      });
      stream.on('error', (err) => {
        log.warn('[feedback] read failed', { projectId: slot.projectId, err });
        slot.draining = false;
      });
    } catch (err) {
      log.warn('[feedback] drain failed', { projectId: slot.projectId, err });
      slot.draining = false;
    }
  }

  function handleLine(slot: Slot, line: string): void {
    let parsed: FeedbackOutboxEntry;
    try {
      parsed = JSON.parse(line) as FeedbackOutboxEntry;
    } catch {
      log.warn('[feedback] skipping malformed outbox line', { projectId: slot.projectId });
      return;
    }
    if (!parsed || typeof parsed.title !== 'string' || typeof parsed.type !== 'string' || !parsed.from?.agent) {
      log.warn('[feedback] skipping shape-invalid outbox line', { projectId: slot.projectId });
      return;
    }
    if (parsed.type !== 'bug' && parsed.type !== 'idea') {
      log.warn('[feedback] skipping unsupported type', { type: parsed.type });
      return;
    }
    const { appVersion, metaprojectOrigin } = deps.runtime();
    const report: FeedbackReport = {
      type: parsed.type,
      title: parsed.title.slice(0, FEEDBACK_LIMITS.titleMax),
      description: (parsed.description ?? '').slice(0, FEEDBACK_LIMITS.descriptionMax),
      source: { kind: 'agent', agent: parsed.from.agent, shellIndex: Math.max(0, Math.trunc(parsed.from.shell ?? 0)) },
      context: {
        appVersion,
        osPlatform: process.platform,
        osRelease: os.release(),
        terminalEngine: 'unknown',
        composedAt: new Date().toISOString(),
      },
    };
    const result = submitReport(report, { origin: metaprojectOrigin, limiter: deps.limiter });
    if (!result.ok || !result.submitted) {
      log.warn('[feedback] agent report rejected', { projectId: slot.projectId, agent: parsed.from.agent, reason: result.message });
      deps.onRejected?.({ projectId: slot.projectId, reason: result.message ?? 'rejected' });
      return;
    }
    deps.onSubmitted?.({ projectId: slot.projectId, submitted: result.submitted });
  }

  const remove = (projectId: number): void => {
    const slot = slots.get(projectId);
    if (!slot) return;
    slot.watcher?.close();
    slot.dirWatcher?.close();
    slots.delete(projectId);
  };

  const stop = (): void => {
    for (const slot of slots.values()) {
      slot.watcher?.close();
      slot.dirWatcher?.close();
    }
    slots.clear();
  };

  for (const p of deps.projects) add(p);

  return { addProject: add, removeProject: remove, stop };
}
