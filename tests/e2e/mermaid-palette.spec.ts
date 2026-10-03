/**
 * Mermaid diagrams in the app's own palette (spec docs/specs/mermaid-app-palette.md,
 * AC1–AC10, AC12, AC13; AC7 lives in markdown-preview.spec.ts).
 *
 * Every fixture in tests/e2e/fixtures/mermaid-palette/ is copied into one
 * temp project and opened in the Files tab of the built app. Each AC runs in
 * both themes, switched through the title-bar toggle.
 *
 * The colour oracle is in helpers/mermaid-palette.ts and is independent of
 * the palette code: it composites the live `--bg` over the contract's
 * reference materials itself, pairs each text with what is painted under it
 * by hit-testing, and computes WCAG contrast itself. The only import from
 * the code under test is `mermaidThemeVariables`, used solely to build the
 * AC8 no-leakage set.
 *
 * Every negative assertion has a positive control in the same render: the
 * built-in-theme twins prove the "no built-in colour" detectors can see one,
 * and the plain flowchart proves the leakage detector can see an overlap.
 */

import { test, expect, type Locator, type Page } from '@playwright/test';
import {
  MERMAID_ERROR_CLASS,
  MERMAID_ERROR_PREFIX,
  MERMAID_STATE_ATTR,
  type EffectiveTheme,
} from '../../src/renderer/markdown/contract';
import {
  CONTRAST_GRAPHIC,
  CONTRAST_TEXT,
  MIN_CATEGORY_DELTA_E,
  THEME_TOKEN_NAMES,
  type ThemeTokens,
} from '../../src/renderer/markdown/mermaid/paletteContract';
import { mermaidThemeVariables } from '../../src/renderer/markdown/mermaid/mermaidPalette';
import { deltaE2000 } from '../support/deltaE2000';
import {
  BLOCK,
  ERRORED,
  OUTPUT,
  RENDERED,
  allSvgColours,
  collectPaints,
  collectTextSamples,
  formatPair,
  graphicRatio,
  hardCodedReason,
  hexOf,
  hueDistance,
  hueSat,
  launchPaletteIde,
  mustParse,
  openFixture,
  openSettled,
  over,
  paintColour,
  paletteHexes,
  rawToken,
  readReferenceBackgrounds,
  scoreTexts,
  setTheme,
  setTokenOverrides,
  settle,
  toHex,
  rerenderViaToggle,
  tokenColour,
  type PaletteIde,
  type Paint,
  type Rgb,
  type RoleSelector,
  type TextPair,
} from './helpers/mermaid-palette';

const THEMES: EffectiveTheme[] = ['dark', 'light'];

/* ───────────────────────────── fixture table ───────────────────────────── */

type Want = 'fill' | 'background' | 'any';

interface Covered {
  file: string;
  /** Blocks in the file; the covered diagram is block 0. */
  blocks: number;
  /** Texts that must be found (positive control against a vacuous pass), and where they must sit. */
  texts: { match: string | RegExp; on: Want }[];
  /** AC5 roles: which paint of which elements must clear 3:1 on both backgrounds. */
  graphics: { role: string; selector: string; paint: 'stroke' | 'fill' | 'fillOrStroke' }[];
  /** AC5: also check every marker referenced by a visible line (arrowheads, cardinality). */
  markers: boolean;
}

// Selectors per Mermaid 11.17.2's rendered SVG (.claude/reports/scout-mermaid-svg-selectors.md).
const NODE_SHAPES = 'g.node rect, g.node polygon, g.node path, g.node circle';

const COVERED: Covered[] = [
  {
    file: 'flowchart.md',
    blocks: 3,
    texts: [
      { match: 'Palette start', on: 'fill' },
      { match: 'Palette choice', on: 'fill' },
      { match: 'Palette end', on: 'fill' },
      { match: 'PALEDGE', on: 'any' },
    ],
    graphics: [
      { role: 'node border', selector: NODE_SHAPES, paint: 'stroke' },
      { role: 'edge', selector: 'path.flowchart-link', paint: 'stroke' },
    ],
    markers: true,
  },
  {
    file: 'sequence.md',
    blocks: 1,
    texts: [
      { match: 'Alice', on: 'fill' },
      { match: 'Bob', on: 'fill' },
      { match: 'SEQNOTE', on: 'fill' },
      { match: 'SEQPING', on: 'background' },
      { match: 'SEQPONG', on: 'background' },
      { match: /SEQLOOP/, on: 'any' },
    ],
    graphics: [
      { role: 'actor border', selector: 'rect.actor', paint: 'stroke' },
      { role: 'lifeline', selector: 'line.actor-line', paint: 'stroke' },
      {
        role: 'message line',
        selector: 'line.messageLine0, line.messageLine1, path.messageLine0, path.messageLine1',
        paint: 'stroke',
      },
      { role: 'note border', selector: 'rect.note', paint: 'stroke' },
      {
        role: 'activation border',
        selector: 'rect.activation0, rect.activation1, rect.activation2',
        paint: 'stroke',
      },
      { role: 'loop line', selector: 'line.loopLine', paint: 'stroke' },
    ],
    markers: true,
  },
  {
    file: 'class.md',
    blocks: 1,
    texts: [
      { match: 'PalAnimal', on: 'fill' },
      { match: 'PalDog', on: 'fill' },
      { match: 'PalOwner', on: 'fill' },
      { match: 'owns', on: 'any' },
    ],
    graphics: [
      { role: 'class border', selector: NODE_SHAPES, paint: 'stroke' },
      { role: 'relation', selector: 'path.relation', paint: 'stroke' },
    ],
    markers: true,
  },
  {
    file: 'state.md',
    blocks: 1,
    texts: [
      { match: 'PalIdle', on: 'fill' },
      { match: 'PalBusy', on: 'fill' },
      { match: 'start', on: 'any' },
      { match: 'finish', on: 'any' },
    ],
    graphics: [
      { role: 'state border', selector: 'g.node rect.basic', paint: 'stroke' },
      { role: 'start/end', selector: 'circle.state-start', paint: 'fillOrStroke' },
      { role: 'transition', selector: 'path.transition', paint: 'stroke' },
    ],
    markers: true,
  },
  {
    file: 'er.md',
    blocks: 1,
    texts: [
      { match: 'CUSTOMER', on: 'fill' },
      { match: 'ORDER', on: 'fill' },
      { match: 'LINEITEM', on: 'fill' },
      { match: 'places', on: 'any' },
      { match: 'contains', on: 'any' },
    ],
    graphics: [
      { role: 'entity border', selector: NODE_SHAPES, paint: 'stroke' },
      { role: 'relationship', selector: 'path.relationshipLine', paint: 'stroke' },
    ],
    markers: true,
  },
  {
    file: 'gantt.md',
    blocks: 1,
    texts: [
      { match: 'Done', on: 'fill' },
      { match: 'Active', on: 'fill' },
      { match: 'Crit', on: 'fill' },
      { match: 'Plain', on: 'fill' },
      { match: 'PalSectionA', on: 'any' },
      { match: 'PalGantt', on: 'any' },
    ],
    // AC5 names no gantt graphic.
    graphics: [],
    markers: false,
  },
  {
    file: 'pie.md',
    blocks: 1,
    texts: [
      { match: '20%', on: 'fill' },
      { match: '8%', on: 'fill' },
      { match: 'Dogs', on: 'background' },
      { match: 'Crabs', on: 'background' },
      { match: 'PalPets', on: 'background' },
    ],
    graphics: [
      { role: 'slice', selector: 'path.pieCircle', paint: 'fillOrStroke' },
      { role: 'legend swatch', selector: 'g.legend rect', paint: 'fill' },
    ],
    markers: false,
  },
  {
    file: 'gitgraph.md',
    blocks: 1,
    texts: [
      { match: 'main', on: 'fill' },
      { match: 'develop', on: 'fill' },
      { match: 'feature', on: 'fill' },
      { match: 'hotfix', on: 'fill' },
      { match: 'v1.0', on: 'fill' },
    ],
    graphics: [
      { role: 'branch line', selector: 'line.branch', paint: 'stroke' },
      { role: 'branch arrow', selector: 'path.arrow', paint: 'stroke' },
      { role: 'commit dot', selector: 'circle.commit', paint: 'fill' },
    ],
    markers: false,
  },
  {
    file: 'journey.md',
    blocks: 1,
    texts: [
      { match: 'Coffee', on: 'fill' },
      { match: 'Code', on: 'fill' },
      { match: 'PalJourney', on: 'any' },
    ],
    // AC5 names no journey graphic.
    graphics: [],
    markers: false,
  },
];

/* ─────────────────────────────── helpers ─────────────────────────────── */

const matches = (m: string | RegExp, text: string) =>
  typeof m === 'string' ? text === m : m.test(text);

async function pairsFor(win: Page, c: Covered, refs: readonly [Rgb, Rgb]): Promise<TextPair[]> {
  const p = await openSettled(win, c.file, c.blocks);
  return scoreTexts(await collectTextSamples(p.locator(BLOCK).nth(0)), refs);
}

/** Positive controls: each required text was found, on the backdrop it must sit on. */
function missingTexts(c: Covered, pairs: TextPair[], want: Want[]): string[] {
  return c.texts
    .filter((t) => want.includes(t.on))
    .filter(
      (t) =>
        !pairs.some((p) => matches(t.match, p.text) && (t.on === 'any' || p.backdrop === t.on)),
    )
    .map((t) => {
      const seen = pairs.filter((p) => matches(t.match, p.text)).map(formatPair);
      return `${c.file}: expected text ${String(t.match)} on ${t.on}; found ${
        seen.length ? seen.join(' | ') : 'nothing'
      }`;
    });
}

/** First shape of the first `g.node` whose label contains `label`. */
function nodeShape(block: Locator, label: string): Locator {
  return block
    .locator(`${OUTPUT} svg g.node`)
    .filter({ hasText: label })
    .first()
    .locator('rect, polygon, path, circle')
    .first();
}

async function shapePaint(shape: Locator): Promise<{ fill: string | null; stroke: string | null }> {
  const [fill, stroke] = await shape.evaluate((el) => {
    const cs = getComputedStyle(el);
    return [cs.fill, cs.stroke];
  });
  return { fill: hexOf(fill), stroke: hexOf(stroke) };
}

/** Text colour of the first text leaf whose content is exactly `label`. */
async function labelColour(block: Locator, label: string): Promise<string | null> {
  const samples = await collectTextSamples(block);
  const s = samples.find((x) => x.text === label);
  return s ? hexOf(s.fg) : null;
}

async function edgeStroke(block: Locator): Promise<string | null> {
  const v = await block
    .locator(`${OUTPUT} svg path.flowchart-link`)
    .first()
    .evaluate((el) => getComputedStyle(el).stroke);
  return hexOf(v);
}

/** Paints in `colours` whose hue is within ±3° of `hue` and that are clearly chromatic. */
function accentHued(colours: string[], hue: number): string[] {
  return colours.filter((h) => {
    const hs = hueSat(mustParse(h, 'svg colour'));
    return hs.sat >= 0.3 && hueDistance(hs.hue, hue) <= 3;
  });
}

async function liveTokens(win: Page): Promise<ThemeTokens> {
  const out = {} as Record<keyof ThemeTokens, string>;
  for (const [key, name] of Object.entries(THEME_TOKEN_NAMES) as [
    keyof ThemeTokens,
    `--${string}`,
  ][]) {
    out[key] = await rawToken(win, name);
  }
  return out;
}

/** Composites a paint over a reference background when it is translucent. */
function onRef(c: ReturnType<typeof paintColour>, ref: Rgb): string | null {
  return c ? toHex(over(c, ref)) : null;
}

/* ═════════════════════════════════ suite ═════════════════════════════════ */

test.describe('mermaid app palette', () => {
  let ide: PaletteIde;
  test.beforeAll(async () => {
    ide = await launchPaletteIde('palette');
  });
  test.afterAll(async () => {
    await ide?.cleanup();
  });
  test.beforeEach(() => {
    ide.pageErrors.length = 0;
  });
  test.afterEach(async () => {
    // A failed AC12/AC13 test must not leave a token override for the next one.
    await setTokenOverrides(ide.win, { '--text': null, '--accent': null });
    expect(ide.pageErrors, 'pageerror events').toEqual([]);
  });

  for (const theme of THEMES) {
    const ac = theme === 'dark' ? 'AC1' : 'AC2';
    const builtIn = theme === 'dark' ? 'dark' : 'default';

    test(`${ac} (${theme}): a plain flowchart uses the app palette, not Mermaid's ${builtIn} theme`, async () => {
      const win = ide.win;
      await setTheme(win, theme);
      const p = await openSettled(win, 'flowchart.md', 3);
      const plain = p.locator(BLOCK).nth(0);
      const twin = p.locator(BLOCK).nth(theme === 'dark' ? 1 : 2);

      const read = async (block: Locator) => {
        const shape = await shapePaint(nodeShape(block, 'Palette start'));
        return {
          nodeFill: shape.fill,
          nodeBorder: shape.stroke,
          nodeText: await labelColour(block, 'Palette start'),
          edge: await edgeStroke(block),
        };
      };
      const mine = await read(plain);
      const theirs = await read(twin);
      // Positive control: the twin rendered and every role resolved to a colour.
      for (const [role, v] of Object.entries(theirs))
        expect(v, `${builtIn} twin ${role}`).not.toBeNull();
      for (const [role, v] of Object.entries(mine)) expect(v, `plain ${role}`).not.toBeNull();
      for (const role of Object.keys(mine) as (keyof typeof mine)[]) {
        expect(mine[role], `${role} differs from Mermaid's ${builtIn} theme`).not.toBe(
          theirs[role],
        );
      }

      // Node text is exactly the live --text.
      expect(mine.nodeText).toBe(toHex(await tokenColour(win, '--text')));

      // Some role carries a colour derived from --accent: same hue within ±3° (D5).
      const accentHue = hueSat(await tokenColour(win, '--accent')).hue;
      const hued = accentHued(await allSvgColours(plain), accentHue);
      expect(hued, `a colour within ±3° of the --accent hue ${accentHue.toFixed(1)}°`).not.toEqual(
        [],
      );
    });

    test(`AC3 (${theme}): every text on a fill clears 4.5:1 against that fill`, async () => {
      const win = ide.win;
      await setTheme(win, theme);
      const refs = await readReferenceBackgrounds(win, theme);
      const failures: string[] = [];
      for (const c of COVERED) {
        const pairs = await pairsFor(win, c, refs);
        failures.push(...missingTexts(c, pairs, ['fill']));
        for (const pr of pairs.filter((x) => x.backdrop === 'fill')) {
          if (hardCodedReason(pr)) continue;
          if (pr.ratio < CONTRAST_TEXT) failures.push(`${c.file}: ${formatPair(pr)}`);
        }
      }
      expect(failures).toEqual([]);
    });

    test(`AC4 (${theme}): text on the pane clears 4.5:1 against both reference backgrounds`, async () => {
      const win = ide.win;
      await setTheme(win, theme);
      const refs = await readReferenceBackgrounds(win, theme);
      const failures: string[] = [];
      for (const c of COVERED) {
        const pairs = await pairsFor(win, c, refs);
        failures.push(...missingTexts(c, pairs, ['background', 'any']));
        // `mixed` = partly on a translucent or partial backdrop: it is scored
        // against the stack over both references, so it belongs here.
        for (const pr of pairs.filter((x) => x.backdrop !== 'fill')) {
          if (hardCodedReason(pr)) continue;
          if (pr.ratio < CONTRAST_TEXT) failures.push(`${c.file}: ${formatPair(pr)}`);
        }
      }
      expect(failures).toEqual([]);
    });

    test(`AC5 (${theme}): meaningful graphics clear 3:1 against both reference backgrounds`, async () => {
      const win = ide.win;
      await setTheme(win, theme);
      const refs = await readReferenceBackgrounds(win, theme);
      const failures: string[] = [];
      for (const c of COVERED.filter((x) => x.graphics.length > 0 || x.markers)) {
        const p = await openSettled(win, c.file, c.blocks);
        const roles: RoleSelector[] = c.graphics.map(({ role, selector }) => ({ role, selector }));
        const paints = await collectPaints(p.locator(BLOCK).nth(0), roles, c.markers);
        const channelFor = (pt: Paint) =>
          pt.role === 'marker'
            ? 'fillOrStroke'
            : (c.graphics.find((g) => g.role === pt.role)?.paint ?? 'fillOrStroke');

        const measured = new Map<string, number>();
        for (const pt of paints) {
          const fill = paintColour(pt.fill, pt.fillAlpha);
          const stroke = pt.strokeWidth > 0 ? paintColour(pt.stroke, pt.strokeAlpha) : null;
          const ch = channelFor(pt);
          const candidates = ch === 'fill' ? [fill] : ch === 'stroke' ? [stroke] : [fill, stroke];
          const concrete = candidates.filter((x): x is NonNullable<typeof x> => x !== null);
          // A stroke role on an element with no stroke (e.g. a roughjs fill
          // path beside its outline) carries nothing to measure.
          if (concrete.length === 0) continue;
          measured.set(pt.role, (measured.get(pt.role) ?? 0) + 1);
          const best = Math.max(...concrete.map((x) => graphicRatio(x, refs)));
          if (best < CONTRAST_GRAPHIC) {
            failures.push(
              `${c.file}: ${pt.role} ${pt.desc} fill=${onRef(fill, refs[0])} stroke=${onRef(
                stroke,
                refs[0],
              )} best ${best.toFixed(2)}:1 < ${CONTRAST_GRAPHIC}`,
            );
          }
        }
        // Positive control: every named role, and markers where expected, were actually measured.
        for (const g of c.graphics) {
          if (!measured.get(g.role))
            failures.push(`${c.file}: no painted ${g.role} (${g.selector})`);
        }
        if (c.markers && !measured.get('marker')) failures.push(`${c.file}: no referenced marker`);
      }
      expect(failures).toEqual([]);
    });

    test(`AC6 (${theme}): pie, gitGraph and journey categories are pairwise ΔE2000 ≥ 15`, async () => {
      const win = ide.win;
      await setTheme(win, theme);
      const refs = await readReferenceBackgrounds(win, theme);

      /** Visible colour of a fill over each reference background (pie slices may be translucent). */
      const visible = (pt: Paint) => {
        const c = paintColour(pt.fill, pt.fillAlpha);
        if (!c) throw new Error(`${pt.desc}: no concrete fill (${pt.fill})`);
        return refs.map((r) => toHex(over(c, r)));
      };
      const failures: string[] = [];
      const distinct = (what: string, colours: string[][]) => {
        for (let i = 0; i < colours.length; i++) {
          for (let j = i + 1; j < colours.length; j++) {
            for (let k = 0; k < refs.length; k++) {
              const a = colours[i]?.[k] as string;
              const b = colours[j]?.[k] as string;
              const d = deltaE2000(a, b);
              if (d < MIN_CATEGORY_DELTA_E) {
                failures.push(`${what} ${i + 1} ${a} vs ${j + 1} ${b}: ΔE ${d.toFixed(1)}`);
              }
            }
          }
        }
      };

      let p = await openSettled(win, 'pie.md', 1);
      const slices = await collectPaints(p.locator(BLOCK).nth(0), [
        { role: 'slice', selector: 'path.pieCircle' },
      ]);
      expect(slices, 'pie slices').toHaveLength(8);
      distinct('pie slice', slices.map(visible));

      p = await openSettled(win, 'gitgraph.md', 1);
      const git = p.locator(BLOCK).nth(0);
      const branches: string[][] = [];
      for (let i = 0; i < 4; i++) {
        const [dot] = await collectPaints(git, [
          { role: `git${i}`, selector: `circle.commit${i}` },
        ]);
        expect(dot, `a commit dot for branch ${i}`).toBeDefined();
        branches.push(visible(dot as Paint));
      }
      distinct('git branch', branches);

      p = await openSettled(win, 'journey.md', 1);
      const journey = p.locator(BLOCK).nth(0);
      const actors: string[][] = [];
      for (let i = 0; i < 2; i++) {
        const [dot] = await collectPaints(journey, [
          { role: `actor${i}`, selector: `circle.actor-${i}` },
        ]);
        expect(dot, `a legend circle for actor ${i}`).toBeDefined();
        // Base leaves actor0..5 unset, so Mermaid falls back to its own
        // journey.actorColours fill attributes (mermaid.js:5913). Those two are
        // distinct from each other, so they would pass ΔE; reject them outright.
        expect(['#8fbc8f', '#7cfc00'], `actor ${i} colour comes from the palette`).not.toContain(
          hexOf((dot as Paint).fill),
        );
        actors.push(visible(dot as Paint));
      }
      distinct('journey actor', actors);

      expect(failures).toEqual([]);
    });

    test(`AC9 (${theme}): author classDef, style and directive themeVariables win; untargeted nodes keep the palette`, async () => {
      const win = ide.win;
      await setTheme(win, theme);
      const text = toHex(await tokenColour(win, '--text'));

      // Palette reference from the plain flowchart in the same theme.
      let p = await openSettled(win, 'flowchart.md', 3);
      const plainBlock = p.locator(BLOCK).nth(0);
      const plainFill = (await shapePaint(nodeShape(plainBlock, 'Palette start'))).fill;
      const plainEdge = await edgeStroke(plainBlock);
      expect(plainFill).not.toBeNull();

      p = await openSettled(win, 'overrides.md', 1);
      const ov = p.locator(BLOCK).nth(0);
      expect(await shapePaint(nodeShape(ov, 'Classed node'))).toEqual({
        fill: '#d9480f',
        stroke: '#2b8a3e',
      });
      expect(await labelColour(ov, 'Classed node')).toBe('#ffffff');
      expect(await shapePaint(nodeShape(ov, 'Styled node'))).toEqual({
        fill: '#1864ab',
        stroke: '#e8590c',
      });
      expect(await labelColour(ov, 'Styled node')).toBe('#fff3bf');
      // Untargeted node: the palette's own fill and text.
      expect((await shapePaint(nodeShape(ov, 'Plain node'))).fill).toBe(plainFill);
      expect(await labelColour(ov, 'Plain node')).toBe(text);

      p = await openSettled(win, 'directive-vars.md', 1);
      const dv = p.locator(BLOCK).nth(0);
      expect((await shapePaint(nodeShape(dv, 'Directive start'))).fill).toBe('#ff00ff');
      // Roles the directive does not target keep the palette.
      expect(await labelColour(dv, 'Directive start')).toBe(text);
      expect(await edgeStroke(dv)).toBe(plainEdge);
    });

    test(`AC10 (${theme}): mindmap and timeline render without Mermaid's dark/default node fills`, async () => {
      const win = ide.win;
      await setTheme(win, theme);
      const BUILT_IN = ['#1f2020', '#ececff'];

      // Positive control: the detector sees each built-in fill in its own twin.
      const f = await openSettled(win, 'flowchart.md', 3);
      expect(await allSvgColours(f.locator(BLOCK).nth(1))).toContain('#1f2020');
      expect(await allSvgColours(f.locator(BLOCK).nth(2))).toContain('#ececff');

      for (const [file, label] of [
        ['mindmap.md', 'PalRoot'],
        ['timeline.md', 'PalTimeline'],
      ] as const) {
        const p = await openSettled(win, file, 1);
        const block = p.locator(BLOCK).nth(0);
        await expect(block.locator(`${OUTPUT} svg`)).toContainText(label);
        const colours = await allSvgColours(block);
        expect(colours.length, `${file} paints colours`).toBeGreaterThan(0);
        expect(
          colours.filter((c) => BUILT_IN.includes(c)),
          file,
        ).toEqual([]);
      }
    });
  }

  test('AC8: a forest directive renders as pure forest in both themes, with no palette leakage', async () => {
    const win = ide.win;
    // Mermaid 11.17.2 theme-forest (node_modules/mermaid/dist/mermaid.js):
    // mainBkg #cde498 (:3034); nodeBorder = border1 #13540c (:3037, assigned :3154);
    // lineColor = textColor = invert("white") = black (:3049-3050), and forest
    // sets no nodeTextColor, so flowchart labels use textColor (:108046).
    const FOREST = {
      nodeFill: '#cde498',
      nodeBorder: '#13540c',
      nodeText: '#000000',
      edge: '#000000',
    };
    const IGNORE = new Set(['#000000', '#ffffff']);

    const seen: Record<string, unknown> = {};
    for (const theme of THEMES) {
      await setTheme(win, theme);
      const p = await openSettled(win, 'forest.md', 1);
      const block = p.locator(BLOCK).nth(0);
      const shape = await shapePaint(nodeShape(block, 'Forest start'));
      const got = {
        nodeFill: shape.fill,
        nodeBorder: shape.stroke,
        nodeText: await labelColour(block, 'Forest start'),
        edge: await edgeStroke(block),
      };
      expect(got, `forest roles in ${theme}`).toEqual(FOREST);
      seen[theme] = got;

      // No leakage: nothing the palette emits for this theme appears in the forest SVG.
      const palette = paletteHexes(mermaidThemeVariables(await liveTokens(win), theme)).filter(
        (h) => !IGNORE.has(h),
      );
      expect(palette.length, 'palette emits colours').toBeGreaterThan(10);
      const forest = (await allSvgColours(block)).filter((h) => !IGNORE.has(h));
      expect(
        forest.filter((h) => palette.includes(h)),
        `palette colours in forest (${theme})`,
      ).toEqual([]);

      // Positive control: the same detector finds the palette in a plain diagram.
      const f = await openSettled(win, 'flowchart.md', 3);
      const plain = (await allSvgColours(f.locator(BLOCK).nth(0))).filter((h) => !IGNORE.has(h));
      expect(
        plain.filter((h) => palette.includes(h)).length,
        `palette in plain (${theme})`,
      ).toBeGreaterThan(0);
    }
    expect(seen.light).toEqual(seen.dark);
  });

  test('AC12: diagram colours follow a --text / --accent change from the next render', async () => {
    const win = ide.win;
    // Hues far from both themes' blue --accent (~217-221°).
    const OVERRIDE = { text: '#ffc9c9', accent: '#e8590c' };
    for (const theme of THEMES) {
      await setTheme(win, theme);
      const p = await openSettled(win, 'flowchart.md', 3);
      const plain = p.locator(BLOCK).nth(0);
      const originalText = await labelColour(plain, 'Palette start');
      const overrideHue = hueSat(mustParse(OVERRIDE.accent, 'override')).hue;
      // Positive control: before the change, nothing is near the override hue.
      expect(accentHued(await allSvgColours(plain), overrideHue), `before (${theme})`).toEqual([]);

      await setTokenOverrides(win, { '--text': OVERRIDE.text, '--accent': OVERRIDE.accent });
      await rerenderViaToggle(win, p, 3);
      expect(await labelColour(plain, 'Palette start'), `text follows --text (${theme})`).toBe(
        OVERRIDE.text,
      );
      expect(
        accentHued(await allSvgColours(plain), overrideHue),
        `a role follows --accent (${theme})`,
      ).not.toEqual([]);

      await setTokenOverrides(win, { '--text': null, '--accent': null });
      await rerenderViaToggle(win, p, 3);
      expect(await labelColour(plain, 'Palette start'), `restored (${theme})`).toBe(originalText);
    }
  });

  test('AC13: an unparseable --accent errors every diagram, naming the token, then recovers', async () => {
    const win = ide.win;
    const cases: { theme: EffectiveTheme; value: string }[] = [
      { theme: 'dark', value: 'garbage' },
      { theme: 'light', value: 'garbage' },
      { theme: 'dark', value: 'color-mix(in srgb, red 50%, blue)' },
    ];
    for (const { theme, value } of cases) {
      await setTheme(win, theme);
      const p = await openFixture(win, 'token-error.md');
      await settle(p, 2, theme);

      await setTokenOverrides(win, { '--accent': value });
      await rerenderViaToggle(win, p, 2, 'error');
      // Plain and forest (directive-themed) blocks alike.
      await expect(p.locator(ERRORED), `${theme} ${value}`).toHaveCount(2);
      const messages = await p.locator(`${BLOCK} .${MERMAID_ERROR_CLASS}`).allTextContents();
      expect(messages).toHaveLength(2);
      for (const m of messages) {
        expect(m).toContain(MERMAID_ERROR_PREFIX.trim());
        expect(m).toContain('--accent');
      }
      await expect(p.locator(`${OUTPUT} svg`)).toHaveCount(0);

      await setTokenOverrides(win, { '--accent': null });
      await rerenderViaToggle(win, p, 2);
      await expect(p.locator(RENDERED)).toHaveCount(2);
      await expect(p.locator(`${BLOCK}[${MERMAID_STATE_ATTR}="error"]`)).toHaveCount(0);
    }
  });
});
