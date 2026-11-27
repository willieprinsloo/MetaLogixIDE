/**
 * Markdown → HTML for a story-feature entry's body.
 *
 * Deliberately kept to its own tiny markdown-it instance — the main
 * project renderer wires in highlight.js, mermaid fences and math,
 * which we don't want to pay for in a right-pane that only ever shows
 * three short sections of prose. `html: false` keeps the generated
 * output trusted even though Claude wrote it; linkify makes raw URLs
 * clickable in case the model dropped an issue link.
 */

import MarkdownIt from 'markdown-it';

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
  typographer: true,
});

export function renderStoryFeatureBody(markdown: string): string {
  return md.render(markdown.trim());
}
