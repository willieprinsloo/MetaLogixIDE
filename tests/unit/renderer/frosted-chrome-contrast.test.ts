/**
 * Contrast oracle for the macOS frosted chrome and its frosted-glass levels (spec macos-frosted-chrome AC1,
 * AC2, AC4, AC5, AC9 to AC11, AC14 to AC16, AC19, AC23, AC25, AC31, D13; spec macos-frosted-glass-settings
 * AC7, AC10 to AC17, AC21, AC23, AC25, AC31 to AC33, D8, D14, D16 to D18, D20). A small cascade engine reads
 * the real `styles.css`, `frosted-chrome.css` and `frosted-glass-levels.css`, resolves every custom property
 * on a modelled element tree (html, body, chrome root, sheet, split card, chat column, modal and overlay
 * layers) for each palette × theme combination at every chrome level × terminal level × Reduce transparency
 * state, then flattens the painted layers over a grey sweep of the black-to-white material envelope
 * (`REFERENCE_MATERIALS`). Custom properties resolve where they are declared, as in CSS, so a token captured
 * on `:root` keeps the root value inside a region that overrides its source. Frosted chrome OFF removes
 * `data-platform="mac"`, so it is the pre-#38 `BASE` state; the stored level attributes are kept on the root
 * here to prove the stylesheets ignore them. Baselines are literals computed at 26eed37 and checked against
 * the engine run without the mac attribute, and `fixtures/frost-6929753.json` records every token this engine
 * resolves at main@6929753, so Subtle is proven equal to that release. Every coloured text and indicator on
 * the chrome is inventoried in `CHROME_PAINT` and held to its floor (D16, D17); a source scan of the chrome
 * components proves the inventory complete. AC21: no per-material case is needed, because every vibrancy
 * material paints some sRGB colour, each composite channel is affine in the matching backdrop channel, so a
 * composite's luminance is monotonic in each backdrop channel and its range is bounded by the black and white
 * composites the envelope samples; the grey sweep between them covers the non-monotonic contrast in between.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CONTRAST_GRAPHIC,
  CONTRAST_TEXT,
  REFERENCE_MATERIALS,
} from '@renderer/markdown/mermaid/paletteContract';
import { FROST_ATTR, MAC_PLATFORM, type SheetContent } from '@renderer/frosted-chrome-contract';
import {
  CHROME_FROST_LEVELS,
  TERMINAL_FROST_LEVELS,
  type ChromeFrostLevel,
  type TerminalFrostLevel,
} from '@shared/frosted-glass';
import { gitStatusTextClass } from '@renderer/git-status-style';
import { ROOT_HUE_TOKENS, rootHueColour } from '@renderer/root-hue';
import { MODAL_CLASSES } from '@renderer/modal-glass';
import tailwindColors from 'tailwindcss/colors';
import { hex, luminance, ratio, type Colour } from './helpers/modal-composite';

const RENDERER = resolve(__dirname, '../../../src/renderer');
const STYLES = readFileSync(resolve(RENDERER, 'styles.css'), 'utf8');
const FROSTED = readFileSync(resolve(RENDERER, 'frosted-chrome.css'), 'utf8');
const LEVELS = readFileSync(resolve(RENDERER, 'frosted-glass-levels.css'), 'utf8');

type Spec = readonly [number, number, number];

interface Rule {
  readonly selectors: readonly string[];
  readonly decls: readonly (readonly [string, string])[];
  readonly media: readonly string[];
  readonly order: number;
}

function closingBrace(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return i;
  }
  throw new Error(`unbalanced brace at ${open}`);
}

function splitTop(src: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === sep && depth === 0) {
      parts.push(src.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(src.slice(start).trim());
  return parts.filter((p) => p.length > 0);
}

function parseDecls(body: string): [string, string][] {
  return splitTop(body, ';').flatMap((d) => {
    const colon = d.indexOf(':');
    return colon < 0
      ? []
      : [[d.slice(0, colon).trim(), d.slice(colon + 1).trim()] as [string, string]];
  });
}

/** Flat style rules with their `@media` conditions; other at-rules are skipped. */
function parseRules(css: string, orderBase: number): Rule[] {
  const rules: Rule[] = [];
  const walk = (src: string, media: readonly string[]): void => {
    let i = 0;
    while (i < src.length) {
      const open = src.indexOf('{', i);
      if (open < 0) return;
      const semi = src.indexOf(';', i);
      if (semi >= 0 && semi < open) {
        i = semi + 1;
        continue;
      }
      const prelude = src.slice(i, open).trim();
      const close = closingBrace(src, open);
      const body = src.slice(open + 1, close);
      if (prelude.startsWith('@media'))
        walk(body, [...media, prelude.slice('@media'.length).trim()]);
      else if (!prelude.startsWith('@'))
        rules.push({
          selectors: splitTop(prelude, ','),
          decls: parseDecls(body),
          media,
          order: orderBase + rules.length,
        });
      i = close + 1;
    }
  };
  walk(css.replace(/\/\*[\s\S]*?\*\//g, ''), []);
  return rules;
}

interface El {
  readonly tag: string;
  readonly root?: boolean;
  readonly attrs: Readonly<Record<string, string>>;
  readonly classes?: readonly string[];
  /** Utility-class declarations (Tailwind), cascaded as one class ahead of every stylesheet rule. */
  readonly utility?: readonly (readonly [string, string])[];
}

function addSpec(a: Spec, b: Spec): Spec {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

const TOKEN = /\[[^\]]+\]|:not\([^)]*\)|:root|::?[\w-]+(?:\([^)]*\))?|\.[\w-]+|\*|[a-z][\w-]*/gy;

function matchAttr(token: string, el: El): boolean {
  const m = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(token);
  if (!m?.[1]) return false;
  const value = el.attrs[m[1]];
  return m[2] === undefined ? value !== undefined : value === m[2];
}

function tokens(compound: string): string[] | null {
  TOKEN.lastIndex = 0;
  const found: string[] = [];
  for (let m = TOKEN.exec(compound); m; m = TOKEN.exec(compound)) found.push(m[0]);
  return found.join('') === compound ? found : null;
}

function specificity(compound: string): Spec {
  return (tokens(compound) ?? []).reduce<Spec>(
    (s, t) => {
      if (t === '*') return s;
      if (t.startsWith(':not(')) return addSpec(s, specificity(t.slice(5, -1)));
      return /^[a-z]/.test(t) ? addSpec(s, [0, 0, 1]) : addSpec(s, [0, 1, 0]);
    },
    [0, 0, 0],
  );
}

function matchToken(t: string, el: El): boolean {
  if (t === '*') return true;
  if (t === ':root') return el.root === true;
  if (t.startsWith('[')) return matchAttr(t, el);
  if (t.startsWith(':not(')) return !matchCompound(t.slice(5, -1), el);
  if (t.startsWith('.')) return el.classes?.includes(t.slice(1)) === true;
  return /^[a-z]/.test(t) && el.tag === t;
}

/** Specificity of a compound selector, or `null` when it does not match `el` (unknown parts never match). */
function matchCompound(compound: string, el: El): Spec | null {
  const parts = tokens(compound);
  return parts?.every((t) => matchToken(t, el)) ? specificity(compound) : null;
}

/** Specificity of a descendant selector against the element at the end of `path`, or `null`. */
function matchSelector(selector: string, path: readonly El[]): Spec | null {
  if (selector.includes('>') || selector.includes('+') || selector.includes('~')) return null;
  const compounds = selector.split(/\s+/);
  const last = compounds.pop();
  const target = path[path.length - 1];
  if (last === undefined || !target) return null;
  let spec = matchCompound(last, target);
  if (!spec) return null;
  let at = path.length - 2;
  for (let c = compounds.length - 1; c >= 0; c--) {
    const compound = compounds[c] ?? '';
    let found: Spec | null = null;
    for (; at >= 0 && !found; at--) found = matchCompound(compound, path[at] as El);
    if (!found) return null;
    spec = addSpec(spec, found);
  }
  return spec;
}

interface Env {
  readonly light: boolean;
  readonly reduceTransparency: boolean;
}

function mediaMatches(query: string, env: Env): boolean {
  if (/^\(prefers-color-scheme:\s*light\)$/.test(query)) return env.light;
  if (/^\(prefers-reduced-transparency:\s*reduce\)$/.test(query)) return env.reduceTransparency;
  return false;
}

function compareSpec(a: Spec, b: Spec): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** The cascaded declarations of the element at the end of `path`. */
function cascade(rules: readonly Rule[], path: readonly El[], env: Env): Map<string, string> {
  const el = path[path.length - 1] as El;
  const hits: { spec: Spec; order: number; index: number; decl: readonly [string, string] }[] = [];
  (el.utility ?? []).forEach((decl, index) =>
    hits.push({ spec: [0, 1, 0], order: -1, index, decl }),
  );
  for (const rule of rules) {
    if (!rule.media.every((q) => mediaMatches(q, env))) continue;
    const specs = rule.selectors
      .map((s) => matchSelector(s, path))
      .filter((s): s is Spec => s !== null);
    if (specs.length === 0) continue;
    const spec = specs.sort(compareSpec)[specs.length - 1] as Spec;
    rule.decls.forEach((decl, index) => hits.push({ spec, order: rule.order, index, decl }));
  }
  hits.sort((a, b) => compareSpec(a.spec, b.spec) || a.order - b.order || a.index - b.index);
  return new Map(hits.map((h) => h.decl));
}

interface Scope {
  readonly decls: Map<string, string>;
  readonly parent?: Scope;
}

function lookup(name: string, scope: Scope | undefined): { expr: string; scope: Scope } | null {
  for (let s = scope; s; s = s.parent) {
    const expr = s.decls.get(name);
    if (expr !== undefined) return { expr, scope: s };
  }
  return null;
}

function varArgs(expr: string): [string, string | undefined] {
  const [name, ...rest] = splitTop(expr.slice(4, -1), ',');
  return [name ?? '', rest.length ? rest.join(',') : undefined];
}

function evalNumber(expr: string, scope: Scope): number {
  const e = expr.trim();
  if (e.startsWith('var(')) {
    const [name, fallback] = varArgs(e);
    const hit = lookup(name, scope);
    if (hit) return evalNumber(hit.expr, hit.scope);
    if (fallback !== undefined) return evalNumber(fallback, scope);
    throw new Error(`undefined number ${name}`);
  }
  const n = Number(e);
  if (Number.isNaN(n)) throw new Error(`not a number: ${e}`);
  return n;
}

const lin = (v: number): number => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const delin = (v: number): number => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

function toOklab(rgb: readonly number[]): number[] {
  const [r, g, b] = rgb.map(lin) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function fromOklab([L = 0, A = 0, B = 0]: readonly number[]): Colour['c'] {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((v) => Math.min(1, Math.max(0, delin(v)))) as unknown as Colour['c'];
}

/** `color-mix(in oklab, x p, y)` with premultiplied alpha, as CSS Color 5 specifies. */
function mixPremultiplied(x: Colour, y: Colour, p: number): Colour {
  const a = x.a * p + y.a * (1 - p);
  if (a === 0) return { c: [0, 0, 0], a: 0 };
  const X = toOklab(x.c);
  const Y = toOklab(y.c);
  return { c: fromOklab(X.map((v, i) => (v * x.a * p + (Y[i] ?? 0) * y.a * (1 - p)) / a)), a };
}

function mixArg(arg: string, scope: Scope): { colour: Colour; pct?: number } {
  const m = /^(.*?)\s+([\d.]+)%$/.exec(arg.trim());
  return m?.[1] !== undefined && m[2] !== undefined
    ? { colour: evalColour(m[1], scope), pct: Number(m[2]) / 100 }
    : { colour: evalColour(arg, scope) };
}

function evalRelative(body: string, scope: Scope): Colour {
  const rest = body.slice('from '.length).trim();
  const parts = splitTop(rest, ' ');
  const [origin, r, g, b, slash, alpha] = parts;
  if (
    origin === undefined ||
    `${r} ${g} ${b}` !== 'r g b' ||
    (slash !== undefined && slash !== '/')
  )
    throw new Error(`unsupported relative colour: rgb(${body})`);
  const base = evalColour(origin, scope);
  return { c: base.c, a: alpha === undefined ? base.a : evalNumber(alpha, scope) };
}

function evalRgbFunction(body: string, scope: Scope): Colour {
  if (body.startsWith('from ')) return evalRelative(body, scope);
  const nums = body
    .split(/[\s,/]+/)
    .filter(Boolean)
    .map((n) => evalNumber(n, scope));
  const [r = 0, g = 0, b = 0, a = 1] = nums;
  return { c: [r / 255, g / 255, b / 255], a };
}

function evalColour(expr: string, scope: Scope): Colour {
  const e = expr.trim();
  if (e.startsWith('var(')) {
    const [name, fallback] = varArgs(e);
    const hit = lookup(name, scope);
    if (hit && hit.expr.trim() !== 'initial') return evalColour(hit.expr, hit.scope);
    if (fallback !== undefined) return evalColour(fallback, scope);
    throw new Error(`undefined colour ${name}`);
  }
  if (e === 'transparent') return { c: [0, 0, 0], a: 0 };
  if (e === 'white') return { c: [1, 1, 1], a: 1 };
  if (/^#[0-9a-f]{6}$/i.test(e)) return { c: hex(e), a: 1 };
  if (/^#[0-9a-f]{3}$/i.test(e)) return { c: hex(e.replace(/[0-9a-f]/gi, '$&$&')), a: 1 };
  const fn = /^(rgba?|color-mix)\(([\s\S]*)\)$/.exec(e);
  if (fn?.[1] === 'color-mix') {
    const [space, a, b] = splitTop(fn[2] ?? '', ',');
    if (space !== 'in oklab' || a === undefined || b === undefined)
      throw new Error(`unsupported color-mix: ${e}`);
    const x = mixArg(a, scope);
    const y = mixArg(b, scope);
    return mixPremultiplied(x.colour, y.colour, x.pct ?? (y.pct === undefined ? 0.5 : 1 - y.pct));
  }
  if (fn?.[2] !== undefined) return evalRgbFunction(fn[2].trim(), scope);
  throw new Error(`unsupported colour: ${e}`);
}

type Palette = 'default' | 'catppuccin' | 'rose-pine';
type Theme = 'dark' | 'light' | 'system-dark' | 'system-light';
type Resolved = 'dark' | 'light';

interface Combo {
  readonly palette: Palette;
  readonly theme: Theme;
  readonly resolved: Resolved;
  readonly label: string;
}

const COMBOS: readonly Combo[] = (['default', 'catppuccin', 'rose-pine'] as const).flatMap(
  (palette) =>
    (['dark', 'light', 'system-dark', 'system-light'] as const).map((theme) => ({
      palette,
      theme,
      resolved: theme.endsWith('light') ? ('light' as const) : ('dark' as const),
      label: `${palette}/${theme}`,
    })),
);

/** Root state: `mac` is darwin with Frosted chrome ON (`data-platform="mac"`); the levels are the stored settings. */
interface State {
  readonly mac: boolean;
  readonly chromeLevel: ChromeFrostLevel;
  readonly terminalLevel: TerminalFrostLevel;
  readonly reduceTransparency: boolean;
}

const at = (
  chromeLevel: ChromeFrostLevel,
  terminalLevel: TerminalFrostLevel,
  reduceTransparency = false,
): State => ({ mac: true, chromeLevel, terminalLevel, reduceTransparency });

const BASE: State = { mac: false, chromeLevel: 'subtle', terminalLevel: 'off', reduceTransparency: false };
/** #38 with the Frosted terminal setting OFF and ON: chrome Subtle with terminal Off and Subtle. */
const OFF = at('subtle', 'off');
const ON = at('subtle', 'subtle');
const FROSTED_TERMINAL = TERMINAL_FROST_LEVELS.filter((l) => l !== 'off');

/** Every mac root state, labelled: chrome level × terminal level × Reduce transparency. */
const MAC_STATES: readonly (readonly [string, State])[] = [false, true].flatMap((rt) =>
  CHROME_FROST_LEVELS.flatMap((cl) =>
    TERMINAL_FROST_LEVELS.map(
      (tl) => [`chrome ${cl}, terminal ${tl}${rt ? ', Reduce transparency' : ''}`, at(cl, tl, rt)] as const,
    ),
  ),
);

const RULES = [
  ...parseRules(STYLES, 0),
  ...parseRules(FROSTED, 100_000),
  ...parseRules(LEVELS, 200_000),
];

type Region = 'chrome' | 'sheet' | 'card' | 'chat' | 'modal' | 'overlay' | 'sheet-popover';

/** The hook the mac stylesheet resets chrome lifts on for popovers, menus and toasts under the chrome root. */
const OVERLAY_ATTR = FROST_ATTR.overlay;

interface Tree {
  readonly scope: Scope;
  readonly layers: readonly Colour[];
}

function htmlEl(combo: Combo, state: State): El {
  const attrs: Record<string, string> = { 'data-palette': combo.palette };
  if (!combo.theme.startsWith('system')) attrs['data-theme'] = combo.theme;
  if (state.mac) attrs[FROST_ATTR.platform] = MAC_PLATFORM;
  if (state.chromeLevel !== 'subtle') attrs[FROST_ATTR.chromeFrost] = state.chromeLevel;
  if (state.terminalLevel !== 'off') attrs[FROST_ATTR.terminalFrost] = state.terminalLevel;
  return { tag: 'html', root: true, attrs };
}

/** The element path from html down to `region`, with the utility class each element paints in App.tsx, ShellSplit.tsx and ShellTabsBar.tsx (`sheet-popover` is its "Add a shell" popover inside the Shell sheet). */
function regionPath(combo: Combo, state: State, region: Region, content: SheetContent): El[] {
  const path: El[] = [
    htmlEl(combo, state),
    { tag: 'body', attrs: {} },
    {
      tag: 'div',
      attrs: { [FROST_ATTR.chromeRoot]: '' },
      utility: [['background-color', 'var(--surface-chrome)']],
    },
  ];
  if (region === 'chat') path.push({ tag: 'div', attrs: { 'data-view': 'chat' } });
  if (region === 'modal') path.push({ tag: 'div', attrs: {}, classes: [MODAL_CLASSES.layer] });
  if (region === 'overlay') path.push({ tag: 'div', attrs: { [OVERLAY_ATTR]: '' } });
  if (region === 'sheet' || region === 'card' || region === 'sheet-popover')
    path.push({
      tag: 'main',
      attrs: { [FROST_ATTR.sheetContent]: content },
      utility: [['background-color', 'var(--surface-sheet)']],
    });
  if (region === 'card')
    path.push({ tag: 'div', attrs: {}, utility: [['background-color', 'var(--surface-pane)']] });
  if (region === 'sheet-popover') path.push({ tag: 'div', attrs: { [OVERLAY_ATTR]: '' } });
  return path;
}

const treeCache = new Map<string, Tree>();

/** Resolved scope of `region` and the background each ancestor-or-self paints, html first. */
function tree(combo: Combo, state: State, region: Region, content: SheetContent = 'shell'): Tree {
  const key = JSON.stringify([combo.label, state, region, content]);
  const cached = treeCache.get(key);
  if (cached) return cached;
  const env: Env = {
    light: combo.theme === 'system-light',
    reduceTransparency: state.reduceTransparency,
  };
  const path = regionPath(combo, state, region, content);
  let scope: Scope | undefined;
  const layers: Colour[] = [];
  path.forEach((_, i) => {
    const decls = cascade(RULES, path.slice(0, i + 1), env);
    scope = { decls, parent: scope };
    const paint = decls.get('background-color') ?? decls.get('background');
    if (paint !== undefined) layers.push(evalColour(paint, scope));
  });
  const built = { scope: scope as Scope, layers };
  treeCache.set(key, built);
  return built;
}

function token(t: Tree, name: string): Colour {
  return evalColour(`var(${name})`, t.scope);
}

function over(top: Colour, under: Colour): Colour {
  return {
    c: top.c.map((v, i) => v * top.a + (under.c[i] ?? 0) * (1 - top.a)) as unknown as Colour['c'],
    a: 1,
  };
}

const [ENVELOPE_LO, ENVELOPE_HI] = REFERENCE_MATERIALS.dark;
/** Grey materials across the envelope; contrast is not monotonic in the backdrop, so the ends alone are not enough. */
const ENVELOPE: readonly Colour[] = Array.from({ length: 18 }, (_, i) => ({
  c: [i / 17, i / 17, i / 17],
  a: 1,
}));

function composites(t: Tree): Colour[] {
  return ENVELOPE.map((m) => t.layers.reduce((acc, layer) => over(layer, acc), m));
}

function compositeAlpha(t: Tree): number {
  return 1 - t.layers.reduce((keep, layer) => keep * (1 - layer.a), 1);
}

/** Per-channel max of |composite over white − composite over black|, in 0..255 (D11). */
function visibleEffect(t: Tree): number {
  const lo = composites(t)[0] as Colour;
  const hi = composites(t)[ENVELOPE.length - 1] as Colour;
  return Math.max(...hi.c.map((v, i) => Math.abs(v - (lo.c[i] ?? 0)))) * 255;
}

function minRatio(fg: Colour, backdrops: readonly Colour[]): number {
  return Math.min(...backdrops.map((b) => ratio(fg, b)));
}

function chip(t: Tree, fill: string): Colour[] {
  return composites(t).map((c) => over(token(t, fill), c));
}

/** Recorded at 26eed37: composite alpha and visible effect of each surface, and terminal text contrast. */
const BASELINE: Record<
  `${Palette}/${Resolved}`,
  {
    readonly chromeAlpha: number;
    readonly sheetAlpha: number;
    readonly cardAlpha: number;
    readonly chromeEffect: number;
    readonly termFgSheet: number;
    readonly termFgCard: number;
  }
> = {
  'default/dark': {
    chromeAlpha: 0.9636,
    sheetAlpha: 0.982,
    cardAlpha: 0.9966,
    chromeEffect: 9.28,
    termFgSheet: 12.73,
    termFgCard: 13.15,
  },
  'default/light': {
    chromeAlpha: 0.9798,
    sheetAlpha: 0.9902,
    cardAlpha: 0.9985,
    chromeEffect: 5.15,
    termFgSheet: 15.49,
    termFgCard: 16.03,
  },
  'catppuccin/dark': {
    chromeAlpha: 1,
    sheetAlpha: 1,
    cardAlpha: 1,
    chromeEffect: 0,
    termFgSheet: 10.26,
    termFgCard: 9.49,
  },
  'catppuccin/light': {
    chromeAlpha: 1,
    sheetAlpha: 1,
    cardAlpha: 1,
    chromeEffect: 0,
    termFgSheet: 6.27,
    termFgCard: 6.33,
  },
  'rose-pine/dark': {
    chromeAlpha: 1,
    sheetAlpha: 1,
    cardAlpha: 1,
    chromeEffect: 0,
    termFgSheet: 11.96,
    termFgCard: 12.1,
  },
  'rose-pine/light': {
    chromeAlpha: 1,
    sheetAlpha: 1,
    cardAlpha: 1,
    chromeEffect: 0,
    termFgSheet: 6.48,
    termFgCard: 6.24,
  },
};

const VISIBLE_FLOOR = 32;

type Surface = 'chrome' | 'selected-row' | 'terminal';
type Pin = readonly [Palette, Resolved, string, Surface | 'any'];

/**
 * Palette token each painted indicator comes from: the status-bar glyphs paint `--hue-*`, which resolve to a
 * palette's `--term-*` colour when it defines one, so a pin names the palette token.
 */
const SOURCE: Readonly<Record<string, string>> = {
  '--hue-yellow': '--term-yellow',
  '--hue-pink': '--term-red',
  '--hue-cyan': '--term-cyan',
};

/**
 * D13: indicator tokens already below 3:1 on the opaque baseline surfaces at 26eed37, on every surface and
 * under Reduce transparency. Only pairs that still fail on the mac stack are pinned: the selected-row
 * `--agent-blocked` extension passes there now (the opaque chip, and the D17 chrome lift in rose-pine light).
 * Each pin still fails on at least one of its surfaces at every chrome and terminal level, which the pin tests
 * re-check: the level lifts stop at each floor they need and never reach a pinned pair.
 */
const D13_DEBT: readonly Pin[] = [
  ['default', 'light', '--agent-idle', 'any'],
  ['catppuccin', 'light', '--agent-idle', 'any'],
  ['catppuccin', 'light', '--agent-busy', 'any'],
  ['catppuccin', 'light', '--term-yellow', 'any'],
  ['catppuccin', 'light', '--term-cursor', 'any'],
  ['rose-pine', 'light', '--agent-busy', 'any'],
  ['rose-pine', 'light', '--term-yellow', 'any'],
  ['rose-pine', 'light', '--term-cyan', 'any'],
];

function pinned(list: readonly Pin[], combo: Combo, surface: Surface, painted: string): boolean {
  const name = combo.palette === 'default' ? painted : (SOURCE[painted] ?? painted);
  return list.some(
    ([p, r, n, s]) =>
      p === combo.palette && r === combo.resolved && n === name && (s === 'any' || s === surface),
  );
}

function exempt(combo: Combo, surface: Surface, painted: string): boolean {
  return pinned(D13_DEBT, combo, surface, painted);
}

const CHROME_INDICATORS = [
  '--agent-idle',
  '--agent-busy',
  '--agent-blocked',
  '--accent-mark',
  '--hue-yellow',
  '--hue-pink',
  '--hue-cyan',
] as const;
/** The colour an indicator token paints: accent glyphs on the chrome read `--accent-mark`, which falls back to `--accent` (D18). */
function indicator(t: Tree, name: string): Colour {
  return evalColour(name === '--accent-mark' ? 'var(--accent-mark, var(--accent))' : `var(${name})`, t.scope);
}

const ROW_DOTS = ['--agent-idle', '--agent-busy', '--agent-blocked'] as const;
const TAB_INDICATORS = ['--agent-idle', '--agent-busy', '--agent-blocked', '--accent-mark'] as const;

const GIT_HUES = { M: 'amber', A: 'emerald', D: 'rose', '?': 'sky' } as const;
type GitLetter = keyof typeof GIT_HUES;
const GIT_LETTERS = Object.keys(GIT_HUES) as GitLetter[];
const GIT_TOKEN = /var\((--git-[\w-]+),(#[0-9a-f]{6})\)/;

/** The colour a git status class paints: `var(--git-*, #hex)` when it reads a lifted token, else its bare Tailwind -400 hue. */
function gitLetterExpr(status: GitLetter): string {
  const m = GIT_TOKEN.exec(gitStatusTextClass(status));
  return m ? `var(${m[1]}, ${m[2]})` : tailwindColors[GIT_HUES[status]][400];
}

/** Chrome text labels and the backdrops they sit on: the badge label on its fill, the branch name and git letters on the chrome. */
function chromeLabels(t: Tree): [string, Colour, Colour[]][] {
  return [
    [
      'Tasks badge (--hue-orange-soft-text on --hue-orange-soft)',
      token(t, '--hue-orange-soft-text'),
      chip(t, '--hue-orange-soft'),
    ],
    ['title-bar branch name (--hue-pink)', token(t, '--hue-pink'), composites(t)],
    ...GIT_LETTERS.map((s): [string, Colour, Colour[]] => [
      `Git panel status letter ${s}`,
      evalColour(gitLetterExpr(s), t.scope),
      composites(t),
    ]),
  ];
}

const baseKey = (c: Combo): `${Palette}/${Resolved}` => `${c.palette}/${c.resolved}`;

interface Fixture {
  readonly commit: string;
  readonly exprs: readonly string[];
  readonly values: readonly string[];
  readonly entries: Readonly<Record<string, readonly number[]>>;
}

/** Every token, composite alpha and envelope-end composite the engine resolved at main@6929753, per combo × #38 state × region. */
const FIXTURE = JSON.parse(
  readFileSync(resolve(__dirname, 'fixtures/frost-6929753.json'), 'utf8'),
) as Fixture;
type RecordedState = 'off' | 'on' | 'off-rt' | 'on-rt';
const RECORDED_REGIONS = [
  ['chrome', 'shell'],
  ['sheet', 'shell'],
  ['sheet', 'other'],
  ['card', 'shell'],
  ['chat', 'shell'],
  ['modal', 'shell'],
  ['overlay', 'shell'],
] as const satisfies readonly (readonly [Region, SheetContent])[];

const fixed = (x: Colour): string => [...x.c, x.a].map((v) => v.toFixed(6)).join(' ');

/** One recorded expression resolved the way the fixture recorder resolved it: a colour, else a number, else unresolved. */
function resolvedValue(t: Tree, cs: readonly Colour[], expr: string): string | null {
  if (expr === '@alpha') return compositeAlpha(t).toFixed(6);
  if (expr === '@black') return fixed(cs[0] as Colour);
  if (expr === '@white') return fixed(cs[cs.length - 1] as Colour);
  try {
    return fixed(evalColour(expr, t.scope));
  } catch {
    try {
      return evalNumber(expr, t.scope).toFixed(6);
    } catch {
      return null;
    }
  }
}

/** The region's value for every recorded expression, keyed by expression. */
function snapshot(t: Tree): Map<string, string | null> {
  const cs = composites(t);
  return new Map(FIXTURE.exprs.map((e) => [e, resolvedValue(t, cs, e)]));
}

/** Expressions whose value in `state` differs from the main@6929753 recording of `recorded`, as `region expr: now != then`. */
function fixtureMismatches(c: Combo, recorded: RecordedState, state: State): string[] {
  return RECORDED_REGIONS.flatMap(([region, content]) => {
    const key = `${c.label}|${recorded}|${region}|${content}`;
    const then = FIXTURE.entries[key];
    if (!then) return [`${key} not recorded`];
    const now = snapshot(tree(c, state, region, content));
    return FIXTURE.exprs.flatMap((e, i) => {
      const was = (then[i] ?? -1) < 0 ? null : (FIXTURE.values[then[i] as number] ?? null);
      return now.get(e) === was ? [] : [`${region}/${content} ${e}: ${now.get(e)} != ${was}`];
    });
  });
}

/** One floor check: what is measured, the measured value, and the floor it must reach. */
type Check = readonly [string, number, number];

function failing(checks: readonly Check[]): string[] {
  return checks
    .filter(([, value, floor]) => !(value >= floor))
    .map(([label, value, floor]) => `${label}: ${value.toFixed(3)} < ${floor}`);
}

const STEP = 8;
const EPS = 1e-9;
/** The styles.css keyboard focus outline colour. */
const FOCUS_OUTLINE_BASE = 'color-mix(in oklab, var(--accent) 70%, transparent)';

type PaintKind = 'text' | 'graphic';

/** One coloured text or indicator painted on mac chrome: its colour, the fills between it and the chrome (each alternative a bottom-up stack; none means bare chrome) and any element opacity it is drawn through. */
interface ChromePaint {
  readonly element: string;
  readonly src: string;
  readonly classes: readonly string[];
  readonly fg: string;
  readonly kind: PaintKind;
  readonly on?: readonly (readonly string[])[];
  readonly opacity?: number;
}

const BARE: readonly string[] = [];
const HOVER_ROW = ['var(--surface-hover)'];
const SELECTED_ROW = ['var(--accent-soft)'];
const RAISED = ['var(--panel-strong)'];
const INSET = ['var(--panel)'];
const FIELD = ['var(--surface-field)'];
const AHEAD_CHIP = ['var(--git-ahead-chip, rgb(52 211 153 / 0.1))'];
const BEHIND_CHIP = ['var(--git-behind-chip, rgb(251 113 133 / 0.1))'];
const ADDED_LINE = ['var(--panel)', 'rgb(16 185 129 / 0.05)'];
const DELETED_LINE = ['var(--panel)', 'rgb(244 63 94 / 0.05)'];

function paint(
  kind: PaintKind,
  src: string,
  element: string,
  fg: string,
  classes: readonly string[],
  on?: readonly (readonly string[])[],
  opacity?: number,
): ChromePaint {
  return { kind, src, element, fg, classes, on, opacity };
}

const CLAUDE_DOTS = ['--agent-idle', '--agent-busy', '--agent-blocked'] as const;

/**
 * D17: every coloured text and non-text indicator rendered under `[data-chrome-root]` outside the sheet and
 * the chat column, with the classes that paint it, so the source scan below can prove nothing is left out.
 */
const CHROME_PAINT: readonly ChromePaint[] = [
  paint('text', 'TitleGroup.tsx', 'title-bar project name', 'var(--text)', ['text-[--text]']),
  paint('text', 'TitleGroup.tsx', 'title-bar branch name', 'var(--hue-pink)', [
    'text-[--hue-pink]',
  ]),
  paint('graphic', 'App.tsx#title', 'title-bar button icon', 'var(--text-muted)', [
    'text-[--text-muted]',
  ]),
  paint(
    'graphic',
    'App.tsx#title',
    'title-bar button icon, hovered',
    'var(--text)',
    ['hover:text-[--text]', 'hover:bg-[--panel-strong]'],
    [RAISED],
  ),
  paint('graphic', 'ActivityBar.tsx', 'activity-bar icon', 'var(--text-muted)', [
    'text-[--text-muted]',
  ]),
  paint(
    'graphic',
    'ActivityBar.tsx',
    'activity-bar icon, hovered',
    'var(--text)',
    ['hover:text-[--text]', 'hover:bg-[--surface-hover]'],
    [HOVER_ROW],
  ),
  paint(
    'graphic',
    'ActivityBar.tsx',
    'activity-bar icon, active',
    'var(--accent-soft-text)',
    ['bg-[--accent-soft]', 'text-[--accent-soft-text]'],
    [SELECTED_ROW],
  ),
  paint(
    'text',
    'ActivityBar.tsx',
    'activity-bar Git/Chat badge',
    'var(--badge-accent-text)',
    ['text-[--badge-accent-text]'],
    [SELECTED_ROW],
  ),
  paint(
    'text',
    'ActivityBar.tsx',
    'activity-bar Tasks badge',
    'var(--hue-orange-soft-text)',
    ['bg-[--hue-orange-soft]', 'text-[--hue-orange-soft-text]'],
    [['var(--hue-orange-soft)']],
  ),
  ...CLAUDE_DOTS.map((d) =>
    paint(
      'graphic',
      'StatusDot.tsx',
      `Claude status dot ${d} (sidebar rows and headers, popout title)`,
      `var(${d})`,
      [],
      [BARE, HOVER_ROW, SELECTED_ROW],
    ),
  ),
  ...ROOT_HUE_TOKENS.map((h) =>
    paint('graphic', 'RootFolderGlyph.tsx', `root folder glyph ${h}`, rootHueColour(h), []),
  ),
  paint('text', 'Sidebar.tsx', 'section title', 'var(--text)', ['text-[--text]']),
  paint('text', 'Sidebar.tsx', 'section title, muted', 'var(--text-muted)', [
    'text-[--text-muted]',
  ]),
  paint(
    'text',
    'Sidebar.tsx',
    'project row name',
    'var(--text)',
    ['bg-[--accent-soft]', 'hover:bg-[--surface-hover]'],
    [BARE, HOVER_ROW, SELECTED_ROW],
  ),
  paint(
    'graphic',
    'Sidebar.tsx',
    'selected project placeholder dot',
    'var(--accent-mark, var(--accent))',
    ['bg-[color:var(--accent-mark,var(--accent))]'],
    [SELECTED_ROW],
  ),
  paint(
    'graphic',
    'Sidebar.tsx',
    'project row focus ring',
    'var(--accent-mark, var(--accent))',
    ['focus-visible:ring-[color:var(--accent-mark,var(--accent))]'],
    [BARE, HOVER_ROW, SELECTED_ROW],
  ),
  paint(
    'graphic',
    'Sidebar.tsx',
    'unload button icon',
    'var(--text-muted)',
    [],
    [HOVER_ROW, SELECTED_ROW],
  ),
  paint(
    'graphic',
    'Sidebar.tsx',
    'unload button icon, hovered',
    'var(--danger)',
    ['hover:text-[--danger]'],
    [HOVER_ROW, [...SELECTED_ROW, ...HOVER_ROW]],
  ),
  paint('text', 'Sidebar.tsx', 'root folder name, hovered', 'var(--text)', ['hover:text-[--text]']),
  paint(
    'text',
    'Sidebar.tsx',
    'root folder project count (opacity-70)',
    'var(--text-muted)',
    ['opacity-70'],
    [BARE],
    0.7,
  ),
  paint(
    'graphic',
    'SidebarHeader.tsx',
    'add button and filter icon',
    'var(--text-muted)',
    ['bg-[--surface-field]', 'text-[--text-muted]'],
    [FIELD],
  ),
  paint(
    'graphic',
    'SidebarHeader.tsx',
    'add button icon, hovered',
    'var(--text)',
    ['hover:text-[--text]', 'hover:bg-[--surface-active]'],
    [['var(--surface-active)']],
  ),
  paint(
    'text',
    'SidebarHeader.tsx',
    'filter input text',
    'var(--text)',
    ['text-[--text]'],
    [FIELD],
  ),
  paint(
    'text',
    'SidebarHeader.tsx',
    'filter placeholder',
    'var(--text-muted)',
    ['placeholder:text-[--text-muted]'],
    [FIELD],
  ),
  paint('text', 'GitPanel.tsx', 'Git panel branch, paths, Pull and Push', 'var(--text)', [
    'hover:text-[--text]',
  ]),
  paint('text', 'GitPanel.tsx', 'Git panel muted text and icons', 'var(--text-muted)', [
    'text-[--text-muted]',
  ]),
  paint(
    'text',
    'GitPanel.tsx',
    'Git panel hovered action',
    'var(--text)',
    ['hover:bg-[--panel]', 'hover:bg-[--panel-strong]'],
    [INSET, RAISED],
  ),
  paint(
    'text',
    'GitPanel.tsx',
    'Git panel ahead count',
    'var(--git-added, #34d399)',
    [
      'text-[color:var(--git-added,#34d399)]',
      'bg-[color:var(--git-ahead-chip,rgb(52_211_153/0.1))]',
    ],
    [AHEAD_CHIP],
  ),
  paint(
    'text',
    'GitPanel.tsx',
    'Git panel behind count',
    'var(--git-deleted, #fb7185)',
    [
      'text-[color:var(--git-deleted,#fb7185)]',
      'bg-[color:var(--git-behind-chip,rgb(251_113_133/0.1))]',
    ],
    [BEHIND_CHIP],
  ),
  paint('text', 'GitPanel.tsx', 'Git panel error', 'var(--danger)', ['text-[--danger]']),
  paint(
    'text',
    'GitPanel.tsx',
    'Git panel Stage all / Unstage all',
    'var(--accent-label, var(--accent))',
    ['text-[color:var(--accent-label,var(--accent))]'],
  ),
  paint(
    'text',
    'GitPanel.tsx',
    'Git panel section count (opacity-60)',
    'var(--text-muted)',
    ['opacity-60'],
    [BARE],
    0.6,
  ),
  ...GIT_LETTERS.map((s) =>
    paint('text', 'git-status-style.ts', `Git panel status letter ${s}`, gitLetterExpr(s), []),
  ),
  paint(
    'text',
    'GitPanel.tsx',
    'inline diff context and loading text',
    'var(--text-muted)',
    ['bg-[--panel]'],
    [INSET],
  ),
  paint(
    'text',
    'GitPanel.tsx',
    'inline diff hunk header',
    'var(--git-untracked, #38bdf8)',
    ['text-[color:var(--git-untracked,#38bdf8)]'],
    [INSET],
  ),
  paint(
    'text',
    'GitPanel.tsx',
    'inline diff added line',
    'var(--git-added, #34d399)',
    ['bg-emerald-500/5'],
    [ADDED_LINE],
  ),
  paint(
    'text',
    'GitPanel.tsx',
    'inline diff deleted line',
    'var(--git-deleted, #fb7185)',
    ['bg-rose-500/5'],
    [DELETED_LINE],
  ),
  paint(
    'text',
    'GitPanel.tsx',
    'inline diff file header (opacity-60)',
    'var(--text-muted)',
    [],
    [INSET],
    0.6,
  ),
  paint(
    'text',
    'GitPanel.tsx',
    'commit message text',
    'var(--text)',
    ['bg-[--panel-strong]'],
    [RAISED],
  ),
  paint('text', 'GitPanel.tsx', 'commit message placeholder', 'var(--text-muted)', [], [RAISED]),
  paint(
    'text',
    'TasksPanel.tsx',
    'Tasks title, names and filter text',
    'var(--text)',
    ['text-[--text]', 'hover:text-[--text]', 'bg-[--panel-strong]', 'hover:bg-[--panel-strong]'],
    [BARE, RAISED],
  ),
  paint(
    'text',
    'TasksPanel.tsx',
    'Tasks counts, descriptions, placeholder and icons',
    'var(--text-muted)',
    ['text-[--text-muted]'],
    [BARE, RAISED],
  ),
  paint(
    'graphic',
    'TasksPanel.tsx',
    'Tasks run glyph',
    'var(--accent-mark, var(--accent))',
    ['text-[color:var(--accent-mark,var(--accent))]'],
    [BARE, RAISED],
  ),
  paint('text', 'StatusBar.tsx', 'status-bar text', 'var(--text-muted)', ['text-[--text-muted]']),
  paint(
    'text',
    'StatusBar.tsx',
    'status-bar branch and hovered shells chip',
    'var(--text)',
    ['text-[--text]', 'hover:text-[--text]', 'hover:bg-[--surface-hover]'],
    [BARE, HOVER_ROW],
  ),
  paint('graphic', 'StatusBar.tsx', 'status-bar project dot', 'var(--accent-mark, var(--accent))', [
    'bg-[color:var(--accent-mark,var(--accent))]',
  ]),
  paint('graphic', 'StatusBar.tsx', 'status-bar dirty dot', 'var(--hue-yellow)', []),
  paint('text', 'StatusBar.tsx', 'status-bar branch icon and behind count', 'var(--hue-pink)', [
    'text-[--hue-pink]',
  ]),
  paint('text', 'StatusBar.tsx', 'status-bar ahead count', 'var(--hue-cyan)', [
    'text-[--hue-cyan]',
  ]),
  paint('text', 'StatusBar.tsx', 'shells chip, hanging', 'var(--danger)', ['text-[--danger]']),
  paint('text', 'StatusBar.tsx', 'shells chip, hot', 'var(--hue-yellow)', ['text-[--hue-yellow]']),
  paint(
    'text',
    'StatusBar.tsx',
    'port chip',
    'var(--accent-soft-text)',
    ['bg-[--accent-soft]', 'text-[--accent-soft-text]'],
    [SELECTED_ROW],
  ),
  paint(
    'text',
    'StatusBar.tsx',
    'shells CPU, ports label and palette hint (opacity-70)',
    'var(--text-muted)',
    ['opacity-70'],
    [BARE],
    0.7,
  ),
  paint(
    'text',
    'StatusBar.tsx',
    'palette hint key (kbd, opacity-70)',
    'var(--text-muted)',
    [],
    [INSET],
    0.7,
  ),
  paint(
    'text',
    'StatusBar.tsx',
    'app version (opacity-80 inside opacity-70)',
    'var(--text-muted)',
    ['opacity-80'],
    [BARE],
    0.56,
  ),
  paint('text', 'App.tsx#popout', 'popout project name', 'var(--text)', ['text-[--text]']),
  paint('text', 'App.tsx#popout', 'popout shell label and idle switcher tab', 'var(--text-muted)', [
    'text-[--text-muted]',
  ]),
  paint(
    'text',
    'App.tsx#popout',
    'popout switcher tab, hovered',
    'var(--text)',
    ['hover:text-[--text]', 'hover:bg-[--surface-hover]'],
    [HOVER_ROW],
  ),
  paint(
    'text',
    'App.tsx#popout',
    'popout switcher tab, active',
    'var(--accent-soft-text)',
    ['bg-[--accent-soft]', 'text-[--accent-soft-text]'],
    [SELECTED_ROW],
  ),
  paint(
    'text',
    'App.tsx#popout',
    'popout app name (opacity-60)',
    'var(--text-muted)',
    ['opacity-60'],
    [BARE],
    0.6,
  ),
];

/** The keyboard focus outline from styles.css, as the mac chrome paints it; off mac and in the working area it is the styles.css colour. */
const FOCUS_OUTLINE: ChromePaint = paint(
  'graphic',
  'styles.css',
  'keyboard focus outline',
  `var(--focus-outline, ${FOCUS_OUTLINE_BASE})`,
  [],
  [BARE, HOVER_ROW, SELECTED_ROW],
);

/** D13 (D17 extension): chrome paint no token lift can bring to its floor, each with the reason. */
const OPACITY_REASON =
  'dimmed by element opacity: through it the shared chrome --text-muted would have to move to or past --text (or reach the pole and still fail), so only a component change can fix it';
const D17_PINS: Readonly<Record<string, string>> = {
  'root folder project count (opacity-70)': OPACITY_REASON,
  'Git panel section count (opacity-60)': OPACITY_REASON,
  'inline diff file header (opacity-60)': OPACITY_REASON,
  'shells CPU, ports label and palette hint (opacity-70)': OPACITY_REASON,
  'palette hint key (kbd, opacity-70)': OPACITY_REASON,
  'app version (opacity-80 inside opacity-70)': OPACITY_REASON,
  'popout app name (opacity-60)': OPACITY_REASON,
};

/** Classes in the chrome sources that paint no chrome colour, with the reason. */
const NOT_CHROME_PAINT: Readonly<Record<string, string>> = {
  'border-[--border]': 'hairline separator; chrome separates by tone (D3)',
  'divide-[--border]': 'hairline separator inside the opaque shells popover',
  'opacity-0': 'hidden until hover or focus; painted at opacity 1 when shown',
  'opacity-100': 'reveal state, opacity 1',
  'group-hover:opacity-100': 'reveal state, opacity 1',
  'focus:opacity-100': 'reveal state, opacity 1',
  'opacity-40': 'decorative middle-dot separator',
  'disabled:opacity-40': 'disabled control, exempt from contrast (WCAG 1.4.3)',
  'disabled:opacity-50': 'disabled control, exempt from contrast (WCAG 1.4.3)',
  'bg-transparent': 'no fill',
  'bg-[--surface-chrome]': 'the chrome surface itself',
  'bg-[--surface-sheet]': 'the working-area sheet (outside chrome)',
  'bg-[--surface-active]':
    'aria-hidden placeholder dot on idle project rows; decorative, the StatusDot carries state',
  'bg-[--text-muted]': 'inactive shell-tab dot, drawn only in the shell tab strip (sheet)',
  'text-[--modal-text-muted]': 'Rename dialog: modal glass, covered by modal-contrast.test.ts',
  'bg-[--panel]': 'Rename dialog input and kbd fill; text on it is listed with INSET',
  'hover:bg-[--panel]': 'hover fill under listed text (INSET)',
  'focus:ring-[--accent]/60':
    'compiles to no CSS (Tailwind v3 drops an opacity modifier on a bare var)',
  'focus-within:ring-[--accent]/60':
    'compiles to no CSS (Tailwind v3 drops an opacity modifier on a bare var)',
  'bg-[--panel]/40': 'compiles to no CSS (Tailwind v3 drops an opacity modifier on a bare var)',
  'hover:bg-[--panel-strong]/60':
    'compiles to no CSS (Tailwind v3 drops an opacity modifier on a bare var)',
  'bg-[--danger]/15': 'compiles to no CSS (Tailwind v3 drops an opacity modifier on a bare var)',
  'bg-[--hue-yellow]/15':
    'compiles to no CSS (Tailwind v3 drops an opacity modifier on a bare var)',
  'bg-[--text-muted]/50':
    'compiles to no CSS (Tailwind v3 drops an opacity modifier on a bare var)',
  'bg-[color:var(--accent)]':
    'also the Commit and Rename buttons: --accent-text on a solid --accent fill, material-independent',
  'text-[--accent-text]': 'text on a solid --accent fill, material-independent',
};
const COMPONENTS = resolve(__dirname, '../../../src/renderer/components');
const APP = readFileSync(resolve(__dirname, '../../../src/renderer/App.tsx'), 'utf8');

function between(src: string, from: string, to: string): string {
  const start = src.indexOf(from);
  const end = src.indexOf(to, start);
  if (start < 0 || end < 0) throw new Error(`anchor not found: ${from} … ${to}`);
  return src.slice(start, end);
}

/** The chrome markup of each source: whole component files, the title-bar and popout slices of App.tsx, and StatusBar without its popover. */
function chromeSource(src: string): string {
  if (src === 'App.tsx#title')
    return between(APP, 'data-testid={CHROME_TESTIDS.titleButtons}', '<main');
  if (src === 'App.tsx#popout')
    return between(
      APP,
      'data-chrome-root>\n      <div className="drag h-11 flex items-center gap-2',
      'data-sheet-content={popoutSheetContent}',
    );
  const text = readFileSync(resolve(COMPONENTS, src), 'utf8');
  return src === 'StatusBar.tsx'
    ? text.replace(between(text, '{open && (', '</div>\n      )}\n    </div>\n  );'), '')
    : text;
}

const COLOUR_CLASS =
  /(?<![\w-])(?:[a-z-]+:)*(?:(?:text|bg|ring|fill|stroke|border|divide|outline)-(?:\[(?!\d)[^\]\s]+\]|(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|white|black|transparent|current)(?:-\d+)?)(?:\/\d+)?|opacity-\d+)/g;

function colourClasses(markup: string): string[] {
  return [...new Set(markup.match(COLOUR_CLASS) ?? [])].sort();
}

function stack(t: Tree, fills: readonly string[]): Colour[] {
  return composites(t).map((c) => fills.reduce((acc, f) => over(evalColour(f, t.scope), acc), c));
}

function blend(a: Colour, b: Colour, opacity: number): Colour {
  return {
    c: a.c.map((v, i) => v * opacity + (b.c[i] ?? 0) * (1 - opacity)) as unknown as Colour['c'],
    a: 1,
  };
}

/** Worst contrast of `p` across the envelope and every backdrop it sits on, drawn through its opacity. */
function paintMin(t: Tree, p: ChromePaint): number {
  const fg = evalColour(p.fg, t.scope);
  const o = p.opacity ?? 1;
  const material = composites(t);
  return Math.min(
    ...(p.on ?? [BARE]).flatMap((fills) =>
      stack(t, fills).map((under, i) => {
        const behind = material[i] as Colour;
        return ratio(blend(over(fg, under), behind, o), blend(under, behind, o));
      }),
    ),
  );
}


const floorOf = (p: ChromePaint): number => (p.kind === 'text' ? CONTRAST_TEXT : CONTRAST_GRAPHIC);

/** Every #38 chrome floor in `state`: surface text, chips, rows, indicators, labels, the full D17 inventory and the focus outline. */
function chromeChecks(c: Combo, state: State): Check[] {
  const t = tree(c, state, 'chrome');
  const env = composites(t);
  const checks: Check[] = [
    ['--text on chrome', minRatio(token(t, '--text'), env), CONTRAST_TEXT],
    ['--text-muted on chrome', minRatio(token(t, '--text-muted'), env), CONTRAST_TEXT],
    ['active chip label', minRatio(token(t, '--accent-soft-text'), chip(t, '--accent-soft')), CONTRAST_TEXT],
    ['--text on --accent-soft row', minRatio(token(t, '--text'), chip(t, '--accent-soft')), CONTRAST_TEXT],
    ['--text on --surface-hover row', minRatio(token(t, '--text'), chip(t, '--surface-hover')), CONTRAST_TEXT],
  ];
  if (!state.reduceTransparency) checks.push(['visible effect', visibleEffect(t), VISIBLE_FLOOR]);
  for (const name of CHROME_INDICATORS)
    if (!exempt(c, 'chrome', name))
      checks.push([`${name} on chrome`, minRatio(indicator(t, name), env), CONTRAST_GRAPHIC]);
  for (const name of ROW_DOTS)
    if (!exempt(c, 'selected-row', name))
      checks.push([`${name} on the selected row`, minRatio(token(t, name), chip(t, '--accent-soft')), CONTRAST_GRAPHIC]);
  for (const [label, fg, under] of chromeLabels(t)) checks.push([label, minRatio(fg, under), CONTRAST_TEXT]);
  for (const p of CHROME_PAINT)
    if (!(p.element in D17_PINS)) checks.push([p.element, paintMin(t, p), floorOf(p)]);
  const outline = paintMin(t, FOCUS_OUTLINE);
  checks.push(['focus outline vs 26eed37', outline, paintMin(tree(c, BASE, 'chrome'), FOCUS_OUTLINE)]);
  if (lookup('--focus-outline', t.scope) && token(t, '--focus-outline').a === 1)
    checks.push(['lifted focus outline', outline, CONTRAST_GRAPHIC]);
  return checks;
}

/** Every #38 terminal floor (AC9, AC11) on the sheet and split card in `state`: terminal frosted, or terminal Off under Reduce transparency (no visible-effect rows there). */
function terminalChecks(c: Combo, state: State): Check[] {
  const sheet = tree(c, state, 'sheet', 'shell');
  const card = tree(c, state, 'card', 'shell');
  const checks: Check[] = [
    ['--term-fg on sheet', minRatio(token(sheet, '--term-fg'), composites(sheet)), CONTRAST_TEXT],
    ['--term-fg on card', minRatio(token(card, '--term-fg'), composites(card)), CONTRAST_TEXT],
    ['--text on sheet', minRatio(token(sheet, '--text'), composites(sheet)), CONTRAST_TEXT],
    ['--text-muted on sheet', minRatio(token(sheet, '--text-muted'), composites(sheet)), CONTRAST_TEXT],
    ['--text-muted on card', minRatio(token(card, '--text-muted'), composites(card)), CONTRAST_TEXT],
    ['--text on the active shell tab', minRatio(token(sheet, '--text'), chip(sheet, '--surface-active')), CONTRAST_TEXT],
  ];
  if (!state.reduceTransparency)
    checks.push(['sheet visible effect', visibleEffect(sheet), VISIBLE_FLOOR], ['card visible effect', visibleEffect(card), VISIBLE_FLOOR]);
  if (!exempt(c, 'terminal', '--term-cursor'))
    checks.push(
      ['cursor on sheet', minRatio(token(sheet, '--term-cursor'), composites(sheet)), CONTRAST_GRAPHIC],
      ['cursor on card', minRatio(token(card, '--term-cursor'), composites(card)), CONTRAST_GRAPHIC],
    );
  for (const name of TAB_INDICATORS)
    if (!exempt(c, 'terminal', name))
      checks.push([`tab-strip ${name}`, minRatio(indicator(sheet, name), composites(sheet)), CONTRAST_GRAPHIC]);
  return checks;
}

const BASE_TERM_FG = (c: Combo, region: 'sheet' | 'card'): number => {
  const t = tree(c, BASE, region);
  return minRatio(token(t, '--term-fg'), composites(t));
};

describe('baseline at 26eed37 (engine without the mac attribute equals the recorded literals)', () => {
  it.each(COMBOS)('$label', (c) => {
    const b = BASELINE[baseKey(c)];
    expect(compositeAlpha(tree(c, BASE, 'chrome'))).toBeCloseTo(b.chromeAlpha, 3);
    expect(compositeAlpha(tree(c, BASE, 'sheet'))).toBeCloseTo(b.sheetAlpha, 3);
    expect(compositeAlpha(tree(c, BASE, 'card'))).toBeCloseTo(b.cardAlpha, 3);
    expect(visibleEffect(tree(c, BASE, 'chrome'))).toBeCloseTo(b.chromeEffect, 1);
    expect(BASE_TERM_FG(c, 'sheet')).toBeCloseTo(b.termFgSheet, 1);
    expect(BASE_TERM_FG(c, 'card')).toBeCloseTo(b.termFgCard, 1);
  });

  it('the envelope is the full black-to-white range for both themes (AC19: the inactive material lies inside it)', () => {
    expect(REFERENCE_MATERIALS.dark).toEqual(['#000000', '#ffffff']);
    expect(REFERENCE_MATERIALS.light).toEqual(['#000000', '#ffffff']);
    expect(ENVELOPE[0]?.c).toEqual(hex(ENVELOPE_LO));
    expect(ENVELOPE[ENVELOPE.length - 1]?.c).toEqual(hex(ENVELOPE_HI));
  });
});

describe('Subtle equals main@6929753 (glass-settings AC10)', () => {
  it('the fixture was recorded from main@6929753 for every combination, #38 state and region', () => {
    expect(FIXTURE.commit).toBe('6929753');
    expect(Object.keys(FIXTURE.entries)).toHaveLength(COMBOS.length * 4 * RECORDED_REGIONS.length);
    expect(FIXTURE.exprs.length).toBeGreaterThan(100);
  });

  describe.each(COMBOS)('$label', (c) => {
    it.each([
      ['chrome Subtle, terminal Off equals #38 setting OFF', 'off', OFF],
      ['chrome Subtle, terminal Subtle equals #38 setting ON', 'on', ON],
      ['under Reduce transparency, terminal Off equals #38 OFF', 'off-rt', at('subtle', 'off', true)],
      ['under Reduce transparency, terminal Subtle equals #38 ON', 'on-rt', at('subtle', 'subtle', true)],
    ] as const)('%s', (_, recorded, state) => {
      expect(fixtureMismatches(c, recorded, state)).toEqual([]);
    });
  });
});

describe.each(COMBOS)('$label Frosted chrome OFF and non-mac render pre-#38 (glass-settings AC7, AC25)', (c) => {
  const stylesOnly = parseRules(STYLES, 0);
  it.each([false, true])('with Reduce transparency %s, at every stored level, every region matches styles.css alone', (rt) => {
    const env: Env = { light: c.theme === 'system-light', reduceTransparency: rt };
    const drift: string[] = [];
    for (const cl of CHROME_FROST_LEVELS)
      for (const tl of TERMINAL_FROST_LEVELS)
        for (const region of ['chrome', 'sheet', 'card', 'chat', 'modal', 'overlay'] as const) {
            const state: State = { mac: false, chromeLevel: cl, terminalLevel: tl, reduceTransparency: rt };
            const path = regionPath(c, state, region, 'shell');
            path.forEach((_, i) => {
              const got = JSON.stringify([...cascade(RULES, path.slice(0, i + 1), env)]);
              const want = JSON.stringify([...cascade(stylesOnly, path.slice(0, i + 1), env)]);
              if (got !== want) drift.push(`${cl}/${tl} ${region}[${i}]`);
            });
          }
    expect(drift).toEqual([]);
  });

  it('every inventoried chrome paint and the focus outline resolve to BASE at every stored level', () => {
    const base = tree(c, BASE, 'chrome');
    for (const cl of CHROME_FROST_LEVELS)
      for (const tl of TERMINAL_FROST_LEVELS) {
        const t = tree(c, { ...BASE, chromeLevel: cl, terminalLevel: tl }, 'chrome');
        for (const p of [...CHROME_PAINT, FOCUS_OUTLINE])
          expect(evalColour(p.fg, t.scope), `${cl}/${tl} ${p.element}`).toEqual(evalColour(p.fg, base.scope));
      }
  });
});

describe.each(COMBOS)('$label chrome frost levels (glass-settings AC11)', (c) => {
  const alpha = (cl: ChromeFrostLevel): number => compositeAlpha(tree(c, at(cl, 'off'), 'chrome'));

  it(`chrome alpha strictly decreases Subtle > Medium > Strong, each step at least ${STEP}/255 of visible effect`, () => {
    expect((alpha('subtle') - alpha('medium')) * 255).toBeGreaterThanOrEqual(STEP - EPS);
    expect((alpha('medium') - alpha('strong')) * 255).toBeGreaterThanOrEqual(STEP - EPS);
  });

  it.each(CHROME_FROST_LEVELS)('chrome %s is below the 26eed37 baseline (#38 AC1)', (cl) => {
    expect(alpha(cl)).toBeLessThan(compositeAlpha(tree(c, BASE, 'chrome')));
  });
});

describe.each(COMBOS)('$label every chrome floor at every level (glass-settings AC12, D17)', (c) => {
  it.each(MAC_STATES)('%s', (_, state) => {
    expect(failing(chromeChecks(c, state))).toEqual([]);
  });
});

/** D8, D20 (clarified): adjacent terminal levels collapsed to one total at chrome Subtle, sheet and split card alike. */
const COLLAPSES: readonly string[] = [
  'default/dark subtle=medium',
  'default/dark medium=strong',
  'default/light subtle=medium',
  'default/light medium=strong',
  'catppuccin/dark medium=strong',
  'catppuccin/light subtle=medium',
  'catppuccin/light medium=strong',
  'rose-pine/dark medium=strong',
  'rose-pine/light subtle=medium',
  'rose-pine/light medium=strong',
];

describe.each(COMBOS)('$label terminal frost levels (glass-settings AC14 to AC16, D8, D16, D20)', (c) => {
  const total = (cl: ChromeFrostLevel, tl: TerminalFrostLevel, region: 'sheet' | 'card'): number =>
    compositeAlpha(tree(c, at(cl, tl), region, 'shell'));

  describe.each(CHROME_FROST_LEVELS)('chrome %s', (cl) => {
    const chromeAlpha = compositeAlpha(tree(c, at(cl, 'off'), 'chrome'));

    it.each(['sheet', 'card'] as const)('terminal Off composites the %s to alpha 1 over the chrome (AC14)', (region) => {
      expect(total(cl, 'off', region)).toBeCloseTo(1, 9);
    });

    it.each(['sheet', 'card'] as const)('terminal Off keeps --term-fg on the %s at least at its 26eed37 contrast (#38 AC5)', (region) => {
      const t = tree(c, at(cl, 'off'), region);
      expect(minRatio(token(t, '--term-fg'), composites(t))).toBeGreaterThanOrEqual(BASE_TERM_FG(c, region));
    });

    it.each(['sheet', 'card'] as const)(
      `the %s total is Off > Subtle >= Medium >= Strong >= the chrome alpha, adjacent levels ${STEP}/255 apart or a pinned collapse`,
      (region) => {
        const totals = TERMINAL_FROST_LEVELS.map((tl) => total(cl, tl, region));
        expect(totals[0]).toBeGreaterThan((totals[1] as number) + EPS);
        const collapsed: string[] = [];
        const tooClose: string[] = [];
        for (let i = 1; i < 3; i++) {
          const gap = ((totals[i] as number) - (totals[i + 1] as number)) * 255;
          const pair = `${baseKey(c)} ${TERMINAL_FROST_LEVELS[i]}=${TERMINAL_FROST_LEVELS[i + 1]}`;
          if (Math.abs(gap) < EPS) collapsed.push(pair);
          else if (gap < STEP - EPS) tooClose.push(`${pair}: ${gap.toFixed(2)}/255`);
        }
        for (const t of totals) expect(t).toBeGreaterThanOrEqual(chromeAlpha - EPS);
        expect(tooClose).toEqual([]);
        const pinned = cl === 'subtle' ? COLLAPSES.filter((p) => p.startsWith(`${baseKey(c)} `)) : [];
        expect(collapsed).toEqual(pinned);
      },
    );

    it.each(FROSTED_TERMINAL.flatMap((tl) => [false, true].map((rt) => [tl, rt] as const)))(
      'terminal %s (Reduce transparency %s) meets every #38 terminal floor on the sheet and card (AC15, AC9, AC11)',
      (tl, rt) => {
        expect(failing(terminalChecks(c, at(cl, tl, rt)))).toEqual([]);
      },
    );

    it('terminal Off under Reduce transparency meets every #38 terminal floor on the solid sheet and card that the off-mac palette meets, and never measures below it (#38 AC10)', () => {
      const rows = terminalChecks(c, at(cl, 'off', true));
      const offMac = terminalChecks(c, { ...BASE, reduceTransparency: true });
      const label = (f: string): string => f.slice(0, f.indexOf(':'));
      expect(failing(rows).map(label)).toEqual(failing(offMac).map(label));
      for (const [name, value, floor] of rows) {
        const before = offMac.find(([n]) => n === name)?.[1] as number;
        expect(value, name).toBeGreaterThanOrEqual(Math.min(before, floor) - EPS);
      }
    });
  });
});

/** Root tokens that carry the terminal level itself (its alphas, the terminal surfaces and the D14 `--term-fg`); every painted value must still match. */
const TERMINAL_MECHANISM = /^var\(--(?:terminal-|surface-terminal\)|surface-pane\)|term-fg\))/;

describe.each(COMBOS)('$label terminal frost covers only the terminal group (glass-settings AC17, #38 AC4, AC10)', (c) => {
  const OUTSIDE = [
    ['chrome', 'shell'],
    ['sheet', 'other'],
    ['chat', 'shell'],
    ['modal', 'shell'],
    ['overlay', 'shell'],
  ] as const;

  it.each(CHROME_FROST_LEVELS)('chrome %s: every terminal level leaves the chrome, Files/Diff/Env/Settings sheet, chat, modals and overlays as terminal Off', (cl) => {
    const drift: string[] = [];
    for (const [region, content] of OUTSIDE) {
      const off = snapshot(tree(c, at(cl, 'off'), region, content));
      for (const tl of FROSTED_TERMINAL) {
        const now = snapshot(tree(c, at(cl, tl), region, content));
        for (const [e, v] of now)
          if (!TERMINAL_MECHANISM.test(e) && v !== off.get(e)) drift.push(`${tl} ${region}/${content} ${e}`);
      }
    }
    expect(drift).toEqual([]);
  });

  it.each(MAC_STATES)('%s: the working area is at least as opaque as the 26eed37 baseline', (_, state) => {
    const regions: (readonly [Region, SheetContent])[] = [['sheet', 'other'], ['chat', 'shell']];
    if (state.terminalLevel === 'off') regions.push(['sheet', 'shell'], ['card', 'shell']);
    for (const [region, content] of regions)
      expect(compositeAlpha(tree(c, state, region, content)), `${region}/${content}`).toBeGreaterThanOrEqual(
        compositeAlpha(tree(c, BASE, region, content)) - EPS,
      );
  });
});

describe.each(COMBOS)('$label Reduce transparency (glass-settings AC23, #38 AC12, AC21)', (c) => {
  it.each(CHROME_FROST_LEVELS.flatMap((cl) => TERMINAL_FROST_LEVELS.map((tl) => [cl, tl] as const)))(
    'chrome %s, terminal %s: every chrome and terminal surface composites to alpha 1, exactly as at Subtle with terminal Off',
    (cl, tl) => {
      for (const region of ['chrome', 'sheet', 'card', 'chat'] as const) {
        const t = tree(c, at(cl, tl, true), region);
        expect(compositeAlpha(t), region).toBeCloseTo(1, 9);
        expect(composites(t), region).toEqual(composites(tree(c, at('subtle', 'off', true), region)));
      }
    },
  );
});

const WORKING_TOKENS = [
  '--text',
  '--text-muted',
  '--accent-soft-text',
  '--accent-soft',
  '--surface-hover',
  '--surface-active',
  '--hue-cyan',
  '--hue-pink',
  '--hue-orange-soft',
  '--hue-yellow',
  '--hue-purple',
  '--danger',
  '--agent-idle',
  '--agent-busy',
  '--agent-blocked',
  '--surface-field',
] as const;

/** Chrome-only tokens with no :root value: the classes that read them fall back to the off-mac colour, which the working area must get. */
const FALLBACK_TOKENS = [
  ['var(--accent-label, var(--accent))', 'var(--accent)'],
  ['var(--accent-mark, var(--accent))', 'var(--accent)'],
  ['var(--git-ahead-chip, rgb(52 211 153 / 0.1))', 'rgb(52 211 153 / 0.1)'],
  ['var(--git-behind-chip, rgb(251 113 133 / 0.1))', 'rgb(251 113 133 / 0.1)'],
  [`var(--focus-outline, ${FOCUS_OUTLINE_BASE})`, FOCUS_OUTLINE_BASE],
] as const;

function lookupRoot(scope: Scope): Scope {
  let s = scope;
  while (s.parent) s = s.parent;
  return s;
}

describe.each(COMBOS)('$label working-area tokens stay the palette values at every level (#38 AC10, AC24, AC30, AC31; glass-settings AC32)', (c) => {
  it.each(MAC_STATES)('%s', (_, state) => {
    const regions: (readonly [Region, SheetContent])[] = [
      ['sheet', 'other'],
      ['chat', 'shell'],
      ['modal', 'shell'],
      ['overlay', 'shell'],
      ['sheet-popover', 'shell'],
    ];
    if (state.terminalLevel === 'off') regions.push(['sheet', 'shell']);
    const rootScope: Tree = { scope: lookupRoot(tree(c, state, 'chrome').scope), layers: [] };
    for (const [region, content] of regions) {
      const t = tree(c, state, region, content);
      const where = `${region}/${content}`;
      for (const name of WORKING_TOKENS) expect(token(t, name), `${where} ${name}`).toEqual(token(rootScope, name));
      for (const s of GIT_LETTERS)
        expect(evalColour(gitLetterExpr(s), t.scope).c, `${where} git ${s}`).toEqual(hex(tailwindColors[GIT_HUES[s]][400]));
      for (const [read, fallback] of FALLBACK_TOKENS)
        expect(evalColour(read, t.scope), `${where} ${read}`).toEqual(evalColour(fallback, rootScope.scope));
    }
  });
});

/** Recorded expressions a popover's own opaque `--panel-strong` hides: the backdrop composites and the sheet surface it covers. */
const POPOVER_HIDDEN = new Set(['@alpha', '@black', '@white', 'var(--surface-sheet)']);

describe.each(COMBOS)('$label the "Add a shell" popover inside the Shell sheet is an overlay (glass-settings AC31)', (c) => {
  const drift = (state: State): string[] => {
    const overlay = snapshot(tree(c, state, 'overlay'));
    return [...snapshot(tree(c, state, 'sheet-popover'))]
      .filter(([e, v]) => !POPOVER_HIDDEN.has(e) && v !== overlay.get(e))
      .map(([e]) => e);
  };

  it.each(MAC_STATES)('%s: every recorded token resolves exactly as a top-level overlay', (_, state) => {
    expect(drift(state)).toEqual([]);
  });

  it.each([
    ['off', OFF],
    ['on', ON],
    ['off-rt', at('subtle', 'off', true)],
    ['on-rt', at('subtle', 'subtle', true)],
  ] as const)('at Subtle (%s) every recorded token equals the main@6929753 overlay', (recorded, state) => {
    const then = FIXTURE.entries[`${c.label}|${recorded}|overlay|shell`] as readonly number[];
    const now = snapshot(tree(c, state, 'sheet-popover'));
    const mismatched = FIXTURE.exprs.filter((e, i) => {
      const was = (then[i] ?? -1) < 0 ? null : (FIXTURE.values[then[i] as number] ?? null);
      return !POPOVER_HIDDEN.has(e) && now.get(e) !== was;
    });
    expect(mismatched).toEqual([]);
  });
});

/** Where the oracle needed `--text` darker (D17 on the chrome; D24 on the frosted Shell sheet and its split cards), as `palette/resolved level`. */
const CHROME_TEXT_LIFTS: readonly string[] = [
  'catppuccin/light medium',
  'catppuccin/light strong',
  'rose-pine/light strong',
];
const SHEET_TEXT_LIFTS: readonly string[] = [
  'catppuccin/light strong',
  'rose-pine/light strong',
];

describe.each(COMBOS)('$label --text lifts (glass-settings AC32, D17, D24)', (c) => {
  const palette = token(tree(c, BASE, 'chrome'), '--text');
  const expectLift = (fg: Colour, lifted: boolean, where: string): void => {
    if (lifted) expect(luminance(fg), `${where} darker`).toBeLessThan(luminance(palette));
    else expect(fg, where).toEqual(palette);
  };

  it.each(MAC_STATES)('%s', (_, state) => {
    const key = `${baseKey(c)} ${state.chromeLevel}`;
    expectLift(token(tree(c, state, 'chrome'), '--text'), CHROME_TEXT_LIFTS.includes(key), 'chrome');
    for (const region of ['sheet', 'card'] as const)
      expectLift(
        token(tree(c, state, region, 'shell'), '--text'),
        state.terminalLevel !== 'off' && SHEET_TEXT_LIFTS.includes(key),
        `${region} on Shell`,
      );
  });

  it('only light catppuccin and rose-pine, and never chrome Subtle, are lifted', () => {
    for (const k of [...CHROME_TEXT_LIFTS, ...SHEET_TEXT_LIFTS])
      expect(k).toMatch(/^(catppuccin|rose-pine)\/light (medium|strong)$/);
  });
});

describe.each(COMBOS)('$label accent and --accent-mark (glass-settings AC33, D18)', (c) => {
  const base = tree(c, BASE, 'chrome');
  const mark = 'var(--accent-mark, var(--accent))';

  it('off mac the accent glyphs paint --accent', () => {
    expect(evalColour(mark, base.scope)).toEqual(token(base, '--accent'));
  });

  it.each(MAC_STATES)('%s: --accent and --accent-text resolve as before in every region; --accent-mark is --accent at Subtle and outside the chrome and frosted Shell sheet', (_, state) => {
    for (const region of ['chrome', 'sheet', 'card', 'chat', 'modal', 'overlay'] as const) {
      const t = tree(c, state, region);
      expect(token(t, '--accent'), `${region} --accent`).toEqual(token(base, '--accent'));
      expect(token(t, '--accent-text'), `${region} --accent-text`).toEqual(token(base, '--accent-text'));
      const hooked = region === 'chrome' || ((region === 'sheet' || region === 'card') && state.terminalLevel !== 'off');
      if (!hooked || state.chromeLevel === 'subtle')
        expect(evalColour(mark, t.scope), `${region} --accent-mark`).toEqual(token(base, '--accent'));
    }
  });

  it('every accent glyph on the chrome reads --accent-mark and is inventoried', () => {
    const glyphs = CHROME_PAINT.filter((p) => /^var\(--accent(?:-mark)?[,)]/.test(p.fg));
    expect(glyphs.map((p) => p.element).sort()).toEqual(
      [
        'project row focus ring',
        'root folder glyph --accent',
        'selected project placeholder dot',
        'status-bar project dot',
        'Tasks run glyph',
      ].sort(),
    );
    for (const p of glyphs) expect(p.fg, p.element).toBe(mark);
  });
});

/** Bare `--accent` classes on the Shell sheet that paint no indicator, with the reason. */
const SHEET_ACCENT_FILLS: Readonly<Record<string, string>> = {
  'bg-[color:var(--accent)]': 'solid accent fill under --accent-text (shell and split action buttons), material-independent',
  'bg-[color:var(--accent)]/10': 'compiles to no CSS (Tailwind v3 drops an opacity modifier on a bare var)',
};

/** Every `--term-*` name the stylesheets declare except `--term-fg`: the ANSI colours, cursor and selection. */
const TERM_TOKENS = [
  ...new Set(RULES.flatMap((r) => r.decls.map(([p]) => p)).filter((p) => p.startsWith('--term-') && p !== '--term-fg')),
].sort();

/** D14: where the oracle needed the root `--term-fg` darker, as `palette/resolved level` (only with a terminal level on). */
const TERM_FG_LIFTS: readonly string[] = [
  'catppuccin/light strong',
  'rose-pine/light strong',
];

describe('root --term-fg lift scope (glass-settings AC31, D14)', () => {
  it('lifts only light catppuccin and rose-pine, never at chrome Subtle', () => {
    for (const k of TERM_FG_LIFTS) expect(k).toMatch(/^(catppuccin|rose-pine)\/light (medium|strong)$/);
  });
});

describe.each(COMBOS)('$label root --term-fg lift (glass-settings AC31, D14)', (c) => {
  const today = token(tree(c, BASE, 'chrome'), '--term-fg');

  it.each(MAC_STATES)('%s', (_, state) => {
    const lifted = TERM_FG_LIFTS.includes(`${baseKey(c)} ${state.chromeLevel}`) && state.terminalLevel !== 'off';
    for (const region of ['chrome', 'sheet', 'card'] as const) {
      const t = tree(c, state, region);
      const fg = token(t, '--term-fg');
      if (lifted) {
        expect(luminance(fg), `${region} darker`).toBeLessThan(luminance(today));
        if (region !== 'chrome') expect(minRatio(fg, composites(t)), `${region} 4.5:1`).toBeGreaterThanOrEqual(CONTRAST_TEXT);
      } else expect(fg, region).toEqual(today);
      const base = tree(c, BASE, region);
      for (const name of TERM_TOKENS)
        expect(resolvedValue(t, [], `var(${name})`), `${region} ${name}`).toBe(resolvedValue(base, [], `var(${name})`));
    }
  });
});

describe('ShellTab repaints the terminal when a level changes (glass-settings AC31)', () => {
  it('the theme observer watches the platform and both level attributes, with theme and palette', () => {
    const src = readFileSync(resolve(RENDERER, 'components/ShellTab.tsx'), 'utf8');
    const filter = /themeObserver\.observe\(document\.documentElement,\s*\{[^}]*attributeFilter:\s*\[([^\]]*)\]/.exec(src)?.[1] ?? '';
    const watched = new Set([...filter.matchAll(/(?:'([\w-]+)'|FROST_ATTR\.(\w+))/g)].map((m) => m[1] ?? FROST_ATTR[m[2] as keyof typeof FROST_ATTR]));
    expect([...watched].sort()).toEqual(
      ['data-theme', 'data-palette', FROST_ATTR.platform, FROST_ATTR.chromeFrost, FROST_ATTR.terminalFrost].sort(),
    );
  });
});

describe.each(COMBOS)('$label menus, popovers and inputs (#38 AC31)', (c) => {
  it.each(['--panel', '--panel-strong', '--chat-surface'])(
    '%s keeps the baseline rgb at alpha 1 in chrome and sheet at every level',
    (name) => {
      const base = token(tree(c, BASE, 'chrome'), name);
      for (const [label, state] of MAC_STATES)
        for (const region of ['chrome', 'sheet'] as const) {
          const mac = token(tree(c, state, region), name);
          expect(mac.a, `${label} ${region}`).toBe(1);
          mac.c.forEach((v, i) => expect(v).toBeCloseTo(base.c[i] ?? -1, 6));
        }
    },
  );
});

describe('pinned exemptions (D13), re-checked at every level', () => {
  it('pins exactly the D13 list', () => {
    expect(D13_DEBT.map((p) => p.join(' '))).toEqual([
      'default light --agent-idle any',
      'catppuccin light --agent-idle any',
      'catppuccin light --agent-busy any',
      'catppuccin light --term-yellow any',
      'catppuccin light --term-cursor any',
      'rose-pine light --agent-busy any',
      'rose-pine light --term-yellow any',
      'rose-pine light --term-cyan any',
    ]);
  });

  const PAINTED: Readonly<Record<string, string>> = {
    '--term-yellow': '--hue-yellow',
    '--term-cyan': '--hue-cyan',
  };

  /** Worst contrast of the pinned token over the surfaces the pin covers: the chrome and selected row in `chromeState`, the terminal sheet in `sheetState`. */
  function worst([palette, resolved, name, surface]: Pin, chromeState: State, sheetState: State): number {
    const combo = COMBOS.find((c) => c.palette === palette && c.theme === resolved) as Combo;
    const painted = PAINTED[name] ?? name;
    const chrome = tree(combo, chromeState, 'chrome');
    const sheet = tree(combo, sheetState, 'sheet');
    const under: Record<Surface, () => number> = {
      chrome: () => minRatio(token(chrome, painted), composites(chrome)),
      'selected-row': () => minRatio(token(chrome, painted), chip(chrome, '--accent-soft')),
      terminal: () => minRatio(token(sheet, painted), composites(sheet)),
    };
    const surfaces: readonly Surface[] =
      surface === 'any' ? ['chrome', 'selected-row', 'terminal'] : [surface];
    return Math.min(...surfaces.map((s) => under[s]()));
  }

  it.each(D13_DEBT.map((p) => [p.join(' '), p] as const))('%s still fails 3:1 at baseline', (_, pin) => {
    expect(worst(pin, BASE, BASE)).toBeLessThan(CONTRAST_GRAPHIC);
  });

  it.each(
    D13_DEBT.flatMap((p) =>
      CHROME_FROST_LEVELS.flatMap((cl) => FROSTED_TERMINAL.map((tl) => [p.join(' '), cl, tl, p] as const)),
    ),
  )('%s still fails at chrome %s, terminal %s (else unpin it)', (_, cl, tl, pin) => {
    expect(worst(pin, at(cl, 'off'), at(cl, tl))).toBeLessThan(CONTRAST_GRAPHIC);
  });
});

describe('catppuccin light chrome cyan (AC16 ruling: darker on mac chrome only)', () => {
  const combos = COMBOS.filter((c) => c.palette === 'catppuccin' && c.resolved === 'light');

  it.each(combos)('$label chrome glyphs read a darker --hue-cyan than the palette at every level', (c) => {
    const palette = token(tree(c, BASE, 'chrome'), '--hue-cyan');
    for (const cl of CHROME_FROST_LEVELS) {
      const chrome = token(tree(c, at(cl, 'off'), 'chrome'), '--hue-cyan');
      expect(chrome.c, cl).not.toEqual(palette.c);
      expect(ratio(chrome, { c: [1, 1, 1], a: 1 }), cl).toBeGreaterThan(ratio(palette, { c: [1, 1, 1], a: 1 }));
    }
  });

  it.each(combos)('$label --term-cyan keeps its palette value everywhere', (c) => {
    const palette = token(tree(c, BASE, 'chrome'), '--term-cyan');
    for (const [label, state] of MAC_STATES)
      for (const region of ['chrome', 'sheet', 'card', 'chat'] as const)
        expect(token(tree(c, state, region), '--term-cyan'), `${label} ${region}`).toEqual(palette);
  });
});

describe('chrome text label lifts (D16: macOS chrome only, lighter in dark themes, darker in light themes)', () => {
  it.each(GIT_LETTERS)(
    'git status %s reads a --git-* token whose fallback is its Tailwind -400 hue, so off mac nothing changes',
    (s) => {
      const m = GIT_TOKEN.exec(gitStatusTextClass(s));
      expect(m?.[1]).toMatch(/^--git-/);
      expect(m?.[2]).toBe(tailwindColors[GIT_HUES[s]][400]);
    },
  );

  it.each(COMBOS)('$label chrome --hue-pink and the deleted letter move toward the theme pole at every level', (c) => {
    const toPole = (lifted: Colour, palette: Colour) =>
      c.resolved === 'dark' ? luminance(lifted) > luminance(palette) : luminance(lifted) < luminance(palette);
    for (const cl of CHROME_FROST_LEVELS) {
      const chrome = tree(c, at(cl, 'off'), 'chrome');
      expect(toPole(token(chrome, '--hue-pink'), token(tree(c, BASE, 'chrome'), '--hue-pink')), cl).toBe(true);
      expect(toPole(evalColour(gitLetterExpr('D'), chrome.scope), { c: hex(tailwindColors.rose[400]), a: 1 }), cl).toBe(true);
    }
  });
});

describe('chrome colour inventory (D17)', () => {
  it('the mac focus rule reads --focus-outline for exactly the styles.css focus selectors', () => {
    const focus = (css: string) =>
      /([^{}]*:focus-visible[^{}]*)\{[^}]*outline[^}]*\}/.exec(css.replace(/\/\*[\s\S]*?\*\//g, ''));
    const base = splitTop((focus(STYLES)?.[1] ?? '').trim(), ',');
    const mac = focus(FROSTED);
    expect(mac?.[0]).toContain(`outline-color: var(--focus-outline, ${FOCUS_OUTLINE_BASE})`);
    const squash = (sel: string) =>
      sel
        .replace(/\s+/g, ' ')
        .replace(/\s*([(),])\s*/g, '$1')
        .trim();
    expect(squash(mac?.[1] ?? '')).toBe(
      squash(base.map((sel) => `:where(:root[data-platform="mac"] [data-chrome-root]) ${sel}`).join(',')),
    );
  });

  it('the mac focus rule adds no specificity over the styles.css focus rule', () => {
    // The styles.css rule loses to an element's own `focus-visible:outline-none` (0,2,0). The mac
    // prefix sits in :where(), so each mac selector keeps exactly its styles.css weight and an
    // outline-none element stays outline-free on mac too.
    const rule = (css: string) =>
      /([^{}]*:focus-visible[^{}]*)\{[^}]*outline[^}]*\}/.exec(css.replace(/\/\*[\s\S]*?\*\//g, ''));
    const weight = (sel: string): Spec =>
      sel
        .replace(/:where\([^)]*\)/g, '')
        .trim()
        .split(/\s+/)
        .map(specificity)
        .reduce<Spec>((a, b) => addSpec(a, b), [0, 0, 0]);
    const base = splitTop((rule(STYLES)?.[1] ?? '').trim(), ',');
    const mac = splitTop((rule(FROSTED)?.[1] ?? '').trim(), ',');
    expect(mac).toHaveLength(base.length);
    mac.forEach((sel, i) => {
      expect(sel, sel).not.toMatch(/:is\(/);
      expect(weight(sel), sel).toEqual(weight(base[i] ?? ''));
    });
  });

  const SOURCES = [...new Set(CHROME_PAINT.map((p) => p.src))].filter((s) => !s.endsWith('.ts'));

  it.each(SOURCES)('%s: every colour class is in the inventory or explained', (src) => {
    const listed = new Set(CHROME_PAINT.filter((p) => p.src === src).flatMap((p) => p.classes));
    const unexplained = colourClasses(chromeSource(src)).filter(
      (k) => !listed.has(k) && !(k in NOT_CHROME_PAINT),
    );
    expect(unexplained).toEqual([]);
  });

  it('lists every pin once, with a reason, against an inventoried element', () => {
    const elements = CHROME_PAINT.map((p) => p.element);
    expect(new Set(elements).size).toBe(elements.length);
    for (const [element, reason] of Object.entries(D17_PINS)) {
      expect(elements, element).toContain(element);
      expect(reason.length).toBeGreaterThan(20);
    }
  });

  it.each(Object.keys(D17_PINS).flatMap((e) => CHROME_FROST_LEVELS.map((cl) => [e, cl] as const)))(
    '%s still fails at chrome %s (else unpin it)',
    (element, cl) => {
      const p = CHROME_PAINT.find((x) => x.element === element) as ChromePaint;
      const states = MAC_STATES.filter(([, s]) => s.chromeLevel === cl);
      const worst = Math.min(...COMBOS.flatMap((c) => states.map(([, s]) => paintMin(tree(c, s, 'chrome'), p))));
      expect(worst).toBeLessThan(floorOf(p));
    },
  );

  it.each(['SplitGutter.tsx', 'ShellTab.tsx'])(
    '%s paints its accent indicators on the frosted Shell sheet with --accent-mark (glass-settings D18)',
    (src) => {
      const text = readFileSync(resolve(COMPONENTS, src), 'utf8');
      const bare = colourClasses(text).filter(
        (k) => /--accent\)?\]/.test(k) && !/--accent-(?:mark|soft|text|label)/.test(k) && !(k in SHEET_ACCENT_FILLS),
      );
      expect(bare).toEqual([]);
      expect(text).toContain('var(--accent-mark,var(--accent))');
    },
  );

  it.each(['StatusBar.tsx', 'ContextMenu.tsx', 'ToastStack.tsx'])(
    '%s marks its overlay root, so the mac reset keeps chrome lifts out of it (AC31)',
    (src) => {
      const text = readFileSync(resolve(COMPONENTS, src), 'utf8');
      const root =
        src === 'StatusBar.tsx'
          ? between(text, '{open && (', '</div>\n      )}\n    </div>\n  );')
          : text;
      expect(root).toMatch(new RegExp(`\\s${FROST_ATTR.overlay}[\\s>]`));
    },
  );

  it('ShellTabsBar spreads the overlay hook onto both "Add a shell" popover panels, so the reset keeps Shell sheet lifts out of them (the sheet-popover region, AC31)', () => {
    const text = readFileSync(resolve(COMPONENTS, 'ShellTabsBar.tsx'), 'utf8');
    expect(between(text, 'const panelProps = {', '};')).toMatch(new RegExp(`'${FROST_ATTR.overlay}':\\s*''`));
    expect(text.match(/<m\.div\s+\{\.\.\.panelProps\}/g)).toHaveLength(2);
  });

  it('GitPanel reads each --git-* token with the same Tailwind -400 fallback as the status letters', () => {
    const letters = new Map(
      GIT_LETTERS.map((l) => GIT_TOKEN.exec(gitStatusTextClass(l)) as RegExpExecArray).map((m) => [
        m[1],
        m[2],
      ]),
    );
    const reads = [
      ...chromeSource('GitPanel.tsx').matchAll(/var\((--git-[\w-]+),(#[0-9a-f]{6})\)/g),
    ];
    expect(reads.length).toBeGreaterThanOrEqual(5);
    for (const [, name, fallback] of reads) expect(fallback, name).toBe(letters.get(name));
  });
});


