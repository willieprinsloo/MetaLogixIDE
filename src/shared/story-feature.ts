/**
 * Story feature feed — the handoff-oriented view of the Story window.
 *
 * One entry per *capability* that shipped (a merged PR, or a direct
 * `feat:`/`fix:` commit on main), written for a non-technical owner
 * who needs to pick the solution up later. Each entry is stored as
 * its own JSON file in `.metaide/story-features/` and is additive:
 * refreshing the feed scans git history since the last entry and
 * appends new ones. Older entries are never regenerated.
 *
 * This module owns the shape of what the renderer sees. The prompt
 * that turns a commit into prose lives in `story-feature-prompt.ts`;
 * the on-disk layout lives in `src/main/story/feature-store.ts`.
 */

export const STORY_FEATURES_DIR = '.metaide/story-features';
export const STORY_FEATURES_CURSOR = '_cursor.json';

/** Whether an entry describes a user-visible capability or an
 *  invisible maintenance change. The UI dims maintenance rows and
 *  hides them behind a toggle so the main feed stays feature-focused. */
export type StoryFeatureKind = 'feature' | 'maintenance';

/** One entry in the feed. The three prose sections are stored as a
 *  single markdown blob under `body`; the renderer splits them on the
 *  `## ` headings the prompt mandates — doing the split in the model
 *  (not in code) keeps the prompt free to grow a fourth section without
 *  a schema change. */
export interface StoryFeature {
  /** Stable id — short commit SHA of the merge or direct commit. */
  id: string;
  /** Full commit SHA. The scanner uses this to know what's already
   *  covered; `id` is just the prettified form for filenames and URLs. */
  sha: string;
  /** ISO timestamp of the commit landing on main. */
  ts: string;
  /** Pull request number if this was a merge commit; `null` for direct
   *  commits. Used by the UI to link out to the forge. */
  prNumber: number | null;
  /** The line the human should read first — the PR title, or the first
   *  line of the commit message for a direct commit. */
  title: string;
  /** Headline file touched (longest common prefix of the changed files)
   *  — one-liner hint under the title in the left rail, e.g.
   *  `src/renderer/components/`. */
  scope: string;
  /** Markdown with three sections, in this order:
   *    `## What you can now do`
   *    `## Why it matters`
   *    `## Where it lives`
   *  Maintenance entries may collapse all three into a single short
   *  "No user-visible change" paragraph. */
  body: string;
  /** Feature vs. maintenance. Decided by the prompt — not by scanning
   *  commit prefixes, which lie too often. */
  kind: StoryFeatureKind;
  /** Was this entry hand-edited after generation? UI shows a small
   *  "edited" badge so the reader knows which prose Claude wrote. */
  edited: boolean;
  /** Metaproject ticket references found in the PR title or commit
   *  body — e.g. `['METAI-7', 'METAI-8']`. Deduplicated, in the order
   *  they first appear. Empty when nothing matched. Displayed as small
   *  chips on the row that link to the project's kanban. */
  ticketRefs?: string[];
}

/** The cursor records where a project's last scan left off, so the
 *  next refresh only looks at commits since that SHA. A missing or
 *  broken cursor is fine — the scanner falls back to "look at the last
 *  N merge commits" and dedupes against entries already on disk. */
export interface StoryFeatureCursor {
  /** Full SHA of the newest commit we've already made an entry for. */
  lastSha: string;
  /** ISO time the cursor was written — human-readable breadcrumb,
   *  the scanner itself doesn't read this field. */
  ts: string;
}

/** `2026-11-27T13:00:00.000Z` → `2026-11-27T13-00-00`. Filesystem-safe
 *  prefix so entries sort by time when listed. Paired with the short
 *  SHA for uniqueness: two merges in the same second produce two files. */
export function featureFilename(iso: string, shortSha: string): string {
  return `${iso.slice(0, 19).replace(/[:.]/g, '-')}--${shortSha}.json`;
}
