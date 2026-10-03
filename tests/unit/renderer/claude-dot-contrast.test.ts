/**
 * Verifies AC21: the busy/blocked dot colours clear WCAG 3:1 non-text
 * contrast against each theme's panel fill (measured, per plan §2 finding
 * 1, composited over black in the dark theme and over white in light,
 * since the panel itself is translucent), and the accent-row ring colour
 * clears 3:1 against both themes' accent. Colours and backgrounds are
 * parsed straight out of `styles.css` rather than hardcoded, so a colour
 * regression there fails this test.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const cssPath = resolve(__dirname, '../../../src/renderer/styles.css');
const css = readFileSync(cssPath, 'utf8');

type Rgb = [number, number, number];
type Rgba = [number, number, number, number];

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

function parseColor(value: string): Rgba {
  const rgba = /rgba?\(([^)]+)\)/.exec(value);
  if (rgba?.[1] !== undefined) {
    const parts = rgba[1].split(',').map((s) => parseFloat(s.trim()));
    const [r, g, b, a] = parts;
    if (r === undefined || g === undefined || b === undefined) throw new Error(`unparseable colour: ${value}`);
    return [r, g, b, a ?? 1];
  }
  const hex = /^#([0-9a-fA-F]{6})$/.exec(value);
  const n = hex?.[1];
  if (n !== undefined) {
    return [parseInt(n.slice(0, 2), 16), parseInt(n.slice(2, 4), 16), parseInt(n.slice(4, 6), 16), 1];
  }
  throw new Error(`unparseable colour: ${value}`);
}

function compositeOver(fg: Rgba, bg: Rgb): Rgb {
  const [r, g, b, a] = fg;
  return [r * a + bg[0] * (1 - a), g * a + bg[1] * (1 - a), b * a + bg[2] * (1 - a)];
}

function relativeLuminance([r, g, b]: Rgb): number {
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [lighter, darker] = la > lb ? [la, lb] : [lb, la];
  return (lighter + 0.05) / (darker + 0.05);
}

const darkBlock = extractBlock(css, /:root,\s*:root\[data-theme="dark"\]\s*\{/);
const lightBlock = extractBlock(css, /:root\[data-theme="light"\]\s*\{/);
const systemLightBlock = extractBlock(css, /:root:not\(\[data-theme\]\)\s*\{/);

describe('claude dot contrast (AC21)', () => {
  it('dark theme: busy and blocked clear 3:1 against the panel composited over black', () => {
    const panel = parseColor(extractVar(darkBlock, '--panel'));
    const bg = compositeOver(panel, [0, 0, 0]);
    const busy = parseColor(extractVar(darkBlock, '--claude-busy')).slice(0, 3) as Rgb;
    const blocked = parseColor(extractVar(darkBlock, '--claude-blocked')).slice(0, 3) as Rgb;
    expect(contrastRatio(busy, bg)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(blocked, bg)).toBeGreaterThanOrEqual(3);
  });

  it('light theme: busy and blocked clear 3:1 against the panel composited over white', () => {
    const panel = parseColor(extractVar(lightBlock, '--panel'));
    const bg = compositeOver(panel, [255, 255, 255]);
    const busy = parseColor(extractVar(lightBlock, '--claude-busy')).slice(0, 3) as Rgb;
    const blocked = parseColor(extractVar(lightBlock, '--claude-blocked')).slice(0, 3) as Rgb;
    expect(contrastRatio(busy, bg)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(blocked, bg)).toBeGreaterThanOrEqual(3);
  });

  it('system-theme light: busy and blocked clear 3:1 against the panel composited over white', () => {
    const panel = parseColor(extractVar(systemLightBlock, '--panel'));
    const bg = compositeOver(panel, [255, 255, 255]);
    const busy = parseColor(extractVar(systemLightBlock, '--claude-busy')).slice(0, 3) as Rgb;
    const blocked = parseColor(extractVar(systemLightBlock, '--claude-blocked')).slice(0, 3) as Rgb;
    expect(contrastRatio(busy, bg), 'busy').toBeGreaterThanOrEqual(3);
    expect(contrastRatio(blocked, bg), 'blocked').toBeGreaterThanOrEqual(3);
  });

  it('the accent-row ring (white) clears 3:1 against the active-row accent in both themes', () => {
    const white: Rgb = [255, 255, 255];
    const darkAccent = parseColor(extractVar(darkBlock, '--accent')).slice(0, 3) as Rgb;
    const lightAccent = parseColor(extractVar(lightBlock, '--accent')).slice(0, 3) as Rgb;
    expect(contrastRatio(white, darkAccent)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(white, lightAccent)).toBeGreaterThanOrEqual(3);
  });

  it('the CSS declares a ring rule (status-dot-ring) so the active-row dot actually gets it', () => {
    expect(css).toMatch(/\.status-dot-ring\s*\{[^}]*box-shadow/);
  });
});
