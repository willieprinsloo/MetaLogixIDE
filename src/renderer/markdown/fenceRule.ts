import type MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import { MERMAID_BLOCK_CLASS, MERMAID_SOURCE_CLASS, MERMAID_STATE_ATTR } from './contract';
import { renderMath } from './math/renderMath';

type RenderRule = NonNullable<InstanceType<typeof MarkdownIt>['renderer']['rules']['fence']>;

function fenceInfoWord(token: Token): string {
  const info = token.info ? token.info.trim() : '';
  return info ? (info.split(/\s+/)[0] ?? '') : '';
}

function renderMermaidBlock(token: Token, md: MarkdownIt): string {
  const source = md.utils.escapeHtml(token.content);
  return (
    `<div class="${MERMAID_BLOCK_CLASS}" ${MERMAID_STATE_ATTR}="pending">` +
    `<pre class="${MERMAID_SOURCE_CLASS}"><code>${source}</code></pre>` +
    `</div>`
  );
}

const renderToken: RenderRule = (tokens, idx, options, _env, self) =>
  self.renderToken(tokens, idx, options);

/** Overrides the fence renderer for `mermaid` and `math` fences; everything else falls through to the saved default. */
export function installFenceRule(md: MarkdownIt): void {
  const defaultFence: RenderRule = md.renderer.rules.fence ?? renderToken;

  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    if (!token) return '';
    const word = fenceInfoWord(token).toLowerCase();

    if (word === 'mermaid') {
      return renderMermaidBlock(token, md);
    }
    if (word === 'math') {
      return renderMath(token.content.trim(), true);
    }
    return defaultFence(tokens, idx, options, env, self);
  };
}
