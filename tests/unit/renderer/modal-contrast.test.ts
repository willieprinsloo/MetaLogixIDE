/**
 * AC23/AC24: the D1T modal material clears WCAG 4.5:1 for panel text, muted text and the
 * highlighted row, over both `--bg` and `--panel-strong`, in every palette x theme combination,
 * and the reduced-transparency (opaque) panel clears 4.5:1 for text and muted text too. AC24: the
 * opaque panel really has alpha 1 (its relative-colour origin may not inherit `--panel-strong`'s
 * alpha). R14: `--surface-raised`, as a modal sheet resolves it, sits lighter than the glass. Colours
 * and the D1T parameters (lift, alpha, scrim darken factor) are parsed straight out of
 * `styles.css`, using the composite model in `helpers/modal-composite.ts` (the same model the
 * design record's contrast table was built from), so a regression in either file fails this test.
 * AC30 (macos-frosted-chrome): on macOS a modal composites over the translucent chrome (`--chrome-solid`
 * at `--chrome-glass-alpha` over a grey sweep of the black-to-white material envelope), the opaque
 * `--sheet-solid`, or the frosted Shell sheet and split card, read from `frosted-chrome.css` (Subtle) and
 * `frosted-glass-levels.css` (Medium, Strong) at every chrome level and terminal level (glass-settings
 * AC12, AC17); the same floors hold there with unchanged `--modal-*`.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  flatten,
  liftedAlpha,
  luminance,
  mix,
  modalSurface,
  over,
  panelBase,
  ratio,
  reducedSurface,
  rgba,
  solid,
  unders,
  type Colour,
  type ModalParams,
  type ThemeColours,
} from './helpers/modal-composite';

const cssPath = resolve(__dirname, '../../../src/renderer/styles.css');
const css = readFileSync(cssPath, 'utf8');

function extractBlock(source: string, selector: RegExp): string {
  const m = selector.exec(source);
  if (!m) throw new Error(`block not found for ${selector}`);
  let depth = 1;
  let i = m.index + m[0].length;
  const start = i;
  while (depth > 0) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') depth--;
    i++;
  }
  return source.slice(start, i - 1);
}

function extractVar(block: string, name: string): string {
  const m = new RegExp(`${name}:\\s*([^;]+);`).exec(block);
  const captured = m?.[1];
  if (captured === undefined) throw new Error(`${name} not found in block`);
  return captured.trim();
}

/** `rgba(r, g, b, a)` or `#rrggbb` -> Colour (0..1 channels). */
function parseColour(value: string): Colour {
  const rgbaMatch = /rgba?\(([^)]+)\)/.exec(value);
  if (rgbaMatch?.[1] !== undefined) {
    const parts = rgbaMatch[1].split(',').map((s) => parseFloat(s.trim()));
    const [r, g, b, a] = parts;
    if (r === undefined || g === undefined || b === undefined) throw new Error(`unparseable colour: ${value}`);
    return rgba(r, g, b, a ?? 1);
  }
  const hex = /^#([0-9a-fA-F]{6})$/.exec(value);
  if (hex?.[1] !== undefined) return solid(value);
  throw new Error(`unparseable colour: ${value}`);
}

const DARK_PALETTE_BLOCK = extractBlock(css, /:root,\s*:root\[data-theme="dark"\]\s*\{/);
const LIGHT_PALETTE_BLOCK = extractBlock(css, /:root\[data-theme="light"\]\s*\{/);
const PALETTE_BLOCKS: Record<string, { dark: string; light: string }> = {
  default: { dark: DARK_PALETTE_BLOCK, light: LIGHT_PALETTE_BLOCK },
  catppuccin: {
    dark: extractBlock(css, /:root\[data-palette="catppuccin"\]\s*\{/),
    light: extractBlock(css, /:root\[data-palette="catppuccin"\]\[data-theme="light"\]\s*\{/),
  },
  'rose-pine': {
    dark: extractBlock(css, /:root\[data-palette="rose-pine"\]\s*\{/),
    light: extractBlock(css, /:root\[data-palette="rose-pine"\]\[data-theme="light"\]\s*\{/),
  },
};

const modalSection = css.slice(css.indexOf('Modal material (D1T'));
const modalShared = extractBlock(modalSection, /:root\s*\{/);
const modalLightBlock = extractBlock(modalSection, /:root\[data-theme="light"\]\s*\{/);

/** Dark lift/alpha/scrim come from the shared block; light overrides them. */
function modalParams(dark: boolean): ModalParams {
  const block = dark ? modalShared : modalLightBlock;
  const lift = parseFloat(extractVar(block, '--modal-lift')) / 100;
  const panelAlpha = parseFloat(extractVar(block, '--modal-panel-alpha'));
  const scrim = extractVar(block, '--modal-scrim');
  if (dark) {
    const darken = /calc\(r \* ([\d.]+)\)/.exec(scrim)?.[1];
    const alpha = /\/\s*([\d.]+)\)\s*;?$/.exec(scrim)?.[1];
    if (darken === undefined || alpha === undefined) throw new Error(`could not parse dark --modal-scrim: ${scrim}`);
    return { scrimAlpha: parseFloat(alpha), scrimDarken: parseFloat(darken), lift, panelAlpha };
  }
  const alpha = /\/\s*([\d.]+)\)\s*;?$/.exec(scrim)?.[1];
  if (alpha === undefined) throw new Error(`could not parse light --modal-scrim: ${scrim}`);
  return { scrimAlpha: parseFloat(alpha), scrimDarken: 1, lift, panelAlpha };
}

const MODAL_PARAMS: Record<'dark' | 'light', ModalParams> = {
  dark: modalParams(true),
  light: modalParams(false),
};

interface Case {
  readonly palette: string;
  readonly dark: boolean;
  readonly label: string;
}

function makeCase(palette: string, dark: boolean): Case {
  return { palette, dark, label: `${palette}/${dark ? 'dark' : 'light'}` };
}

const CASES: readonly Case[] = [
  makeCase('default', true),
  makeCase('default', false),
  makeCase('catppuccin', true),
  makeCase('catppuccin', false),
  makeCase('rose-pine', true),
  makeCase('rose-pine', false),
];

function themeFor(c: Case): ThemeColours {
  const block = PALETTE_BLOCKS[c.palette]![c.dark ? 'dark' : 'light'];
  return {
    dark: c.dark,
    bg: parseColour(extractVar(block, '--bg')),
    panelStrong: parseColour(extractVar(block, '--panel-strong')),
  };
}

function textFor(c: Case): Colour {
  const block = PALETTE_BLOCKS[c.palette]![c.dark ? 'dark' : 'light'];
  return parseColour(extractVar(block, '--text'));
}

function textMutedFor(c: Case): Colour {
  const block = PALETTE_BLOCKS[c.palette]![c.dark ? 'dark' : 'light'];
  return parseColour(extractVar(block, '--text-muted'));
}

function accentFor(c: Case): Colour {
  const block = PALETTE_BLOCKS[c.palette]![c.dark ? 'dark' : 'light'];
  return parseColour(extractVar(block, '--accent'));
}

/** `--modal-text-muted` share of `--text` in `color-mix(in oklab, var(--text) N%, var(--text-muted))`. */
const MODAL_TEXT_MUTED_SHARE = (() => {
  const expr = extractVar(modalShared, '--modal-text-muted');
  const pct = /var\(--text\)\s*([\d.]+)%/.exec(expr)?.[1];
  if (pct === undefined) throw new Error(`could not parse --modal-text-muted share: ${expr}`);
  return parseFloat(pct) / 100;
})();

/** `--accent-soft` alpha in `color-mix(in oklab, var(--accent) N%, transparent)`, read from the shared surface-tokens block. */
const ACCENT_SOFT_ALPHA = (() => {
  const surfaceTokensBlock = extractBlock(css, /:root\s*\{\s*--surface-chrome:/);
  const expr = extractVar(surfaceTokensBlock, '--accent-soft');
  const pct = /var\(--accent\)\s*([\d.]+)%/.exec(expr)?.[1];
  if (pct === undefined) throw new Error(`could not parse --accent-soft alpha: ${expr}`);
  return parseFloat(pct) / 100;
})();

function modalTextMuted(c: Case): Colour {
  return mix(textFor(c), textMutedFor(c), MODAL_TEXT_MUTED_SHARE);
}

/** The highlighted row: --text over --accent-soft (the --modal-row-active fill) over the panel surface. */
function highlighted(c: Case, panelSurface: Colour): Colour {
  const fill: Colour = { c: accentFor(c).c, a: ACCENT_SOFT_ALPHA };
  return over(fill, panelSurface);
}

const GATE = 4.5;

const PANEL_BASE_EXPR = extractVar(modalShared, '--modal-panel-base');

/** Alpha of `--modal-panel-base`'s relative-colour origin: its explicit `/ a`, else `--panel-strong`'s own. */
function panelBaseOriginAlpha(theme: ThemeColours): number {
  const m = /rgb\(from var\(--panel-strong\) r g b(?:\s*\/\s*([\d.]+))?\)/.exec(PANEL_BASE_EXPR);
  if (!m) throw new Error(`could not parse --modal-panel-base origin: ${PANEL_BASE_EXPR}`);
  return m[1] === undefined ? theme.panelStrong.a : parseFloat(m[1]);
}

const SHEET_RULE = extractBlock(css, /\.modal-sheet\s*\{/);
const SURFACE_TOKENS = extractBlock(css, /:root\s*\{\s*--surface-chrome:/);
const RAISED_EXPR = /--surface-raised:/.test(SHEET_RULE)
  ? extractVar(SHEET_RULE, '--surface-raised')
  : extractVar(SURFACE_TOKENS, '--surface-raised');

/** White share of `--surface-raised`: a literal `N%` origin share, or `calc(100% - var(--modal-raised-lift))`. */
function raisedWhiteShare(dark: boolean): number {
  const literal = /\)\s*([\d.]+)%,\s*white\)/.exec(RAISED_EXPR)?.[1];
  if (literal !== undefined) return 1 - parseFloat(literal) / 100;
  if (!/calc\(100% - var\(--modal-raised-lift\)\)/.test(RAISED_EXPR)) throw new Error(`could not parse --surface-raised: ${RAISED_EXPR}`);
  return parseFloat(extractVar(dark ? modalShared : modalLightBlock, '--modal-raised-lift')) / 100;
}

/** `--surface-raised` as an element inside `.modal-sheet` resolves it: its origin token mixed toward white. */
function raisedInModal(theme: ThemeColours, params: ModalParams): Colour {
  const origin = /var\(--modal-panel-base\)/.test(RAISED_EXPR) ? panelBase(theme, params) : { c: theme.panelStrong.c, a: 1 };
  return mix(origin, solid('#ffffff'), 1 - raisedWhiteShare(theme.dark));
}

describe.each(CASES)('$label AC23 contrast', (c) => {
  const label = c.label;
  const theme = themeFor(c);
  const params = MODAL_PARAMS[c.dark ? 'dark' : 'light'];
  const base = unders(theme);
  const text = textFor(c);
  const muted = modalTextMuted(c);

  it.each(['bg', 'panelStrong'] as const)(`${label}: text clears ${GATE}:1 over %s`, (under) => {
    const surface = modalSurface(theme, params, base[under]);
    expect(ratio(text, surface)).toBeGreaterThanOrEqual(GATE);
  });

  it.each(['bg', 'panelStrong'] as const)(`${label}: muted text clears ${GATE}:1 over %s`, (under) => {
    const surface = modalSurface(theme, params, base[under]);
    expect(ratio(muted, surface)).toBeGreaterThanOrEqual(GATE);
  });

  it.each(['bg', 'panelStrong'] as const)(`${label}: the highlighted row clears ${GATE}:1 over %s`, (under) => {
    const surface = modalSurface(theme, params, base[under]);
    const row = highlighted(c, surface);
    expect(ratio(text, row)).toBeGreaterThanOrEqual(GATE);
  });

  it.each(['bg', 'panelStrong'] as const)(`${label}: reduced transparency text clears ${GATE}:1 over %s`, (under) => {
    const surface = reducedSurface(theme, params, base[under]);
    expect(ratio(text, surface)).toBeGreaterThanOrEqual(GATE);
  });

  it.each(['bg', 'panelStrong'] as const)(`${label}: reduced transparency muted text clears ${GATE}:1 over %s`, (under) => {
    const surface = reducedSurface(theme, params, base[under]);
    expect(ratio(muted, surface)).toBeGreaterThanOrEqual(GATE);
  });

  it(`${label}: the reduced-transparency panel is opaque (AC24)`, () => {
    expect(liftedAlpha(panelBaseOriginAlpha(theme), params.lift)).toBeCloseTo(1, 6);
  });

  it.each(['bg', 'panelStrong'] as const)(`${label}: a raised surface inside a modal is lighter than the glass over %s (R14)`, (under) => {
    const glass = modalSurface(theme, params, base[under]);
    expect(luminance(raisedInModal(theme, params))).toBeGreaterThan(luminance(glass));
  });

  it(`${label}: a raised surface inside a modal is lighter than the panel alone over the theme base (R14, the settings-board oracle)`, () => {
    const panel = over({ c: panelBase(theme, params).c, a: params.panelAlpha }, solid(theme.dark ? '#000000' : '#ffffff'));
    expect(luminance(raisedInModal(theme, params))).toBeGreaterThan(luminance(panel));
  });
});

const frostedCss = readFileSync(resolve(__dirname, '../../../src/renderer/frosted-chrome.css'), 'utf8');
const MAC_BLOCKS: Record<string, { dark: string; light: string }> = {
  default: {
    dark: extractBlock(frostedCss, /:root\[data-platform="mac"\],\s*:root\[data-platform="mac"\]\[data-theme="dark"\]\s*\{/),
    light: extractBlock(frostedCss, /:root\[data-platform="mac"\]\[data-theme="light"\]\s*\{/),
  },
  catppuccin: {
    dark: extractBlock(frostedCss, /:root\[data-platform="mac"\]\[data-palette="catppuccin"\]\s*\{/),
    light: extractBlock(frostedCss, /:root\[data-platform="mac"\]\[data-palette="catppuccin"\]\[data-theme="light"\]\s*\{/),
  },
  'rose-pine': {
    dark: extractBlock(frostedCss, /:root\[data-platform="mac"\]\[data-palette="rose-pine"\]\s*\{/),
    light: extractBlock(frostedCss, /:root\[data-platform="mac"\]\[data-palette="rose-pine"\]\[data-theme="light"\]\s*\{/),
  },
};

const MATERIAL_SWEEP: readonly Colour[] = Array.from({ length: 18 }, (_, i) => rgba(i * 15, i * 15, i * 15));

const levelsCss = readFileSync(resolve(__dirname, '../../../src/renderer/frosted-glass-levels.css'), 'utf8');
const CHROME_LEVELS = ['subtle', 'medium', 'strong'] as const;
type ChromeLevel = (typeof CHROME_LEVELS)[number];
const escape = (s: string): string => s.replace(/[[\]().*+?^$|]/g, '\\$&');

/** The level block for a palette block at Medium or Strong: its selector with `[data-chrome-frost]` added to each compound. */
function levelBlock(c: Case, level: Exclude<ChromeLevel, 'subtle'>): string {
  const cf = `[data-chrome-frost="${level}"]`;
  const mac = ':root[data-platform="mac"]';
  const pal = c.palette === 'default' ? '' : `[data-palette="${c.palette}"]`;
  const selectors = c.dark
    ? c.palette === 'default'
      ? [`${mac}${cf}`, `${mac}[data-theme="dark"]${cf}`]
      : [`${mac}${pal}${cf}`]
    : [`${mac}${pal}[data-theme="light"]${cf}`];
  return extractBlock(levelsCss, new RegExp(`${selectors.map(escape).join(',\\s*')}\\s*\\{`));
}

/** What sits under a modal on macOS at every level: the chrome, the Shell sheet and split card at each terminal level over each grey material, and the opaque sheet. */
function macUnders(c: Case): { readonly label: string; readonly under: Colour }[] {
  const palette = MAC_BLOCKS[c.palette]![c.dark ? 'dark' : 'light'];
  const chrome = parseColour(extractVar(palette, '--chrome-solid'));
  const sheet = parseColour(extractVar(palette, '--sheet-solid'));
  const pane = parseColour(extractVar(palette, '--pane-solid'));
  return [
    ...CHROME_LEVELS.flatMap((level) => {
      const block = level === 'subtle' ? palette : levelBlock(c, level);
      const alpha = (name: string): number => parseFloat(extractVar(block, name));
      const terminals = [
        ['subtle', '--terminal-glass-alpha', '--terminal-pane-alpha'],
        ['medium', '--terminal-medium-glass-alpha', '--terminal-medium-pane-alpha'],
        ['strong', '--terminal-strong-glass-alpha', '--terminal-strong-pane-alpha'],
      ] as const;
      return MATERIAL_SWEEP.flatMap((m, i) => {
        const onChrome = over({ c: chrome.c, a: alpha('--chrome-glass-alpha') }, m);
        return [
          { label: `chrome ${level} over grey ${i * 15}`, under: onChrome },
          ...terminals.flatMap(([tl, sheetAlpha, paneAlpha]) => {
            const onSheet = over({ c: sheet.c, a: alpha(sheetAlpha) }, onChrome);
            return [
              { label: `Shell sheet ${level}/${tl} over grey ${i * 15}`, under: onSheet },
              { label: `split card ${level}/${tl} over grey ${i * 15}`, under: over({ c: pane.c, a: alpha(paneAlpha) }, onSheet) },
            ];
          }),
        ];
      });
    }),
    { label: 'sheet', under: sheet },
  ];
}

describe.each(CASES)('$label AC30 contrast on the macOS stack at every frosted-glass level', (c) => {
  const theme = themeFor(c);
  const params = MODAL_PARAMS[c.dark ? 'dark' : 'light'];
  const text = textFor(c);
  const muted = modalTextMuted(c);
  const unders = macUnders(c);

  it('models every chrome level and terminal level', () => {
    expect(unders).toHaveLength(CHROME_LEVELS.length * MATERIAL_SWEEP.length * 7 + 1);
  });

  it(`text, muted text and the highlighted row clear ${GATE}:1 over every mac backdrop`, () => {
    for (const { label, under } of unders) {
      const surface = modalSurface(theme, params, under);
      expect(ratio(text, surface), `text, ${label}`).toBeGreaterThanOrEqual(GATE);
      expect(ratio(muted, surface), `muted, ${label}`).toBeGreaterThanOrEqual(GATE);
      expect(ratio(text, highlighted(c, surface)), `highlighted row, ${label}`).toBeGreaterThanOrEqual(GATE);
    }
  });

  it(`reduced transparency text and muted text clear ${GATE}:1 over every mac backdrop`, () => {
    for (const { label, under } of unders) {
      const surface = reducedSurface(theme, params, under);
      expect(ratio(text, surface), `text, ${label}`).toBeGreaterThanOrEqual(GATE);
      expect(ratio(muted, surface), `muted, ${label}`).toBeGreaterThanOrEqual(GATE);
    }
  });
});

describe('flatten sanity (model smoke)', () => {
  it('an opaque colour flattens to itself', () => {
    const opaque = solid('#112233');
    expect(flatten(opaque, true)).toEqual(opaque);
  });
});
