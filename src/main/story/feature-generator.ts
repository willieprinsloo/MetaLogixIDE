/**
 * Orchestrate the "refresh" pass for the Story feature feed.
 *
 * Steps:
 *   1. Load the cursor and the set of SHAs already on disk.
 *   2. Ask the scanner for commits since the cursor (or a sensible
 *      fallback window on first run).
 *   3. For each new commit, ask Claude for the three-section handoff
 *      note and write the entry to disk.
 *   4. Advance the cursor to the newest commit we covered.
 *
 * A commit the model refuses to narrate is NOT added to the feed —
 * the cursor only moves past successfully written entries. A refusal
 * mid-batch leaves the older entries intact and the cursor on the
 * last success, so the next refresh retries the failing commits without
 * reworking the ones that already landed.
 */

import log from 'electron-log/main';
import { buildFeaturePrompt, extractKindAndBody } from '@shared/story-feature-prompt';
import type { StoryFeature } from '@shared/story-feature';
import { runCliTurn } from '../group-chat/engines/run-cli';
import { claudeArgs, claudeProgress, parseClaude } from '../group-chat/engines/claude';
import { npmCli } from '../group-chat/engines/cli';
import { scanCommits, type CommitCandidate } from './feature-scanner';
import { existingShas, readCursor, writeCursor, writeFeature } from './feature-store';

const FEATURE_TIMEOUT_MS = 60_000;

export interface RefreshOptions {
  projectPath: string;
  projectName: string;
  /** Optional cap on how many new entries to generate in one refresh.
   *  Protects against "I haven't scanned in a year, now 200 Claude calls
   *  fire at once". Defaults to 10 — about a sprint's worth. */
  maxEntries?: number;
  /** Signal emitted after each entry lands so the renderer can
   *  stream results instead of waiting for the whole batch. Optional
   *  so main-side tests can call this without an event channel. */
  onEntry?: (entry: StoryFeature) => void;
  /** Injectable Claude caller for tests. The default runs the real CLI. */
  ask?: (projectPath: string, prompt: string) => Promise<string>;
  /** Injectable scanner for tests. */
  scan?: typeof scanCommits;
}

export interface RefreshResult {
  /** Count of entries actually written this pass. */
  added: number;
  /** Count of commits the scanner surfaced but Claude failed on. The
   *  renderer surfaces this as a soft error so a flaky network doesn't
   *  look like "nothing new shipped." */
  failed: number;
  /** New cursor SHA, or `null` if nothing was written (cursor unchanged). */
  cursor: string | null;
}

export async function refreshFeatures(opts: RefreshOptions): Promise<RefreshResult> {
  const maxEntries = opts.maxEntries ?? 10;
  const ask = opts.ask ?? defaultAsk;
  const scan = opts.scan ?? scanCommits;

  const cursor = readCursor(opts.projectPath);
  const have = existingShas(opts.projectPath);

  const candidates = await scan({
    cwd: opts.projectPath,
    sinceSha: cursor?.lastSha,
  });

  // The scanner returns newest first. We generate oldest-first so the
  // cursor can advance incrementally — a crash after the 3rd of 7
  // entries still records progress at the 3rd rather than throwing
  // away the whole batch.
  const todo = candidates
    .filter((c) => !have.has(c.sha))
    .reverse()
    .slice(0, maxEntries);

  let added = 0;
  let failed = 0;
  let lastWritten: string | null = null;

  for (const commit of todo) {
    try {
      const entry = await generateOne(opts.projectName, commit, ask, opts.projectPath);
      writeFeature(opts.projectPath, entry);
      opts.onEntry?.(entry);
      lastWritten = commit.sha;
      added += 1;
    } catch (err) {
      log.warn('[story-features] generation failed for', commit.shortSha, err);
      failed += 1;
      // Keep going — one refusal shouldn't block the batch.
    }
  }

  if (lastWritten) writeCursor(opts.projectPath, lastWritten);

  return { added, failed, cursor: lastWritten };
}

async function generateOne(
  projectName: string,
  commit: CommitCandidate,
  ask: (projectPath: string, prompt: string) => Promise<string>,
  projectPath: string,
): Promise<StoryFeature> {
  const prompt = buildFeaturePrompt({
    projectName,
    prNumber: commit.prNumber,
    title: commit.title,
    body: commit.body,
    files: commit.files,
    lines: commit.lines,
  });
  const raw = await ask(projectPath, prompt);
  const { kind, body } = extractKindAndBody(raw);
  return {
    id: commit.shortSha,
    sha: commit.sha,
    ts: commit.ts,
    prNumber: commit.prNumber,
    title: commit.title,
    scope: topScope(commit.files),
    body,
    kind,
    edited: false,
  };
}

/** Longest common path prefix of the changed files — a one-line hint in
 *  the left rail that's more human than "20 files changed". Empty
 *  string when there are no files or they share nothing above the
 *  repo root. */
export function topScope(files: string[]): string {
  if (files.length === 0) return '';
  const only = files[0];
  if (files.length === 1 || only === undefined) return only ?? '';
  const split = files.map((f) => f.split('/'));
  const first = split[0]!;
  let prefix: string[] = [];
  outer: for (let i = 0; i < first.length; i++) {
    const seg = first[i]!;
    for (const parts of split) {
      if (parts[i] !== seg) break outer;
    }
    prefix.push(seg);
  }
  if (prefix.length === 0) return '';
  // Drop the trailing file name if the common prefix went all the way
  // through one file's path — we want the folder, not the file.
  if (prefix.length === first.length) prefix = prefix.slice(0, -1);
  return prefix.length === 0 ? '' : `${prefix.join('/')}/`;
}

async function defaultAsk(projectPath: string, prompt: string): Promise<string> {
  const cmd = npmCli('@anthropic-ai/claude-code', 'claude');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FEATURE_TIMEOUT_MS);
  try {
    const result = await runCliTurn({
      cmd,
      // One-shot; must NOT land in the user's own Claude session history.
      args: claudeArgs({ forkFrom: null, engineSession: null, permission: 'auto' }),
      cwd: projectPath,
      text: prompt,
      progress: claudeProgress(),
      parse: parseClaude,
      signal: controller.signal,
    });
    if (!result.ok) throw new Error(result.error ?? 'claude returned no answer');
    const reply = (result.reply ?? '').trim();
    if (!reply) throw new Error('claude returned an empty answer');
    return reply;
  } finally {
    clearTimeout(timer);
  }
}
