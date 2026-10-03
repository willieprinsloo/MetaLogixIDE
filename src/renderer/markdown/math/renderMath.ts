import katex, { type KatexOptions } from 'katex';
import { MATH_ERROR_CLASS } from '../contract';

const BASE_OPTIONS: KatexOptions = {
  throwOnError: true,
  trust: false,
  strict: 'ignore',
  output: 'htmlAndMathml',
  maxSize: 20,
  maxExpand: 1000,
};

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Renders TeX to KaTeX HTML (display mode wraps it in `.katex-display`). Runs
 * untrusted, so `\href`, `\url` and the `\html*` commands emit no links or
 * attributes. Never throws: any failure becomes a `span.math-error` whose body
 * is the escaped source and whose `title` is the escaped error message.
 */
export function renderMath(tex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(tex, { ...BASE_OPTIONS, displayMode });
  } catch (error) {
    return `<span class="${MATH_ERROR_CLASS}" title="${escapeHtml(errorMessage(error))}">${escapeHtml(tex)}</span>`;
  }
}
