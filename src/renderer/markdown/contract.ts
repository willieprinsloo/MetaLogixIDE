/**
 * Shared contract for the Markdown preview pipeline: the markup the
 * renderer emits and the DOM hook reads, and the diagram renderer seam.
 * Every slice and the E2E suite agree on these names; change them here only.
 */

export type EffectiveTheme = 'light' | 'dark';

export type DiagramResult = { ok: true; svg: string } | { ok: false; message: string };

/** Renders one diagram source to SVG. Never throws; failures come back as values. */
export interface DiagramRenderer {
  render(source: string, theme: EffectiveTheme, container: Element): Promise<DiagramResult>;
}

export type MermaidBlockState = 'pending' | 'rendered' | 'error';

export const MARKDOWN_PREVIEW_TESTID = 'markdown-preview';

export const MERMAID_BLOCK_CLASS = 'mermaid-block';
export const MERMAID_SOURCE_CLASS = 'mermaid-source';
export const MERMAID_OUTPUT_CLASS = 'mermaid-output';
export const MERMAID_ERROR_CLASS = 'mermaid-error';

export const MERMAID_STATE_ATTR = 'data-mermaid-state';
export const MERMAID_THEME_ATTR = 'data-mermaid-theme';

export const MERMAID_ERROR_PREFIX = 'Mermaid error: ';
export const MERMAID_EMPTY_MESSAGE = 'Diagram source is empty';

export const MATH_ERROR_CLASS = 'math-error';
