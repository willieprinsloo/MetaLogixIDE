/**
 * Pane and menu motion (docs/specs/2026-10-06-split-shell-cards.md
 * Amendment 2, AC42–AC57; AC58 is this file).
 *
 * Motion is observed by sampling the laid-out boxes every animation frame
 * (helpers/frames.ts), never by recording how an animation was requested.
 * The folding pane is the element that appears and disappears: for the
 * split, the wrapper around the gutter and `split-right` (its grandparent);
 * for the sidebar, the wrapper around `aside[data-view="projects"]`. The
 * staying pane is `.split-left`, or `main` beside the sidebar.
 *
 * Thresholds are the spec's, unchanged. On a red, the assertion message
 * carries the frame log so a dropped frame can be told from a real defect.
 */

import { test, expect, type Page } from '@playwright/test';
import { SPLIT_TESTIDS } from '../../src/renderer/split-copy';
import { SIDEBAR_TESTIDS } from '../../src/renderer/sidebar-copy';
import { PALETTE_TESTIDS } from '../../src/renderer/command-palette-contract';
import { launch, openProject, projectIdByName, projectRow, marker, type Launched } from './helpers/focus';
import {
  sampleDuring, contentWidth, frameLog, recordIpc, ipcLog, recordKeydowns, keydownTimes, transformParts,
  startFrames, collectFrames, type Frame,
} from './helpers/frames';
import { RIGHT, LEFT, openSplit, waitSettled, aliveIndices, splitState } from './helpers/split';

/* ─────────────────────────────── targets ─────────────────────────────── */

const SPLIT_TARGETS = {
  row: `${LEFT}^`,
  left: LEFT,
  right: RIGHT,
  fold: `${RIGHT}^^`,
  inner: `${RIGHT}^`,
  screen: `${LEFT} .xterm-screen`,
  pill: `[data-testid="${SPLIT_TESTIDS.toggle}"]`,
};
const ASIDE = 'aside[data-view="projects"]';
const SIDEBAR_TARGETS = {
  fold: `${ASIDE}^^^`,
  aside: ASIDE,
  main: 'main',
  screen: `${LEFT} .xterm-screen`,
};
const SAMPLE_MS = 1500;
const FOLD_LOG: Array<[string, 'w' | 'present' | 'opacity' | 'count' | 'h']> = [
  ['fold', 'present'], ['fold', 'w'], ['fold', 'opacity'], ['left', 'w'], ['row', 'w'], ['screen', 'w'], ['screen', 'h'], ['right', 'count'],
];
const SIDEBAR_LOG: Array<[string, 'w' | 'present' | 'opacity' | 'x']> = [
  ['fold', 'present'], ['fold', 'w'], ['fold', 'opacity'], ['main', 'x'], ['main', 'w'], ['screen', 'w'],
];

/* ─────────────────────────────── helpers ─────────────────────────────── */

async function withApp(names: string[], body: (h: Launched) => Promise<void>): Promise<void> {
  const h = await launch(names);
  try {
    await openProject(h.win, names[0]!);
    await body(h);
  } finally {
    await h.app.close();
    h.cleanup();
  }
}

const round = (n: number) => Math.round(n * 100) / 100;

/** Wall-clock time at which a series (by frame) first satisfies `pred`, or null. */
function firstT(frames: Frame[], pred: (f: Frame) => boolean, from = 0): number | null {
  for (let i = from; i < frames.length; i++) if (pred(frames[i]!)) return frames[i]!.t;
  return null;
}

/** Linear interpolation of `value` at time t. */
function valueAt(frames: Frame[], t: number, value: (f: Frame) => number): number {
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1]!;
    const b = frames[i]!;
    if (b.t >= t) return value(a) + (value(b) - value(a)) * ((t - a.t) / (b.t - a.t || 1));
  }
  return value(frames.at(-1)!);
}

/** Number of times a value changes (beyond `eps`) across the frames, and the frame indices where it does. */
function changes(frames: Frame[], value: (f: Frame) => string): number[] {
  const at: number[] = [];
  for (let i = 1; i < frames.length; i++) if (value(frames[i]!) !== value(frames[i - 1]!)) at.push(i);
  return at;
}

const screenKey = (f: Frame) => (f.s.screen?.present ? `${round(f.s.screen.w)}x${round(f.s.screen.h)}` : 'absent');

/** Width the folding pane occupies in a frame (0 when absent). */
const foldW = (f: Frame) => (f.s.fold?.present ? f.s.fold.w : 0);

/**
 * AC42 / AC43 / AC44 for one split close: row sum, largest single-frame widening, duration,
 * half-time width, and the left terminal refitting once, after the fold.
 */
function assertSplitClose(frames: Frame[], what: string): { foldEnd: number } {
  const log = `\n${what} frames:\n${frameLog(frames, FOLD_LOG)}`;
  const startW = foldW(frames[0]!);
  expect(startW, `${what}: the fold was open when sampling began${log}`).toBeGreaterThan(100);

  // AC42 row sum on every frame the folding pane is laid out.
  for (const f of frames) {
    if (!f.s.fold?.present || !f.s.left?.present) continue;
    const diff = Math.abs(f.s.left.w + f.s.fold.w - contentWidth(f.s.row!));
    expect(diff, `${what}: AC42 left + fold = row content ±2px at ${round(f.t - frames[0]!.t)}ms${log}`).toBeLessThanOrEqual(2);
  }
  // AC42 no end-of-exit jump.
  const lefts = frames.map((f) => f.s.left!.w);
  const total = lefts.at(-1)! - lefts[0]!;
  expect(total, `${what}: the left pane widened${log}`).toBeGreaterThan(100);
  const steps = lefts.slice(1).map((w, i) => w - lefts[i]!);
  expect(Math.max(...steps), `${what}: AC42 largest one-frame widening ≤ 25% of ${round(total)}px${log}`).toBeLessThanOrEqual(total * 0.25);

  // AC43 duration and half-time width.
  let startIdx = 0;
  for (let i = 0; i < frames.length; i++) { if (foldW(frames[i]!) >= startW - 0.5) startIdx = i; else break; }
  const tStart = frames[startIdx]!.t;
  const tEnd = firstT(frames, (f) => foldW(f) <= 0.5, startIdx);
  expect(tEnd, `${what}: the fold reached zero${log}`).not.toBeNull();
  const d = tEnd! - tStart;
  expect(d, `${what}: AC43 close duration 180–320ms${log}`).toBeGreaterThanOrEqual(180);
  expect(d, `${what}: AC43 close duration 180–320ms${log}`).toBeLessThanOrEqual(320);
  const half = valueAt(frames, tStart + d / 2, foldW) / startW;
  expect(half, `${what}: AC43 width at half time is 30–70% of the start${log}`).toBeGreaterThanOrEqual(0.3);
  expect(half, `${what}: AC43 width at half time is 30–70% of the start${log}`).toBeLessThanOrEqual(0.7);

  // AC44 one refit, after the fold.
  // Frames where the original left terminal is gone (To tab swaps in the moved shell at the end) are not a refit.
  const withScreen = frames.filter((f) => f.s.screen?.present);
  const refits = changes(withScreen, screenKey);
  expect(refits.length, `${what}: AC44 left .xterm-screen changes size at most once${log}`).toBeLessThanOrEqual(1);
  if (refits.length === 1) {
    expect(withScreen[refits[0]!]!.t, `${what}: AC44 the refit comes after the fold ended${log}`).toBeGreaterThanOrEqual(tEnd!);
  }
  return { foldEnd: tEnd! };
}

/** AC42 / AC43 / AC44 for one split open. */
function assertSplitOpen(frames: Frame[], what: string): void {
  const log = `\n${what} frames:\n${frameLog(frames, FOLD_LOG)}`;
  const present = frames.filter((f) => f.s.fold?.present);
  expect(present.length, `${what}: the fold was sampled${log}`).toBeGreaterThan(5);
  const finalW = present.at(-1)!.s.fold!.w;
  for (const f of present) {
    const diff = Math.abs(f.s.left!.w + f.s.fold!.w - contentWidth(f.s.row!));
    expect(diff, `${what}: AC42 left + fold = row content ±2px at ${round(f.t - frames[0]!.t)}ms${log}`).toBeLessThanOrEqual(2);
  }
  const lefts = frames.map((f) => f.s.left!.w);
  const total = lefts[0]! - lefts.at(-1)!;
  expect(total, `${what}: the left pane narrowed${log}`).toBeGreaterThan(100);
  const steps = lefts.slice(1).map((w, i) => lefts[i]! - w);
  expect(Math.max(...steps), `${what}: AC42 largest one-frame narrowing ≤ 25% of ${round(total)}px${log}`).toBeLessThanOrEqual(total * 0.25);
  const t0 = present[0]!.t;
  const tDone = firstT(frames, (f) => !!f.s.fold?.present && f.s.fold.w >= finalW - 0.5)!;
  expect(tDone - t0, `${what}: AC43 open completes within 320ms${log}`).toBeLessThanOrEqual(320);
  expect(present.filter((f) => f.s.fold!.w > 0.5 && f.s.fold!.w < finalW - 0.5).length, `${what}: open is gradual${log}`).toBeGreaterThan(3);
  expect(changes(frames, screenKey).length, `${what}: AC44 left .xterm-screen changes size at most once${log}`).toBeLessThanOrEqual(1);
}

/** AC46 at rest: no clip, transform or partial inline opacity on the pane chain; full width after close. */
async function assertAtRest(win: Page, what: string): Promise<void> {
  const facts = await win.evaluate((sels) => sels.map((sel) => {
    const m = /^(.*?)(\^*)$/.exec(sel)!;
    let el: Element | null = document.querySelector(m[1]!);
    for (let i = 0; i < m[2]!.length && el; i++) el = el.parentElement;
    if (!el) return { sel, present: false };
    const cs = getComputedStyle(el);
    const inline = (el as HTMLElement).style.opacity;
    return { sel, present: true, clip: cs.clipPath, transform: cs.transform, inlineOpacityBelow1: inline !== '' && parseFloat(inline) < 1 };
  }), [`${RIGHT}^^`, `${RIGHT}^`, RIGHT, LEFT]);
  for (const f of facts) {
    if (!f.present) continue;
    expect({ clip: f.clip, transform: f.transform, inlineOpacityBelow1: f.inlineOpacityBelow1 }, `${what}: AC46 ${f.sel} at rest`)
      .toEqual({ clip: 'none', transform: 'none', inlineOpacityBelow1: false });
  }
  if (!facts.find((f) => f.sel === RIGHT)!.present) {
    const w = await win.evaluate((s) => {
      const l = document.querySelector(s)!;
      return { left: l.getBoundingClientRect().width, row: l.parentElement!.getBoundingClientRect().width };
    }, LEFT);
    expect(Math.abs(w.left - w.row), `${what}: AC46 .split-left is full width after close`).toBeLessThan(0.5);
  }
}

/** Kill calls for a shell since the last `recordIpc`. */
async function killsOf(h: Launched, projectId: number, shellIndex: number) {
  return (await ipcLog(h.app)).filter((c) => c.ch === 'shells:kill'
    && (c.req as { projectId: number; shellIndex: number }).projectId === projectId
    && (c.req as { projectId: number; shellIndex: number }).shellIndex === shellIndex);
}

/* ─────────────────────────────── pane folds ─────────────────────────────── */

test('AC42–AC47: split open and every close fold smoothly, refit the left terminal once, and kill only after the exit', async () => {
  await withApp(['alpha'], async (h) => {
    const { win } = h;
    const projectId = await projectIdByName(win, 'alpha');
    await win.evaluate(() => {
      (document.querySelector('.split-left [data-testid="shell-tab"] .xterm') as HTMLElement & { __e2eLeft?: boolean }).__e2eLeft = true;
    });
    const leftKept = () => win.evaluate(() => (document.querySelector('.split-left .xterm') as HTMLElement & { __e2eLeft?: boolean } | null)?.__e2eLeft === true);

    // Open (pill).
    await recordIpc(h.app);
    const openFrames = await sampleDuring(win, SPLIT_TARGETS, SAMPLE_MS, () => win.getByTestId(SPLIT_TESTIDS.toggle).click());
    assertSplitOpen(openFrames, 'open');
    await waitSettled(win);
    await assertAtRest(win, 'after open');
    expect(await leftKept(), 'AC44/AC33: left terminal not remounted by open').toBe(true);
    let right = (await splitState(win, projectId))!.rightShellIndex!;

    // Close via the pill: kill only after the exit (AC47).
    await recordIpc(h.app);
    const pillFrames = await sampleDuring(win, SPLIT_TARGETS, SAMPLE_MS, () => win.getByTestId(SPLIT_TESTIDS.toggle).click());
    const pillClose = assertSplitClose(pillFrames, 'close by pill');
    await expect.poll(() => killsOf(h, projectId, right).then((k) => k.length), { message: 'pill close kills the right shell' }).toBe(1);
    // Frame times are frame starts; Date.now() in main is whole ms, so compare at ms resolution.
    const lastWide = Math.floor([...pillFrames].reverse().find((f) => foldW(f) > 0.5)!.t);
    const kill = (await killsOf(h, projectId, right))[0]!.t;
    expect(kill, `AC47: kill (t=${kill}) only after the fold left the screen (last visible frame t=${round(lastWide)})`).toBeGreaterThanOrEqual(lastWide);
    expect(kill - pillClose.foldEnd, 'AC47: kill follows the exit completion promptly').toBeLessThan(250);
    await waitSettled(win);
    await assertAtRest(win, 'after pill close');
    expect(await leftKept(), 'left terminal not remounted by close').toBe(true);

    // Close via split-close.
    right = await openSplit(win, 'alpha');
    await recordIpc(h.app);
    const xFrames = await sampleDuring(win, SPLIT_TARGETS, SAMPLE_MS, () => win.getByTestId(SPLIT_TESTIDS.close).click());
    const xClose = assertSplitClose(xFrames, 'close by split-close');
    await expect.poll(() => killsOf(h, projectId, right).then((k) => k.length)).toBe(1);
    expect((await killsOf(h, projectId, right))[0]!.t, 'AC47: split-close kills after the exit').toBeGreaterThanOrEqual(xClose.foldEnd - 17);
    await waitSettled(win);
    await assertAtRest(win, 'after split-close');

    // To tab: the same fold, never a kill.
    right = await openSplit(win, 'alpha');
    await recordIpc(h.app);
    // To tab swaps the left terminal for the moved shell at the end (AC61), so AC44 follows the original one.
    await win.evaluate(() => document.querySelector('.split-left .xterm-screen')!.setAttribute('data-e2e-original', '1'));
    const tFrames = await sampleDuring(win, { ...SPLIT_TARGETS, screen: '[data-e2e-original="1"]' }, SAMPLE_MS,
      () => win.getByTestId(SPLIT_TESTIDS.toTab).click());
    assertSplitClose(tFrames, 'To tab');
    await win.waitForTimeout(1000);
    expect(await killsOf(h, projectId, right), 'AC47/AC28: To tab never kills').toEqual([]);
    expect(await aliveIndices(win, 'alpha')).toContain(right);
    await waitSettled(win);
    await assertAtRest(win, 'after To tab');
  });
});

test('AC47: switching project while a close is folding out kills the old right shell at once', async () => {
  await withApp(['alpha', 'beta'], async ({ win }) => {
    const right = await openSplit(win, 'alpha');
    expect(await aliveIndices(win, 'alpha'), 'positive control: right shell live').toContain(right);
    await win.evaluate((pillId) => {
      (document.querySelector(`[data-testid="${pillId}"]`) as HTMLElement).click();
      const row = [...document.querySelectorAll<HTMLElement>('[data-testid="project-row"]')].find((r) => r.textContent?.trim() === 'beta')!;
      row.click();
    }, SPLIT_TESTIDS.toggle);
    await expect.poll(() => win.title()).toBe('beta — MetaLogix IDE');
    await expect.poll(() => aliveIndices(win, 'alpha'), { timeout: 1500, message: 'the pending kill fires on the switch' }).not.toContain(right);
  });
});

test('AC48: reopening the split while it folds out never mounts two right panes and ends open', async () => {
  await withApp(['alpha'], async ({ win }) => {
    await openSplit(win, 'alpha');
    await startFrames(win, SPLIT_TARGETS, 2500);
    await win.getByTestId(SPLIT_TESTIDS.toggle).click();
    // Reopen once the fold is visibly under way.
    await win.waitForFunction((sel) => {
      const fold = document.querySelector(sel)?.parentElement?.parentElement;
      const row = document.querySelector('.split-left')!.parentElement!;
      return !!fold && fold.getBoundingClientRect().width < row.getBoundingClientRect().width * 0.45;
    }, RIGHT, { polling: 'raf' });
    await win.getByTestId(SPLIT_TESTIDS.toggle).click();
    const frames = await collectFrames(win);
    const log = `\nframes:\n${frameLog(frames, FOLD_LOG)}`;
    const reopenedWhileExiting = frames.some((f) => f.s.pill?.pressed === 'true' && f.s.fold?.present && f.s.fold.w < frames[0]!.s.fold!.w - 5
      && frames.indexOf(f) > frames.findIndex((g) => g.s.pill?.pressed === 'false'));
    expect(reopenedWhileExiting, `precondition: the reopen landed while the old pane was still exiting${log}`).toBe(true);
    expect(Math.max(...frames.map((f) => f.s.right!.count)), `AC48: never two right panes${log}`).toBeLessThanOrEqual(1);
    await expect(win.getByTestId(SPLIT_TESTIDS.right)).toHaveCount(1);
    await expect(win.getByTestId(SPLIT_TESTIDS.toggle)).toHaveAttribute('aria-pressed', 'true');
    await waitSettled(win);
    await assertAtRest(win, 'after reopen');
  });
});

test('AC42/AC43/AC48: the sidebar folds smoothly on a mouse toggle and survives a mid-fold reversal', async () => {
  await withApp(['alpha'], async ({ win }) => {
    const toggle = win.getByTestId('ab-toggle-sidebar');
    const hide = await sampleDuring(win, SIDEBAR_TARGETS, SAMPLE_MS, () => toggle.click());
    const log = (fr: Frame[]) => `\nframes:\n${frameLog(fr, SIDEBAR_LOG)}`;
    const sum0 = foldW(hide[0]!) + hide[0]!.s.main!.w;
    for (const f of hide) {
      expect(Math.abs(foldW(f) + f.s.main!.w - sum0), `hide: AC42 sidebar + main constant ±2px${log(hide)}`).toBeLessThanOrEqual(2);
    }
    const xs = hide.map((f) => f.s.main!.x);
    const total = xs[0]! - xs.at(-1)!;
    expect(total, `hide: main moved left${log(hide)}`).toBeGreaterThan(100);
    const steps = xs.slice(1).map((x, i) => xs[i]! - x);
    expect(Math.max(...steps), `hide: AC42 largest one-frame move ≤ 25%${log(hide)}`).toBeLessThanOrEqual(total * 0.25);
    const tStart = [...hide].reverse().find((f) => f.s.main!.x >= xs[0]! - 0.5)!.t;
    const tEnd = firstT(hide, (f) => f.s.main!.x <= xs.at(-1)! + 0.5)!;
    expect(tEnd - tStart, `hide: AC43 duration 180–320ms${log(hide)}`).toBeGreaterThanOrEqual(180);
    expect(tEnd - tStart, `hide: AC43 duration 180–320ms${log(hide)}`).toBeLessThanOrEqual(320);
    expect(changes(hide, screenKey).length, `hide: AC44 shown terminal refits at most once${log(hide)}`).toBeLessThanOrEqual(1);

    const show = await sampleDuring(win, SIDEBAR_TARGETS, SAMPLE_MS, () => toggle.click());
    const sx = show.map((f) => f.s.main!.x);
    const sTotal = sx.at(-1)! - sx[0]!;
    expect(sTotal, `show: main moved right${log(show)}`).toBeGreaterThan(100);
    expect(Math.max(...sx.slice(1).map((x, i) => x - sx[i]!)), `show: AC42 largest one-frame move ≤ 25%${log(show)}`).toBeLessThanOrEqual(sTotal * 0.25);
    const sStart = firstT(show, (f) => f.s.main!.x > sx[0]! + 0.5)!;
    const sDone = firstT(show, (f) => f.s.main!.x >= sx.at(-1)! - 0.5)!;
    expect(sDone - sStart, `show: AC43 open within 320ms${log(show)}`).toBeLessThanOrEqual(320);
    await waitSettled(win);

    // AC48: reverse mid-fold — never two sidebars, ends open, at rest.
    await startFrames(win, SIDEBAR_TARGETS, 2000);
    await toggle.click();
    await win.waitForTimeout(90);
    await toggle.click();
    const rev = await collectFrames(win);
    expect(Math.max(...rev.map((f) => f.s.aside!.count)), `AC48: never two sidebars${log(rev)}`).toBeLessThanOrEqual(1);
    expect(rev.some((f) => f.s.main!.x < sx.at(-1)! - 5), `precondition: the reversal happened mid-fold${log(rev)}`).toBe(true);
    await expect(win.getByTestId(SIDEBAR_TESTIDS.addButton)).toBeVisible();
    await waitSettled(win);
    expect(await win.locator('main').evaluate((m) => m.getBoundingClientRect().x), 'sidebar fully open again').toBeCloseTo(sx.at(-1)!, 0);
    const fold = await win.locator(ASIDE).evaluate((a) => {
      const f = a.parentElement!.parentElement!;
      const cs = getComputedStyle(f);
      return { clip: cs.clipPath, transform: cs.transform, inlineOpacityBelow1: f.style.opacity !== '' && parseFloat(f.style.opacity) < 1 };
    });
    expect(fold, 'AC46: sidebar fold at rest').toEqual({ clip: 'none', transform: 'none', inlineOpacityBelow1: false });
  });
});

test('AC49: ⌘B, ⌘\\ and the palette sidebar command toggle the sidebar in one step', async () => {
  await withApp(['alpha'], async ({ win }) => {
    const addBtn = win.getByTestId(SIDEBAR_TESTIDS.addButton);
    await win.getByTestId('activity-bar').click({ position: { x: 20, y: 400 } }); // focus out of the terminal
    await recordKeydowns(win);

    const instant = async (what: string, act: () => Promise<void>, key: string) => {
      const frames = await sampleDuring(win, SIDEBAR_TARGETS, 600, act);
      const log = `\n${what} frames:\n${frameLog(frames, SIDEBAR_LOG)}`;
      const xs = [...new Set(frames.map((f) => round(f.s.main!.x)))];
      expect(xs.length, `${what}: main has exactly two positions (no intermediate widths)${log}`).toBe(2);
      const pressed = (await keydownTimes(win)).filter((k) => k.key === key).at(-1)!.t;
      const after = frames.filter((f) => f.t > pressed);
      const flip = after.findIndex((f) => round(f.s.main!.x) !== round(frames[0]!.s.main!.x));
      expect(flip, `${what}: layout changes within 2 frames of the keydown${log}`).toBeGreaterThanOrEqual(0);
      expect(flip, `${what}: layout changes within 2 frames of the keydown${log}`).toBeLessThanOrEqual(1);
      expect(frames.every((f) => !f.s.fold!.present || f.s.fold!.opacity === 1), `${what}: no fade on the sidebar${log}`).toBe(true);
    };

    await instant('⌘B hide', () => win.keyboard.press('ControlOrMeta+b'), 'b');
    await expect(addBtn).toHaveCount(0);
    await instant('⌘B show', () => win.keyboard.press('ControlOrMeta+b'), 'b');
    await expect(addBtn).toBeVisible();
    await instant('⌘\\ hide', () => win.keyboard.press('ControlOrMeta+Backslash'), '\\');
    await expect(addBtn).toHaveCount(0);
    await instant('⌘\\ show', () => win.keyboard.press('ControlOrMeta+Backslash'), '\\');
    await expect(addBtn).toBeVisible();

    for (const title of ['Hide sidebar', 'Show sidebar']) {
      // ⌘⇧P opens the palette seeded with ">" (commands mode); typing appends after it.
      await win.keyboard.press('ControlOrMeta+Shift+P');
      await expect(win.getByTestId(PALETTE_TESTIDS.root)).toBeVisible();
      await expect(win.getByTestId(PALETTE_TESTIDS.input)).toHaveValue('>');
      await win.keyboard.type(title);
      await expect(win.getByTestId(PALETTE_TESTIDS.root).locator('[role="option"][aria-selected="true"]'), `${title} is the highlighted row Enter runs`)
        .toContainText(title);
      await instant(`palette ${title}`, () => win.keyboard.press('Enter'), 'Enter');
      await expect(win.getByTestId(PALETTE_TESTIDS.root)).toHaveCount(0);
    }
    await expect(addBtn).toBeVisible();
  });
});

/* ─────────────────────────────── menus ─────────────────────────────── */

const MENU_LOG: Array<[string, 'present' | 'opacity' | 'transform' | 'testid' | 'count' | 'x']> = [
  ['menu', 'present'], ['menu', 'testid'], ['menu', 'opacity'], ['menu', 'transform'], ['menu', 'count'],
];

/** AC50 enter/exit and AC54 rest for one open+close of a menu (target `menu`). */
async function assertMenuMotion(win: Page, what: string, menuSel: string, open: () => Promise<void>, close: () => Promise<void>, reduced: boolean) {
  const enter = await sampleDuring(win, { menu: menuSel }, 500, open);
  let log = `\n${what} enter frames:\n${frameLog(enter, MENU_LOG)}`;
  const shown = enter.filter((f) => f.s.menu!.present);
  expect(shown.length, `${what}: menu appeared${log}`).toBeGreaterThan(2);
  expect(shown[0]!.s.menu!.opacity, `${what}: enter starts below full opacity${log}`).toBeLessThan(1);
  for (const f of shown) {
    const tp = transformParts(f.s.menu!.transform);
    if (reduced) {
      expect(f.s.menu!.transform, `${what}: AC55 no transform under reduced motion${log}`).toBe('none');
    } else {
      expect(Math.min(tp.scaleX, tp.scaleY), `${what}: AC50 scale ≥ 0.95${log}`).toBeGreaterThanOrEqual(0.95);
      expect(Math.max(Math.abs(tp.tx), Math.abs(tp.ty)), `${what}: AC50 translate ≤ 6px${log}`).toBeLessThanOrEqual(6);
    }
  }
  if (!reduced) expect(shown.some((f) => f.s.menu!.transform !== 'none'), `${what}: AC50 enter has a scale${log}`).toBe(true);
  const settled = firstT(enter, (f) => !!f.s.menu?.present && f.s.menu.opacity >= 0.999 && f.s.menu.transform === 'none');
  expect(settled, `${what}: enter settles${log}`).not.toBeNull();
  const enterD = settled! - shown[0]!.t;
  if (reduced) expect.soft(enterD, `${what}: AC56 enter fade ≥ 150ms${log}`).toBeGreaterThanOrEqual(150);
  expect(enterD, `${what}: AC50 enter within 200ms${log}`).toBeLessThanOrEqual(200);
  // AC54 at rest.
  const rest = await win.locator(menuSel).first().evaluate((n) => ({ t: getComputedStyle(n).transform, o: getComputedStyle(n).opacity }));
  expect(rest, `${what}: AC54 at rest`).toEqual({ t: 'none', o: '1' });

  const exit = await sampleDuring(win, { menu: menuSel }, 500, close);
  log = `\n${what} exit frames:\n${frameLog(exit, MENU_LOG)}`;
  const tStart = [...exit].reverse().find((f) => f.s.menu!.present && f.s.menu!.opacity >= 0.999)?.t ?? exit[0]!.t;
  const leaving = exit.filter((f) => f.s.menu!.present && f.s.menu!.opacity < 0.999);
  expect(leaving.length, `${what}: AC50 the menu stays in the DOM while it exits${log}`).toBeGreaterThan(2);
  for (let i = 1; i < leaving.length; i++) {
    expect(leaving[i]!.s.menu!.opacity, `${what}: exit opacity falls${log}`).toBeLessThanOrEqual(leaving[i - 1]!.s.menu!.opacity + 0.001);
  }
  if (reduced) expect(exit.every((f) => !f.s.menu!.present || f.s.menu!.transform === 'none'), `${what}: AC55 no transform on exit${log}`).toBe(true);
  else expect(leaving.some((f) => f.s.menu!.transform !== 'none'), `${what}: AC50 exit reverses the scale${log}`).toBe(true);
  const gone = firstT(exit, (f) => !f.s.menu!.present);
  expect(gone, `${what}: AC50 the menu is gone when the exit ends${log}`).not.toBeNull();
  if (reduced) expect.soft(gone! - tStart, `${what}: AC56 exit fade ≥ 150ms${log}`).toBeGreaterThanOrEqual(150);
  expect(gone! - (leaving[0]?.t ?? tStart), `${what}: AC50 exit within 200ms${log}`).toBeLessThanOrEqual(200);
}

const CTX_ANY = '[data-testid="context-menu"], [data-testid="context-menu-leaving"]';
const NEW_SHELL = '[data-new-shell-menu="1"]';

test('AC50/AC53/AC54: menus pop in and out — new-shell and ContextMenu, closed by Escape, item and outside click', async () => {
  await withApp(['alpha'], async ({ win }) => {
    const plus = win.getByTestId('tabbar-new-shell');
    await assertMenuMotion(win, 'new-shell (Escape)', NEW_SHELL, () => plus.click(), () => win.keyboard.press('Escape'), false);
    await assertMenuMotion(win, 'new-shell (outside click)', NEW_SHELL, () => plus.click(), () => win.getByTestId('status-bar').click(), false);

    const add = win.getByTestId(SIDEBAR_TESTIDS.addButton);
    await assertMenuMotion(win, 'sidebar + (Escape)', CTX_ANY, async () => { await add.focus(); await win.keyboard.press('Enter'); },
      () => win.keyboard.press('Escape'), false);
    await expect(add, 'AC53: Escape returns focus to "+"').toBeFocused();
    await assertMenuMotion(win, 'sidebar + (outside click)', CTX_ANY, () => add.click(), async () => {
      const sb = await win.getByTestId('status-bar').boundingBox();
      await win.mouse.click(sb!.x + sb!.width / 2, sb!.y + sb!.height / 2);
    }, false);
    await assertMenuMotion(win, 'sidebar + (item)', CTX_ANY, () => add.click(), () => win.getByTestId(SIDEBAR_TESTIDS.menuRescan).click(), false);

    // AC54: a right-click menu sits at the click point.
    const row = await projectRow(win, 'alpha').boundingBox();
    const at = { x: Math.round(row!.x + 30), y: Math.round(row!.y + row!.height / 2) };
    await win.mouse.click(at.x, at.y, { button: 'right' });
    const menu = win.getByTestId('context-menu');
    await expect(menu).toBeVisible();
    await waitSettled(win);
    await win.waitForTimeout(250);
    const pos = await menu.evaluate((n) => ({ left: (n as HTMLElement).style.left, top: (n as HTMLElement).style.top, r: n.getBoundingClientRect() }));
    expect([pos.left, pos.top], 'AC54: anchored at the click point').toEqual([`${at.x}px`, `${at.y}px`]);
    expect([Math.round(pos.r.x), Math.round(pos.r.y)], 'AC54: no transform offset at rest').toEqual([at.x, at.y]);
    await win.keyboard.press('Escape');
    await expect(win.locator(CTX_ANY)).toHaveCount(0);
  });
});

test('AC51/AC52: reopening during an exit yields one menu; a click during the exit lands on what is under it', async () => {
  await withApp(['alpha', 'beta'], async ({ win }) => {
    const add = win.getByTestId(SIDEBAR_TESTIDS.addButton);

    // AC51 ContextMenu.
    await add.click();
    await expect(win.getByTestId('context-menu')).toBeVisible();
    await waitSettled(win);
    await startFrames(win, { menu: CTX_ANY, leaving: '[data-testid="context-menu-leaving"]' }, 600);
    await win.keyboard.press('Escape');
    await win.waitForFunction(() => !!document.querySelector('[data-testid="context-menu-leaving"]'), undefined, { polling: 'raf' });
    await add.click();
    let frames = await collectFrames(win);
    let log = `\nframes:\n${frameLog(frames, MENU_LOG)}`;
    expect(frames.some((f) => f.s.leaving!.present), `precondition: reopened while the old menu was leaving${log}`).toBe(true);
    expect(Math.max(...frames.map((f) => f.s.menu!.count)), `AC51: never two context menus${log}`).toBeLessThanOrEqual(1);
    await expect(win.getByTestId('context-menu'), 'AC51: exactly one live menu').toHaveCount(1);
    await expect(win.getByRole('menu')).toHaveCount(1);
    await win.keyboard.press('Escape');
    await expect(win.locator(CTX_ANY)).toHaveCount(0);

    // AC51 new-shell menu.
    const plus = win.getByTestId('tabbar-new-shell');
    await plus.click();
    await expect(win.locator(NEW_SHELL)).toBeVisible();
    await waitSettled(win);
    await startFrames(win, { menu: NEW_SHELL, leaving: '[data-testid="new-shell-menu-leaving"]' }, 600);
    await win.keyboard.press('Escape');
    await win.waitForFunction(() => !!document.querySelector('[data-testid="new-shell-menu-leaving"]'), undefined, { polling: 'raf' });
    await plus.click();
    frames = await collectFrames(win);
    log = `\nframes:\n${frameLog(frames, MENU_LOG)}`;
    expect(frames.some((f) => f.s.leaving!.present), `precondition: reopened while the old menu was leaving${log}`).toBe(true);
    expect(Math.max(...frames.map((f) => f.s.menu!.count)), `AC51: never two new-shell menus${log}`).toBeLessThanOrEqual(1);
    await expect(win.locator(NEW_SHELL)).toHaveCount(1);
    await expect(win.locator('[data-testid="new-shell-menu-leaving"]')).toHaveCount(0);
    await win.keyboard.press('Escape');
    await expect(win.locator(NEW_SHELL)).toHaveCount(0);

    // AC52: Escape starts the exit; the next click on a sidebar row activates it.
    await expect.poll(() => win.title()).toBe('alpha — MetaLogix IDE');
    const beta = await projectRow(win, 'beta').boundingBox();
    await add.click();
    await expect(win.getByTestId('context-menu')).toBeVisible();
    await waitSettled(win);
    await win.keyboard.press('Escape');
    const leavingAtClick = await win.evaluate(() => !!document.querySelector('[data-testid="context-menu-leaving"]'));
    await win.mouse.click(beta!.x + beta!.width / 2, beta!.y + beta!.height / 2);
    expect(leavingAtClick, 'precondition: the menu was still leaving when the click was sent').toBe(true);
    await expect.poll(() => win.title(), { message: 'AC52: the click during the exit selected the row' }).toBe('beta — MetaLogix IDE');
  });
});

/* ─────────────────────────────── reduced motion ─────────────────────────────── */

test('AC55–AC57: under reduced motion panes and menus fade in place and layout changes in one step', async () => {
  await withApp(['alpha'], async ({ win }) => {
    await win.emulateMedia({ reducedMotion: 'reduce' });
    expect(await win.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);
    const noGeomMotion = (fr: Frame[], what: string, log: string) => {
      for (const f of fr) {
        for (const k of ['fold', 'inner', 'right', 'left'] as const) {
          const s = f.s[k];
          if (!s?.present) continue;
          expect([s.clip, s.transform], `${what}: AC55 ${k} has no clip-path or transform${log}`).toEqual(['none', 'none']);
        }
      }
    };

    // Open: final layout in the first frame, then a fade ≥ 150ms.
    const open = await sampleDuring(win, SPLIT_TARGETS, SAMPLE_MS, () => win.getByTestId(SPLIT_TESTIDS.toggle).click());
    let log = `\nopen frames:\n${frameLog(open, FOLD_LOG)}`;
    noGeomMotion(open, 'open', log);
    const present = open.filter((f) => f.s.fold?.present);
    expect(present.length, `open: fold sampled${log}`).toBeGreaterThan(3);
    const finalW = present.at(-1)!.s.fold!.w;
    expect(present.every((f) => Math.abs(f.s.fold!.w - finalW) <= 1), `AC57: the fold has its final width from its first frame${log}`).toBe(true);
    const leftFinal = open.at(-1)!.s.left!.w;
    expect(present.every((f) => Math.abs(f.s.left!.w - leftFinal) <= 1), `AC57: the left pane has its final width from the fold's first frame${log}`).toBe(true);
    expect(present[0]!.s.fold!.opacity, `AC56: the fold starts transparent${log}`).toBeLessThan(0.5);
    const opaque = firstT(open, (f) => !!f.s.fold?.present && f.s.fold.opacity >= 0.999)!;
    expect(opaque - present[0]!.t, `AC56: open fade ≥ 150ms${log}`).toBeGreaterThanOrEqual(150);
    expect(changes(open, screenKey).length, `AC44 under reduce: one refit at most${log}`).toBeLessThanOrEqual(1);
    await waitSettled(win);
    await assertAtRest(win, 'reduced open');

    // Close: fade in place at full size, then one layout step.
    const close = await sampleDuring(win, SPLIT_TARGETS, SAMPLE_MS, () => win.getByTestId(SPLIT_TESTIDS.toggle).click());
    log = `\nclose frames:\n${frameLog(close, FOLD_LOG)}`;
    noGeomMotion(close, 'close', log);
    const startW = close[0]!.s.fold!.w;
    const fading = close.filter((f) => f.s.fold?.present && f.s.fold.opacity < 0.999 && f.s.fold.opacity > 0.001);
    expect(fading.length, `AC56: close fades${log}`).toBeGreaterThan(3);
    expect(fading.every((f) => Math.abs(f.s.fold!.w - startW) <= 1), `AC57: the fold fades at full size${log}`).toBe(true);
    const fadeStart = [...close].reverse().find((f) => f.s.fold?.present && f.s.fold.opacity >= 0.999 && f.t < fading[0]!.t)?.t ?? close[0]!.t;
    const fadeEnd = firstT(close, (f) => !f.s.fold?.present || f.s.fold.opacity <= 0.001 || f.s.fold.w <= 0.5)!;
    expect(fadeEnd - fadeStart, `AC56: close fade ≥ 150ms${log}`).toBeGreaterThanOrEqual(150);
    // The left pane takes its final width in one step after the fade. The 16px row inset (S3, accepted)
    // may leave in its own frame; every other px of the change lands in one frame.
    const lefts = close.map((f) => f.s.left!.w);
    const steps = lefts.slice(1).map((w, i) => ({ d: w - lefts[i]!, t: close[i + 1]!.t })).filter((s) => Math.abs(s.d) > 0.5);
    const total = lefts.at(-1)! - lefts[0]!;
    const big = steps.filter((s) => s.d > 16.5);
    expect(big.length, `AC57: one layout step${log}`).toBe(1);
    expect(steps.reduce((a, s) => a + s.d, 0), `steps add up${log}`).toBeCloseTo(total, 0);
    expect(steps.filter((s) => s !== big[0]).every((s) => Math.abs(s.d) <= 16.5), `AC57: no other step beyond the S3 inset${log}`).toBe(true);
    expect(big[0]!.t, `AC57: the step comes after the fade${log}`).toBeGreaterThanOrEqual(fadeEnd);
    expect(changes(close, screenKey).length, `AC44 under reduce: one refit at most${log}`).toBeLessThanOrEqual(1);
    await waitSettled(win);
    await assertAtRest(win, 'reduced close');

    // Sidebar under reduce: one layout step each way, with a fade.
    const toggle = win.getByTestId('ab-toggle-sidebar');
    for (const what of ['hide', 'show'] as const) {
      const fr = await sampleDuring(win, SIDEBAR_TARGETS, SAMPLE_MS, () => toggle.click());
      const l = `\nsidebar ${what} frames:\n${frameLog(fr, SIDEBAR_LOG)}`;
      const xs = [...new Set(fr.map((f) => round(f.s.main!.x)))];
      expect(xs.length, `AC57: sidebar ${what} moves main in one step${l}`).toBe(2);
      const fadeFrames = fr.filter((f) => f.s.fold?.present && f.s.fold.opacity > 0.001 && f.s.fold.opacity < 0.999);
      expect(fadeFrames.length, `AC56: sidebar ${what} fades${l}`).toBeGreaterThan(3);
      expect(fr.every((f) => !f.s.fold?.present || (f.s.fold.transform === 'none' && f.s.fold.clip === 'none')), `AC55: sidebar ${what}${l}`).toBe(true);
      const a = fr.find((f) => f.s.fold?.present && f.s.fold.opacity > 0.001 && f.s.fold.opacity < 0.999)!;
      const opaqueOrGone = what === 'show'
        ? firstT(fr, (f) => !!f.s.fold?.present && f.s.fold.opacity >= 0.999 && f.t > a.t)!
        : firstT(fr, (f) => !f.s.fold?.present || f.s.fold.opacity <= 0.001)!;
      const before = [...fr].reverse().find((f) => f.t < a.t)?.t ?? a.t;
      expect(opaqueOrGone - before, `AC56: sidebar ${what} fade ≥ 150ms${l}`).toBeGreaterThanOrEqual(150);
      await waitSettled(win);
    }

    // Menus under reduce: opacity only, ≥ 150ms each way.
    const plus = win.getByTestId('tabbar-new-shell');
    await assertMenuMotion(win, 'reduced new-shell', NEW_SHELL, () => plus.click(), () => win.keyboard.press('Escape'), true);
    const add = win.getByTestId(SIDEBAR_TESTIDS.addButton);
    await assertMenuMotion(win, 'reduced sidebar +', CTX_ANY, () => add.click(), () => win.keyboard.press('Escape'), true);
  });
});

/* ─────────────────────────────── gate regressions ─────────────────────────────── */

test('AC48/AC47 regression: close → open → close inside one fold-out leaves no right shell alive', async () => {
  await withApp(['alpha'], async (h) => {
    const { win } = h;
    const pill = win.getByTestId(SPLIT_TESTIDS.toggle);
    const pressed = (v: 'true' | 'false') => win.waitForFunction(({ sel, v }) =>
      document.querySelector(sel)?.getAttribute('aria-pressed') === v, { sel: SPLIT_TARGETS.pill, v }, { polling: 'raf' });

    // Positive control: close → settle → open keeps the reopened shell; a normal close kills it.
    await openSplit(win, 'alpha');
    await pill.click();
    await expect.poll(() => aliveIndices(win, 'alpha'), { message: 'normal close kills' }).toEqual([0]);
    await waitSettled(win);
    const reopened = await openSplit(win, 'alpha');
    await win.waitForTimeout(800);
    expect(await aliveIndices(win, 'alpha'), 'positive control: a reopened shell stays alive').toEqual([0, reopened]);

    // Triple toggle inside the exit of `reopened`.
    await recordIpc(h.app);
    await startFrames(win, SPLIT_TARGETS, 3000);
    await pill.click();
    await pressed('false');
    await pill.click();
    await pressed('true');
    await pill.click();
    await pressed('false');
    const frames = await collectFrames(win);
    const log = `\nframes:\n${frameLog(frames, [['fold', 'present'], ['fold', 'w'], ['pill', 'pressed'], ['right', 'count']])}`;
    // Precondition: the reopen and the second close both landed while the first pane was still folding out.
    const i1 = frames.findIndex((f) => f.s.pill!.pressed === 'false');
    const i2 = frames.findIndex((f, i) => i > i1 && f.s.pill!.pressed === 'true');
    const i3 = frames.findIndex((f, i) => i > i2 && f.s.pill!.pressed === 'false');
    expect([i1, i2, i3].every((i) => i >= 0), `precondition: three toggles sampled${log}`).toBe(true);
    expect(frames[i3]!.s.fold!.present && frames[i3]!.s.fold!.w > 0.5, `precondition: the second close landed during the first exit${log}`).toBe(true);
    expect(Math.max(...frames.map((f) => f.s.right!.count)), `never two right panes${log}`).toBeLessThanOrEqual(1);

    await waitSettled(win);
    await expect.poll(() => aliveIndices(win, 'alpha'), { timeout: 3000, message: `no right shell left alive${log}` }).toEqual([0]);
    const killed = (await ipcLog(h.app)).filter((c) => c.ch === 'shells:kill').map((c) => (c.req as { shellIndex: number }).shellIndex);
    expect(killed, 'the first pane\'s shell was killed').toContain(reopened);
    expect(killed.length, 'both right shells were killed').toBe(2);
    await win.waitForTimeout(400);
    await expect(win.locator('[data-testid="shell-tab-button"]:not([data-shell-index="0"])'), 'no chip for either shell').toHaveCount(0);
    await expect(win.getByTestId(SPLIT_TESTIDS.right)).toHaveCount(0);
    await expect(pill).toHaveAttribute('aria-pressed', 'false');
  });
});

test('leaving menus are inert to the keyboard: Enter during the exit does not run the focused item', async () => {
  await withApp(['alpha'], async (h) => {
    const { app, win } = h;
    const projectId = await projectIdByName(win, 'alpha');

    // NewShellMenu: positive control — Enter on the open menu launches one shell.
    const plus = win.getByTestId('tabbar-new-shell');
    const terminalItem = win.locator(`${NEW_SHELL} button`, { hasText: 'Terminal' });
    await recordIpc(app);
    await plus.click();
    await terminalItem.focus();
    await win.keyboard.press('Enter');
    await expect.poll(async () => (await ipcLog(app)).filter((c) => c.ch === 'shells:launch-plain').length,
      { message: 'positive control: Enter on the open menu runs the item' }).toBe(1);
    await win.waitForTimeout(500);
    expect((await ipcLog(app)).filter((c) => c.ch === 'shells:launch-plain').length, 'runs it once').toBe(1);
    await expect(win.locator(NEW_SHELL)).toHaveCount(0);

    // Escape, then Enter while the menu is leaving.
    const alive = await aliveIndices(win, 'alpha');
    await recordIpc(app);
    await recordKeydowns(win);
    await plus.click();
    await expect(win.locator(NEW_SHELL)).toBeVisible();
    await waitSettled(win);
    await terminalItem.focus();
    await startFrames(win, { leaving: '[data-testid="new-shell-menu-leaving"]' }, 500);
    await win.keyboard.press('Escape');
    await win.keyboard.press('Enter');
    let frames = await collectFrames(win);
    let enterAt = (await keydownTimes(win)).filter((k) => k.key === 'Enter').at(-1)!.t;
    expect(frames.some((f) => f.s.leaving!.present && f.t >= enterAt), `precondition: Enter landed while the menu was leaving\n${frameLog(frames, [['leaving', 'present']])}`).toBe(true);
    await win.waitForTimeout(600);
    expect((await ipcLog(app)).filter((c) => c.ch === 'shells:launch-plain'), 'NewShellMenu: no shell launched from the leaving menu').toEqual([]);
    expect(await aliveIndices(win, 'alpha')).toEqual(alive);

    // ContextMenu (terminal menu, Paste): positive control, then Escape + Enter during the exit.
    const mark = marker('paste');
    await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), mark);
    const pastes = async () => (await ipcLog(app)).filter((c) => c.ch === 'shells:write'
      && (c.req as { projectId: number; data: string }).projectId === projectId && (c.req as { data: string }).data === mark).length;
    const pasteItem = win.getByRole('menuitem', { name: 'Paste' });
    await recordIpc(app);
    await win.locator(`${LEFT} .xterm`).click({ button: 'right' });
    await expect(win.getByTestId('context-menu')).toBeVisible();
    await pasteItem.focus();
    await win.keyboard.press('Enter');
    await expect.poll(pastes, { message: 'positive control: Enter on the open menu pastes' }).toBe(1);
    await win.waitForTimeout(400);
    expect(await pastes(), 'pastes once').toBe(1);

    await recordIpc(app);
    await win.locator(`${LEFT} .xterm`).click({ button: 'right' });
    await expect(win.getByTestId('context-menu')).toBeVisible();
    await waitSettled(win);
    await pasteItem.focus();
    await startFrames(win, { leaving: '[data-testid="context-menu-leaving"]' }, 500);
    await win.keyboard.press('Escape');
    await win.keyboard.press('Enter');
    await win.keyboard.press('Space');
    frames = await collectFrames(win);
    enterAt = (await keydownTimes(win)).filter((k) => k.key === ' ').at(-1)!.t;
    expect(frames.some((f) => f.s.leaving!.present && f.t >= enterAt), `precondition: Enter/Space landed while the menu was leaving\n${frameLog(frames, [['leaving', 'present']])}`).toBe(true);
    await win.waitForTimeout(600);
    expect(await pastes(), 'ContextMenu: no paste from the leaving menu').toBe(0);
  });
});
