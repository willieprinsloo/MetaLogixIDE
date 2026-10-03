/**
 * Rendered Markdown preview: sanitised HTML from `renderMarkdown`, mermaid
 * diagrams drawn in place, math, and link routing that never navigates the
 * renderer window.
 */
import { useMemo, useRef, type MouseEvent } from 'react';
import { api } from '@renderer/api';
import { renderMarkdown } from '@renderer/markdown/markdownRenderer';
import { MARKDOWN_PREVIEW_TESTID, MERMAID_BLOCK_CLASS } from '@renderer/markdown/contract';
import { resolvePreviewLink } from '@renderer/markdown/previewLinks';
import { useMermaidDiagrams } from '@renderer/markdown/mermaid/useMermaidDiagrams';
import { useDocumentTheme } from '@renderer/hooks/useDocumentTheme';

interface Props {
  source: string;
}

function onPreviewClick(e: MouseEvent<HTMLDivElement>): void {
  if (!(e.target instanceof Element)) return;
  const anchor = e.target.closest('a');
  if (!anchor) return;
  e.preventDefault();
  const href = anchor.getAttribute('href') ?? anchor.getAttribute('xlink:href');
  const action = resolvePreviewLink(href, anchor.closest(`.${MERMAID_BLOCK_CLASS}`) !== null);
  if (action.kind === 'external') {
    void api.invoke('app:open-external', { url: action.url }).catch((err) => console.error(err));
  }
}

/** Preview of Markdown `source`; mount only while the file is not being edited. */
export function MarkdownPreview({ source }: Props): JSX.Element {
  const html = useMemo(() => renderMarkdown(source), [source]);
  const ref = useRef<HTMLDivElement>(null);
  useMermaidDiagrams(ref, html, useDocumentTheme());
  return (
    <div
      ref={ref}
      className="markdown p-6 max-w-3xl mx-auto"
      data-testid={MARKDOWN_PREVIEW_TESTID}
      onClick={onPreviewClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
