/**
 * AC7 (design contract 5): does the busy / blocked status dot clear WCAG 3:1 against the palette's
 * highlighted row without the white ring? The row is `--modal-row-active` (`--accent` at the
 * `--accent-soft` share) over the panel, over the scrim, over each of the flattened `--bg` and
 * `--panel-strong`, using the AC23 composite model. Every input is parsed from `styles.css`, for the
 * three palettes × light/dark. `RING_NEEDED` in `ProjectRow` must equal "any ratio < 3".
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  modalSurface,
  over,
  ratio,
  rgba,
  solid,
  unders,
  type Colour,
  type ModalParams,
  type ThemeColours,
} from './helpers/modal-composite';

vi.mock('@renderer/api', () => ({ api: { invoke: vi.fn(), on: vi.fn(() => () => undefined) } }));

const { RING_NEEDED } = await import('@renderer/components/palette/ProjectRow');

const css = readFileSync(resolve(__dirname, '../../../src/renderer/styles.css'), 'utf8');

/** Bodies of every top-level rule whose selector is exactly `selector`, in source order. */
function blocks(selector: string): string[] {
  const out: string[] = [];
  const escaped = selector.replace(/[[\]().*"=:]/g, '\\$&');
  const re = new RegExp(`(^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`, 'g');
  for (let m = re.exec(css); m; m = re.exec(css)) out.push(m[2] ?? '');
  return out;
}

function value(selector: string, name: string): string {
  for (const body of blocks(selector)) {
    const m = new RegExp(`${name}:\\s*([^;]+);`).exec(body);
    if (m?.[1]) return m[1].trim();
  }
  throw new Error(`${name} not found under ${selector}`);
}

function colour(v: string): Colour {
  const m = /rgba?\(([^)]+)\)/.exec(v);
  if (m?.[1]) {
    const [r = 0, g = 0, b = 0, a = 1] = m[1].split(',').map((s) => parseFloat(s));
    return rgba(r, g, b, a);
  }
  if (/^#[0-9a-f]{6}$/i.test(v)) return solid(v);
  throw new Error(`unparseable colour ${v}`);
}

function num(v: string, re: RegExp): number {
  const m = re.exec(v);
  if (!m?.[1]) throw new Error(`no match for ${re} in ${v}`);
  return parseFloat(m[1]);
}

function params(dark: boolean): ModalParams {
  const sel = dark ? ':root' : ':root[data-theme="light"]';
  const scrim = value(sel, '--modal-scrim');
  return {
    scrimAlpha: num(scrim, /\/\s*([\d.]+)\)\s*$/),
    scrimDarken: dark ? num(scrim, /calc\(r \* ([\d.]+)\)/) : 1,
    lift: num(value(sel, '--modal-lift'), /([\d.]+)%/) / 100,
    panelAlpha: num(value(sel, '--modal-panel-alpha'), /([\d.]+)/),
  };
}

const ACCENT_SHARE = num(value(':root', '--accent-soft'), /var\(--accent\)\s*([\d.]+)%/) / 100;

const COMBOS = [
  { id: 'default-dark', sel: ':root, :root[data-theme="dark"]', dark: true },
  { id: 'default-light', sel: ':root[data-theme="light"]', dark: false },
  { id: 'catppuccin-dark', sel: ':root[data-palette="catppuccin"]', dark: true },
  { id: 'catppuccin-light', sel: ':root[data-palette="catppuccin"][data-theme="light"]', dark: false },
  { id: 'rose-pine-dark', sel: ':root[data-palette="rose-pine"]', dark: true },
  { id: 'rose-pine-light', sel: ':root[data-palette="rose-pine"][data-theme="light"]', dark: false },
] as const;

/** The worst (lowest) dot-vs-highlighted-row ratio for one palette × appearance. */
function worstRatio(sel: string, dark: boolean): number {
  const theme: ThemeColours = { dark, bg: colour(value(sel, '--bg')), panelStrong: colour(value(sel, '--panel-strong')) };
  const accent: Colour = { c: colour(value(sel, '--accent')).c, a: ACCENT_SHARE };
  const dots = [colour(value(sel, '--agent-busy')), colour(value(sel, '--agent-blocked'))];
  const { bg, panelStrong } = unders(theme);
  const rows = [bg, panelStrong].map((under) => over(accent, modalSurface(theme, params(dark), under)));
  return Math.min(...rows.flatMap((row) => dots.map((dot) => ratio(dot, row))));
}

const RATIOS = Object.fromEntries(COMBOS.map((c) => [c.id, worstRatio(c.sel, c.dark)]));

describe('palette status dot on the highlighted row (AC7)', () => {
  it('measures all six palette × appearance combinations from styles.css', () => {
    console.info('[AC7] worst dot-vs-row ratios', RATIOS);
    expect(Object.keys(RATIOS)).toHaveLength(6);
    for (const r of Object.values(RATIOS)) expect(r).toBeGreaterThan(1);
  });

  it('parses the model inputs it relies on', () => {
    expect(ACCENT_SHARE).toBeCloseTo(0.22, 5);
    expect(params(true)).toEqual({ scrimAlpha: 0.4, scrimDarken: 0.6, lift: 0.06, panelAlpha: 0.78 });
    expect(params(false)).toEqual({ scrimAlpha: 0.3, scrimDarken: 1, lift: 0.5, panelAlpha: 0.8 });
  });

  it('ProjectRow keeps the ring exactly when some combination is below 3:1', () => {
    const needed = Object.values(RATIOS).some((r) => r < 3);
    expect(RING_NEEDED).toBe(needed);
  });
});
