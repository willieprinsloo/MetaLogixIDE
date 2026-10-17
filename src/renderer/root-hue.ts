/**
 * Stable colour for a sidebar root folder. The same path always maps to the
 * same palette hue token, so a root keeps its colour across launches and
 * across palettes (each palette defines the tokens; see styles.css).
 */
export const ROOT_HUE_TOKENS = ['--accent', '--hue-purple', '--hue-cyan', '--hue-yellow', '--hue-pink'] as const;
export type RootHueToken = (typeof ROOT_HUE_TOKENS)[number];

/** FNV-1a over UTF-16 code units; trailing separators are ignored so `/a/b` and `/a/b/` match. */
export function rootHueToken(path: string): RootHueToken {
  const normalized = path.replace(/[\\/]+$/u, '');
  let hash = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return ROOT_HUE_TOKENS[hash % ROOT_HUE_TOKENS.length]!;
}

/** CSS colour a hue token paints. The accent hue reads `--accent-mark`, the macOS chrome's lifted accent glyph colour, which falls back to `--accent` everywhere else. */
export function rootHueColour(token: RootHueToken): string {
  return token === '--accent' ? 'var(--accent-mark, var(--accent))' : `var(${token})`;
}

/** CSS colour value for a root folder, e.g. `var(--hue-cyan)`. */
export function rootHueVar(path: string): string {
  return rootHueColour(rootHueToken(path));
}
