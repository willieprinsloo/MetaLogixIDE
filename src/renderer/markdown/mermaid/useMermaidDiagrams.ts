/**
 * DOM orchestration for mermaid placeholders in the rendered preview: finds
 * each block the Markdown renderer emitted and replaces its pending state with
 * the diagram or an inline error, one block at a time.
 */
import { useEffect, type RefObject } from 'react';
import {
  MERMAID_BLOCK_CLASS,
  MERMAID_ERROR_CLASS,
  MERMAID_ERROR_PREFIX,
  MERMAID_OUTPUT_CLASS,
  MERMAID_SOURCE_CLASS,
  MERMAID_STATE_ATTR,
  MERMAID_THEME_ATTR,
  type DiagramRenderer,
  type DiagramResult,
  type EffectiveTheme,
  type MermaidBlockState,
} from '../contract';
import { mermaidRenderer } from './mermaidRenderer';

function resetBlock(block: Element): void {
  block
    .querySelectorAll(`:scope > .${MERMAID_OUTPUT_CLASS}, :scope > .${MERMAID_ERROR_CLASS}`)
    .forEach((el) => el.remove());
  block.setAttribute(MERMAID_STATE_ATTR, 'pending' satisfies MermaidBlockState);
}

function writeResult(block: Element, result: DiagramResult, theme: EffectiveTheme): void {
  const el = document.createElement('div');
  if (result.ok) {
    el.className = MERMAID_OUTPUT_CLASS;
    el.setAttribute(MERMAID_THEME_ATTR, theme);
    el.innerHTML = result.svg;
  } else {
    el.className = MERMAID_ERROR_CLASS;
    el.setAttribute('role', 'alert');
    el.textContent = MERMAID_ERROR_PREFIX + result.message;
  }
  block.append(el);
  block.setAttribute(
    MERMAID_STATE_ATTR,
    (result.ok ? 'rendered' : 'error') satisfies MermaidBlockState,
  );
}

const yieldToEvents = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Renders every mermaid placeholder inside `container` after `html` lands and
 * again on each `theme` change. Blocks render in document order with a
 * macrotask yield between them; a re-run or unmount cancels the pass in
 * flight. With no placeholders the renderer (and so mermaid) is never touched.
 */
export function useMermaidDiagrams(
  container: RefObject<HTMLElement | null>,
  html: string,
  theme: EffectiveTheme,
  renderer: DiagramRenderer = mermaidRenderer,
): void {
  useEffect(() => {
    const blocks = Array.from(container.current?.querySelectorAll(`.${MERMAID_BLOCK_CLASS}`) ?? []);
    if (blocks.length === 0) return;
    let cancelled = false;
    blocks.forEach(resetBlock);

    void (async () => {
      for (const block of blocks) {
        await yieldToEvents();
        if (cancelled || !block.isConnected) return;
        const source = block.querySelector(`.${MERMAID_SOURCE_CLASS}`)?.textContent ?? '';
        const result = await renderer.render(source, theme, block);
        if (cancelled || !block.isConnected) return;
        writeResult(block, result, theme);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [container, html, theme, renderer]);
}
