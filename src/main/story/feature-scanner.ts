/**
 * Scan git history for capabilities that shipped since the last refresh.
 *
 * A capability is either:
 *   - a merge commit on the project's trunk (its message starts with
 *     `Merge pull request #N` — the PR becomes the entry's natural unit)
 *   - a direct non-merge commit whose message starts with `feat:` or
 *     `fix:` (projects that push directly to main without PRs still get
 *     represented, but without the noise of refactor/chore commits)
 *
 * The output is the *input to the prompt*: we hand git-level facts over
 * to the generator, which asks Claude to turn them into prose. The
 * scanner itself makes no claim about whether a commit is user-visible —
 * that call stays with the model so we don't throw out fixes that are
 * genuinely new capability.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

/** Raw facts about one commit that `feature-generator.ts` hands to the
 *  prompt. Nothing here is prose; prose is Claude's job. */
export interface CommitCandidate {
  /** Full commit SHA on disk. */
  sha: string;
  /** Short 7-char SHA for human-readable filenames and ids. */
  shortSha: string;
  /** ISO timestamp of the commit's author date. We use author date
   *  rather than commit date because rebases can shift commit date in
   *  ways that confuse the "shipped today" framing. */
  ts: string;
  /** PR number if the commit message starts with `Merge pull request
   *  #N`; `null` for direct commits. */
  prNumber: number | null;
  /** First line of the commit message. For a merge commit this is the
   *  PR title; for a direct commit, the plain subject line. */
  title: string;
  /** Rest of the commit message after the first blank line — can be
   *  multi-paragraph, often holds the PR description for merges that
   *  used `--merge` with a body. Empty string when the body is absent. */
  body: string;
  /** Changed files, longest-common-prefix-sorted. Capped at 30 by the
   *  caller; the prompt doesn't need the whole diff file list to pick
   *  up the scope, and keeping the list short saves prompt tokens. */
  files: string[];
  /** +added / -removed lines. Gives the prompt a sense of size without
   *  needing the diff itself. */
  lines: { added: number; removed: number };
}

/** Options controlling `scanCommits()`. */
export interface ScanOptions {
  /** Project path (git repo root). */
  cwd: string;
  /** Full SHA to scan *since* — only commits after this one are returned.
   *  When omitted, the scanner returns up to `fallbackLimit` commits from
   *  the current branch's history. */
  sinceSha?: string;
  /** Cap on the scan when `sinceSha` is missing. Keeps the first run on a
   *  long-lived repo bounded. Defaults to 20 — about a working month. */
  fallbackLimit?: number;
  /** Cap on the list regardless of `sinceSha`. Used so a repo that hasn't
   *  been scanned in months doesn't spawn 300 Claude runs in one refresh. */
  hardLimit?: number;
  /** Injectable for tests. Defaults to `child_process.execFile`-based
   *  git invocation. The function MUST return stdout; stderr is
   *  swallowed because git prints progress noise there. */
  run?: (args: string[]) => Promise<string>;
}

const DEFAULT_FALLBACK = 20;
const DEFAULT_HARD_LIMIT = 50;

/**
 * Walk the first-parent history and return the commits that look like
 * shipped work. The scanner is first-parent only so we see each merged
 * PR exactly once (its own merge commit) rather than once per commit
 * on its branch.
 */
export async function scanCommits(opts: ScanOptions): Promise<CommitCandidate[]> {
  const run = opts.run ?? defaultRunner(opts.cwd);
  const fallbackLimit = opts.fallbackLimit ?? DEFAULT_FALLBACK;
  const hardLimit = opts.hardLimit ?? DEFAULT_HARD_LIMIT;

  // Format uses NUL-delimited fields plus a NUL between commits, so a
  // commit body that contains newlines doesn't break parsing.
  const FMT = '%H%x1f%h%x1f%aI%x1f%s%x1f%b';
  const COMMIT_SEP = '\x1e';
  const args = [
    'log',
    '--first-parent',
    `--pretty=format:${FMT}${COMMIT_SEP}`,
    '-n',
    String(opts.sinceSha ? hardLimit : fallbackLimit),
  ];
  if (opts.sinceSha) args.push(`${opts.sinceSha}..HEAD`);

  let raw: string;
  try {
    raw = await run(args);
  } catch {
    // Not a git repo, or git errored — return empty and let the caller
    // treat it as "nothing new". Beats throwing up the IPC stack.
    return [];
  }

  const commits: CommitCandidate[] = [];
  for (const chunk of raw.split(COMMIT_SEP)) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;
    const [sha, shortSha, ts, title, body = ''] = trimmed.split('\x1f');
    if (!sha || !shortSha || !ts || !title) continue;

    const prNumber = parsePrNumber(title);
    const isDirectFeatOrFix = prNumber === null && isUserVisiblePrefix(title);
    // Filter: merge commits (any PR) or direct feat:/fix: commits. Plain
    // chore/refactor/test/ci commits never get a feature entry — they
    // belong on the "activity" view, not the "features" view.
    if (prNumber === null && !isDirectFeatOrFix) continue;

    let files: string[] = [];
    let lines = { added: 0, removed: 0 };
    try {
      // --numstat gives `added\tremoved\tpath` per changed file. For a
      // merge commit this is the combined diff against the first parent.
      const stat = await run(['show', '--first-parent', '--numstat', '--format=', sha]);
      ({ files, lines } = parseNumstat(stat));
    } catch {
      // Keep going without file info — the prompt can still produce
      // prose from title + body alone.
    }

    commits.push({
      sha,
      shortSha,
      ts,
      prNumber,
      title,
      body,
      files,
      lines,
    });
  }

  return commits;
}

function defaultRunner(cwd: string): (args: string[]) => Promise<string> {
  return async (args) => {
    const { stdout } = await execFileP('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  };
}

/**
 * `Merge pull request #26 from doubleeye/fix-...` → `26`. Returns null
 * for any other first line so direct commits are routed down the
 * `feat:`/`fix:` path.
 */
export function parsePrNumber(subject: string): number | null {
  const m = /^Merge pull request #(\d+)\b/.exec(subject);
  return m ? Number(m[1]) : null;
}

function isUserVisiblePrefix(subject: string): boolean {
  // Conventional-commit style: `feat: …`, `fix(scope): …`, `feat!: …`.
  // We intentionally skip chore / refactor / test / ci / docs / build /
  // style / perf — perf is left out because it's rarely the thing a
  // product owner needs told; a perf win that deserves a row will
  // usually come via a PR and land through the merge path anyway.
  return /^(feat|fix)(\([^)]+\))?!?:/.test(subject);
}

function parseNumstat(raw: string): { files: string[]; lines: { added: number; removed: number } } {
  const files: string[] = [];
  let added = 0;
  let removed = 0;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split('\t');
    if (parts.length < 3) continue;
    // git prints `-` for binary files; coerce to 0 to keep the math.
    const a = Number(parts[0]);
    const r = Number(parts[1]);
    const path = parts[2];
    if (!path) continue;
    if (Number.isFinite(a)) added += a;
    if (Number.isFinite(r)) removed += r;
    files.push(path);
  }
  // Rough scope hint: path components shared across changed files.
  files.sort();
  return { files, lines: { added, removed } };
}
