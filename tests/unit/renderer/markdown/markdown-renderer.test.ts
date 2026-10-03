import { describe, expect, it, vi } from 'vitest';
import { MERMAID_BLOCK_CLASS, MERMAID_SOURCE_CLASS, MERMAID_STATE_ATTR } from '../../../../src/renderer/markdown/contract';

const renderMathMock = vi.fn((tex: string, displayMode: boolean) => `<span class="katex-mock" data-display="${displayMode}">${tex}</span>`);
vi.mock('../../../../src/renderer/markdown/math/renderMath', () => ({
  renderMath: (tex: string, displayMode: boolean) => renderMathMock(tex, displayMode),
}));

const mathPluginMock = vi.fn();
vi.mock('../../../../src/renderer/markdown/math/mathPlugin', () => ({
  mathPlugin: (md: unknown) => mathPluginMock(md),
}));

// Imported after mocks so markdownRenderer picks up the mocked modules.
const { renderMarkdown } = await import('../../../../src/renderer/markdown/markdownRenderer');

describe('renderMarkdown', () => {
  it('escapes a raw <script> tag in the document body (AC18)', () => {
    const html = renderMarkdown('<script>alert(1)</script>');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes an <img onerror=...> in the document body (AC18)', () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)">');
    expect(html).not.toContain('<img src=x onerror="alert(1)">');
    expect(html).toContain('&lt;img');
  });

  it('highlights a fenced ts block via hljs (AC19)', () => {
    const html = renderMarkdown('```ts\nconst x: number = 1;\n```');
    expect(html).toContain('hljs-keyword');
  });

  it('leaves an unknown-language fence as plain escaped text (AC19)', () => {
    const html = renderMarkdown('```notalang\nsome text\n```');
    expect(html).not.toContain('hljs-keyword');
    expect(html).toContain('some text');
  });

  it('renders a mermaid fence as the pending placeholder with escaped source (AC1)', () => {
    const html = renderMarkdown('```mermaid\n<script>graph TD;A-->B;</script>\n```');
    expect(html).toContain(`class="${MERMAID_BLOCK_CLASS}"`);
    expect(html).toContain(`${MERMAID_STATE_ATTR}="pending"`);
    expect(html).toContain(`class="${MERMAID_SOURCE_CLASS}"`);
    expect(html).not.toContain('<script>graph');
    expect(html).toContain('&lt;script&gt;graph TD;A--&gt;B;&lt;/script&gt;');
  });

  it('recognizes mermaid fence info string case-insensitively with trailing attrs (AC1)', () => {
    const html = renderMarkdown('```Mermaid {x}\ngraph TD;A-->B;\n```');
    expect(html).toContain(`class="${MERMAID_BLOCK_CLASS}"`);
  });

  it('does not treat "mermaidx" as a mermaid fence', () => {
    const html = renderMarkdown('```mermaidx\ngraph TD;A-->B;\n```');
    expect(html).not.toContain(MERMAID_BLOCK_CLASS);
  });

  it('does not treat an indented code block containing mermaid-like text as a mermaid fence', () => {
    const html = renderMarkdown('    graph TD;A-->B;\n');
    expect(html).not.toContain(MERMAID_BLOCK_CLASS);
  });

  it.each(['math', 'Math', 'MATH'])('renders a %s fence via renderMath in display mode (AC10)', (word) => {
    renderMathMock.mockClear();
    const html = renderMarkdown('```' + word + '\nx^2\n```');
    expect(renderMathMock).toHaveBeenCalledWith('x^2', true);
    expect(html).toContain('katex-mock');
  });

  it.each(['mermaid', 'Mermaid', 'MERMAID'])('renders a %s fence as a placeholder (AC10)', (word) => {
    const html = renderMarkdown('```' + word + '\ngraph TD;A-->B;\n```');
    expect(html).toContain(MERMAID_BLOCK_CLASS);
  });

  it('renders an empty mermaid fence as a placeholder with empty source (AC5 path)', () => {
    const html = renderMarkdown('```mermaid\n```');
    expect(html).toContain(`class="${MERMAID_BLOCK_CLASS}"`);
    expect(html).toContain(`${MERMAID_STATE_ATTR}="pending"`);
  });

  it('registers mathPlugin on the MarkdownIt instance', () => {
    expect(mathPluginMock).toHaveBeenCalled();
  });
});
