/**
 * Helpers for the Mermaid app-palette suite (tests/e2e/mermaid-palette.spec.ts).
 *
 * The colour oracle here is deliberately independent of the code under test:
 * it parses the browser's computed colours, composites them itself and
 * computes WCAG contrast itself. Only the shared contract constants
 * (`REFERENCE_MATERIALS`, `BG_LAYERS`, thresholds) are imported.
 *
 * Text is paired with what it actually sits on by hit-testing, not by class
 * name: every visible text leaf is sampled at three points across its box,
 * and the shapes painted under each point (SVG fills that contain the point,
 * HTML backgrounds) are composited over the theme's reference backgrounds.
 * A mis-paired selector cannot produce a false pass that way.
 */

import {
  expect,
  _electron as electron,
  type ElectronApplication,
  type Locator,
  type Page,
} from '@playwright/test';
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  MARKDOWN_PREVIEW_TESTID,
  MERMAID_BLOCK_CLASS,
  MERMAID_OUTPUT_CLASS,
  MERMAID_STATE_ATTR,
  MERMAID_THEME_ATTR,
  type EffectiveTheme,
} from '../../../src/renderer/markdown/contract';
import {
  BG_LAYERS,
  REFERENCE_MATERIALS,
} from '../../../src/renderer/markdown/mermaid/paletteContract';

export const PROJECT = 'palproj';
const FIXTURES = resolve(process.cwd(), 'tests/e2e/fixtures/mermaid-palette');

export const BLOCK = `.${MERMAID_BLOCK_CLASS}`;
export const OUTPUT = `.${MERMAID_OUTPUT_CLASS}`;
export const PENDING = `${BLOCK}[${MERMAID_STATE_ATTR}="pending"]`;
export const RENDERED = `${BLOCK}[${MERMAID_STATE_ATTR}="rendered"]`;
export const ERRORED = `${BLOCK}[${MERMAID_STATE_ATTR}="error"]`;

/* ─────────────────────────────── colour maths ─────────────────────────────── */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface Rgba extends Rgb {
  a: number;
}

/**
 * Parses the colour forms the browser's computed style produces
 * (`rgb()`/`rgba()`, comma or space separated, optional `/ alpha`) plus hex.
 * Returns null for `none`, `transparent`-less keywords and paint servers.
 */
export function parseColour(value: string): Rgba | null {
  const v = value.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,8})$/.exec(v);
  if (hex) {
    const h = hex[1] ?? '';
    const full =
      h.length === 3 || h.length === 4
        ? h
            .split('')
            .map((c) => c + c)
            .join('')
        : h;
    if (full.length !== 6 && full.length !== 8) return null;
    const n = (i: number) => parseInt(full.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: full.length === 8 ? n(6) / 255 : 1 };
  }
  if (v === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  const fn = /^rgba?\(([^)]*)\)$/.exec(v);
  if (!fn) return null;
  const parts = (fn[1] ?? '')
    .replace('/', ' ')
    .split(/[\s,]+/)
    .filter(Boolean);
  if (parts.length < 3) return null;
  const channel = (p: string) => (p.endsWith('%') ? (parseFloat(p) * 255) / 100 : parseFloat(p));
  const alpha =
    parts[3] === undefined
      ? 1
      : parts[3].endsWith('%')
        ? parseFloat(parts[3]) / 100
        : parseFloat(parts[3]);
  const [r, g, b] = parts.slice(0, 3).map(channel);
  if ([r, g, b, alpha].some((x) => x === undefined || Number.isNaN(x))) return null;
  return { r: r as number, g: g as number, b: b as number, a: alpha };
}

/** Parses a colour that must be a concrete colour; throws with `what` in the message otherwise. */
export function mustParse(value: string, what: string): Rgba {
  const c = parseColour(value);
  if (!c) throw new Error(`${what}: not a concrete colour: ${JSON.stringify(value)}`);
  return c;
}

/** Source-over compositing in sRGB space, as Chromium paints it. */
export function over(src: Rgba, dst: Rgb): Rgb {
  return {
    r: src.r * src.a + dst.r * (1 - src.a),
    g: src.g * src.a + dst.g * (1 - src.a),
    b: src.b * src.a + dst.b * (1 - src.a),
  };
}

function channelLuminance(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.1 relative luminance. */
export function luminance(c: Rgb): number {
  return (
    0.2126 * channelLuminance(c.r) + 0.7152 * channelLuminance(c.g) + 0.0722 * channelLuminance(c.b)
  );
}

/** WCAG 2.1 contrast ratio. */
export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

export function toHex(c: Rgb): string {
  const h = (x: number) =>
    Math.max(0, Math.min(255, Math.round(x)))
      .toString(16)
      .padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

/** HSL hue in degrees and saturation in [0, 1]. */
export function hueSat(c: Rgb): { hue: number; sat: number } {
  const r = c.r / 255;
  const g = c.g / 255;
  const b = c.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const l = (max + min) / 2;
  if (d === 0) return { hue: 0, sat: 0 };
  const sat = d / (1 - Math.abs(2 * l - 1));
  let hue: number;
  if (max === r) hue = ((g - b) / d) % 6;
  else if (max === g) hue = (b - r) / d + 2;
  else hue = (r - g) / d + 4;
  return { hue: (hue * 60 + 360) % 360, sat };
}

export function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** Normalises a computed colour string to `#rrggbb`, or null if it is not a concrete colour. */
export function hexOf(value: string): string | null {
  const c = parseColour(value);
  return c && c.a > 0 ? toHex(c) : null;
}

/* ─────────────────────────────── app harness ─────────────────────────────── */

export interface PaletteIde {
  app: ElectronApplication;
  win: Page;
  pageErrors: string[];
  cleanup: () => Promise<void>;
}

/** Launches the built app with an isolated profile and one project holding every palette fixture. */
export async function launchPaletteIde(label: string): Promise<PaletteIde> {
  const mockClaude = resolve(process.cwd(), 'scripts/mock-claude.mjs');
  const home = mkdtempSync(join(tmpdir(), `metaide-pal-${label}-home-`));
  const root = mkdtempSync(join(tmpdir(), `metaide-pal-${label}-root-`));
  const projDir = join(root, PROJECT);
  mkdirSync(projDir);
  mkdirSync(join(projDir, '.git'));
  cpSync(FIXTURES, projDir, { recursive: true });

  const app = await electron.launch({
    args: ['.', `--user-data-dir=${join(home, 'userData')}`],
    env: {
      ...process.env,
      HOME: home,
      METAIDE_TEST_MODE: '1',
      METAIDE_CLAUDE_PERMISSION_MODE: 'bypass',
      METAIDE_DEFAULT_LAUNCH_FIRST: JSON.stringify({ argv: ['node', mockClaude], env: {} }),
      METAIDE_DEFAULT_LAUNCH_SUBSEQUENT: JSON.stringify({
        argv: ['node', mockClaude, '--continue'],
        env: {},
      }),
    },
  });
  const win = await app.firstWindow();
  const ide: PaletteIde = {
    app,
    win,
    pageErrors: [],
    cleanup: async () => {
      await app.close();
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    },
  };
  win.on('pageerror', (err) => ide.pageErrors.push(err.message));
  await win.waitForLoadState('domcontentloaded');

  // Seed the root through IPC (dialogs are no-ops under METAIDE_TEST_MODE).
  await win.evaluate(async (path: string) => {
    const api = (
      window as unknown as { api: { invoke: (c: string, r: unknown) => Promise<unknown> } }
    ).api;
    await api.invoke('roots:add', { path });
  }, root);
  const projectButton = win.getByRole('button', { name: PROJECT, exact: true });
  await expect(projectButton).toBeVisible({ timeout: 10000 });
  await projectButton.click();
  await win.getByRole('button', { name: 'Files', exact: true }).click();
  await expect(fileEntry(win, 'flowchart.md')).toBeVisible({ timeout: 10000 });
  return ide;
}

function fileEntry(win: Page, name: string): Locator {
  return win.getByTestId('file-entry').filter({ has: win.getByText(name, { exact: true }) });
}

export function preview(win: Page): Locator {
  return win.getByTestId(MARKDOWN_PREVIEW_TESTID);
}

/** Effective theme as the document reports it (explicit attribute, else the OS preference). */
export async function effectiveTheme(win: Page): Promise<EffectiveTheme> {
  return win.evaluate(() => {
    const attr = document.documentElement.getAttribute('data-theme');
    if (attr === 'dark' || attr === 'light') return attr;
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });
}

/** Switches the app to `theme` through the title-bar toggle (a no-op when already there). */
export async function setTheme(win: Page, theme: EffectiveTheme): Promise<void> {
  if ((await effectiveTheme(win)) !== theme) await win.getByTestId('theme-toggle').click();
  await expect(win.locator('html')).toHaveAttribute('data-theme', theme);
}

/** Opens a fixture and returns its preview once the HTML has landed. */
export async function openFixture(win: Page, name: string): Promise<Locator> {
  await fileEntry(win, name).click();
  const p = preview(win);
  await expect(p).toBeVisible({ timeout: 10000 });
  await expect(win.getByTestId('file-preview')).toContainText(name);
  return p;
}

/**
 * Waits until the preview holds exactly `count` diagram blocks, none pending,
 * and (unless `expectRendered` is false) all rendered for `theme`.
 */
export async function settle(
  p: Locator,
  count: number,
  theme: EffectiveTheme,
  expectRendered = true,
): Promise<void> {
  await expect(p.locator(BLOCK)).toHaveCount(count, { timeout: 10000 });
  await expect(p.locator(PENDING)).toHaveCount(0, { timeout: 20000 });
  if (!expectRendered) return;
  await expect(p.locator(`${OUTPUT}[${MERMAID_THEME_ATTR}="${theme}"]`)).toHaveCount(count, {
    timeout: 15000,
  });
  await expect(p.locator(PENDING)).toHaveCount(0, { timeout: 20000 });
  await expect(p.locator(RENDERED)).toHaveCount(count);
}

/**
 * Flips the theme away and back through the toggle, waiting for the preview's
 * `count` diagrams to finish each re-render, so nothing read afterwards can
 * come from the render before the flip. `expect: 'error'` waits for every
 * block to show the inline error instead.
 */
export async function rerenderViaToggle(
  win: Page,
  p: Locator,
  count: number,
  outcome: 'rendered' | 'error' = 'rendered',
): Promise<void> {
  const theme = await effectiveTheme(win);
  for (const t of [theme === 'dark' ? 'light' : 'dark', theme] as const) {
    await setTheme(win, t);
    if (outcome === 'rendered') await settle(p, count, t);
    else {
      await expect(p.locator(ERRORED)).toHaveCount(count, { timeout: 15000 });
      await expect(p.locator(PENDING)).toHaveCount(0, { timeout: 20000 });
    }
  }
}

/** Opens a fixture in the current theme and waits for its diagrams; returns the preview. */
export async function openSettled(win: Page, name: string, count: number): Promise<Locator> {
  const p = await openFixture(win, name);
  await settle(p, count, await effectiveTheme(win));
  return p;
}

/* ─────────────────────────────── live tokens ─────────────────────────────── */

/** Raw computed value of a custom property on `<html>`, as the palette would read it. */
export async function rawToken(win: Page, name: `--${string}`): Promise<string> {
  return win.evaluate(
    (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(),
    name,
  );
}

/**
 * A token resolved to a concrete colour by the browser itself: a probe
 * element's `color` is set to `var(<name>)` and read back.
 */
export async function tokenColour(win: Page, name: `--${string}`): Promise<Rgba> {
  const value = await win.evaluate((n) => {
    const probe = document.createElement('span');
    probe.style.color = `var(${n})`;
    probe.style.display = 'none';
    document.body.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  }, name);
  return mustParse(value, `token ${name}`);
}

/**
 * The theme's two reference backgrounds: live `--bg` composited `BG_LAYERS`
 * times over each of the theme's `REFERENCE_MATERIALS` bounds.
 */
export async function readReferenceBackgrounds(
  win: Page,
  theme: EffectiveTheme,
): Promise<readonly [Rgb, Rgb]> {
  const bg = await tokenColour(win, '--bg');
  const build = (material: string): Rgb => {
    let c: Rgb = mustParse(material, `REFERENCE_MATERIALS.${theme}`);
    for (let i = 0; i < BG_LAYERS; i++) c = over(bg, c);
    return c;
  };
  const [lo, hi] = REFERENCE_MATERIALS[theme];
  return [build(lo), build(hi)] as const;
}

/**
 * Sets inline custom-property overrides on `<html>` (inline beats the theme
 * blocks); `null` removes one.
 */
export async function setTokenOverrides(
  win: Page,
  overrides: Record<`--${string}`, string | null>,
): Promise<void> {
  await win.evaluate((o) => {
    for (const [k, v] of Object.entries(o)) {
      if (v === null) document.documentElement.style.removeProperty(k);
      else document.documentElement.style.setProperty(k, v);
    }
  }, overrides);
}

/* ──────────────────────────── text / backdrop pairs ──────────────────────────── */

/** One painted layer under a sample point, topmost first. */
export interface Layer {
  colour: string;
  alpha: number;
  desc: string;
}

/** A visible text leaf, its paint, and the layers under each sample point. */
export interface TextSample {
  text: string;
  desc: string;
  fg: string;
  fgAlpha: number;
  /** One layer stack (topmost first) per sample point across the text box. */
  stacks: Layer[][];
}

/**
 * Collects every visible text leaf in a block's SVG with what is painted
 * under it. Runs in the page; hit-testing is forced on for the duration so
 * `pointer-events: none` on a shape cannot hide it from the oracle.
 */
export async function collectTextSamples(block: Locator): Promise<TextSample[]> {
  return block.evaluate((blockEl, outputSel) => {
    const svg = blockEl.querySelector(`${outputSel} svg`);
    if (!svg) throw new Error('no rendered svg in block');
    const output = svg.parentElement as Element;
    const force = document.createElement('style');
    force.textContent = `${outputSel} svg, ${outputSel} svg * { pointer-events: auto !important; }`;
    document.head.appendChild(force);

    const describe = (el: Element) =>
      `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${
        el.getAttribute('class')
          ? `.${(el.getAttribute('class') ?? '').trim().split(/\s+/).join('.')}`
          : ''
      }`;
    /** Product of `opacity` from `el` up to (and including) the output wrapper. */
    const chainOpacity = (el: Element) => {
      let o = 1;
      for (let e: Element | null = el; e && e !== output.parentElement; e = e.parentElement) {
        o *= parseFloat(getComputedStyle(e).opacity || '1');
      }
      return o;
    };
    const hasOwnText = (el: Element) =>
      Array.from(el.childNodes).some(
        (n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim() !== '',
      );

    const leaves = Array.from(svg.querySelectorAll('text, tspan, foreignObject *')).filter(
      (el) => hasOwnText(el) && !el.closest('defs, marker'),
    );
    const out: {
      text: string;
      desc: string;
      fg: string;
      fgAlpha: number;
      stacks: { colour: string; alpha: number; desc: string }[][];
    }[] = [];
    try {
      for (const el of leaves) {
        const cs = getComputedStyle(el);
        if (cs.visibility !== 'visible' || cs.display === 'none') continue;
        const isSvg = el instanceof SVGElement;
        const fg = isSvg ? cs.fill : cs.color;
        const fgAlpha = (isSvg ? parseFloat(cs.fillOpacity || '1') : 1) * chainOpacity(el);
        if (fg === 'none' || fgAlpha === 0) continue;
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        const stacks = [0.2, 0.5, 0.8].map((fx) => {
          const x = r.left + r.width * fx;
          const y = r.top + r.height / 2;
          const layers: { colour: string; alpha: number; desc: string }[] = [];
          for (const hit of document.elementsFromPoint(x, y)) {
            if (hit === document.body || hit === document.documentElement) break;
            const hs = getComputedStyle(hit);
            // The <svg> root paints like an HTML box (Mermaid may give it a
            // background-color), so only its descendants take the fill path.
            if (hit instanceof SVGElement && !(hit instanceof SVGSVGElement)) {
              if (!(hit instanceof SVGGeometryElement)) continue;
              if (hs.fill === 'none') continue;
              const ctm = hit.getScreenCTM();
              if (!ctm) continue;
              // Chromium 128's isPointInFill takes an SVGPoint, not a DOMPoint.
              const pt = (svg as SVGSVGElement).createSVGPoint();
              pt.x = x;
              pt.y = y;
              if (!hit.isPointInFill(pt.matrixTransform(ctm.inverse()))) continue;
              layers.push({
                colour: hs.fill,
                alpha: parseFloat(hs.fillOpacity || '1') * chainOpacity(hit),
                desc: describe(hit),
              });
            } else {
              const bg = hs.backgroundColor;
              if (bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') continue;
              layers.push({ colour: bg, alpha: chainOpacity(hit), desc: describe(hit) });
            }
          }
          return layers;
        });
        // The leaf plus its two nearest classed ancestors: Mermaid often puts
        // the role class on a wrapping <g> rather than on the text itself.
        const chain = [describe(el)];
        for (let a = el.parentElement; a && a !== svg && chain.length < 3; a = a.parentElement) {
          if (a.getAttribute('class')) chain.unshift(describe(a));
        }
        out.push({
          text: (el.textContent ?? '').trim(),
          desc: chain.join(' > '),
          fg,
          fgAlpha,
          stacks,
        });
      }
    } finally {
      force.remove();
    }
    return out;
  }, OUTPUT);
}

/** Where a text sits: on an opaque fill at every sample, on bare background at every sample, or mixed. */
export type Backdrop = 'fill' | 'background' | 'mixed';

export interface TextPair {
  text: string;
  desc: string;
  backdrop: Backdrop;
  fg: string;
  /** The (first) layer directly under the text, for failure messages. */
  on: string;
  /** Worst contrast across sample points and both reference backgrounds. */
  ratio: number;
  worst: { fg: string; bg: string };
}

/** Composites a layer stack (topmost first) over `base`, bottom-up. */
function compositeStack(stack: Layer[], base: Rgb): Rgb {
  let c = base;
  for (let i = stack.length - 1; i >= 0; i--) {
    const l = stack[i] as Layer;
    const col = mustParse(l.colour, `backdrop ${l.desc}`);
    c = over({ ...col, a: col.a * l.alpha }, c);
  }
  return c;
}

const OPAQUE = 0.999;

/** Scores every sample against both reference backgrounds. */
export function scoreTexts(samples: TextSample[], refs: readonly [Rgb, Rgb]): TextPair[] {
  return samples.map((s) => {
    const fgRaw = mustParse(s.fg, `text ${s.desc} "${s.text}"`);
    let ratio = Infinity;
    let worst = { fg: '', bg: '' };
    const opaqueAt = s.stacks.map((stack) =>
      stack.some((l) => mustParse(l.colour, l.desc).a * l.alpha >= OPAQUE),
    );
    for (const stack of s.stacks) {
      for (const ref of refs) {
        const bg = compositeStack(stack, ref);
        const fg = over({ ...fgRaw, a: fgRaw.a * s.fgAlpha }, bg);
        const r = contrast(fg, bg);
        if (r < ratio) {
          ratio = r;
          worst = { fg: toHex(fg), bg: toHex(bg) };
        }
      }
    }
    const allEmpty = s.stacks.every((st) => st.length === 0);
    const backdrop: Backdrop = opaqueAt.every(Boolean) ? 'fill' : allEmpty ? 'background' : 'mixed';
    return {
      text: s.text,
      desc: s.desc,
      backdrop,
      fg: s.fg,
      on: s.stacks.find((st) => st.length > 0)?.[0]?.desc ?? '(pane background)',
      ratio,
      worst,
    };
  });
}

/**
 * Texts whose colour Mermaid hard-codes where `themeVariables` cannot reach
 * it. Each is exempt only while it still carries that exact colour, so the
 * exemption lapses by itself the moment the palette does reach it.
 */
const HARD_CODED_TEXT: { why: string; desc: RegExp; fg: string }[] = [
  // Spec non-goal S7: `.commit-id, .commit-msg, .branch-label { fill: lightgrey }`.
  { why: 'gitGraph lightgrey (S7)', desc: /commit-id|commit-msg|branch-label/, fg: '#d3d3d3' },
];

export function hardCodedReason(p: TextPair): string | null {
  const hex = hexOf(p.fg);
  return HARD_CODED_TEXT.find((h) => h.desc.test(p.desc) && h.fg === hex)?.why ?? null;
}

export function formatPair(p: TextPair): string {
  return `"${p.text}" ${p.desc} on ${p.on} [${p.backdrop}]: ${p.worst.fg} on ${p.worst.bg} = ${p.ratio.toFixed(2)}:1`;
}

/* ─────────────────────────────── graphic paints ─────────────────────────────── */

export interface Paint {
  role: string;
  desc: string;
  fill: string;
  fillAlpha: number;
  stroke: string;
  strokeAlpha: number;
  strokeWidth: number;
}

/** A role name and the selector (inside the diagram SVG) of the elements that carry it. */
export interface RoleSelector {
  role: string;
  selector: string;
}

/**
 * Computed fill and stroke of every element matching each role selector.
 * With `markers`, also every marker actually referenced by a visible
 * element (arrowheads, ER cardinality markers), under role `marker`.
 */
export async function collectPaints(
  block: Locator,
  roles: RoleSelector[],
  markers = false,
): Promise<Paint[]> {
  return block.evaluate(
    (blockEl, { roles: rs, markers: withMarkers, outputSel }) => {
      const svg = blockEl.querySelector(`${outputSel} svg`);
      if (!svg) throw new Error('no rendered svg in block');
      const output = svg.parentElement as Element;
      const describe = (el: Element) =>
        `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${
          el.getAttribute('class')
            ? `.${(el.getAttribute('class') ?? '').trim().split(/\s+/).join('.')}`
            : ''
        }`;
      const chainOpacity = (el: Element, stop: Element) => {
        let o = 1;
        for (let e: Element | null = el; e && e !== stop; e = e.parentElement) {
          o *= parseFloat(getComputedStyle(e).opacity || '1');
        }
        return o;
      };
      const paintOf = (role: string, el: Element, stop: Element) => {
        const cs = getComputedStyle(el);
        const o = chainOpacity(el, stop);
        return {
          role,
          desc: describe(el),
          fill: cs.fill,
          fillAlpha: parseFloat(cs.fillOpacity || '1') * o,
          stroke: cs.stroke,
          strokeAlpha: parseFloat(cs.strokeOpacity || '1') * o,
          strokeWidth: parseFloat(cs.strokeWidth || '0'),
        };
      };
      const visible = (el: Element) => {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility !== 'visible') return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 || r.height > 0;
      };
      const out: ReturnType<typeof paintOf>[] = [];
      for (const { role, selector } of rs) {
        for (const el of Array.from(svg.querySelectorAll(selector))) {
          if (el.closest('defs, marker') || !visible(el)) continue;
          out.push(paintOf(role, el, output.parentElement as Element));
        }
      }
      if (withMarkers) {
        const ids = new Set<string>();
        for (const el of Array.from(svg.querySelectorAll('path, line, polyline'))) {
          if (el.closest('defs, marker') || !visible(el)) continue;
          const cs = getComputedStyle(el);
          for (const m of [cs.markerStart, cs.markerMid, cs.markerEnd]) {
            const id = /url\(["']?#([^"')]+)["']?\)/.exec(m ?? '')?.[1];
            if (id) ids.add(id);
          }
        }
        for (const id of ids) {
          const marker = svg.querySelector(`marker#${CSS.escape(id)}`);
          if (!marker) continue;
          for (const shape of Array.from(
            marker.querySelectorAll('path, circle, rect, polygon, line, polyline, ellipse'),
          )) {
            const p = paintOf('marker', shape, marker);
            out.push({ ...p, desc: `marker#${id} ${p.desc}` });
          }
        }
      }
      return out;
    },
    { roles, markers, outputSel: OUTPUT },
  );
}

/** Concrete colour of a paint channel, or null for `none` / paint servers / fully transparent. */
export function paintColour(value: string, alpha: number): Rgba | null {
  if (alpha <= 0) return null;
  const c = parseColour(value);
  if (!c || c.a === 0) return null;
  return { ...c, a: c.a * alpha };
}

/** Worst contrast of a paint channel against both reference backgrounds. */
export function graphicRatio(colour: Rgba, refs: readonly [Rgb, Rgb]): number {
  return Math.min(...refs.map((ref) => contrast(over(colour, ref), ref)));
}

/**
 * Every concrete colour (`#rrggbb`) painted inside a block's SVG: fill and
 * stroke of SVG elements, colour and background of HTML labels.
 */
export async function allSvgColours(block: Locator): Promise<string[]> {
  const raw = await block.evaluate((blockEl, outputSel) => {
    const svg = blockEl.querySelector(`${outputSel} svg`);
    if (!svg) throw new Error('no rendered svg in block');
    const values: string[] = [];
    for (const el of Array.from(svg.querySelectorAll('*'))) {
      const cs = getComputedStyle(el);
      if (el instanceof SVGElement) values.push(cs.fill, cs.stroke);
      else values.push(cs.color, cs.backgroundColor);
    }
    return values;
  }, OUTPUT);
  return [...new Set(raw.map(hexOf).filter((h): h is string => h !== null))];
}

/** Every `#rrggbb` string value anywhere in a (possibly nested) themeVariables map. */
export function paletteHexes(vars: Record<string, unknown>): string[] {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      const h = hexOf(v);
      if (h) out.add(h);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(vars);
  return [...out];
}
