/**
 * One-time metaproject bind-prompt (METAI-8).
 *
 * When a project opens with no `.metaproject.yaml`, the status-bar
 * chip (METAI-4) already shows "Bind" — but a chip is easy to miss.
 * This module answers "should we also show a banner nudging them to
 * link / create / skip?" and records the "skip" choice as a sentinel
 * file so the banner doesn't come back on every window reload.
 *
 * Sentinel: `.metaide/metaproject-skip` inside the project folder.
 * Presence of the file = skip. Absence = no decision yet, so prompt.
 *
 * Deliberately not using the SQLite settings store. The decision is
 * per-folder, not per-remote-id; keeping it beside the other `.metaide`
 * state means that moving a folder moves its decision too, and that
 * deleting the file brings the prompt back without needing an IDE
 * setting to flip.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

export const BIND_SKIP_RELPATH = '.metaide/metaproject-skip';

/** Full path to the sentinel. Exported for tests. */
export function bindSkipPath(projectPath: string): string {
  return join(projectPath, BIND_SKIP_RELPATH);
}

/** `true` when the user has recorded "skip" for this folder. */
export function isBindSkipped(projectPath: string): boolean {
  return existsSync(bindSkipPath(projectPath));
}

/** Idempotent. Creates the `.metaide` directory if it's missing. */
export function recordBindSkip(projectPath: string, now: () => Date = () => new Date()): void {
  const sentinelDir = join(projectPath, '.metaide');
  mkdirSync(sentinelDir, { recursive: true });
  // Content is informational — the file's existence is what matters.
  // A timestamp line makes stale files easy to audit from a shell.
  writeFileSync(bindSkipPath(projectPath), `skipped-at: ${now().toISOString()}\n`, 'utf8');
}

/** A sensible default name for the "Create new" button to prefill. The
 *  folder's basename is what a human would call it; the caller can
 *  override in the dialog before submitting. */
export function folderNameFor(projectPath: string): string {
  return basename(projectPath) || 'project';
}
