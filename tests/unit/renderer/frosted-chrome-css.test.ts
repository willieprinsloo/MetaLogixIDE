/**
 * Static guards on `frosted-chrome.css` and `frosted-glass-levels.css` (spec macos-frosted-chrome AC12, AC21,
 * AC25a, plan §2.1 and §4; spec macos-frosted-glass-settings AC23, AC29, D14, D15): every selector in both
 * files is gated on `:root[data-platform="mac"]`, the stylesheets key on the exact `FROST_ATTR` strings, no
 * glass surface adds a `backdrop-filter` or `filter`, each glass surface token has exactly two declarations
 * across both files (the base rule and the Reduce transparency override, which maps it to its solid source
 * and never reads a setting), every palette block and every level block declares its kind's token set, so
 * the most specific matching block always decides every token, every glass alpha stays inside the
 * visible-effect cap, and the level file holds nothing but level blocks and the D14 `--term-fg` rules.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FROST_ATTR, MAC_PLATFORM } from '@renderer/frosted-chrome-contract';

const read = (file: string): string =>
  readFileSync(resolve(__dirname, '../../../src/renderer', file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const FROSTED = read('frosted-chrome.css');
const LEVELS = read('frosted-glass-levels.css');
const CSS = `${FROSTED}\n${LEVELS}`;

interface Rule {
  readonly selectors: readonly string[];
  readonly body: string;
  readonly media: readonly string[];
}

/** Splits a selector list on the commas outside parentheses, so `:is(a, b)` stays one selector. */
function topLevelSplit(prelude: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  [...prelude].forEach((ch, i) => {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(prelude.slice(start, i).trim());
      start = i + 1;
    }
  });
  return [...parts, prelude.slice(start).trim()];
}

function rules(src: string, media: readonly string[] = []): Rule[] {
  const out: Rule[] = [];
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open < 0) break;
    let depth = 0;
    let close = open;
    for (; close < src.length; close++) {
      if (src[close] === '{') depth++;
      else if (src[close] === '}' && --depth === 0) break;
    }
    const prelude = src.slice(i, open).trim();
    const body = src.slice(open + 1, close);
    if (prelude.startsWith('@media')) out.push(...rules(body, [...media, prelude.slice(6).trim()]));
    else out.push({ selectors: topLevelSplit(prelude), body, media });
    i = close + 1;
  }
  return out;
}

const RULES = rules(CSS);
const FROSTED_RULES = rules(FROSTED);
const LEVEL_RULES = rules(LEVELS);
const GATE = `:root[${FROST_ATTR.platform}="${MAC_PLATFORM}"]`;
const RT = '(prefers-reduced-transparency: reduce)';
const GLASS = ['--surface-chrome', '--surface-terminal', '--surface-pane'] as const;
const SOLID_SOURCE: Record<(typeof GLASS)[number], string> = {
  '--surface-chrome': 'var(--chrome-solid)',
  '--surface-terminal': 'var(--sheet-solid)',
  '--surface-pane': 'var(--pane-solid)',
};

function decls(body: string): [string, string][] {
  return body
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => [d.slice(0, d.indexOf(':')).trim(), d.slice(d.indexOf(':') + 1).trim()]);
}

const PALETTE_SELECTORS = [
  `${GATE}, ${GATE}[data-theme="dark"]`,
  `${GATE}[data-theme="light"]`,
  `${GATE}:not([data-theme])`,
  ...['catppuccin', 'rose-pine'].flatMap((p) => [
    `${GATE}[data-palette="${p}"]`,
    `${GATE}[data-palette="${p}"][data-theme="light"]`,
    `${GATE}[data-palette="${p}"]:not([data-theme])`,
  ]),
];

/** Glass alphas a palette or level block sets: chrome, then the Shell sheet and split card per terminal level. */
const ALPHA_TOKENS = [
  '--chrome-glass-alpha',
  '--terminal-glass-alpha',
  '--terminal-pane-alpha',
  '--terminal-medium-glass-alpha',
  '--terminal-medium-pane-alpha',
  '--terminal-strong-glass-alpha',
  '--terminal-strong-pane-alpha',
];

/** Lift tokens both block kinds set (the Subtle values in a palette block, the level values in a level block). */
const LIFT_TOKENS = [
  '--chrome-text-muted',
  '--chrome-chip-text',
  '--terminal-text-muted',
  '--terminal-medium-text-muted',
  '--terminal-strong-text-muted',
  '--chrome-hue-pink',
  '--chrome-git-modified',
  '--chrome-git-added',
  '--chrome-git-deleted',
  '--chrome-git-untracked',
  '--chrome-accent-label',
  '--chrome-hue-cyan',
  '--chrome-hue-yellow',
  '--chrome-hue-purple',
  '--chrome-danger',
  '--chrome-agent-idle',
  '--chrome-agent-busy',
  '--chrome-agent-blocked',
  '--chrome-focus-ring',
];

/** Solids a palette block sets and a level block never touches, so every level paints the same solids, opaque panels and markdown sheet. */
const SOLID_TOKENS = ['--chrome-solid', '--sheet-solid', '--pane-solid', '--panel', '--panel-strong', '--chat-surface'];

const PALETTE_TOKENS = [...ALPHA_TOKENS, ...LIFT_TOKENS, ...SOLID_TOKENS].sort();

/** Hooks only a level block sets; at Subtle they are undeclared, so their readers fall back to the palette. */
const LEVEL_HOOKS = [
  '--chrome-text',
  '--chrome-accent-mark',
  '--terminal-text',
  '--terminal-accent-mark',
  '--terminal-agent-idle',
  '--terminal-agent-busy',
  '--terminal-agent-blocked',
];

const LEVEL_TOKENS = [...ALPHA_TOKENS, ...LIFT_TOKENS, ...LEVEL_HOOKS].sort();

const LEVELS_OF = ['medium', 'strong'] as const;

/** The level block selector for a palette block selector: each compound gains `[data-chrome-frost]` before any `:not()`. */
function levelSelector(palette: string, level: string): string {
  return palette
    .split(', ')
    .map((s) => s.replace(/(:not\(\[data-theme\]\))?$/, `[${FROST_ATTR.chromeFrost}="${level}"]$1`))
    .join(', ');
}

const LEVEL_SELECTORS = LEVELS_OF.flatMap((level) => PALETTE_SELECTORS.map((p) => levelSelector(p, level)));

function paletteBlock(selector: string, from: readonly Rule[] = FROSTED_RULES): Rule {
  const found = from.filter((r) => r.selectors.join(', ') === selector);
  expect(found, selector).toHaveLength(1);
  return found[0] as Rule;
}

describe('frosted-chrome.css and frosted-glass-levels.css', () => {
  it('has rules to check', () => {
    expect(RULES.length).toBeGreaterThan(5);
  });

  it(`gates every selector on ${GATE} (AC25a)`, () => {
    for (const rule of RULES)
      // A zero-specificity `:where(<gate> …)` prefix still gates the selector on mac.
      for (const s of rule.selectors) expect(s.startsWith(GATE) || s.startsWith(`:where(${GATE}`), s).toBe(true);
  });

  it('uses only the light colour-scheme and Reduce transparency media queries', () => {
    const queries = new Set(RULES.flatMap((r) => r.media));
    expect([...queries].sort()).toEqual(['(prefers-color-scheme: light)', RT].sort());
  });

  it('keys on the exact FROST_ATTR strings and no other data attribute besides theme, palette and the chat view', () => {
    const attrs = new Set([...CSS.matchAll(/\[(data-[\w-]+)/g)].map((m) => m[1]));
    expect([...attrs].sort()).toEqual(
      [
        FROST_ATTR.platform,
        FROST_ATTR.chromeFrost,
        FROST_ATTR.terminalFrost,
        FROST_ATTR.chromeRoot,
        FROST_ATTR.sheetContent,
        FROST_ATTR.overlay,
        'data-theme',
        'data-palette',
        'data-view',
      ].sort(),
    );
    expect(CSS).toContain(`[${FROST_ATTR.sheetContent}="shell"]`);
    expect(CSS).toContain(`[${FROST_ATTR.terminalFrost}]`);
    expect(CSS).not.toContain('[data-frost-terminal');
    expect(CSS).toContain(`[${FROST_ATTR.chromeRoot}]`);
    expect(CSS).toContain('[data-view="chat"]');
    expect(CSS).toContain(`[${FROST_ATTR.overlay}]`);
    for (const level of ['subtle', 'medium', 'strong'])
      expect(FROSTED).toContain(`[${FROST_ATTR.terminalFrost}="${level}"]`);
    for (const level of LEVELS_OF) expect(LEVELS).toContain(`[${FROST_ATTR.chromeFrost}="${level}"]`);
  });

  it('adds no backdrop-filter or filter (plan §4)', () => {
    for (const rule of RULES)
      for (const [prop] of decls(rule.body))
        expect(prop, rule.selectors.join()).not.toMatch(/(^|-)filter$/);
  });

  it.each(GLASS)(
    'declares %s exactly twice: the base rule and the Reduce transparency override',
    (name) => {
      const holders = RULES.filter((r) => decls(r.body).some(([p]) => p === name));
      expect(holders.map((r) => [r.selectors.join(', '), r.media.join(' ')])).toEqual([
        [GATE, ''],
        [GATE, RT],
      ]);
    },
  );

  it('maps every glass surface to its opaque source under Reduce transparency, without reading the setting (AC12, AC21)', () => {
    const rt = RULES.filter((r) => r.media.includes(RT));
    expect(rt.map((r) => r.selectors.join(', '))).toEqual([GATE]);
    const body = new Map(decls(rt[0]?.body ?? ''));
    for (const name of GLASS) expect(body.get(name), name).toBe(SOLID_SOURCE[name]);
    for (const attr of [FROST_ATTR.chromeFrost, FROST_ATTR.terminalFrost])
      expect(rt[0]?.selectors.join() ?? '', attr).not.toContain(attr);
  });

  it('makes html and body transparent so only the app layers sit on the material', () => {
    const rule = RULES.find(
      (r) => r.selectors.includes(GATE) && r.selectors.includes(`${GATE} body`),
    );
    expect(new Map(decls(rule?.body ?? '')).get('background')).toBe('transparent');
  });

  it.each(PALETTE_SELECTORS)(
    'palette block %s declares exactly the palette token set',
    (selector) => {
      const block = paletteBlock(selector);
      expect(
        decls(block.body)
          .map(([p]) => p)
          .sort(),
      ).toEqual(PALETTE_TOKENS);
    },
  );

  it('puts the system-follow palette blocks inside the light colour-scheme query only', () => {
    for (const selector of PALETTE_SELECTORS) {
      const block = paletteBlock(selector);
      expect(block.media, selector).toEqual(
        selector.endsWith(':not([data-theme])') ? ['(prefers-color-scheme: light)'] : [],
      );
    }
  });

  it('keeps each system-follow block identical to its explicit light block', () => {
    for (const p of ['', '[data-palette="catppuccin"]', '[data-palette="rose-pine"]']) {
      expect(decls(paletteBlock(`${GATE}${p}:not([data-theme])`).body)).toEqual(
        decls(paletteBlock(`${GATE}${p}[data-theme="light"]`).body),
      );
    }
  });

  it('sets every glass alpha inside the visible-effect cap (0 <= alpha <= 0.8745, D11), at every level', () => {
    const blocks = [
      ...PALETTE_SELECTORS.map((s) => paletteBlock(s)),
      ...LEVEL_SELECTORS.map((s) => paletteBlock(s, LEVEL_RULES)),
    ];
    for (const block of blocks) {
      const body = new Map(decls(block.body));
      for (const name of ALPHA_TOKENS) {
        const a = Number(body.get(name));
        expect(a, `${block.selectors.join()} ${name}`).toBeGreaterThanOrEqual(0);
        expect(a, `${block.selectors.join()} ${name}`).toBeLessThanOrEqual(0.8745);
      }
    }
  });

  it.each(LEVEL_SELECTORS)('level block %s declares exactly the level token set', (selector) => {
    expect(
      decls(paletteBlock(selector, LEVEL_RULES).body)
        .map(([p]) => p)
        .sort(),
    ).toEqual(LEVEL_TOKENS);
  });

  it('puts the system-follow level blocks inside the light colour-scheme query only, identical to their light block', () => {
    for (const level of LEVELS_OF)
      for (const p of ['', '[data-palette="catppuccin"]', '[data-palette="rose-pine"]']) {
        const system = paletteBlock(levelSelector(`${GATE}${p}:not([data-theme])`, level), LEVEL_RULES);
        const light = paletteBlock(levelSelector(`${GATE}${p}[data-theme="light"]`, level), LEVEL_RULES);
        expect(system.media).toEqual(['(prefers-color-scheme: light)']);
        expect(light.media).toEqual([]);
        expect(decls(system.body)).toEqual(decls(light.body));
      }
  });

  it('keeps the level hooks out of frosted-chrome.css, so Subtle reads the palette through their fallbacks', () => {
    for (const rule of FROSTED_RULES)
      for (const [p] of decls(rule.body)) expect(LEVEL_HOOKS, rule.selectors.join()).not.toContain(p);
  });

  it('holds only level blocks and D14 --term-fg rules in frosted-glass-levels.css (glass-settings D14, D15)', () => {
    const levelBlocks = new Set(LEVEL_SELECTORS);
    const termFg = LEVEL_RULES.filter((r) => !levelBlocks.has(r.selectors.join(', ')));
    expect(LEVEL_RULES.length - termFg.length).toBe(LEVEL_SELECTORS.length);
    expect(termFg.length).toBeGreaterThan(0);
    for (const rule of termFg) {
      expect(decls(rule.body).map(([p]) => p), rule.selectors.join()).toEqual(['--term-fg']);
      for (const s of rule.selectors) {
        expect(s).toMatch(/\[data-palette="(catppuccin|rose-pine)"\]/);
        expect(s).toMatch(/\[data-theme="light"\]|:not\(\[data-theme\]\)/);
        expect(s).toMatch(new RegExp(`\\[${FROST_ATTR.chromeFrost}="(medium|strong)"\\]`));
        expect(s).toContain(`[${FROST_ATTR.terminalFrost}]`);
      }
    }
  });

  it('never redeclares --accent, --text or an ANSI --term-* colour (glass-settings D14, D18)', () => {
    for (const rule of RULES)
      for (const [p] of decls(rule.body)) {
        expect(p, rule.selectors.join()).not.toBe('--accent');
        if (p.startsWith('--term-')) expect(p, rule.selectors.join()).toBe('--term-fg');
        if (p === '--text') expect(rule.selectors.join(), 'only the chrome, its resets and the frosted Shell sheet').toMatch(/data-chrome-root/);
      }
  });
});
