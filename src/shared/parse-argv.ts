/**
 * Split a shell-like command line into argv, respecting double and single
 * quotes but WITHOUT interpreting escapes, expansions, or subshells. Used
 * by the Settings launch-command editor to preserve user intent while
 * ensuring the underlying spawn is still argv-based (never a shell string).
 *
 * Rules:
 *   - Whitespace outside quotes separates arguments.
 *   - "double quoted" and 'single quoted' spans are literal until the
 *     matching closing quote.
 *   - Unbalanced quotes are tolerated: the tail is treated as literal.
 *   - Empty input returns an empty array.
 */
export function parseArgv(input: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ' ' || ch === '\t') {
      if (cur) { out.push(cur); cur = ''; }
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}
