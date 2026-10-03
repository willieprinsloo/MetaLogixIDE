/**
 * Derives Mermaid `base`-theme `themeVariables` from the app's live theme
 * tokens, so diagrams use the app palette and stay legible in both themes.
 * Pure: it never reads the DOM. Every emitted colour is an opaque `#rrggbb`
 * computed from a token, so a token edit flows through with no second copy.
 * Translucent tokens are composited onto the reference backgrounds, lines and
 * accent roles are moved in lightness until they clear the WCAG graphic
 * threshold against both backgrounds, and text is the exact `--text` token.
 */
import type { EffectiveTheme } from '../contract';
import { categoricalColours } from './categoricalColours';
import { adjustToContrast, composite, contrastRatio, parseColour, toHex } from './colour';
import {
  BG_LAYERS,
  CONTRAST_GRAPHIC,
  CONTRAST_TEXT,
  PaletteTokenError,
  REFERENCE_MATERIALS,
  THEME_TOKEN_NAMES,
  type Rgb,
  type Rgba,
  type ThemeTokens,
} from './paletteContract';

type Parsed = Record<keyof ThemeTokens, Rgba>;
type Variables = Record<string, string>;

/** The app hues the categorical colours start from, in pick order; `--danger` is reserved for errors. */
const CATEGORY_SEEDS = [
  'iconMd',
  'iconImg',
  'iconCode',
  'hljsVariable',
  'hljsFunction',
  'hljsTag',
  'hljsString',
  'hljsNumber',
] as const satisfies ReadonlyArray<keyof ThemeTokens>;

const TINT = { note: 0.18, category: 0.22, active: 0.3, crit: 0.3 } as const;

interface Base {
  text: Rgb;
  refs: readonly [Rgb, Rgb];
  surface: Rgb;
  surfaceAlt: Rgb;
  inverse: Rgb;
  line: Rgb;
  accent: Rgb;
  accentLine: Rgb;
  danger: Rgb;
  dangerLine: Rgb;
  categories: Rgb[];
}

function parseTokens(tokens: ThemeTokens): Parsed {
  const entries = Object.entries(THEME_TOKEN_NAMES).map(([field, name]) => {
    const value = tokens[field as keyof ThemeTokens];
    const colour = parseColour(value);
    if (!colour) throw new PaletteTokenError(name, value);
    return [field, colour] as const;
  });
  return Object.fromEntries(entries) as Parsed;
}

function opaque(colour: Rgba, over: Rgb): Rgb {
  return colour.a < 1 ? composite(colour, over) : colour;
}

function tint(colour: Rgb, alpha: number, over: Rgb): Rgb {
  return composite({ ...colour, a: alpha }, over);
}

function material(hex: string): Rgb {
  const colour = parseColour(hex);
  if (!colour) throw new Error(`REFERENCE_MATERIALS holds a non-colour: ${hex}`);
  return colour;
}

function backgrounds(bg: Rgba, theme: EffectiveTheme): readonly [Rgb, Rgb] {
  const paint = (hex: string): Rgb => {
    let colour = material(hex);
    for (let layer = 0; layer < BG_LAYERS; layer++) colour = composite(bg, colour);
    return { r: Math.round(colour.r), g: Math.round(colour.g), b: Math.round(colour.b) };
  };
  const [lo, hi] = REFERENCE_MATERIALS[theme];
  return [paint(lo), paint(hi)];
}

/**
 * The two opaque colours a diagram's transparent areas can land on in
 * `theme`: the live `--bg` painted `BG_LAYERS` times over each reference
 * material, as `#rrggbb`. Throws `PaletteTokenError` if `--bg` is unparseable.
 */
export function referenceBackgrounds(
  tokens: ThemeTokens,
  theme: EffectiveTheme,
): readonly [string, string] {
  const bg = parseColour(tokens.bg);
  if (!bg) throw new PaletteTokenError(THEME_TOKEN_NAMES.bg, tokens.bg);
  const [lo, hi] = backgrounds(bg, theme);
  return [toHex(lo), toHex(hi)];
}

function fit(colour: Rgb, against: readonly Rgb[], min: number, role: string): Rgb {
  const fitted = adjustToContrast(colour, against, min);
  if (!fitted)
    throw new Error(`The ${role} colour cannot reach ${min}:1 on the diagram background`);
  return fitted;
}

/**
 * A `categoricalColours` fit for these reference backgrounds and label colour:
 * the candidate moved in lightness to 3:1 on both backgrounds, then to 4.5:1
 * under `label`, or `null` when the second move undoes the first.
 */
export function fitCategory(refs: readonly [Rgb, Rgb], label: Rgb): (c: Rgb) => Rgb | null {
  return (candidate) => {
    const onPane = adjustToContrast(candidate, refs, CONTRAST_GRAPHIC);
    const readable = onPane && adjustToContrast(onPane, [label], CONTRAST_TEXT);
    return readable && refs.every((r) => contrastRatio(readable, r) >= CONTRAST_GRAPHIC)
      ? readable
      : null;
  };
}

function derive(tokens: ThemeTokens, theme: EffectiveTheme): Base {
  const t = parseTokens(tokens);
  const refs = backgrounds(t.bg, theme);
  const near = refs[1];
  const surface = opaque(t.panelStrong, near);
  const inverse = theme === 'dark' ? refs[0] : refs[1];
  const accent = opaque(t.accent, surface);
  const danger = opaque(t.danger, surface);
  const seeds = CATEGORY_SEEDS.map((field) => ({
    token: THEME_TOKEN_NAMES[field],
    colour: opaque(t[field], surface),
  }));
  return {
    text: opaque(t.text, surface),
    refs,
    surface,
    surfaceAlt: opaque(t.panel, near),
    inverse,
    line: fit(opaque(t.textMuted, surface), refs, CONTRAST_GRAPHIC, THEME_TOKEN_NAMES.textMuted),
    accent,
    accentLine: fit(accent, refs, CONTRAST_GRAPHIC, THEME_TOKEN_NAMES.accent),
    danger,
    dangerLine: fit(danger, refs, CONTRAST_GRAPHIC, THEME_TOKEN_NAMES.danger),
    categories: categoricalColours(seeds, fitCategory(refs, inverse), [danger]),
  };
}

function hexes(roles: Record<string, Rgb>): Variables {
  return Object.fromEntries(Object.entries(roles).map(([name, colour]) => [name, toHex(colour)]));
}

function surfaceRoles(b: Base): Variables {
  const note = tint(b.accent, TINT.note, b.surface);
  return hexes({
    background: b.refs[0],
    primaryColor: b.surface,
    secondaryColor: b.surfaceAlt,
    tertiaryColor: b.surfaceAlt,
    mainBkg: b.surface,
    nodeBkg: b.surface,
    clusterBkg: b.surfaceAlt,
    edgeLabelBackground: b.surface,
    actorBkg: b.surface,
    labelBoxBkgColor: b.surface,
    activationBkgColor: b.surfaceAlt,
    noteBkgColor: note,
    stateBkg: b.surface,
    labelBackgroundColor: b.surface,
    compositeBackground: b.surfaceAlt,
    compositeTitleBackground: b.surface,
    altBackground: b.surfaceAlt,
    innerEndBackground: b.line,
    rowOdd: b.surface,
    rowEven: b.surfaceAlt,
    attributeBackgroundColorOdd: b.surface,
    attributeBackgroundColorEven: b.surfaceAlt,
    personBkg: b.surface,
    faceColor: b.surface,
    requirementBackground: b.surface,
    relationLabelBackground: b.surface,
    tagLabelBackground: b.surface,
    commitLabelBackground: b.surface,
    errorBkgColor: tint(b.danger, TINT.crit, b.surface),
  });
}

const TEXT_ROLES = [
  'primaryTextColor',
  'secondaryTextColor',
  'tertiaryTextColor',
  'textColor',
  'nodeTextColor',
  'titleColor',
  'actorTextColor',
  'labelTextColor',
  'loopTextColor',
  'signalTextColor',
  'noteTextColor',
  'classText',
  'stateLabelColor',
  'transitionLabelColor',
  'taskTextColor',
  'taskTextOutsideColor',
  'taskTextLightColor',
  'taskTextDarkColor',
  'pieTitleTextColor',
  'pieLegendTextColor',
  'relationLabelColor',
  'requirementTextColor',
  'tagLabelColor',
  'commitLabelColor',
  'errorTextColor',
  'quadrant1TextFill',
  'quadrant2TextFill',
  'quadrant3TextFill',
  'quadrant4TextFill',
  'quadrantPointTextFill',
  'quadrantXAxisTextFill',
  'quadrantYAxisTextFill',
  'quadrantTitleFill',
] as const;

function textRoles(b: Base): Variables {
  return hexes(Object.fromEntries(TEXT_ROLES.map((role) => [role, b.text])));
}

function lineRoles(b: Base): Variables {
  return hexes({
    lineColor: b.line,
    arrowheadColor: b.line,
    defaultLinkColor: b.line,
    signalColor: b.line,
    actorLineColor: b.line,
    transitionColor: b.line,
    specialStateColor: b.line,
    relationColor: b.line,
    clusterBorder: b.line,
    secondaryBorderColor: b.line,
    tertiaryBorderColor: b.line,
    border1: b.line,
    border2: b.line,
    vertLineColor: b.line,
    doneTaskBorderColor: b.line,
    pieOuterStrokeColor: b.line,
    quadrantExternalBorderStrokeFill: b.line,
    quadrantInternalBorderStrokeFill: b.line,
    gridColor: tint(b.line, 0.5, b.refs[0]),
    sequenceNumberColor: b.inverse,
    pieStrokeColor: b.inverse,
  });
}

function accentRoles(b: Base): Variables {
  return hexes({
    primaryBorderColor: b.accentLine,
    nodeBorder: b.accentLine,
    actorBorder: b.accentLine,
    labelBoxBorderColor: b.accentLine,
    noteBorderColor: b.accentLine,
    activationBorderColor: b.accentLine,
    personBorder: b.accentLine,
    requirementBorderColor: b.accentLine,
    tagLabelBorder: b.accentLine,
    activeTaskBorderColor: b.accentLine,
    taskBorderColor: b.accentLine,
    todayLineColor: b.accentLine,
    quadrantPointFill: b.accentLine,
    taskTextClickableColor: fit(b.accent, [...b.refs, b.surface], CONTRAST_TEXT, 'link'),
  });
}

function ganttRoles(b: Base): Variables {
  return hexes({
    taskBkgColor: b.surface,
    activeTaskBkgColor: tint(b.accent, TINT.active, b.surface),
    doneTaskBkgColor: b.surfaceAlt,
    critBkgColor: tint(b.danger, TINT.crit, b.surface),
    critBorderColor: b.dangerLine,
    sectionBkgColor: b.surfaceAlt,
    sectionBkgColor2: b.surface,
    altSectionBkgColor: b.refs[0],
    excludeBkgColor: b.surfaceAlt,
    quadrant1Fill: b.surface,
    quadrant2Fill: b.surfaceAlt,
    quadrant3Fill: b.surface,
    quadrant4Fill: b.surfaceAlt,
  });
}

/** `{prefix}{start}` … `{prefix}{start + count - 1}`, cycling through `colours`. */
function indexed(prefix: string, colours: readonly Rgb[], count: number, start = 0) {
  return Object.fromEntries(
    Array.from({ length: count }, (_, i) => [`${prefix}${i + start}`, colours[i % colours.length]]),
  ) as Record<string, Rgb>;
}

function categoryRoles(b: Base): Variables {
  const soft = b.categories.map((c) => tint(c, TINT.category, b.surface));
  return hexes({
    ...indexed('pie', b.categories, 12, 1),
    pieSectionTextColor: b.inverse,
    ...indexed('git', b.categories, 8),
    ...indexed('gitInv', [b.inverse], 8),
    ...indexed('gitBranchLabel', [b.inverse], 8),
    ...indexed('actor', b.categories, 6),
    ...indexed('fillType', soft, 8),
    ...indexed('cScale', soft, 12),
    ...indexed('cScalePeer', b.categories, 12),
    ...indexed('cScaleInv', b.categories, 12),
    ...indexed('cScaleLabel', [b.text], 12),
  });
}

function xyChart(b: Base): Record<string, string> {
  const [title, line] = [toHex(b.text), toHex(b.line)];
  return {
    backgroundColor: toHex(b.surfaceAlt),
    titleColor: title,
    dataLabelColor: title,
    legendTextColor: title,
    xAxisTitleColor: title,
    xAxisLabelColor: title,
    xAxisTickColor: line,
    xAxisLineColor: line,
    yAxisTitleColor: title,
    yAxisLabelColor: title,
    yAxisTickColor: line,
    yAxisLineColor: line,
    plotColorPalette: b.categories.map(toHex).join(','),
  };
}

/**
 * Mermaid `base`-theme `themeVariables` for `theme`, derived from `tokens`:
 * a flat map of `#rrggbb` colours plus `darkMode`, `pieOpacity` and the
 * nested `xyChart` block. Throws `PaletteTokenError`, naming the CSS custom
 * property, when a token cannot be parsed as a colour.
 */
export function mermaidThemeVariables(
  tokens: ThemeTokens,
  theme: EffectiveTheme,
): Record<string, unknown> {
  const b = derive(tokens, theme);
  return {
    darkMode: theme === 'dark',
    ...surfaceRoles(b),
    ...textRoles(b),
    ...lineRoles(b),
    ...accentRoles(b),
    ...ganttRoles(b),
    ...categoryRoles(b),
    pieOpacity: '1',
    xyChart: xyChart(b),
  };
}

/**
 * Mermaid `base`-theme derivations the palette pre-empts, child keys first,
 * then the inputs `updateColors` derives them from (mermaid 11.17.2,
 * dist/mermaid.js:1878-2181). Used to hand a derived key back to Mermaid when
 * a diagram's directive overrides one of its inputs.
 */
const DERIVED_FROM: ReadonlyArray<readonly [children: string, parents: string]> = [
  ['primaryTextColor', 'darkMode'],
  ['secondaryColor tertiaryColor nodeBkg mainBkg sectionBkgColor2 taskBkgColor', 'primaryColor'],
  [
    'activeTaskBorderColor activeTaskBkgColor requirementBackground tagLabelBackground',
    'primaryColor',
  ],
  ['quadrant1Fill git0 git3 git4 git5 git6 git7 pie1 cScale0', 'primaryColor'],
  ['cScale3 cScale4 cScale5 cScale6 cScale7 cScale8 cScale9 cScale10 cScale11', 'primaryColor'],
  ['fillType0 fillType2 fillType4 fillType6', 'primaryColor'],
  ['primaryBorderColor', 'primaryColor darkMode'],
  ['secondaryBorderColor edgeLabelBackground relationLabelBackground', 'secondaryColor darkMode'],
  [
    'secondaryTextColor activationBorderColor activationBkgColor commitLabelBackground',
    'secondaryColor',
  ],
  ['git1 pie2 cScale1 fillType1 fillType3 fillType5 fillType7', 'secondaryColor'],
  ['tertiaryBorderColor', 'tertiaryColor darkMode'],
  [
    'tertiaryTextColor clusterBkg sectionBkgColor rectBkgColor altBackground errorBkgColor',
    'tertiaryColor',
  ],
  ['git2 pie3 cScale2', 'tertiaryColor'],
  ['pie4 pie5 pie6 pie7 pie8 pie9 pie10 pie11 pie12', 'primaryColor secondaryColor tertiaryColor'],
  ['noteBorderColor', 'noteBkgColor darkMode'],
  ['lineColor arrowheadColor compositeBackground', 'background'],
  [
    'defaultLinkColor sequenceNumberColor transitionColor specialStateColor relationColor',
    'lineColor',
  ],
  ['textColor nodeTextColor actorTextColor stateLabelColor tagLabelColor', 'primaryTextColor'],
  ['requirementTextColor quadrantPointTextFill quadrantXAxisTextFill', 'primaryTextColor'],
  [
    'quadrantYAxisTextFill quadrantTitleFill quadrant1TextFill quadrant2TextFill',
    'primaryTextColor',
  ],
  ['quadrant3TextFill quadrant4TextFill', 'primaryTextColor'],
  ['signalColor signalTextColor classText transitionLabelColor pieSectionTextColor', 'textColor'],
  ['taskTextColor taskTextOutsideColor taskTextLightColor taskTextDarkColor', 'textColor'],
  ['pieTitleTextColor pieLegendTextColor', 'taskTextDarkColor'],
  ['border2 clusterBorder', 'tertiaryBorderColor'],
  [
    'nodeBorder actorBorder taskBorderColor personBorder requirementBorderColor',
    'primaryBorderColor',
  ],
  [
    'tagLabelBorder quadrantInternalBorderStrokeFill quadrantExternalBorderStrokeFill',
    'primaryBorderColor',
  ],
  ['titleColor errorTextColor', 'tertiaryTextColor'],
  ['commitLabelColor', 'secondaryTextColor'],
  ['actorBkg personBkg stateBkg compositeTitleBackground', 'mainBkg'],
  ['rowOdd rowEven', 'mainBkg darkMode'],
  ['innerEndBackground', 'nodeBorder'],
  ['labelBoxBkgColor', 'actorBkg'],
  ['labelBoxBorderColor actorLineColor', 'actorBorder'],
  ['labelTextColor loopTextColor relationLabelColor', 'actorTextColor'],
  ['labelBackgroundColor', 'stateBkg'],
  ['quadrant2Fill quadrant3Fill quadrant4Fill quadrantPointFill', 'quadrant1Fill'],
  ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => [`gitInv${i}`, `git${i}`] as const),
  ['gitBranchLabel0 gitBranchLabel1 gitBranchLabel2 gitBranchLabel3', 'labelTextColor darkMode'],
  ['gitBranchLabel4 gitBranchLabel5 gitBranchLabel6 gitBranchLabel7', 'labelTextColor darkMode'],
  ...Array.from({ length: 12 }, (_, i) => [`cScaleInv${i} cScalePeer${i}`, `cScale${i}`] as const),
  [Array.from({ length: 12 }, (_, i) => `cScaleLabel${i}`).join(' '), 'labelTextColor'],
];

const EDGES = DERIVED_FROM.flatMap(([children, parents]) =>
  children.split(' ').flatMap((child) => parents.split(' ').map((parent) => [child, parent])),
);

/** Mermaid's own directive value filter (sanitizeDirective); anything else never reaches a theme. */
const SAFE_VALUE = /^[\d "#%(),.;A-Za-z]+$/;
const SAFE_KEY = /^[A-Za-z][A-Za-z0-9]*$/;
/**
 * Colour forms Mermaid's colour library and `parseColour` both read, with the
 * same meaning: unpadded `#rgb`/`#rrggbb`/`#rrggbbaa` and comma `rgb[a]()`.
 * khroma rejects padding and four-part space syntax, and reads `#abcd` as two
 * channels rather than `#rgba`, so those are never folded in.
 */
const FOLDABLE = [
  /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i,
  /^rgba?\([^,()]+(?:,[^,()]+){2,3}\)$/i,
];

function authorEntries(author: unknown): Array<[string, string]> {
  if (typeof author !== 'object' || author === null) return [];
  return Object.entries(author).filter(
    (entry): entry is [string, string] =>
      SAFE_KEY.test(entry[0]) &&
      typeof entry[1] === 'string' &&
      SAFE_VALUE.test(entry[1]) &&
      FOLDABLE.some((form) => form.test(entry[1])) &&
      parseColour(entry[1]) !== null,
  );
}

function derivedFrom(inputs: ReadonlySet<string>): Set<string> {
  const reached = new Set(inputs);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [child = '', parent = ''] of EDGES) {
      if (reached.has(parent) && !reached.has(child)) {
        reached.add(child);
        grew = true;
      }
    }
  }
  return reached;
}

/**
 * The palette with a diagram's own directive `themeVariables` (given without
 * a `theme`) folded in. Mermaid does not re-derive the theme for such a
 * directive, so the author keys go into `initialize` and every palette colour
 * Mermaid would have derived from them is dropped, letting `base` derive it
 * from the author's value; everything else keeps the app palette. Only plain
 * keys whose value passes Mermaid's directive sanitiser and parses as a colour
 * are folded in: Mermaid's colour library throws on anything else under
 * `base`, while left out it is still overlaid from the directive, un-derived.
 */
export function withAuthorVariables(
  palette: Record<string, unknown>,
  author: unknown,
): Record<string, unknown> {
  const entries = authorEntries(author);
  if (entries.length === 0) return palette;
  const authored = new Set(entries.map(([key]) => key));
  const dropped = derivedFrom(authored);
  const kept = Object.entries(palette).filter(([key]) => !dropped.has(key));
  return { ...Object.fromEntries(kept), ...Object.fromEntries(entries) };
}
