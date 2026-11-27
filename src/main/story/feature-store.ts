/**
 * On-disk persistence for the Story feature feed.
 *
 * One JSON file per entry under `.metaide/story-features/<ts>--<sha>.json`,
 * plus a single `_cursor.json` that remembers the newest SHA we've
 * already covered so the next refresh knows where to resume.
 *
 * All operations are synchronous — files are small (a few KB), there are
 * tens not thousands, and the renderer is already blocked on the IPC
 * call that triggers them.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import log from 'electron-log/main';
import {
  STORY_FEATURES_CURSOR,
  STORY_FEATURES_DIR,
  featureFilename,
  type StoryFeature,
  type StoryFeatureCursor,
} from '@shared/story-feature';

export function featureDir(projectPath: string): string {
  return join(projectPath, STORY_FEATURES_DIR);
}

function cursorPath(projectPath: string): string {
  return join(featureDir(projectPath), STORY_FEATURES_CURSOR);
}

/** Read every entry on disk, newest first. Broken JSON files are skipped
 *  with a log line — the feed must not crash because one file was
 *  truncated by a crash halfway through a write. */
export function readFeatures(projectPath: string): StoryFeature[] {
  const dir = featureDir(projectPath);
  if (!existsSync(dir)) return [];
  const out: StoryFeature[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    if (name === STORY_FEATURES_CURSOR) continue;
    const full = join(dir, name);
    try {
      const raw = readFileSync(full, 'utf8');
      const parsed = JSON.parse(raw) as StoryFeature;
      if (!parsed.id || !parsed.sha || !parsed.ts || !parsed.title) continue;
      out.push(parsed);
    } catch (err) {
      log.warn('[story-features] skipping unreadable file', name, err);
    }
  }
  // Newest first — the UI's "feed" affordance relies on this order.
  out.sort((a, b) => b.ts.localeCompare(a.ts));
  return out;
}

/** Read one entry by its stable id (short SHA). Returns `null` if the
 *  file is missing or unreadable so the caller can distinguish a real
 *  entry from a stale link in the left rail. */
export function readFeature(projectPath: string, id: string): StoryFeature | null {
  const dir = featureDir(projectPath);
  if (!existsSync(dir)) return null;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(`--${id}.json`)) continue;
    try {
      const raw = readFileSync(join(dir, name), 'utf8');
      return JSON.parse(raw) as StoryFeature;
    } catch {
      return null;
    }
  }
  return null;
}

/** Write a single entry atomically — write to a `.tmp` sibling then
 *  rename. A crash midway leaves the old file (or no file) in place,
 *  never a truncated one that would break `readFeatures`. */
export function writeFeature(projectPath: string, entry: StoryFeature): void {
  const dir = featureDir(projectPath);
  mkdirSync(dir, { recursive: true });
  const filename = featureFilename(entry.ts, entry.id);
  const target = join(dir, filename);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(entry, null, 2), 'utf8');
  // fs.renameSync is atomic on the same filesystem on both macOS and Linux.
  // On Windows it throws if the target exists; we remove-then-rename only
  // when we see it. The common case (new entry) skips that branch.
  try {
    renameOverwrite(tmp, target);
  } catch (err) {
    log.warn('[story-features] rename failed', err);
  }
}

function renameOverwrite(src: string, dst: string): void {
  try {
    renameSync(src, dst);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // Windows returns EEXIST/EPERM when the destination exists. Unix
    // overwrites atomically, so this branch only fires on Windows —
    // one unlink + retry preserves the same "newer wins" semantics.
    if (code === 'EEXIST' || code === 'EPERM') {
      try { unlinkSync(dst); } catch { /* ignore */ }
      renameSync(src, dst);
    } else {
      throw err;
    }
  }
}

/** Cursor is a tiny breadcrumb: the newest SHA we've generated for.
 *  A missing / corrupt cursor is fine — `readFeatures` is the real
 *  source of truth for "what's already covered" via a set of SHAs. */
export function readCursor(projectPath: string): StoryFeatureCursor | null {
  const p = cursorPath(projectPath);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as StoryFeatureCursor;
  } catch {
    return null;
  }
}

export function writeCursor(projectPath: string, sha: string): void {
  const dir = featureDir(projectPath);
  mkdirSync(dir, { recursive: true });
  const cursor: StoryFeatureCursor = { lastSha: sha, ts: new Date().toISOString() };
  writeFileSync(cursorPath(projectPath), JSON.stringify(cursor, null, 2), 'utf8');
}

/** Set of SHAs we already have entries for. The generator uses this to
 *  dedupe against a half-populated directory — e.g. if the cursor was
 *  lost but files exist, we still skip the commits they cover. */
export function existingShas(projectPath: string): Set<string> {
  const out = new Set<string>();
  for (const entry of readFeatures(projectPath)) {
    out.add(entry.sha);
  }
  return out;
}

/** Mtime of the newest entry on disk, or `null` if the feed is empty.
 *  Used by the renderer to show "last refreshed" without a separate
 *  metadata file. */
export function newestEntryMtime(projectPath: string): string | null {
  const dir = featureDir(projectPath);
  if (!existsSync(dir)) return null;
  let newest: number | null = null;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json') || name === STORY_FEATURES_CURSOR) continue;
    try {
      const m = statSync(join(dir, name)).mtimeMs;
      if (newest === null || m > newest) newest = m;
    } catch { /* ignore */ }
  }
  return newest === null ? null : new Date(newest).toISOString();
}
