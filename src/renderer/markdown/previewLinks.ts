/**
 * Click routing for the Markdown preview: decides whether an anchor's link
 * leaves the app via the OS or is dropped. Navigation of the renderer window
 * itself is never an outcome.
 */

export type PreviewLinkAction = { kind: 'external'; url: string } | { kind: 'ignore' };

const EXTERNAL_SCHEME = /^(https?|mailto|file):/i;

/**
 * Decides what a click on a preview anchor does. `href` is the anchor's
 * `href` or `xlink:href` (null when it has neither); anchors inside a
 * diagram are always ignored. Callers always preventDefault.
 */
export function resolvePreviewLink(href: string | null, insideDiagram: boolean): PreviewLinkAction {
  if (insideDiagram || href === null || !EXTERNAL_SCHEME.test(href)) return { kind: 'ignore' };
  return { kind: 'external', url: href };
}
