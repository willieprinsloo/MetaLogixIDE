/**
 * The Story window turns raw agent activity into human-readable "chunks"
 * — a page per session of work, written in plain English and rendered as
 * a self-contained HTML file in `.metaide/story/`.
 *
 * This shared module defines what the renderer sees: filenames, titles,
 * and timestamps. The HTML body itself lives on disk and is served to
 * the webview via `story:read`.
 */

export const STORY_DIR = '.metaide/story';

/** One entry in the chunk list the StoryTab shows down its left column. */
export interface StoryChunk {
  /** Filename within `.metaide/story/`, e.g. `2026-11-24T14-30-00--login-fix.html`. */
  file: string;
  /** ISO timestamp this chunk was generated at. */
  ts: string;
  /** Human-written title, one line — e.g. "Fixed the login redirect bug". */
  title: string;
  /** One-line teaser shown under the title in the list. */
  blurb: string;
}
