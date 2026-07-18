import type { GitFileStatus } from './ipc-contract';

/**
 * Parse `git status --porcelain=v1 -b` output. Doesn't spawn — pure
 * function over the captured stdout string. Returns:
 *   - branch:  current branch name (or null on detached HEAD)
 *   - ahead:   commits ahead of upstream (0 if no upstream)
 *   - behind:  commits behind upstream (0 if no upstream)
 *   - files:   map from relPath → single GitFileStatus code
 *
 * Two-column codes (X = staged, Y = unstaged) collapse to a single
 * priority-ordered code so the UI stays simple.
 */
export interface GitStatus {
  branch: string | null;
  ahead: number;
  behind: number;
  files: Record<string, GitFileStatus>;
}

function collapse(x: string, y: string): GitFileStatus {
  // Conflict has priority.
  if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) return 'U';
  if (x === '?') return '?';                    // untracked
  if (x === '!') return '!';                    // ignored
  if (x === 'D' || y === 'D') return 'D';
  if (x === 'M' || y === 'M') return 'M';
  if (x === 'A') return 'A';
  if (x === 'R') return 'R';
  return 'M';
}

export function parseGitStatus(raw: string): GitStatus {
  const out: GitStatus = { branch: null, ahead: 0, behind: 0, files: {} };
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith('##')) {
      // Header: ## branch...upstream [ahead N, behind M]  or  ## HEAD (no branch)
      const body = line.slice(3).trim();
      if (body.startsWith('HEAD (no branch)')) {
        out.branch = null;
      } else {
        // "main...origin/main [ahead 3, behind 1]"
        const tripleDot = body.indexOf('...');
        const bracket = body.indexOf(' [');
        const branchEnd = tripleDot >= 0 ? tripleDot : (bracket >= 0 ? bracket : body.length);
        out.branch = body.slice(0, branchEnd);
        const tail = bracket >= 0 ? body.slice(bracket + 2, body.length - 1) : '';
        const aheadMatch = /ahead (\d+)/.exec(tail);
        const behindMatch = /behind (\d+)/.exec(tail);
        if (aheadMatch) out.ahead = Number(aheadMatch[1]);
        if (behindMatch) out.behind = Number(behindMatch[1]);
      }
      continue;
    }
    // "XY path"
    const xy = line.slice(0, 2);
    const rest = line.slice(3);
    const x = xy[0] ?? ' ';
    const y = xy[1] ?? ' ';
    // For rename we get " R  old -> new" — normalize to new.
    const arrow = rest.indexOf(' -> ');
    const path = arrow >= 0 ? rest.slice(arrow + 4) : rest;
    out.files[path] = collapse(x, y);
  }
  return out;
}
