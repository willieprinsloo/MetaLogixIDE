import { beforeAll, describe, expect, it } from 'vitest';
import type { EffectiveTheme } from '@renderer/markdown/contract';
import {
  CategoricalColourError,
  categoricalColours,
  deltaE2000 as solverDeltaE,
} from '@renderer/markdown/mermaid/categoricalColours';
import {
  composite,
  contrastRatio,
  hslHue,
  parseColour,
  toHex,
} from '@renderer/markdown/mermaid/colour';
import {
  fitCategory,
  mermaidThemeVariables,
  referenceBackgrounds,
  withAuthorVariables,
} from '@renderer/markdown/mermaid/mermaidPalette';
import {
  CONTRAST_GRAPHIC,
  CONTRAST_TEXT,
  MIN_CATEGORY_DELTA_E,
  PaletteTokenError,
  THEME_TOKEN_NAMES,
  type Rgb,
  type ThemeTokens,
} from '@renderer/markdown/mermaid/paletteContract';
import { readThemeTokens } from '@renderer/markdown/mermaid/themeTokens';
import { deltaE2000 } from '../../../support/deltaE2000';
import { stylesheetBlock, stylesheetTokens, type TokenBlock } from './support/styleTokens';

const HEX6 = /^#[0-9a-f]{6}$/;
const THEMES: Array<[TokenBlock, EffectiveTheme]> = [
  ['dark', 'dark'],
  ['light', 'light'],
  ['systemLight', 'light'],
];
const TOKEN_FIELDS = Object.keys(THEME_TOKEN_NAMES) as Array<keyof ThemeTokens>;

function rgb(hex: string): Rgb {
  const parsed = parseColour(hex);
  if (!parsed) throw new Error(`not a colour: ${hex}`);
  return parsed;
}

function palette(tokens: ThemeTokens, theme: EffectiveTheme): Record<string, string> {
  const vars = mermaidThemeVariables(tokens, theme);
  const flat: Record<string, string> = {};
  for (const [key, value] of Object.entries(vars)) if (typeof value === 'string') flat[key] = value;
  return flat;
}

function role(vars: Record<string, string>, name: string): string {
  const value = vars[name];
  if (value === undefined) throw new Error(`palette does not set ${name}`);
  return value;
}

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

const ACCENT_ROLES = [
  'nodeBorder',
  'primaryBorderColor',
  'actorBorder',
  'activationBorderColor',
  'activeTaskBorderColor',
  'todayLineColor',
];

const TEXT_ON_FILL: Array<[string, string]> = [
  ['nodeTextColor', 'mainBkg'],
  ['nodeTextColor', 'nodeBkg'],
  ['actorTextColor', 'actorBkg'],
  ['stateLabelColor', 'stateBkg'],
  ['classText', 'mainBkg'],
  ['noteTextColor', 'noteBkgColor'],
  ['labelTextColor', 'labelBoxBkgColor'],
  ['textColor', 'edgeLabelBackground'],
  ['textColor', 'clusterBkg'],
  ['transitionLabelColor', 'labelBackgroundColor'],
  ['taskTextColor', 'taskBkgColor'],
  ['taskTextColor', 'activeTaskBkgColor'],
  ['taskTextColor', 'doneTaskBkgColor'],
  ['taskTextColor', 'critBkgColor'],
  ['taskTextClickableColor', 'taskBkgColor'],
  ['commitLabelColor', 'commitLabelBackground'],
  ['tagLabelColor', 'tagLabelBackground'],
  ['relationLabelColor', 'relationLabelBackground'],
  ['requirementTextColor', 'requirementBackground'],
  ['errorTextColor', 'errorBkgColor'],
  ...range(1, 12).map((i): [string, string] => ['pieSectionTextColor', `pie${i}`]),
  ...range(0, 7).map((i): [string, string] => [`gitBranchLabel${i}`, `git${i}`]),
  ...range(0, 7).map((i): [string, string] => ['textColor', `fillType${i}`]),
  ...range(0, 11).map((i): [string, string] => [`cScaleLabel${i}`, `cScale${i}`]),
];

const TEXT_ON_BACKGROUND = [
  'textColor',
  'titleColor',
  'pieTitleTextColor',
  'pieLegendTextColor',
  'signalTextColor',
  'loopTextColor',
  'taskTextOutsideColor',
  'taskTextDarkColor',
  'taskTextClickableColor',
];

const GRAPHICS = [
  'lineColor',
  'arrowheadColor',
  'defaultLinkColor',
  'signalColor',
  'actorLineColor',
  'nodeBorder',
  'actorBorder',
  'clusterBorder',
  'transitionColor',
  'relationColor',
  'labelBoxBorderColor',
  'noteBorderColor',
  'critBorderColor',
  'pieOuterStrokeColor',
  ...ACCENT_ROLES,
  ...range(0, 7).map((i) => `git${i}`),
  ...range(1, 12).map((i) => `pie${i}`),
  ...range(0, 5).map((i) => `actor${i}`),
];

const CATEGORY_SETS: Array<[string, string[]]> = [
  ['pie', range(1, 8).map((i) => `pie${i}`)],
  ['gitGraph', range(0, 3).map((i) => `git${i}`)],
  ['journey', range(0, 1).map((i) => `actor${i}`)],
];

describe('categoricalColours', () => {
  it('measures distance with CIEDE2000, agreeing with the reference implementation', () => {
    let seed = 7;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % 256;
    };
    for (let i = 0; i < 500; i++) {
      const a = { r: next(), g: next(), b: next() };
      const b = { r: next(), g: next(), b: next() };
      expect(solverDeltaE(a, b)).toBeCloseTo(deltaE2000(toHex(a), toHex(b)), 6);
    }
    expect(solverDeltaE(rgb('#808080'), rgb('#808080'))).toBe(0);
  });

  const seeds = (...hexes: string[]) =>
    hexes.map((hex, i) => ({ token: `--seed-${i}` as const, colour: rgb(hex) }));

  it('keeps distinct seeds as they are and turns a clashing seed until it stands apart', () => {
    const picks = categoricalColours(seeds('#2563eb', '#dc2626', '#2c68ee'), (c) => c);
    expect(picks.slice(0, 2).map(toHex)).toEqual(['#2563eb', '#dc2626']);
    expect(toHex(picks[2] ?? rgb('#000'))).not.toBe('#2c68ee');
    for (const [i, a] of picks.entries())
      for (const b of picks.slice(i + 1))
        expect(deltaE2000(toHex(a), toHex(b))).toBeGreaterThanOrEqual(MIN_CATEGORY_DELTA_E);
  });

  it('keeps picks away from reserved colours', () => {
    const [pick] = categoricalColours(seeds('#dc2626'), (c) => c, [rgb('#dc2626')]);
    expect(deltaE2000(toHex(pick ?? rgb('#000')), '#dc2626')).toBeGreaterThanOrEqual(
      MIN_CATEGORY_DELTA_E,
    );
  });

  it('names the seed token and the contrast rule when no candidate fits (C2)', () => {
    let thrown: unknown;
    try {
      categoricalColours(seeds('#2563eb'), () => null);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CategoricalColourError);
    expect((thrown as CategoricalColourError).token).toBe('--seed-0');
    expect((thrown as Error).message).toMatch(/--seed-0.*contrast/);
  });

  it('names the seed token and the distinctness rule when every fit clashes (C2)', () => {
    const fixed = rgb('#2563eb');
    expect(() => categoricalColours(seeds('#2563eb', '#dc2626'), () => fixed)).toThrow(
      /--seed-1.*CIEDE2000/,
    );
  });
});

describe('fitCategory', () => {
  it('rejects a candidate whose label fix breaks its contrast on the backgrounds', () => {
    const grey = rgb('#333333');
    expect(fitCategory([grey, grey], rgb('#ffffff'))(rgb('#3b82f6'))).toBeNull();
  });

  it('returns a colour meeting both rules when they are compatible', () => {
    const fitted = fitCategory([rgb('#000000'), rgb('#000000')], rgb('#000000'))(rgb('#3b82f6'));
    if (!fitted) throw new Error('expected a fitted colour');
    expect(contrastRatio(fitted, rgb('#000000'))).toBeGreaterThanOrEqual(CONTRAST_TEXT);
  });
});

describe('readThemeTokens', () => {
  it('reads and trims every token from the element’s computed style', () => {
    const asked: string[] = [];
    const root = {
      ownerDocument: {
        defaultView: {
          getComputedStyle: (el: unknown) => {
            expect(el).toBe(root);
            return {
              getPropertyValue: (name: string) => {
                asked.push(name);
                return `  value-of${name} `;
              },
            };
          },
        },
      },
    } as unknown as Element;
    const tokens = readThemeTokens(root);
    for (const field of TOKEN_FIELDS)
      expect(tokens[field]).toBe(`value-of${THEME_TOKEN_NAMES[field]}`);
    expect(new Set(asked)).toEqual(new Set(Object.values(THEME_TOKEN_NAMES)));
  });
});

describe('styles.css theme tokens (AC13 guard)', () => {
  it.each(THEMES)('declares every palette token in the %s block as a parseable colour', (block) => {
    const tokens = stylesheetTokens(block);
    for (const field of TOKEN_FIELDS) {
      expect(parseColour(tokens[field]), `${block} ${THEME_TOKEN_NAMES[field]}`).not.toBeNull();
    }
  });

  it('keeps the System-mode light block identical to the explicit light block', () => {
    expect(stylesheetBlock('systemLight')).toEqual(stylesheetBlock('light'));
  });

  it('names the block and token when a token is missing', () => {
    const css = ':root, :root[data-theme="dark"] { --bg: #000; }';
    expect(() => stylesheetTokens('dark', css)).toThrow(/dark block does not declare --panel/);
  });
});

describe('referenceBackgrounds', () => {
  it.each([
    ['dark', 'dark', ['#11141a', '#454850']],
    ['light', 'light', ['#cacbcf', '#eff0f4']],
  ] as const)(
    'paints %s --bg twice over the black and white materials',
    (block, theme, expected) => {
      const refs = referenceBackgrounds(stylesheetTokens(block), theme);
      expect(refs).toHaveLength(2);
      refs.forEach((ref, i) => {
        expect(ref).toMatch(HEX6);
        const [got, want] = [rgb(ref), rgb(expected[i] ?? '')];
        for (const channel of ['r', 'g', 'b'] as const)
          expect(Math.abs(got[channel] - want[channel])).toBeLessThanOrEqual(1);
      });
    },
  );

  it('follows the live --bg token', () => {
    const tokens = { ...stylesheetTokens('dark'), bg: 'rgba(100, 0, 0, 0.5)' };
    expect(referenceBackgrounds(tokens, 'dark')).toEqual(['#4b0000', '#8b4040']);
  });
});

describe.each(THEMES)('mermaidThemeVariables (%s tokens, %s theme)', (block, theme) => {
  const tokens = stylesheetTokens(block);
  let vars: Record<string, string> = {};
  let refs: Rgb[] = [];
  beforeAll(() => {
    refs = referenceBackgrounds(tokens, theme).map(rgb);
    vars = palette(tokens, theme);
  });

  it('emits only opaque #rrggbb colours, plus darkMode, pieOpacity and a hex xyChart block', () => {
    const all = mermaidThemeVariables(tokens, theme);
    const nonColour = Object.keys(all).filter((k) => !HEX6.test(String(all[k])));
    expect(nonColour.sort()).toEqual(['darkMode', 'pieOpacity', 'xyChart']);
    expect(all.darkMode).toBe(theme === 'dark');
    expect(all.pieOpacity).toBe('1');
    const xy = all.xyChart as Record<string, string>;
    for (const [key, value] of Object.entries(xy)) {
      const parts = key === 'plotColorPalette' ? value.split(',') : [value];
      for (const part of parts) expect(part, `xyChart.${key}`).toMatch(HEX6);
    }
  });

  it('sets no font or layout variables', () => {
    expect(Object.keys(vars).filter((k) => /font|size|width/i.test(k))).toEqual([]);
  });

  it('uses the exact --text token for text (AC1/AC2)', () => {
    const text = tokens.text.toLowerCase();
    for (const name of ['textColor', 'nodeTextColor', 'primaryTextColor', 'actorTextColor'])
      expect(role(vars, name)).toBe(text);
  });

  it('derives the accent roles from --accent: same hue within 3°, clearing 3:1 on both backgrounds (AC1/AC2, D5)', () => {
    const accentHue = hslHue(rgb(tokens.accent));
    for (const name of ACCENT_ROLES) {
      const colour = rgb(role(vars, name));
      const turn = Math.abs(hslHue(colour) - accentHue);
      expect(Math.min(turn, 360 - turn), name).toBeLessThanOrEqual(3);
      for (const bg of refs) expect(contrastRatio(colour, bg), name).toBeGreaterThanOrEqual(3);
    }
  });

  it.each(TEXT_ON_FILL)('%s on %s reaches 4.5:1 (AC3)', (fg, bg) => {
    expect(contrastRatio(rgb(role(vars, fg)), rgb(role(vars, bg)))).toBeGreaterThanOrEqual(
      CONTRAST_TEXT,
    );
  });

  it.each(TEXT_ON_BACKGROUND)('%s reaches 4.5:1 on both reference backgrounds (AC4)', (fg) => {
    for (const bg of refs)
      expect(contrastRatio(rgb(role(vars, fg)), bg)).toBeGreaterThanOrEqual(CONTRAST_TEXT);
  });

  it.each(GRAPHICS)('%s reaches 3:1 on both reference backgrounds (AC5)', (name) => {
    for (const bg of refs)
      expect(contrastRatio(rgb(role(vars, name)), bg)).toBeGreaterThanOrEqual(CONTRAST_GRAPHIC);
  });

  it.each(CATEGORY_SETS)('keeps the %s colours pairwise ΔE2000 ≥ 15 (AC6)', (_, names) => {
    const colours = names.map((n) => role(vars, n));
    for (const [i, a] of colours.entries())
      for (const [j, b] of colours.entries())
        if (i < j)
          expect(deltaE2000(a, b), `${names[i]} vs ${names[j]}`).toBeGreaterThanOrEqual(
            MIN_CATEGORY_DELTA_E,
          );
  });

  it('keeps --danger out of the categorical colours', () => {
    const danger = tokens.danger.toLowerCase();
    const categorical = CATEGORY_SETS.flatMap(([, names]) => names.map((n) => role(vars, n)));
    expect(categorical).not.toContain(danger);
    for (const colour of categorical)
      expect(deltaE2000(colour, danger)).toBeGreaterThanOrEqual(MIN_CATEGORY_DELTA_E);
  });

  it('never emits Mermaid’s built-in dark or default node fills (AC10)', () => {
    const emitted = Object.values(vars);
    expect(emitted).not.toContain('#ececff');
    expect(emitted).not.toContain('#1f2020');
  });

  it('composites the surfaces over the near (material-hi) reference, per plan §2.4 (L1)', () => {
    const near = rgb(referenceBackgrounds(tokens, theme)[1]);
    const over = (value: string) => {
      const c = parseColour(value);
      if (!c) throw new Error(value);
      return toHex(composite(c, near));
    };
    expect(role(vars, 'mainBkg')).toBe(over(tokens.panelStrong));
    expect(role(vars, 'secondaryColor')).toBe(over(tokens.panel));
  });

  it('labels slices and branches with the pole opposite the theme (the far reference)', () => {
    const pole = referenceBackgrounds(tokens, theme)[theme === 'dark' ? 0 : 1];
    expect(role(vars, 'pieSectionTextColor')).toBe(pole);
    expect(role(vars, 'gitBranchLabel0')).toBe(pole);
  });

  it('draws each categorical colour from its app-hue seed, turned by one solver step (Q3)', () => {
    const seeds = [
      'iconMd',
      'iconImg',
      'iconCode',
      'hljsVariable',
      'hljsFunction',
      'hljsTag',
      'hljsString',
      'hljsNumber',
    ] as const;
    const steps = [0, 15, 30, 45, 60, 90, 120, 150, 180];
    const hueGap = (a: string, b: string) => {
      const d = Math.abs(hslHue(rgb(a)) - hslHue(rgb(b))) % 360;
      return Math.min(d, 360 - d);
    };
    seeds.forEach((field, i) => {
      const gap = hueGap(role(vars, `pie${i + 1}`), tokens[field]);
      const offStep = Math.min(...steps.map((step) => Math.abs(gap - step)));
      expect(offStep, `pie${i + 1} from ${field} (gap ${gap.toFixed(1)}°)`).toBeLessThanOrEqual(4);
    });
    for (const [i, field] of seeds.slice(0, 3).entries())
      expect(hueGap(role(vars, `pie${i + 1}`), tokens[field]), field).toBeLessThanOrEqual(4);
  });

  it('is deterministic', () => {
    expect(mermaidThemeVariables(tokens, theme)).toEqual(mermaidThemeVariables(tokens, theme));
  });
});

describe('mermaidThemeVariables follows the tokens (AC12)', () => {
  it.each(THEMES)('changes the text roles when only --text changes (%s)', (block, theme) => {
    const base = { ...stylesheetTokens(block), text: '#e0e1e2' };
    const changed = { ...base, text: theme === 'dark' ? '#f5f0e6' : '#1a0f0f' };
    const before = palette(base, theme);
    const after = palette(changed, theme);
    expect(after.textColor).toBe(changed.text);
    expect(after.nodeTextColor).toBe(changed.text);
    expect(Object.values(after)).not.toContain('#e0e1e2');
    expect(after.mainBkg).toBe(before.mainBkg);
  });

  it.each(THEMES)('changes the accent roles when only --accent changes (%s)', (block, theme) => {
    const base = { ...stylesheetTokens(block), accent: '#0d9488' };
    const changed = { ...base, accent: '#9333ea' };
    const before = palette(base, theme);
    const after = palette(changed, theme);
    for (const name of ACCENT_ROLES) {
      expect(after[name], name).not.toBe(before[name]);
      const turn = Math.abs(hslHue(rgb(role(after, name))) - hslHue(rgb(changed.accent)));
      expect(Math.min(turn, 360 - turn), name).toBeLessThanOrEqual(3);
    }
    expect(Object.values(after)).not.toContain('#0d9488');
    expect(after.textColor).toBe(before.textColor);
  });
});

describe('mermaidThemeVariables with an infeasible categorical palette (C2)', () => {
  it('fails loudly, naming a categorical token', () => {
    const tokens = { ...stylesheetTokens('light'), iconMd: '#3399ff', hljsNumber: '#3399ff' };
    let thrown: unknown;
    try {
      mermaidThemeVariables(tokens, 'light');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CategoricalColourError);
    const names = ['iconMd', 'iconImg', 'iconCode', 'hljsFunction', 'hljsVariable', 'hljsTag']
      .concat(['hljsString', 'hljsNumber'])
      .map((f) => THEME_TOKEN_NAMES[f as keyof ThemeTokens]);
    expect(names).toContain((thrown as CategoricalColourError).token);
    expect((thrown as Error).message).toContain((thrown as CategoricalColourError).token);
  });
});

describe('mermaidThemeVariables rejects unparseable tokens (AC13, D6)', () => {
  const cases = TOKEN_FIELDS.flatMap((field) =>
    ['garbage', 'var(--x)', 'color-mix(in srgb, red 50%, blue)', ''].map(
      (value) => [THEME_TOKEN_NAMES[field], field, value] as const,
    ),
  );

  it.each(cases)('throws PaletteTokenError naming %s when %s is %j', (name, field, value) => {
    const tokens = { ...stylesheetTokens('dark'), [field]: value };
    let thrown: unknown;
    try {
      mermaidThemeVariables(tokens, 'dark');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(PaletteTokenError);
    expect((thrown as PaletteTokenError).token).toBe(name);
    expect((thrown as Error).message).toContain(name);
  });

  it('rejects an unparseable --bg in referenceBackgrounds too', () => {
    const tokens = { ...stylesheetTokens('light'), bg: 'transparent' };
    expect(() => referenceBackgrounds(tokens, 'light')).toThrow(PaletteTokenError);
  });
});

describe('withAuthorVariables (AC9: directive themeVariables without a theme)', () => {
  const app = mermaidThemeVariables(stylesheetTokens('dark'), 'dark');

  it('returns the app palette unchanged when the directive sets no usable variables', () => {
    for (const author of [undefined, null, 'x', 42, {}, { nested: { a: '#fff' } }])
      expect(withAuthorVariables(app, author)).toEqual(app);
  });

  it('takes the author primaryColor and drops every palette colour Mermaid derives from it', () => {
    const merged = withAuthorVariables(app, { primaryColor: '#ff00ff' });
    expect(merged.primaryColor).toBe('#ff00ff');
    for (const derived of [
      'mainBkg',
      'nodeBkg',
      'actorBkg',
      'labelBoxBkgColor',
      'stateBkg',
      'labelBackgroundColor',
      'secondaryColor',
      'tertiaryColor',
      'clusterBkg',
      'primaryBorderColor',
      'nodeBorder',
      'actorBorder',
      'taskBkgColor',
      'pie1',
      'git0',
      'cScale0',
      'fillType0',
      'edgeLabelBackground',
    ])
      expect(merged, derived).not.toHaveProperty(derived);
  });

  it('keeps the palette colours that do not derive from the author keys', () => {
    const merged = withAuthorVariables(app, { primaryColor: '#ff00ff' });
    for (const kept of ['textColor', 'nodeTextColor', 'lineColor', 'noteBkgColor', 'critBkgColor'])
      expect(merged[kept], kept).toBe(app[kept]);
    expect(merged.darkMode).toBe(true);
    expect(merged.xyChart).toEqual(app.xyChart);
  });

  it.each([
    ['lineColor', 'none'],
    ['primaryColor', '#ff00f'],
    ['noteBkgColor', 'notacolour'],
    ['primaryColor', 'hsl(300, 100%, 50%)'],
    ['primaryColor', ' #ff0000 '],
    ['primaryColor', 'rgba(1 2 3 0.5)'],
    ['primaryColor', '#abcd'],
  ])(
    'leaves an author %s of %j to Mermaid’s overlay instead of folding it in (C1)',
    (key, value) => {
      expect(withAuthorVariables(app, { [key]: value })).toEqual(app);
    },
  );

  it.each(['#f0f', '#ff00ff', '#ff00ff80', 'rgb(255, 0, 255)', 'rgba(255,0,255,0.5)'])(
    'folds in an author primaryColor of %j, a form Mermaid parses the same way (G2)',
    (value) => {
      const merged = withAuthorVariables(app, { primaryColor: value });
      expect(merged.primaryColor).toBe(value);
      expect(merged).not.toHaveProperty('mainBkg');
    },
  );

  it('folds in only the author colours that parse, next to one that does not (C1)', () => {
    const merged = withAuthorVariables(app, { lineColor: 'none', primaryColor: '#ff00ff' });
    expect(merged.lineColor).toBe(app.lineColor);
    expect(merged.defaultLinkColor).toBe(app.defaultLinkColor);
    expect(merged.primaryColor).toBe('#ff00ff');
    expect(merged).not.toHaveProperty('mainBkg');
  });

  it('drops only what an author lineColor feeds', () => {
    const merged = withAuthorVariables(app, { lineColor: '#00ff00' });
    expect(merged.lineColor).toBe('#00ff00');
    for (const derived of [
      'defaultLinkColor',
      'transitionColor',
      'relationColor',
      'specialStateColor',
    ])
      expect(merged, derived).not.toHaveProperty(derived);
    expect(merged.mainBkg).toBe(app.mainBkg);
    expect(merged.nodeBorder).toBe(app.nodeBorder);
  });

  it('forwards only plain keys with string values Mermaid itself would accept', () => {
    const author = JSON.parse(
      '{"__proto__": {"x": 1}, "bad-key": "#fff", "lineColor": 7, "primaryColor": "#fff;}</style>", "noteBkgColor": "#123456"}',
    ) as unknown;
    const merged = withAuthorVariables(app, author);
    expect(merged).not.toHaveProperty('bad-key');
    expect(merged.lineColor).toBe(app.lineColor);
    expect(merged.primaryColor).toBe(app.primaryColor);
    expect(merged.noteBkgColor).toBe('#123456');
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
  });

  it('does not mutate the app palette', () => {
    const before = structuredClone(app);
    withAuthorVariables(app, { primaryColor: '#ff00ff' });
    expect(app).toEqual(before);
  });
});
