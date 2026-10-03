/**
 * markdown-it plugin for TeX math. Inline: `$…$`, `\(…\)`; display: `$$…$$`,
 * `\[…\]` (as a block or mid-paragraph). An inline `$` opens only before a
 * non-space and closes only after a non-space and before a non-digit; `\$` and
 * unmatched `\(`/`\[` stay literal. Code spans and code blocks are never math.
 * Closers come from per-source next-closer tables, so scanning stays linear
 * however many openers go unmatched.
 */
import type MarkdownIt from 'markdown-it';
import type StateBlock from 'markdown-it/lib/rules_block/state_block.mjs';
import type StateInline from 'markdown-it/lib/rules_inline/state_inline.mjs';
import { renderMath } from './renderMath';

type InlineMatch =
  | { kind: 'math'; content: string; display: boolean; end: number }
  | { kind: 'text'; content: string; end: number };

type BlockClose = { content: string; line: number };

const BLOCK_DELIMITERS = [
  { open: '$$', close: '$$' },
  { open: '\\[', close: '\\]' },
];

const BRACKET_CLOSERS: Record<string, { close: string; display: boolean }> = {
  '(': { close: '\\)', display: false },
  '[': { close: '\\]', display: true },
};

const isSpace = (ch: string | undefined): boolean => ch === undefined || /\s/.test(ch);
const isDigit = (ch: string | undefined): boolean => ch !== undefined && ch >= '0' && ch <= '9';

type CloserIndex = {
  single: Int32Array;
  double: Int32Array;
  paren: Int32Array;
  bracket: Int32Array;
  escaped: Uint8Array;
};

type ScanContext = { src: string; max: number; index: CloserIndex };

const closerIndexes = new WeakMap<StateInline, CloserIndex>();

function canCloseSingle(src: string, at: number): boolean {
  return !isSpace(src[at - 1]) && !isDigit(src[at + 1]);
}

function markEscaped(src: string): Uint8Array {
  const escaped = new Uint8Array(src.length);
  let run = 0;
  for (let i = 0; i < src.length; i++) {
    escaped[i] = run % 2;
    run = src[i] === '\\' ? run + 1 : 0;
  }
  return escaped;
}

function nextMatching(length: number, matches: (i: number) => boolean): Int32Array {
  const next = new Int32Array(length + 1);
  next[length] = -1;
  for (let i = length - 1; i >= 0; i--) next[i] = matches(i) ? i : (next[i + 1] ?? -1);
  return next;
}

function buildCloserIndex(src: string): CloserIndex {
  const escaped = markEscaped(src);
  const dollar = (i: number): boolean => src[i] === '$' && escaped[i] === 0;
  return {
    single: nextMatching(src.length, (i) => dollar(i) && canCloseSingle(src, i)),
    double: nextMatching(src.length, (i) => dollar(i) && src[i + 1] === '$'),
    paren: nextMatching(src.length, (i) => src.startsWith('\\)', i)),
    bracket: nextMatching(src.length, (i) => src.startsWith('\\]', i)),
    escaped,
  };
}

function closerIndexFor(state: StateInline): CloserIndex {
  let index = closerIndexes.get(state);
  if (!index) {
    index = buildCloserIndex(state.src);
    closerIndexes.set(state, index);
  }
  return index;
}

function charAt(ctx: ScanContext, i: number): string | undefined {
  return i < ctx.max ? ctx.src[i] : undefined;
}

function closerBefore(table: Int32Array, from: number, end: number, width: number): number {
  const at = table[from] ?? -1;
  return at >= 0 && at + width <= end ? at : -1;
}

function singleCloserAtEnd(ctx: ScanContext, from: number): number {
  const at = ctx.max - 1;
  const free = at >= from && ctx.src[at] === '$' && ctx.index.escaped[at] === 0;
  return free && !isSpace(ctx.src[at - 1]) ? at : -1;
}

function findDollarCloser(ctx: ScanContext, from: number, delim: string): number {
  if (delim === '$$') return closerBefore(ctx.index.double, from, ctx.max, 2);
  const close = closerBefore(ctx.index.single, from, ctx.max, 1);
  return close >= 0 ? close : singleCloserAtEnd(ctx, from);
}

function scanDollar(ctx: ScanContext, pos: number): InlineMatch | null {
  if (charAt(ctx, pos) !== '$') return null;
  const delim = charAt(ctx, pos + 1) === '$' ? '$$' : '$';
  const start = pos + delim.length;
  if (delim === '$' && isSpace(charAt(ctx, start))) return null;
  const close = findDollarCloser(ctx, start, delim);
  if (close <= start) {
    return delim === '$$' ? { kind: 'text', content: '$$', end: start } : null;
  }
  return {
    kind: 'math',
    content: ctx.src.slice(start, close),
    display: delim === '$$',
    end: close + delim.length,
  };
}

function scanBracket(ctx: ScanContext, pos: number): InlineMatch | null {
  const opener = charAt(ctx, pos) === '\\' ? charAt(ctx, pos + 1) : undefined;
  const closer = opener === '(' || opener === '[' ? BRACKET_CLOSERS[opener] : undefined;
  if (!closer) return null;
  const start = pos + 2;
  const table = closer.display ? ctx.index.bracket : ctx.index.paren;
  const close = closerBefore(table, start, ctx.max, 2);
  if (close < 0 || ctx.src.slice(start, close).trim() === '') return null;
  return {
    kind: 'math',
    content: ctx.src.slice(start, close),
    display: closer.display,
    end: close + closer.close.length,
  };
}

function pushInline(state: StateInline, match: InlineMatch): void {
  if (match.kind === 'text') {
    state.pending += match.content;
    return;
  }
  const token = state.push(match.display ? 'math_inline_display' : 'math_inline', 'math', 0);
  token.content = match.content;
}

function mathInline(state: StateInline, silent: boolean): boolean {
  const first = state.src[state.pos];
  if (first !== '$' && first !== '\\') return false;
  const ctx = { src: state.src, max: state.posMax, index: closerIndexFor(state) };
  const match = scanDollar(ctx, state.pos) ?? scanBracket(ctx, state.pos);
  if (!match) return false;
  if (!silent) pushInline(state, match);
  state.pos = match.end;
  return true;
}

function lineText(state: StateBlock, line: number): string {
  return state.src.slice((state.bMarks[line] ?? 0) + (state.tShift[line] ?? 0), state.eMarks[line]);
}

function lineIndent(state: StateBlock, line: number): number {
  return (state.sCount[line] ?? 0) - state.blkIndent;
}

function closerAtEnd(text: string, close: string): number {
  const trimmed = text.trimEnd();
  return trimmed.endsWith(close) ? trimmed.length - close.length : -1;
}

function scanFollowingLines(
  state: StateBlock,
  startLine: number,
  endLine: number,
  close: string,
): BlockClose | null {
  const lines: string[] = [];
  for (let line = startLine + 1; line < endLine; line++) {
    if (state.isEmpty(line) || lineIndent(state, line) < 0) return null;
    const text = lineText(state, line);
    const at = closerAtEnd(text, close);
    if (at >= 0) {
      lines.push(text.slice(0, at));
      return { content: lines.join('\n'), line };
    }
    lines.push(text);
  }
  return null;
}

function findBlockClose(
  state: StateBlock,
  startLine: number,
  endLine: number,
  first: string,
  close: string,
): BlockClose | null {
  const at = closerAtEnd(first, close);
  if (at > 0 && first.indexOf(close) === at)
    return { content: first.slice(0, at), line: startLine };
  if (first.includes(close)) return null;
  const rest = scanFollowingLines(state, startLine, endLine, close);
  return rest && { content: `${first}\n${rest.content}`, line: rest.line };
}

function mathBlock(
  state: StateBlock,
  startLine: number,
  endLine: number,
  silent: boolean,
): boolean {
  const text = lineText(state, startLine);
  const delim = BLOCK_DELIMITERS.find((d) => text.startsWith(d.open));
  if (!delim) return false;
  const found = findBlockClose(
    state,
    startLine,
    endLine,
    text.slice(delim.open.length),
    delim.close,
  );
  if (!found) return false;
  if (silent) return true;
  const token = state.push('math_block', 'math', 0);
  token.block = true;
  token.content = found.content;
  token.markup = delim.open;
  token.map = [startLine, found.line + 1];
  state.line = found.line + 1;
  return true;
}

/** Registers the math rules on `md`; formulas render through `renderMath`. */
export function mathPlugin(md: MarkdownIt): void {
  md.inline.ruler.before('escape', 'math_inline', mathInline);
  md.block.ruler.before('fence', 'math_block', mathBlock, {
    alt: ['paragraph', 'reference', 'blockquote', 'list'],
  });
  md.renderer.rules.math_inline = (tokens, idx) => renderMath(tokens[idx]?.content ?? '', false);
  md.renderer.rules.math_inline_display = (tokens, idx) =>
    renderMath(tokens[idx]?.content ?? '', true);
  md.renderer.rules.math_block = (tokens, idx) =>
    `${renderMath(tokens[idx]?.content ?? '', true)}\n`;
}
