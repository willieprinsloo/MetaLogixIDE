/**
 * Colour oracle for the shell chrome suites (chrome-dimensions.spec.ts).
 *
 * Chromium serialises `color-mix()` results as `oklab()` or `color()`. Every
 * colour here is resolved by the browser itself through `resolveColour`
 * (mermaid-palette.ts): it is painted on a 1x1 canvas and the pixel is read
 * back, so whatever syntax the computed style uses, the test sees concrete
 * sRGB channels and alpha.
 *
 * Canvas resolution, compositing and WCAG contrast live in mermaid-palette.ts.
 */

import type { Locator, Page } from '@playwright/test';
import type { EffectiveTheme } from '../../../src/renderer/markdown/contract';
import { REFERENCE_MATERIALS } from '../../../src/renderer/markdown/mermaid/paletteContract';
import { contrast, isMacPlatform, mustParse, over, readReferenceBackgrounds, resolveColour, toHex, type Rgb, type Rgba } from './mermaid-palette';

export { isMacPlatform, resolveColour };

/** Resolved `background-color` alpha (0-1) of an element, through the canvas oracle. */
export async function backgroundAlpha(win: Page, el: Locator): Promise<number> {
  return (await elementColour(win, el, 'background-color')).a;
}

/**
 * A custom property resolved through a probe's computed `color`, then through the canvas. The probe sits in
 * `<body>`, or inside `within` when given, so it inherits that element's overrides (the macOS chrome lifts).
 */
export async function resolveToken(win: Page, name: `--${string}`, within?: Locator): Promise<Rgba> {
  const computed = await (within ?? win.locator('body')).evaluate((host, n) => {
    const probe = document.createElement('span');
    probe.style.color = `var(${n})`;
    probe.style.display = 'none';
    host.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  }, name);
  return resolveColour(win, computed);
}

/** The computed `color` or `background-color` of an element, resolved through the canvas. */
export async function elementColour(win: Page, el: Locator, prop: 'color' | 'background-color'): Promise<Rgba> {
  const computed = await el.evaluate((node, p) => getComputedStyle(node).getPropertyValue(p), prop);
  return resolveColour(win, computed);
}

/** Largest per-channel difference (0–255) between two resolved colours, alpha scaled to 255. */
export function colourDistance(a: Rgba, b: Rgba): number {
  return Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b), Math.abs(a.a - b.a) * 255);
}

/** `#rrggbb@alpha`, for failure messages. */
export function fmtColour(c: Rgba): string {
  return `${toHex(c)}@${c.a.toFixed(3)}`;
}

export interface BadgeContrast {
  /** Worst contrast across the theme's reference backgrounds. */
  ratio: number;
  fill: Rgba;
  text: Rgba;
  /** Backgrounds painted under the badge, innermost first (badge fill excluded). */
  under: Rgba[];
}

/** Greys sampled across the material envelope; contrast is not monotonic in the backdrop, so the ends alone are not enough. */
const ENVELOPE_STEPS = 18;

/**
 * What the window shows under the chrome root. Non-mac: the theme's reference
 * backgrounds (`readReferenceBackgrounds`, which stand for the `--bg` that
 * `<html>` and `<body>` paint). macOS: `<html>` and `<body>` are transparent,
 * so the chrome sits straight on the vibrancy material, sampled across the
 * black-to-white `REFERENCE_MATERIALS` envelope (frosted-chrome AC15, AC17).
 */
async function windowBackdrops(win: Page, theme: EffectiveTheme): Promise<readonly Rgb[]> {
  if (!(await isMacPlatform(win))) return readReferenceBackgrounds(win, theme);
  const [loHex, hiHex] = REFERENCE_MATERIALS[theme];
  const lo = mustParse(loHex, `REFERENCE_MATERIALS.${theme}`);
  const hi = mustParse(hiHex, `REFERENCE_MATERIALS.${theme}`);
  return Array.from({ length: ENVELOPE_STEPS }, (_, i) => {
    const t = i / (ENVELOPE_STEPS - 1);
    return { r: lo.r + (hi.r - lo.r) * t, g: lo.g + (hi.g - lo.g) * t, b: lo.b + (hi.b - lo.b) * t };
  });
}

/**
 * Contrast of a badge's text against what it actually sits on: the badge
 * fill, over every painted ancestor up to (not including) `<body>` — which
 * includes the translucent `--surface-chrome` — over each window backdrop
 * (`windowBackdrops`). Returns the worst.
 */
export async function badgeContrast(win: Page, badge: Locator, theme: EffectiveTheme): Promise<BadgeContrast> {
  const layers = await badge.evaluate((el) => {
    const out: { fill: string; text: string; under: string[] } = {
      fill: getComputedStyle(el).backgroundColor,
      text: getComputedStyle(el).color,
      under: [],
    };
    for (let a = el.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (parseFloat(cs.opacity) !== 1) throw new Error(`ancestor ${a.tagName} has opacity ${cs.opacity}; the oracle does not model it`);
      out.under.push(cs.backgroundColor);
    }
    return out;
  });
  const fill = await resolveColour(win, layers.fill);
  const text = await resolveColour(win, layers.text);
  const under: Rgba[] = [];
  for (const u of layers.under) under.push(await resolveColour(win, u));

  let ratio = Infinity;
  for (const ref of await windowBackdrops(win, theme)) {
    let bg: Rgb = ref;
    for (const layer of [...under].reverse()) bg = over(layer, bg);
    bg = over(fill, bg);
    ratio = Math.min(ratio, contrast(over(text, bg), bg));
  }
  return { ratio, fill, text, under };
}
