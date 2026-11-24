/**
 * Frosted-glass modals: docs/specs/command-palette.md AC5a, AC21-AC26 (plan §4.6, §4.7, §8 "Agent 4").
 *
 * Why this home can observe the behaviour: the suite drives the built Electron app (real
 * Chromium 128 compositor, the real styles.css, real React) through helpers/focus.ts `launch`.
 * Computed styles are read from the live DOM and colours are resolved by the browser itself
 * through a 1x1 canvas (helpers/colour.ts), so `color-mix()` and relative-colour syntax are
 * checked as Chromium actually resolves them. The only test-side interventions are setting the
 * palette/theme root attributes (as chrome-dimensions.spec.ts does), CDP media emulation for
 * reduced transparency, and a `shell:focus-request` for a project id that does not exist, which
 * makes the app raise its own error toast while a modal is open.
 *
 * Surfaces, testids, tiers and motion come from MODAL_SURFACES / MODAL_CLASSES / MODAL_TIER_Z /
 * TOAST_Z / scrimTestId; the `--modal-*` token names are the D1T contract in plan §4.6.
 */

import { test, expect, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { PALETTE_TESTIDS } from '../../src/renderer/command-palette-contract';
import {
  MODAL_CLASSES, MODAL_SURFACES, MODAL_TIER_Z, TOAST_Z, scrimTestId, type ModalSurface,
} from '../../src/renderer/modal-glass';
import { PERMISSION_MODE_TEST_IDS } from '../../src/renderer/permission-mode-copy';
import { UNLOAD_SESSION_TESTIDS } from '../../src/renderer/unload-session-copy';
import { launch, openProject, projectRow, type Launched } from './helpers/focus';
import { alphaMatches, blurRadiusPx, computedColour, fmtColour, resolveToken } from './helpers/colour';

const PALETTES = ['default', 'catppuccin', 'rose-pine'] as const;
const THEMES = ['dark', 'light'] as const;
type Theme = (typeof THEMES)[number];
/** D1T panel alpha per appearance (plan §4.6). */
const PANEL_ALPHA: Record<Theme, number> = { dark: 0.78, light: 0.8 };
/** AC22 floor for the scrim blur (plan §6.1: never below 2px). */
const MIN_SCRIM_BLUR_PX = 2;
/** Colour-valued `--modal-*` tokens (plan §4.6). */
const COLOUR_TOKENS = [
  '--modal-scrim', '--modal-panel-base', '--modal-panel', '--modal-text-muted', '--modal-row-active',
  '--modal-row-active-text', '--modal-hairline',
] as const;
/** Non-colour `--modal-*` tokens that must resolve to a non-empty value (plan §4.6). */
const VALUE_TOKENS = [
  '--modal-lift', '--modal-panel-alpha', '--modal-edge', '--modal-shadow', '--modal-radius',
  '--modal-dialog-radius', '--modal-scrim-filter', '--modal-panel-filter',
] as const;
/** A project id no test creates: `shell:focus-request` for it makes the app toast an error. */
const MISSING_PROJECT_ID = 987654;

/* ─────────────────────────────── surface drivers ─────────────────────────────── */

const surface = (id: string): ModalSurface => {
  const s = MODAL_SURFACES.find((x) => x.id === id);
  if (!s) throw new Error(`no modal surface ${id}`);
  return s;
};

const layerOf = (win: Page, s: ModalSurface) => win.getByTestId(s.testId);
const scrimOf = (win: Page, s: ModalSurface) => win.getByTestId(scrimTestId(s.testId));
const sheetOf = (win: Page, s: ModalSurface) => layerOf(win, s).locator(`.${MODAL_CLASSES.sheet}`).first();

/** How to open and close each non-blocking surface with project `alpha` selected. */
const DRIVERS: Record<string, { open: (win: Page) => Promise<void>; close: (win: Page) => Promise<void> }> = {
  'palette': { open: (w) => w.keyboard.press('ControlOrMeta+k'), close: (w) => w.keyboard.press('Escape') },
  'settings': { open: (w) => w.keyboard.press('ControlOrMeta+,'), close: (w) => w.getByTestId('settings-done').click() },
  'new-project': { open: (w) => w.keyboard.press('ControlOrMeta+Shift+N'), close: (w) => w.keyboard.press('Escape') },
  'project-search': { open: (w) => w.keyboard.press('ControlOrMeta+Shift+F'), close: (w) => w.keyboard.press('Escape') },
  'prompt-library': { open: (w) => w.keyboard.press('ControlOrMeta+Shift+K'), close: (w) => w.keyboard.press('Escape') },
  'scrollback-search': { open: (w) => w.keyboard.press('ControlOrMeta+Shift+O'), close: (w) => w.keyboard.press('Escape') },
  'rename-project': {
    open: async (w) => {
      await projectRow(w, 'alpha').click({ button: 'right' });
      await w.getByRole('menuitem', { name: 'Rename folder…' }).click();
    },
    // Closed by a scrim click, so the dismiss path of a plain modal is exercised too.
    close: (w) => clickScrimCorner(w, surface('rename-project')),
  },
  'shortcuts-help': { open: (w) => w.keyboard.press('ControlOrMeta+/'), close: (w) => w.keyboard.press('Escape') },
  'unload-session': {
    open: (w) => w.getByTestId('unload-current').click(),
    close: (w) => w.getByTestId(UNLOAD_SESSION_TESTIDS.keep).click(),
  },
};
const NON_BLOCKING = MODAL_SURFACES.filter((s) => s.tier !== 'blocking');

async function clickScrimCorner(win: Page, s: ModalSurface): Promise<void> {
  const b = await scrimOf(win, s).boundingBox();
  if (!b) throw new Error(`${s.id}: scrim has no box`);
  await win.mouse.click(b.x + 24, b.y + b.height - 80);
}

/** Opens a surface and waits until it is at rest (a fade surface has finished fading in). */
async function openSurface(win: Page, s: ModalSurface): Promise<void> {
  await DRIVERS[s.id]!.open(win);
  await expect(layerOf(win, s), `${s.id} opens`).toBeVisible({ timeout: 5000 });
  await expect(sheetOf(win, s), `${s.id} has a sheet`).toBeVisible();
  await expect.poll(() => sheetOf(win, s).evaluate((el) => getComputedStyle(el).opacity), { message: `${s.id} at rest` }).toBe('1');
  await expect.poll(() => scrimOf(win, s).evaluate((el) => getComputedStyle(el).opacity), { message: `${s.id} scrim at rest` }).toBe('1');
}

async function closeSurface(win: Page, s: ModalSurface): Promise<void> {
  await DRIVERS[s.id]!.close(win);
  await expect(layerOf(win, s), `${s.id} closes`).toHaveCount(0);
  await expect(scrimOf(win, s)).toHaveCount(0);
}

interface Material {
  scrimBackground: string;
  scrimBackdrop: string;
  sheetBackground: string;
  sheetBackdrop: string;
  sheetShadow: string;
  sheetBorder: string;
}

async function materialOf(win: Page, s: ModalSurface): Promise<Material> {
  const scrim = await scrimOf(win, s).evaluate((el) => {
    const cs = getComputedStyle(el);
    return { bg: cs.backgroundColor, bf: cs.backdropFilter };
  });
  const sheet = await sheetOf(win, s).evaluate((el) => {
    const cs = getComputedStyle(el);
    return { bg: cs.backgroundColor, bf: cs.backdropFilter, sh: cs.boxShadow, bw: `${cs.borderTopWidth} ${cs.borderTopStyle}` };
  });
  return {
    scrimBackground: scrim.bg, scrimBackdrop: scrim.bf,
    sheetBackground: sheet.bg, sheetBackdrop: sheet.bf, sheetShadow: sheet.sh, sheetBorder: sheet.bw,
  };
}

/** The shared material as styles.css defines it: probe elements wearing only the scrim and sheet classes. */
async function referenceMaterial(win: Page): Promise<Material> {
  return win.evaluate(({ scrimClass, sheetClass }) => {
    const scrim = document.createElement('div');
    scrim.className = scrimClass;
    const sheet = document.createElement('div');
    sheet.className = sheetClass;
    document.body.append(scrim, sheet);
    const a = getComputedStyle(scrim);
    const b = getComputedStyle(sheet);
    const m = {
      scrimBackground: a.backgroundColor, scrimBackdrop: a.backdropFilter,
      sheetBackground: b.backgroundColor, sheetBackdrop: b.backdropFilter, sheetShadow: b.boxShadow,
      sheetBorder: `${b.borderTopWidth} ${b.borderTopStyle}`,
    };
    scrim.remove();
    sheet.remove();
    return m;
  }, { scrimClass: MODAL_CLASSES.scrim, sheetClass: MODAL_CLASSES.sheet });
}

/* ─────────────────────────────── look ─────────────────────────────── */

async function setLook(win: Page, palette: string, theme: Theme): Promise<void> {
  await win.evaluate(({ palette, theme }) => {
    document.documentElement.setAttribute('data-palette', palette);
    document.documentElement.setAttribute('data-theme', theme);
  }, { palette, theme });
}

async function currentLook(win: Page): Promise<{ palette: string | null; theme: string | null }> {
  return win.evaluate(() => ({
    palette: document.documentElement.getAttribute('data-palette'),
    theme: document.documentElement.getAttribute('data-theme'),
  }));
}

async function restoreLook(win: Page, look: { palette: string | null; theme: string | null }): Promise<void> {
  await win.evaluate((l) => {
    const root = document.documentElement;
    for (const [attr, v] of [['data-palette', l.palette], ['data-theme', l.theme]] as const) {
      if (v === null) root.removeAttribute(attr);
      else root.setAttribute(attr, v);
    }
  }, look);
}

/* ─────────────────────────────── toasts ─────────────────────────────── */

/** Makes the app raise its own error toast ("Could not focus shell"), whatever is open. */
async function raiseToast(app: ElectronApplication, win: Page): Promise<void> {
  const previous = await win.evaluateHandle(() => document.querySelector('[data-testid="toast"]'));
  try {
    await app.evaluate(({ BrowserWindow }, projectId: number) => {
      BrowserWindow.getAllWindows()[0]!.webContents.send('shell:focus-request', { projectId, shellIndex: 0 });
    }, MISSING_PROJECT_ID);
    await expect.poll(
      () => win.evaluate((prior) => {
        const latest = document.querySelector('[data-testid="toast"]');
        return latest !== null && latest !== prior;
      }, previous),
      { message: 'precondition: a new toast was raised' },
    ).toBe(true);
  } finally {
    await previous.dispose();
  }
}

/** For each live toast: whether the topmost element at its centre belongs to that toast. */
async function toastsOnTop(win: Page): Promise<boolean[]> {
  return win.getByTestId('toast').evaluateAll((toasts) => toasts.map((t) => {
    const r = t.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return !!hit && t.contains(hit);
  }));
}

async function zIndex(el: Locator): Promise<string> {
  return el.evaluate((node) => getComputedStyle(node).zIndex);
}

/** Every ancestor of every `.xterm` with a transform or filter (AC25: none while a modal is open). */
async function transformedXtermAncestors(win: Page): Promise<string[]> {
  return win.evaluate(() => {
    const bad: string[] = [];
    for (const x of document.querySelectorAll('.xterm')) {
      for (let el: Element | null = x.parentElement; el && el !== document.documentElement; el = el.parentElement) {
        const cs = getComputedStyle(el);
        if (cs.transform !== 'none' || cs.filter !== 'none') {
          bad.push(`${el.tagName.toLowerCase()}.${[...el.classList].join('.')} transform=${cs.transform} filter=${cs.filter}`);
        }
      }
    }
    return bad;
  });
}

/* ─────────────────────────────── shared app ─────────────────────────────── */

test.describe('modal glass (shared app, project alpha open)', () => {
  // Not serial: the tests share one app for speed but do not depend on each other, so one red
  // must not stop the rest. A failure restarts the worker, and beforeAll launches a fresh app.

  let l: Launched;
  let win: Page;

  test.beforeAll(async () => {
    l = await launch(['alpha']);
    win = l.win;
    await openProject(win, 'alpha');
    await win.getByTestId('activity-bar').click({ position: { x: 20, y: 400 } }); // focus out of the terminal
  });

  test.afterAll(async () => {
    await l.app.close();
    l.cleanup();
  });

  test('AC21, AC25, contract 1: every surface wears the palette\'s scrim and sheet material, as siblings, with motion only on mouse-opened modals', async () => {
    const look = await currentLook(win);
    const looks = [['default', 'dark'], ['rose-pine', 'light']] as const;
    try {
      // The palette is the reference (AC21); the stylesheet probe proves the palette itself wears the shared classes.
      const palette = surface('palette');
      const reference: Record<string, Material> = {};
      await openSurface(win, palette);
      for (const [p, t] of looks) {
        await setLook(win, p, t);
        reference[`${p}/${t}`] = await materialOf(win, palette);
        expect(reference[`${p}/${t}`], `${p}/${t}: the palette wears the stylesheet's material`).toEqual(await referenceMaterial(win));
      }
      await closeSurface(win, palette);
      expect(reference['default/dark'], 'positive control: the two looks differ').not.toEqual(reference['rose-pine/light']);

      for (const s of NON_BLOCKING) {
        await setLook(win, 'default', 'dark');
        await openSurface(win, s);
        for (const [p, t] of looks) {
          await setLook(win, p, t);
          expect(await materialOf(win, s), `${s.id} ${p}/${t}: same material as the palette`).toEqual(reference[`${p}/${t}`]);
        }

        const scrim = scrimOf(win, s);
        const layer = layerOf(win, s);
        const sheet = sheetOf(win, s);
        const structure = await scrim.evaluate((sc, testId) => {
          const layerEl = document.querySelector(`[data-testid="${testId}"]`);
          return {
            siblings: sc.parentElement === layerEl?.parentElement,
            scrimHoldsLayer: !!layerEl && sc.contains(layerEl),
            scrimHoldsSheet: sc.querySelector('.modal-sheet') !== null,
          };
        }, s.testId);
        expect(structure, `${s.id}: scrim and layer are siblings and the scrim holds no panel`).toEqual({ siblings: true, scrimHoldsLayer: false, scrimHoldsSheet: false });
        await expect(scrim).toHaveClass(new RegExp(`\\b${MODAL_CLASSES.scrim}\\b`));
        await expect(layer).toHaveClass(new RegExp(`\\b${MODAL_CLASSES.layer}\\b`));
        const layerStyle = await layer.evaluate((el) => {
          const cs = getComputedStyle(el);
          return { transform: cs.transform, filter: cs.filter, opacity: cs.opacity, pointerEvents: cs.pointerEvents };
        });
        expect(layerStyle, `${s.id}: the layer is pointer-transparent and carries no transform, filter or opacity`)
          .toEqual({ transform: 'none', filter: 'none', opacity: '1', pointerEvents: 'none' });
        if (s.radius === 'compact') await expect(sheet).toHaveClass(new RegExp(`\\b${MODAL_CLASSES.sheetCompact}\\b`));
        else await expect(sheet).not.toHaveClass(new RegExp(`\\b${MODAL_CLASSES.sheetCompact}\\b`));

        // No ad-hoc overlay classes left on any part of the frame.
        for (const [part, el] of [['scrim', scrim], ['layer', layer], ['sheet', sheet]] as const) {
          const cls = (await el.getAttribute('class')) ?? '';
          expect(cls, `${s.id} ${part}: no bg-black/NN or backdrop-blur-* class`).not.toMatch(/\bbg-black\/\d+|\bbackdrop-blur-/);
        }

        // AC25: fade only on mouse-opened modals; keyboard surfaces stay unanimated.
        const fade = s.motion === 'fade';
        const hasFadeScrim = ((await scrim.getAttribute('class')) ?? '').split(/\s+/).includes(MODAL_CLASSES.fadeScrim);
        const hasFadePanel = ((await sheet.getAttribute('class')) ?? '').split(/\s+/).includes(MODAL_CLASSES.fadePanel);
        expect({ hasFadeScrim, hasFadePanel }, `${s.id}: motion ${s.motion}`).toEqual({ hasFadeScrim: fade, hasFadePanel: fade });
        expect(await sheet.evaluate((el) => getComputedStyle(el).transform), `${s.id}: sheet at rest has no transform`).toBe('none');
        expect(await win.locator('.xterm').count(), 'positive control: a terminal is mounted').toBeGreaterThan(0);
        expect(await transformedXtermAncestors(win), `${s.id}: no .xterm ancestor is transformed or filtered`).toEqual([]);

        await setLook(win, 'default', 'dark');
        await closeSurface(win, s);
      }
    } finally {
      await restoreLook(win, look);
    }
  });

  test('AC22: the scrim blurs (≥ 2px) and tints; the sheet blurs and is translucent at the D1T alpha in every palette and appearance', async () => {
    const look = await currentLook(win);
    const s = surface('settings');
    await openSurface(win, s);
    try {
      for (const p of PALETTES) {
        for (const t of THEMES) {
          await setLook(win, p, t);
          const at = `${p}/${t}`;
          const m = await materialOf(win, s);
          const scrimBlur = blurRadiusPx(m.scrimBackdrop);
          expect(scrimBlur, `${at}: scrim backdrop-filter ${m.scrimBackdrop}`).not.toBeNull();
          expect(scrimBlur!, `${at}: scrim blur`).toBeGreaterThanOrEqual(MIN_SCRIM_BLUR_PX);
          const sheetBlur = blurRadiusPx(m.sheetBackdrop);
          expect(sheetBlur, `${at}: sheet backdrop-filter ${m.sheetBackdrop}`).not.toBeNull();
          expect(sheetBlur!, `${at}: sheet blur`).toBeGreaterThan(0);

          const tint = await computedColour(win, scrimOf(win, s), 'background-color');
          expect(tint.a > 0 && tint.a < 1, `${at}: scrim tint ${fmtColour(tint)} is a translucent tint`).toBe(true);
          const panel = await computedColour(win, sheetOf(win, s), 'background-color');
          expect(alphaMatches(panel.a, PANEL_ALPHA[t]), `${at}: sheet ${fmtColour(panel)} alpha is ${PANEL_ALPHA[t]}`).toBe(true);
        }
      }
    } finally {
      await restoreLook(win, look);
      await closeSurface(win, s);
    }
  });

  test('AC23: every --modal-* token resolves to a non-empty value in every palette and appearance', async () => {
    const look = await currentLook(win);
    try {
      for (const p of PALETTES) {
        for (const t of THEMES) {
          await setLook(win, p, t);
          const at = `${p}/${t}`;
          const values = await win.evaluate((names) => {
            const cs = getComputedStyle(document.documentElement);
            return Object.fromEntries(names.map((n) => [n, cs.getPropertyValue(n).trim()]));
          }, [...COLOUR_TOKENS, ...VALUE_TOKENS]);
          for (const [name, value] of Object.entries(values)) expect(value, `${at}: ${name} is set`).not.toBe('');
          for (const name of COLOUR_TOKENS) {
            // The canvas throws on a value it cannot paint, so resolving is the check.
            const c = await resolveToken(win, name);
            expect(c, `${at}: ${name} resolves to a colour`).toBeTruthy();
          }
          const panel = await resolveToken(win, '--modal-panel');
          expect(alphaMatches(panel.a, PANEL_ALPHA[t]), `${at}: --modal-panel ${fmtColour(panel)} keeps the D1T alpha`).toBe(true);
        }
      }
    } finally {
      await restoreLook(win, look);
    }
  });

  test('AC24: under emulated reduced transparency nothing blurs and every sheet is opaque', async () => {
    const s = surface('settings');
    const p = surface('palette');
    const look = await currentLook(win);
    await openSurface(win, s);
    // Positive control in the same app state: glass before emulation.
    const before = await materialOf(win, s);
    expect(blurRadiusPx(before.scrimBackdrop), 'control: the scrim blurs without emulation').not.toBeNull();
    expect((await computedColour(win, sheetOf(win, s), 'background-color')).a, 'control: the sheet is translucent').toBeLessThan(1);

    const cdp = await win.context().newCDPSession(win);
    try {
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] });
      const flipped = await win.evaluate(() => matchMedia('(prefers-reduced-transparency: reduce)').matches);
      // R12: if Chromium 128 does not honour this CDP feature, AC24's proof is Agent 3's CSS unit
      // check (tests/unit/renderer/modal-glass.test.ts, the reduced-transparency block) plus the
      // manual macOS "Reduce transparency" check recorded in the delivery record.
      test.skip(!flipped, 'CDP cannot emulate prefers-reduced-transparency here; AC24 is proved by the R12 unit check + manual macOS record');

      // Every palette x appearance; misses are collected so one run names them all.
      const misses: string[] = [];
      for (const target of [s, p]) {
        if (target.id === 'palette') {
          await closeSurface(win, s);
          await openSurface(win, p);
        }
        for (const pal of PALETTES) {
          for (const t of THEMES) {
            await setLook(win, pal, t);
            const at = `${target.id} ${pal}/${t}`;
            const m = await materialOf(win, target);
            if (m.scrimBackdrop !== 'none') misses.push(`${at}: scrim backdrop-filter ${m.scrimBackdrop}`);
            if (m.sheetBackdrop !== 'none') misses.push(`${at}: sheet backdrop-filter ${m.sheetBackdrop}`);
            const sheet = await computedColour(win, sheetOf(win, target), 'background-color');
            if (sheet.a !== 1) misses.push(`${at}: sheet not opaque ${fmtColour(sheet)}`);
            const tint = await computedColour(win, scrimOf(win, target), 'background-color');
            if (!(tint.a > 0)) misses.push(`${at}: scrim lost its tint`);
          }
        }
      }
      expect(misses, 'reduced transparency: no blur, opaque sheets, tinted scrim').toEqual([]);
      await closeSurface(win, p);
    } finally {
      await restoreLook(win, look);
      await cdp.send('Emulation.setEmulatedMedia', { features: [] });
      await cdp.detach();
      for (const target of [s, p]) {
        if (await layerOf(win, target).count()) await closeSurface(win, target);
      }
    }
  });

  test('AC26: toasts sit at z-index 60 and are topmost over every non-blocking modal', async () => {
    for (const s of NON_BLOCKING) {
      await openSurface(win, s);
      await raiseToast(l.app, win);
      const toast = win.getByTestId('toast').first();
      expect(await zIndex(toast.locator('xpath=..')), 'the toast stack z-index').toBe(String(TOAST_Z));
      const onTop = await toastsOnTop(win);
      expect(onTop.length, 'positive control: toasts are on screen').toBeGreaterThan(0);
      expect(onTop.every(Boolean), `${s.id}: every toast is the topmost element at its centre`).toBe(true);
      await closeSurface(win, s);
    }
  });

  test('AC5a: ⌘K over Settings or the prompt library opens the palette on top; Esc closes only the palette', async () => {
    const palette = surface('palette');
    for (const id of ['settings', 'prompt-library'] as const) {
      const s = surface(id);
      await openSurface(win, s);
      // Let the modal take focus first (the prompt library focuses its search on a 30ms timer),
      // as it has by the time a user presses ⌘K.
      await expect.poll(() => layerOf(win, s).evaluate((el) => el.contains(document.activeElement)), {
        message: `${id} holds focus before ⌘K`,
      }).toBe(true);
      const before = await layerOf(win, s).innerText();
      await win.keyboard.press('ControlOrMeta+k');
      await expect(layerOf(win, palette), `⌘K over ${id} opens the palette`).toBeVisible();
      const input = win.getByTestId(PALETTE_TESTIDS.input);
      await expect(input).toBeFocused();
      // Focus must stay in the palette, not just land there: the prompt library re-arms a 30ms
      // focus timer on re-render, so observe past it. A duration is the point of this check.
      await win.waitForTimeout(250);
      await expect(input, `the palette keeps focus over ${id}`).toBeFocused();
      const top = await input.evaluate((el, rootId) => {
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return !!hit && !!el.closest(`[data-testid="${rootId}"]`)?.contains(hit);
      }, palette.testId);
      expect(top, `the palette is above ${id}`).toBe(true);
      expect(Number(await zIndex(layerOf(win, palette)))).toBeGreaterThan(Number(await zIndex(layerOf(win, s))));

      await win.keyboard.press('Escape');
      await expect(layerOf(win, palette), 'Esc closes the palette').toHaveCount(0);
      await expect(layerOf(win, s), `${id} is still open`).toBeVisible();
      expect(await layerOf(win, s).innerText(), `${id} is unchanged`).toBe(before);
      await closeSurface(win, s);
    }
  });
});

/* ─────────────────────────────── blocking tier ─────────────────────────────── */

test('AC21, AC26: the permission dialog wears the shared material on the blocking tier, above toasts', async () => {
  const l = await launch(['alpha'], { unsetEnv: ['METAIDE_CLAUDE_PERMISSION_MODE'] });
  try {
    const { app, win } = l;
    const s = surface('permission-mode');
    expect(s.testId).toBe(PERMISSION_MODE_TEST_IDS.dialog);
    await expect(layerOf(win, s), 'the first-run permission dialog is up').toBeVisible({ timeout: 10000 });
    await expect.poll(() => sheetOf(win, s).evaluate((el) => getComputedStyle(el).opacity)).toBe('1');

    // Same material as the stylesheet's shared classes (the palette cannot open while this blocks).
    expect(await materialOf(win, s)).toEqual(await referenceMaterial(win));
    const sheetClasses = ((await sheetOf(win, s).getAttribute('class')) ?? '').split(/\s+/);
    expect(sheetClasses, 'mouse-opened: fades in').toContain(MODAL_CLASSES.fadePanel);
    expect(await scrimOf(win, s).evaluate((sc, testId) => sc.parentElement === document.querySelector(`[data-testid="${testId}"]`)?.parentElement, s.testId),
      'scrim and layer are siblings').toBe(true);

    const [scrimZ, layerZ] = MODAL_TIER_Z.blocking;
    expect(await zIndex(scrimOf(win, s))).toBe(String(scrimZ));
    expect(await zIndex(layerOf(win, s))).toBe(String(layerZ));
    expect(scrimZ, 'the blocking tier sits above toasts').toBeGreaterThan(TOAST_Z);

    await raiseToast(app, win);
    const onTop = await toastsOnTop(win);
    expect(onTop.length, 'positive control: a toast is on screen').toBeGreaterThan(0);
    expect(onTop.some(Boolean), 'no toast is above the permission dialog').toBe(false);
  } finally {
    await l.app.close();
    l.cleanup();
  }
});
