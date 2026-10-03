/**
 * Reads the app's real theme tokens out of `src/renderer/styles.css` for the
 * palette unit tests: the dark block (`:root, :root[data-theme="dark"]`), the
 * explicit light block and the System-mode light block inside
 * `@media (prefers-color-scheme: light)`. The tests run the real tokens
 * through the palette, so a stylesheet edit is checked before merge.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { THEME_TOKEN_NAMES, type ThemeTokens } from '@renderer/markdown/mermaid/paletteContract';

export type TokenBlock = 'dark' | 'light' | 'systemLight';

const STYLESHEET = resolve(__dirname, '../../../../../src/renderer/styles.css');

const BLOCK_SELECTORS: Record<TokenBlock, RegExp> = {
  dark: /:root,\s*:root\[data-theme="dark"\]\s*\{([^}]*)\}/,
  light: /:root\[data-theme="light"\]\s*\{([^}]*)\}/,
  systemLight:
    /@media\s*\(prefers-color-scheme:\s*light\)\s*\{\s*:root:not\(\[data-theme\]\)\s*\{([^}]*)\}/,
};

function declarations(body: string): Map<string, string> {
  const withoutComments = body.replace(/\/\*[\s\S]*?\*\//g, '');
  const found = new Map<string, string>();
  for (const match of withoutComments.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    if (match[1] && match[2]) found.set(match[1], match[2].trim());
  }
  return found;
}

/** Every custom property declared in one token block of the real stylesheet. */
export function stylesheetBlock(
  block: TokenBlock,
  css = readFileSync(STYLESHEET, 'utf8'),
): Map<string, string> {
  const body = BLOCK_SELECTORS[block].exec(css)?.[1];
  if (body === undefined) throw new Error(`styles.css has no ${block} token block`);
  return declarations(body);
}

/** The palette's `ThemeTokens` from one block; throws naming the block and token if one is missing. */
export function stylesheetTokens(block: TokenBlock, css?: string): ThemeTokens {
  const values = stylesheetBlock(block, css);
  const entries = Object.entries(THEME_TOKEN_NAMES).map(([field, name]) => {
    const value = values.get(name);
    if (value === undefined) throw new Error(`styles.css ${block} block does not declare ${name}`);
    return [field, value] as const;
  });
  return Object.fromEntries(entries) as unknown as ThemeTokens;
}
