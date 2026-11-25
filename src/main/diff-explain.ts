/**
 * Headless Claude explainer for the Diff pane's "Explain changes" button and
 * the Git panel's "Suggest commit message" button. One shared entry point —
 * two prompts, same engine. Uses the existing `runCliTurn` + `claudeArgs` +
 * `parseClaude` pieces so a project's Claude CLI config applies uniformly.
 *
 * Cache is session-scoped and per-project: the key is `projectId|kind|hash`.
 * The UI picks the hash (usually the diff's sha). A repeat request returns
 * the cached text immediately without spawning Claude again, so tabbing back
 * to a file you already explained is free.
 */
import { runCliTurn } from './group-chat/engines/run-cli';
import { claudeArgs, claudeProgress, parseClaude } from './group-chat/engines/claude';
import { npmCli } from './group-chat/engines/cli';
import {
  buildCommitMessagePrompt,
  buildExplainDiffPrompt,
  truncateDiffForPrompt,
} from '@shared/diff-explain-prompt';

const MAX_DIFF_BYTES = 128 * 1024;

export interface ExplainDiffArgs {
  projectId: number;
  projectPath: string;
  kind: 'explain' | 'commit';
  diff: string;
  /** Only for kind: 'explain'. */
  newPath?: string;
  /** Only for kind: 'explain'. */
  oldPath?: string;
  /** Opt in to the cache by passing a stable hash (usually sha1(diff)). */
  cacheHash?: string;
}

export type ExplainDiffResult =
  | { status: 'ok'; text: string; cached: boolean }
  | { status: 'error'; message: string };

const cache = new Map<string, { status: 'ok'; text: string }>();

function cacheKey(args: ExplainDiffArgs): string | null {
  if (!args.cacheHash) return null;
  return `${args.projectId}|${args.kind}|${args.cacheHash}`;
}

function buildPrompt(args: ExplainDiffArgs): string {
  const { text: diff } = truncateDiffForPrompt(args.diff, MAX_DIFF_BYTES);
  if (args.kind === 'commit') return buildCommitMessagePrompt({ diff });
  return buildExplainDiffPrompt({
    newPath: args.newPath ?? '(unknown)',
    oldPath: args.oldPath ?? args.newPath ?? '(unknown)',
    diff,
  });
}

export async function explainDiff(args: ExplainDiffArgs): Promise<ExplainDiffResult> {
  const key = cacheKey(args);
  if (key) {
    const hit = cache.get(key);
    if (hit) return { ...hit, cached: true };
  }

  const prompt = buildPrompt(args);
  const cmd = npmCli('@anthropic-ai/claude-code', 'claude');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const result = await runCliTurn({
      cmd,
      // No resume / no fork — this is a one-shot read of the diff; it must not
      // land in the user's Claude session history.
      args: claudeArgs({ forkFrom: null, engineSession: null, permission: 'auto' }),
      cwd: args.projectPath,
      text: prompt,
      progress: claudeProgress(),
      parse: parseClaude,
      signal: controller.signal,
    });
    if (!result.ok) return { status: 'error', message: result.error ?? 'Claude returned no answer' };
    const text = (result.reply ?? '').trim();
    if (!text) return { status: 'error', message: 'Claude returned an empty answer' };
    if (key) cache.set(key, { status: 'ok', text });
    return { status: 'ok', text, cached: false };
  } finally {
    clearTimeout(timer);
  }
}

/** Test-only: clear the in-memory cache between unit tests. */
export function __resetCacheForTests(): void {
  cache.clear();
}
