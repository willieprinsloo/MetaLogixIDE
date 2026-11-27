/**
 * Metaproject ticket-ref + GitHub PR URL helpers (METAI-9).
 *
 * The scanner feeds raw PR titles and commit bodies through
 * `extractTicketRefs` to pull out any `METAI-123` style tokens, and
 * `parseGithubRepoUrl` turns a `git remote get-url origin` reading
 * (either `git@github.com:owner/repo.git` or
 * `https://github.com/owner/repo.git`) into the clean `https://`
 * web URL used to compose PR deep links in the renderer.
 *
 * Kept in shared/ so renderer tests can snapshot the extractor
 * without pulling the main-side scanner.
 */

/** Match `ABC-123` or `ABC1-123` tokens, bounded so they don't bleed
 *  into surrounding words. The identifier (prefix before the dash)
 *  must be 2–10 letters/digits starting with a letter; the number is
 *  up to 6 digits. */
const TICKET_RE = /\b([A-Z][A-Z0-9]{1,9})-(\d{1,6})\b/g;

/** Return every unique ticket reference in order of first appearance.
 *  Strips overlaps and uppercases consistently. Case-insensitive on
 *  input — `metai-7` or `MetAI-7` both land as `METAI-7`. */
export function extractTicketRefs(text: string | null | undefined): string[] {
  if (!text) return [];
  const upper = text.toUpperCase();
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of upper.matchAll(TICKET_RE)) {
    const ref = `${match[1]}-${match[2]}`;
    if (!seen.has(ref)) {
      seen.add(ref);
      out.push(ref);
    }
  }
  return out;
}

/** Normalise a `git remote get-url origin` reading to the HTTPS web
 *  URL for the repo, or `null` when the URL isn't a recognisable
 *  GitHub remote (SSH or HTTPS). Does NOT trail a slash. */
export function parseGithubRepoUrl(remote: string | null | undefined): string | null {
  if (!remote) return null;
  const raw = remote.trim();
  // SSH: `git@github.com:owner/repo.git` → `owner/repo`
  const ssh = /^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(raw);
  if (ssh && ssh[1]) return `https://github.com/${ssh[1]}`;
  // HTTPS: `https://github.com/owner/repo(.git)` → `owner/repo`
  const https = /^https?:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(raw);
  if (https && https[1]) return `https://github.com/${https[1]}`;
  return null;
}

/** Compose a GitHub PR deep link. Returns `null` when either input is
 *  missing so callers can hide the link without further checks. */
export function githubPrUrl(repoUrl: string | null, prNumber: number | null): string | null {
  if (!repoUrl || prNumber === null) return null;
  return `${repoUrl}/pull/${prNumber}`;
}
