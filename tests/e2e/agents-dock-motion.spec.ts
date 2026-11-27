/**
 * Agents dock slide (docs/specs/agents-dock-slide.md rev 5, AC1-AC28 + AC24a).
 *
 * Motion is observed the way motion.spec.ts observes the sidebar: by sampling the laid-out boxes every
 * animation frame (helpers/frames.ts), never by recording how an animation was requested.
 *
 * Targets (see src/renderer/agents-dock-copy.ts):
 *   fold   = the folding box, aside -> FoldPane inner -> FoldPane outer (`AGENTS_DOCK_FOLD_TARGET`)
 *   dock   = the Agents pane (the dock content)
 *   main   = the main column
 *   row    = main's parent (`workspace-row`; asserted once in the at-rest group)
 *   screen = the active project's primary terminal
 *   handle = the dock's resize handle, the aside's previous sibling (only the in-page probe reads it, since the
 *            sidebar's handle shares the `resize-handle` test id)
 *
 * Not covered here, and why (see the report): AC3's "same shared values" and AC14 are unit tests; AC18, AC20,
 * AC21 and AC22 need a remote pane or an empty selection, which no UI action in a local launch produces.
 */

import { test, expect, type Page } from '@playwright/test';
import { AGENTS_DOCK_TESTIDS, AGENTS_DOCK_FOLD_TARGET } from '../../src/renderer/agents-dock-copy';
import { launch, openProject, type Launched } from './helpers/focus';
import {
  sampleDuring, startFrames, collectFrames, contentWidth, frameLog, recordKeydowns, keydownTimes, type Frame,
} from './helpers/frames';

/* ─────────────────────────────── targets ─────────────────────────────── */

const DOCK = `[data-testid="${AGENTS_DOCK_TESTIDS.dock}"]`;
const MAIN = `[data-testid="${AGENTS_DOCK_TESTIDS.main}"]`;
const COMPOSER = '[data-testid="agent-chat-composer"] textarea';
const T = {
  fold: AGENTS_DOCK_FOLD_TARGET,
  dock: DOCK,
  main: MAIN,
  row: `${MAIN}^`,
  screen: '.split-left .xterm-screen',
};
const LOG: Array<[string, 'w' | 'present' | 'opacity' | 'x' | 'count']> = [
  ['fold', 'present'], ['fold', 'w'], ['fold', 'opacity'], ['dock', 'x'], ['dock', 'w'], ['dock', 'count'], ['main', 'x'], ['main', 'w'], ['screen', 'w'],
];
const SAMPLE_MS = 1500;
const SB_TOGGLE = 'ab-toggle-sidebar';

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
const rightOf = (f: Frame) => f.s.main!.x + f.s.main!.w;
const foldW = (f: Frame) => (f.s.fold?.present ? f.s.fold.w : 0);
/** The dock's effective opacity: the lower of the folding box's and the pane's own (the fade may sit on either). */
const dockOpacity = (f: Frame) => Math.min(f.s.fold?.present ? f.s.fold.opacity : 1, f.s.dock?.present ? f.s.dock.opacity : 1);
const screenKey = (f: Frame) => (f.s.screen?.present ? `${round(f.s.screen.w)}x${round(f.s.screen.h)}` : 'absent');
const logOf = (frames: Frame[], what: string) => `\n${what} frames:\n${frameLog(frames, LOG)}`;

function changes(frames: Frame[], value: (f: Frame) => string): number[] {
  const at: number[] = [];
  for (let i = 1; i < frames.length; i++) if (value(frames[i]!) !== value(frames[i - 1]!)) at.push(i);
  return at;
}

function firstT(frames: Frame[], pred: (f: Frame) => boolean, from = 0): number | null {
  for (let i = from; i < frames.length; i++) if (pred(frames[i]!)) return frames[i]!.t;
  return null;
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

/** Waits until the main column, the dock and the terminal have stopped changing (300ms of identical polls). */
async function settle(win: Page): Promise<void> {
  let prev = '';
  let same = 0;
  for (let i = 0; i < 80 && same < 5; i++) {
    const s = await win.evaluate(({ main, dock, screen }) => {
      const box = (sel: string) => { const r = document.querySelector(sel)?.getBoundingClientRect(); return r ? [r.x, r.y, r.width, r.height].map((n) => Math.round(n * 100)) : null; };
      return JSON.stringify([box(main), box(dock), box(screen)]);
    }, { main: MAIN, dock: DOCK, screen: T.screen });
    same = s === prev ? same + 1 : 0;
    prev = s;
    await win.waitForTimeout(60);
  }
  expect(same, 'precondition: the layout settled').toBeGreaterThanOrEqual(5);
}

const dockCount = (win: Page) => win.locator(DOCK).count();

async function openDock(win: Page): Promise<void> {
  await win.getByTestId(AGENTS_DOCK_TESTIDS.toggle).click();
  await expect(win.locator(DOCK)).toHaveCount(1);
  await settle(win);
}

async function closeDock(win: Page): Promise<void> {
  await win.getByTestId(AGENTS_DOCK_TESTIDS.close).click();
  await expect(win.locator(DOCK)).toHaveCount(0);
  await settle(win);
}

/** Puts focus on the activity bar's blank area, so a shortcut is not typed into a terminal. */
async function focusOutOfTerminal(win: Page): Promise<void> {
  await win.getByTestId('activity-bar').click({ position: { x: 20, y: 400 } });
}

/** Sets the dock open or closed with ⌘J (one step) and waits for rest. Uses the shortcut so it never slides. */
async function ensureDock(win: Page, open: boolean): Promise<void> {
  await focusOutOfTerminal(win);
  if ((await dockCount(win) === 1) !== open) await win.keyboard.press('ControlOrMeta+j');
  await expect(win.locator(DOCK)).toHaveCount(open ? 1 : 0);
  await settle(win);
}

interface Rest {
  mainRight: number;
  rowRight: number;
  rowContentW: number;
  main: { x: number; w: number };
  aside: { x: number; w: number; right: number } | null;
  handle: { x: number; w: number } | null;
  fold: { x: number; w: number } | null;
}

/** Box facts at rest. rowRight is the row's content-box right edge (border box minus right padding). */
async function rest(win: Page): Promise<Rest> {
  return win.evaluate(({ main, dock }) => {
    const m = document.querySelector(main)!;
    const mr = m.getBoundingClientRect();
    const row = m.parentElement!;
    const rr = row.getBoundingClientRect();
    const rcs = getComputedStyle(row);
    const padL = parseFloat(rcs.paddingLeft) || 0;
    const padR = parseFloat(rcs.paddingRight) || 0;
    const a = document.querySelector(dock);
    const ar = a?.getBoundingClientRect();
    const h = a?.previousElementSibling;
    const hr = h?.getBoundingClientRect();
    const f = a?.parentElement?.parentElement?.getBoundingClientRect();
    return {
      mainRight: mr.right,
      rowRight: rr.right - padR,
      rowContentW: rr.width - padL - padR,
      main: { x: mr.x, w: mr.width },
      aside: ar ? { x: ar.x, w: ar.width, right: ar.right } : null,
      handle: hr ? { x: hr.x, w: hr.width } : null,
      fold: f ? { x: f.x, w: f.width } : null,
    };
  }, { main: MAIN, dock: DOCK });
}

/** AC7-style facts: no clip-path, no transform, no inline opacity below 1 on the dock chain. */
async function chainAtRest(win: Page) {
  return win.evaluate((dock) => {
    const a = document.querySelector(dock)!;
    const chain = { dock: a, inner: a.parentElement!, fold: a.parentElement!.parentElement! };
    return Object.fromEntries(Object.entries(chain).map(([k, el]) => {
      const cs = getComputedStyle(el);
      const inline = (el as HTMLElement).style.opacity;
      return [k, { clip: cs.clipPath, transform: cs.transform, inlineOpacityBelow1: inline !== '' && parseFloat(inline) < 1 }];
    }));
  }, DOCK);
}

const CLEAN = { clip: 'none', transform: 'none', inlineOpacityBelow1: false };

/* ───────── per-frame probe: things frames.ts does not read (handle hit-tests, focus, inertness) ───────── */

interface ProbeFrame {
  t: number;
  count: number;
  foldW: number;
  activeInFold: boolean;
  /** elementFromPoint 10px inside the aside's left edge lands inside the aside; null when the aside is absent. */
  asideHit: boolean | null;
  handleW: number | null;
  handleHitL: boolean | null;
  handleHitR: boolean | null;
  handleHitMid: boolean | null;
}

async function startProbe(win: Page, ms: number): Promise<void> {
  await win.evaluate(({ ms, dock }) => {
    const w = window as unknown as { __dockProbe?: { frames: ProbeFrame[]; done: boolean; stop: boolean; mark: number } };
    if (w.__dockProbe) w.__dockProbe.stop = true;
    const run = { frames: [] as ProbeFrame[], done: false, stop: false, mark: -1 };
    w.__dockProbe = run;
    const end = performance.now() + ms;
    const tick = (ts: number) => {
      if (run.stop) { run.done = true; return; }
      const aside = document.querySelector(dock);
      const fold = aside?.parentElement?.parentElement ?? null;
      let asideHit: boolean | null = null;
      let handleW: number | null = null;
      let hl: boolean | null = null;
      let hr: boolean | null = null;
      let hm: boolean | null = null;
      if (aside) {
        const r = aside.getBoundingClientRect();
        const el = document.elementFromPoint(r.x + 10, r.y + r.height / 2);
        asideHit = !!el && aside.contains(el);
        const h = aside.previousElementSibling;
        if (h && h.getAttribute('role') === 'separator') {
          const b = h.getBoundingClientRect();
          const y = b.y + b.height / 2;
          handleW = b.width;
          hl = document.elementFromPoint(b.x + 0.5, y) === h;
          hr = document.elementFromPoint(b.x + b.width - 0.5, y) === h;
          hm = document.elementFromPoint(b.x + b.width / 2, y) === h;
        }
      }
      run.frames.push({
        t: performance.timeOrigin + ts,
        count: document.querySelectorAll(dock).length,
        foldW: fold ? fold.getBoundingClientRect().width : 0,
        activeInFold: !!fold && fold.contains(document.activeElement),
        asideHit, handleW, handleHitL: hl, handleHitR: hr, handleHitMid: hm,
      });
      if (performance.now() < end) requestAnimationFrame(tick); else run.done = true;
    };
    requestAnimationFrame(tick);
  }, { ms, dock: DOCK });
}

async function collectProbe(win: Page): Promise<{ frames: ProbeFrame[]; mark: number }> {
  await win.waitForFunction(() => (window as unknown as { __dockProbe?: { done: boolean } }).__dockProbe?.done === true, undefined, { timeout: 15000 });
  return win.evaluate(() => {
    const p = (window as unknown as { __dockProbe: { frames: unknown[]; mark: number } }).__dockProbe;
    return { frames: p.frames as never, mark: p.mark };
  });
}

/* ───────── slide assertions shared by the groups ───────── */

/**
 * AC1/AC2 (+ AC3 timings): one slide. `dir` is the direction of the dock: open grows the folding box, close shrinks it.
 * Returns the time the main column reached its end position.
 */
function assertSlide(frames: Frame[], what: string, dir: 'open' | 'close'): { tEnd: number; rStart: number; rEnd: number } {
  const log = logOf(frames, what);
  const present = frames.filter((f) => f.s.fold?.present);
  expect(present.length, `${what}: the folding box was sampled${log}`).toBeGreaterThan(4);
  const sums = present.map((f) => f.s.fold!.w + f.s.main!.w);
  const ref = median(sums);
  for (const [i, s] of sums.entries()) {
    expect(Math.abs(s - ref), `${what}: AC1 fold + main constant ±2px at frame ${i}${log}`).toBeLessThanOrEqual(2);
  }
  const rights = frames.map(rightOf);
  const rStart = rights[0]!;
  const rEnd = rights.at(-1)!;
  const total = Math.abs(rEnd - rStart);
  expect(total, `${what}: the main column travelled (positive control)${log}`).toBeGreaterThan(200);
  expect(dir === 'open' ? rEnd < rStart : rEnd > rStart, `${what}: main ${dir === 'open' ? 'narrowed' : 'widened'}${log}`).toBe(true);
  const steps = rights.slice(1).map((r, i) => Math.abs(r - rights[i]!));
  expect(Math.max(...steps), `${what}: AC1 largest one-frame move of main's right edge ≤ 25% of ${round(total)}px${log}`).toBeLessThanOrEqual(total * 0.25);
  expect(rights.filter((r) => Math.abs(r - rStart) > 1 && Math.abs(r - rEnd) > 1).length, `${what}: the slide is gradual${log}`).toBeGreaterThan(3);

  const firstMove = rights.findIndex((r) => Math.abs(r - rStart) > 0.5);
  expect(firstMove, `${what}: main moved${log}`).toBeGreaterThan(0);
  const tStart = dir === 'open' ? frames[firstMove]!.t : frames[firstMove - 1]!.t;
  const tEnd = firstT(frames, (f) => Math.abs(rightOf(f) - rEnd) <= 0.5, firstMove);
  expect(tEnd, `${what}: main reached its end position${log}`).not.toBeNull();
  const d = tEnd! - tStart;
  expect(d, `${what}: AC3 ${dir} duration${log}`).toBeLessThanOrEqual(320);
  if (dir === 'close') expect(d, `${what}: AC3 close duration ≥ 180ms${log}`).toBeGreaterThanOrEqual(180);
  return { tEnd: tEnd!, rStart, rEnd };
}

/** AC4: dock content keeps its at-rest width and its offset from the folding box's left edge on every frame it is laid out. */
function assertContentGeometry(frames: Frame[], what: string, restFrame: Frame): void {
  const log = logOf(frames, what);
  const restW = restFrame.s.dock!.w;
  const restOff = restFrame.s.dock!.x - restFrame.s.fold!.x;
  expect(restW, `${what}: at-rest dock width is positive (control)${log}`).toBeGreaterThan(200);
  let n = 0;
  for (const f of frames) {
    if (!f.s.fold?.present || !f.s.dock?.present) continue;
    n++;
    expect(Math.abs(f.s.dock.w - restW), `${what}: AC4 content width = at-rest ${round(restW)} at ${round(f.t - frames[0]!.t)}ms${log}`).toBeLessThanOrEqual(1);
    expect(Math.abs((f.s.dock.x - f.s.fold.x) - restOff), `${what}: AC4 content offset from the fold's left edge = ${round(restOff)}${log}`).toBeLessThanOrEqual(1);
  }
  expect(n, `${what}: content sampled on several frames${log}`).toBeGreaterThan(4);
}

/** AC13: the terminal's size changes at most once, and not before the slide ends. */
function assertRefit(frames: Frame[], what: string, tEnd: number): void {
  const log = logOf(frames, what);
  expect(frames.every((f) => f.s.screen?.present), `${what}: terminal present on every frame (control)${log}`).toBe(true);
  const ch = changes(frames, screenKey);
  expect(ch.length, `${what}: AC13 terminal resized at most once${log}`).toBeLessThanOrEqual(1);
  if (ch.length === 1) expect(frames[ch[0]!]!.t, `${what}: AC13 the refit comes after the slide ended${log}`).toBeGreaterThanOrEqual(tEnd);
}

/* ─────────────────────────────── groups ─────────────────────────────── */

test('AC1/AC2/AC3/AC4/AC7/AC13/AC24a: pointer open and close slide smoothly, content travels at full width, handle stays hittable, terminal refits once', async () => {
  await withApp(['alpha'], async ({ win }) => {
    // Positive control for every negative below: the dock is closed and the main column fills the row.
    expect(await dockCount(win), 'precondition: dock closed').toBe(0);
    const closedRest = await rest(win);
    expect(Math.abs(closedRest.mainRight - closedRest.rowRight), 'precondition: main fills the row when the dock is closed').toBeLessThanOrEqual(0.5);
    const screen0 = await win.locator(T.screen).evaluate((e) => e.getBoundingClientRect().width);

    // ── open (Agents button) ──
    await startProbe(win, SAMPLE_MS);
    await startFrames(win, T, SAMPLE_MS);
    await win.getByTestId(AGENTS_DOCK_TESTIDS.toggle).click();
    const open = await collectFrames(win);
    const probe = (await collectProbe(win)).frames;
    const openSlide = assertSlide(open, 'open', 'open');
    assertContentGeometry(open, 'open', open.at(-1)!);
    assertRefit(open, 'open', openSlide.tEnd);
    expect(await win.locator(T.screen).evaluate((e) => e.getBoundingClientRect().width), 'AC13 control: the terminal did refit to the narrower column')
      .toBeLessThan(screen0 - 100);
    // AC24a: during the slide-in the handle's full 4px is painted and hit-testable.
    const withHandle = probe.filter((p) => p.handleW !== null);
    const sliding = withHandle.filter((p) => p.foldW > 4 && p.foldW < open.at(-1)!.s.fold!.w - 10);
    expect(sliding.length, 'AC24a control: the handle was probed mid-slide').toBeGreaterThan(3);
    const bad = withHandle.filter((p) => p.foldW >= 4).filter((p) => Math.abs(p.handleW! - 4) > 0.5 || !(p.handleHitL && p.handleHitMid && p.handleHitR));
    expect(bad.map((p) => `fold ${round(p.foldW)}px w=${p.handleW} hit L/mid/R=${p.handleHitL}/${p.handleHitMid}/${p.handleHitR}`), 'AC24a (rev 6): every probed frame with the fold ≥ 4px wide has a 4px handle hit-testable across its full width').toEqual([]);
    expect(Math.max(...probe.map((p) => p.count)), 'at most one dock on every frame').toBeLessThanOrEqual(1);
    await settle(win);
    const chain = await chainAtRest(win);
    expect(chain, 'AC7: at rest after open, no clip-path, transform or partial inline opacity').toEqual({ dock: CLEAN, inner: CLEAN, fold: CLEAN });

    // ── close (× button) ──
    const closeFrames = await sampleDuring(win, T, SAMPLE_MS, () => win.getByTestId(AGENTS_DOCK_TESTIDS.close).click());
    const closeSlide = assertSlide(closeFrames, 'close ×', 'close');
    assertContentGeometry(closeFrames, 'close ×', closeFrames[0]!);
    assertRefit(closeFrames, 'close ×', closeSlide.tEnd);
    expect(Math.abs(closeSlide.rEnd - closedRest.mainRight), 'closed again: main right edge back where it started').toBeLessThanOrEqual(0.5);
    await expect(win.locator(DOCK)).toHaveCount(0);
    await settle(win);

    // ── close (Agents button, dock open) ──
    await openDock(win);
    const toggleClose = await sampleDuring(win, T, SAMPLE_MS, () => win.getByTestId(AGENTS_DOCK_TESTIDS.toggle).click());
    const s2 = assertSlide(toggleClose, 'close (Agents button)', 'close');
    assertRefit(toggleClose, 'close (Agents button)', s2.tEnd);
    await expect(win.locator(DOCK)).toHaveCount(0);
  });
});

test('AC5: the leaving dock is inert — nothing inside it is hit, focused or typed into from the moment the close starts', async () => {
  await withApp(['alpha'], async ({ win }) => {
    await openDock(win);
    await win.locator(COMPOSER).click();
    await expect(win.locator(COMPOSER), 'precondition: composer focused before the close').toBeFocused();

    await startProbe(win, SAMPLE_MS);
    await win.waitForTimeout(100);
    // Click × inside the page so the probe's mark lands in the same task as the click.
    await win.evaluate((sel) => {
      (document.querySelector(sel) as HTMLElement).click();
      const p = (window as unknown as { __dockProbe: { frames: unknown[]; mark: number } }).__dockProbe;
      p.mark = p.frames.length;
    }, `[data-testid="${AGENTS_DOCK_TESTIDS.close}"]`);
    // A real mouse click on the leaving pane, aimed where the composer was.
    await win.mouse.click(await win.evaluate(() => window.innerWidth - 120), await win.evaluate(() => window.innerHeight - 90));
    const { frames, mark } = await collectProbe(win);
    expect(mark, 'the close was marked').toBeGreaterThan(1);
    const before = frames.slice(0, mark);
    expect(before.some((p) => p.activeInFold), 'control: focus was inside the dock before the close').toBe(true);
    expect(before.every((p) => p.asideHit === true), 'control: the dock is hit-testable before the close').toBe(true);
    expect(before.every((p) => p.handleHitMid === true), 'control: the handle is hit-testable before the close').toBe(true);

    const leaving = frames.slice(mark).filter((p) => p.count > 0 && p.foldW > 0);
    expect(leaving.length, 'the dock stayed on screen for several frames while leaving (exit animation)').toBeGreaterThan(3);
    expect(leaving.some((p) => p.foldW > 40), 'control: the leaving dock was wide enough to probe').toBe(true);
    for (const p of leaving) {
      expect(p.activeInFold, `AC5: no element inside the leaving dock has focus (fold ${p.foldW}px)`).toBe(false);
      if (p.foldW > 40) expect(p.asideHit, `AC5: a point inside the leaving dock hits nothing in it (fold ${p.foldW}px)`).toBe(false);
      if (p.handleW !== null) expect(p.handleHitMid, `AC5: the leaving handle is inert (fold ${p.foldW}px)`).toBe(false);
    }
    await expect(win.locator(DOCK)).toHaveCount(0);

    // Control after the exit: at rest the same dock takes focus again.
    await openDock(win);
    await win.locator(COMPOSER).click();
    await expect(win.locator(COMPOSER), 'control: a reopened dock is interactive again').toBeFocused();
  });
});

test('AC6: two pointer toggles within one slide reverse it — one dock at a time, ends in the last state at full width', async () => {
  await withApp(['alpha'], async ({ win }) => {
    await settle(win);
    const closedRest = await rest(win);
    await openDock(win);
    const openRest = await rest(win);
    await closeDock(win);
    expect(Math.abs((await rest(win)).mainRight - closedRest.mainRight), 'control: closed rest is reproducible').toBeLessThanOrEqual(0.5);

    // closed -> click open -> click again mid-slide -> closed
    await startFrames(win, T, 2000);
    await win.getByTestId(AGENTS_DOCK_TESTIDS.toggle).click();
    await win.waitForTimeout(90);
    await win.getByTestId(AGENTS_DOCK_TESTIDS.toggle).click();
    let fr = await collectFrames(win);
    let log = logOf(fr, 'reverse during open');
    expect(Math.max(...fr.map((f) => f.s.dock!.count)), `AC6: never two docks${log}`).toBeLessThanOrEqual(1);
    expect(fr.some((f) => rightOf(f) < closedRest.mainRight - 5 && rightOf(f) > openRest.mainRight + 5), `precondition: the second click landed mid-slide${log}`).toBe(true);
    await expect(win.locator(DOCK)).toHaveCount(0);
    await settle(win);
    expect(Math.abs((await rest(win)).mainRight - closedRest.mainRight), `AC6: ends closed, main back at full width${log}`).toBeLessThanOrEqual(0.5);

    // open -> click close -> click again mid-slide -> open at full width
    await openDock(win);
    await startFrames(win, T, 2000);
    await win.getByTestId(AGENTS_DOCK_TESTIDS.toggle).click();
    await win.waitForTimeout(90);
    await win.getByTestId(AGENTS_DOCK_TESTIDS.toggle).click();
    fr = await collectFrames(win);
    log = logOf(fr, 'reverse during close');
    expect(Math.max(...fr.map((f) => f.s.dock!.count)), `AC6: never two docks${log}`).toBeLessThanOrEqual(1);
    expect(fr.some((f) => rightOf(f) > openRest.mainRight + 5 && rightOf(f) < closedRest.mainRight - 5), `precondition: the second click landed mid-slide${log}`).toBe(true);
    await expect(win.locator(DOCK)).toHaveCount(1);
    await settle(win);
    const end = await rest(win);
    expect(Math.abs(end.mainRight - openRest.mainRight), `AC6: ends open, main at its open position${log}`).toBeLessThanOrEqual(0.5);
    expect(Math.abs(end.aside!.w - openRest.aside!.w), `AC6: the dock is at full width${log}`).toBeLessThanOrEqual(0.5);
    expect(await chainAtRest(win), 'AC7: clean at rest after a reversal').toEqual({ dock: CLEAN, inner: CLEAN, fold: CLEAN });
  });
});

test('AC8: a pointer open does not move focus (keyboard activation of the Agents button, and a mouse click)', async () => {
  await withApp(['alpha'], async ({ win }) => {
    const toggle = win.getByTestId(AGENTS_DOCK_TESTIDS.toggle);
    // Keyboard activation counts as a pointer toggle. Focus the button, press Enter: the button must still have focus after the slide.
    await toggle.focus();
    await expect(toggle, 'precondition: the button has focus').toBeFocused();
    await win.keyboard.press('Enter');
    await expect(win.locator(DOCK)).toHaveCount(1);
    await settle(win);
    await expect(toggle, 'AC8: focus did not move to the dock').toBeFocused();
    expect(await win.evaluate((d) => document.querySelector(d)!.contains(document.activeElement), DOCK), 'AC8: focus is not inside the dock').toBe(false);
    // Keyboard close through ×: focus goes to the page body, not back into a dock that is gone.
    await closeDock(win);

    // Mouse: whatever has focus once the click has landed keeps it through the slide.
    await toggle.click();
    await win.evaluate(() => { (window as unknown as { __ae: Element | null }).__ae = document.activeElement; });
    await expect(win.locator(DOCK)).toHaveCount(1);
    await settle(win);
    expect(await win.evaluate(() => document.activeElement === (window as unknown as { __ae: Element | null }).__ae), 'AC8: the slide did not move focus').toBe(true);
    expect(await win.evaluate((d) => document.querySelector(d)!.contains(document.activeElement), DOCK), 'AC8: focus is not inside the dock').toBe(false);
  });
});

test('AC9/AC10: ⌘J and ⇧⌘A open and close the dock in one step; ⇧⌘A focuses the composer', async () => {
  await withApp(['alpha'], async ({ win }) => {
    await focusOutOfTerminal(win);
    await recordKeydowns(win);

    const instant = async (what: string, act: () => Promise<void>, key: string) => {
      const frames = await sampleDuring(win, T, 600, act);
      const log = logOf(frames, what);
      const xs = [...new Set(frames.map((f) => round(rightOf(f))))];
      expect(xs.length, `${what}: AC9 main's right edge takes exactly two positions${log}`).toBe(2);
      const pressed = (await keydownTimes(win)).filter((k) => k.key.toLowerCase() === key).at(-1)!.t;
      const after = frames.filter((f) => f.t > pressed);
      const flip = after.findIndex((f) => round(rightOf(f)) !== round(rightOf(frames[0]!)));
      expect(flip, `${what}: AC9 layout changes within 2 frames of the keydown${log}`).toBeGreaterThanOrEqual(0);
      expect(flip, `${what}: AC9 layout changes within 2 frames of the keydown${log}`).toBeLessThanOrEqual(1);
      expect(frames.every((f) => dockOpacity(f) >= 0.999), `${what}: no fade${log}`).toBe(true);
    };

    await instant('⌘J open', () => win.keyboard.press('ControlOrMeta+j'), 'j');
    await expect(win.locator(DOCK)).toHaveCount(1);
    await instant('⌘J close', () => win.keyboard.press('ControlOrMeta+j'), 'j');
    await expect(win.locator(DOCK)).toHaveCount(0);
    await instant('⇧⌘A open', () => win.keyboard.press('ControlOrMeta+Shift+a'), 'a');
    await expect(win.locator(DOCK)).toHaveCount(1);
    await expect(win.locator(COMPOSER), 'AC10: focus is in the composer once the dock is open').toBeFocused();
    await settle(win);
    expect(await win.locator(COMPOSER).evaluate((e) => document.activeElement === e), 'AC10: still focused at rest').toBe(true);
  });
});

test('AC11: a shortcut during a pointer slide ends it in the shortcut\'s end state in one step', async () => {
  await withApp(['alpha'], async ({ win }) => {
    await focusOutOfTerminal(win);
    await recordKeydowns(win);
    await ensureDock(win, false);
    const rClosed = (await rest(win)).mainRight;
    await ensureDock(win, true);
    const rOpen = (await rest(win)).mainRight;

    const cases = [
      { name: 'pointer open, then ⌘J', from: false, chord: 'ControlOrMeta+j', key: 'j', endOpen: false },
      { name: 'pointer close, then ⌘J', from: true, chord: 'ControlOrMeta+j', key: 'j', endOpen: true },
      { name: 'pointer open, then ⇧⌘A', from: false, chord: 'ControlOrMeta+Shift+a', key: 'a', endOpen: true },
      { name: 'pointer close, then ⇧⌘A', from: true, chord: 'ControlOrMeta+Shift+a', key: 'a', endOpen: true },
    ];
    for (const c of cases) {
      await ensureDock(win, c.from);
      await startFrames(win, T, 1500);
      await win.getByTestId(AGENTS_DOCK_TESTIDS.toggle).click();
      await win.waitForTimeout(90);
      await win.keyboard.press(c.chord);
      const frames = await collectFrames(win);
      const log = logOf(frames, c.name);
      const pressed = (await keydownTimes(win)).filter((k) => k.key.toLowerCase() === c.key).at(-1)!.t;
      const rEnd = c.endOpen ? rOpen : rClosed;
      const pre = [...frames].reverse().find((f) => f.t <= pressed)!;
      expect(rightOf(pre) > Math.min(rOpen, rClosed) + 5 && rightOf(pre) < Math.max(rOpen, rClosed) - 5, `${c.name}: precondition: the shortcut landed mid-slide${log}`).toBe(true);
      const after = frames.filter((f) => f.t > pressed);
      expect(after.length, `${c.name}: frames after the keydown${log}`).toBeGreaterThan(4);
      expect(after.slice(2).every((f) => Math.abs(rightOf(f) - rEnd) <= 0.5), `${c.name}: AC11 one step to the end state within 2 frames${log}`).toBe(true);
      expect(Math.max(...frames.map((f) => f.s.dock!.count)), `${c.name}: AC11 at most one dock${log}`).toBeLessThanOrEqual(1);
      await expect(win.locator(DOCK)).toHaveCount(c.endOpen ? 1 : 0);
      await settle(win);
      expect(Math.abs((await rest(win)).mainRight - rEnd), `${c.name}: ends at rest in the end state${log}`).toBeLessThanOrEqual(0.5);
      if (c.key === 'a') await expect(win.locator(COMPOSER), `${c.name}: AC11 composer focused`).toBeFocused();
    }
  });
});

test('AC12/AC13: reduced motion — pointer open fades after one layout step, pointer close fades then one layout step, shortcuts stay one step', async () => {
  await withApp(['alpha'], async ({ win }) => {
    await win.emulateMedia({ reducedMotion: 'reduce' });
    expect(await win.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), 'precondition: reduced motion is on').toBe(true);
    const noTransform = (fr: Frame[], what: string, log: string) => {
      for (const f of fr) {
        for (const k of ['fold', 'dock', 'main'] as const) {
          if (f.s[k]?.present) expect(f.s[k]!.transform, `${what}: AC12 no transform on ${k}${log}`).toBe('none');
        }
      }
    };

    // open
    const open = await sampleDuring(win, T, SAMPLE_MS, () => win.getByTestId(AGENTS_DOCK_TESTIDS.toggle).click());
    let log = logOf(open, 'reduced open');
    noTransform(open, 'open', log);
    const present = open.filter((f) => f.s.fold?.present);
    expect(present.length, `open: fold sampled${log}`).toBeGreaterThan(3);
    const finalW = present.at(-1)!.s.fold!.w;
    expect(finalW, `open: control: the folding box has a real width${log}`).toBeGreaterThan(200);
    expect(present.every((f) => Math.abs(f.s.fold!.w - finalW) <= 1), `AC12: layout is in its end state from the dock's first frame${log}`).toBe(true);
    expect([...new Set(open.map((f) => round(rightOf(f))))].length, `AC12: main takes exactly two positions${log}`).toBe(2);
    expect(dockOpacity(present[0]!), `AC12: the dock starts transparent${log}`).toBeLessThan(0.5);
    const opaque = firstT(open, (f) => !!f.s.fold?.present && dockOpacity(f) >= 0.999)!;
    expect(opaque - present[0]!.t, `AC12: open fade ≥ 150ms${log}`).toBeGreaterThanOrEqual(150);
    expect(changes(open, screenKey).length, `AC13 under reduced motion: terminal resized at most once${log}`).toBeLessThanOrEqual(1);
    await settle(win);
    expect(await chainAtRest(win), 'AC7 under reduced motion: clean at rest').toEqual({ dock: CLEAN, inner: CLEAN, fold: CLEAN });

    // close
    const close = await sampleDuring(win, T, SAMPLE_MS, () => win.getByTestId(AGENTS_DOCK_TESTIDS.close).click());
    log = logOf(close, 'reduced close');
    noTransform(close, 'close', log);
    const startW = close[0]!.s.fold!.w;
    const fading = close.filter((f) => f.s.fold?.present && dockOpacity(f) < 0.999 && dockOpacity(f) > 0.001);
    expect(fading.length, `AC12: close fades${log}`).toBeGreaterThan(3);
    expect(fading.every((f) => Math.abs(f.s.fold!.w - startW) <= 1), `AC12: the dock fades at full size${log}`).toBe(true);
    const fadeStart = [...close].reverse().find((f) => f.s.fold?.present && dockOpacity(f) >= 0.999 && f.t < fading[0]!.t)?.t ?? close[0]!.t;
    const fadeEnd = firstT(close, (f) => !f.s.fold?.present || dockOpacity(f) <= 0.001 || f.s.fold.w <= 0.5)!;
    expect(fadeEnd - fadeStart, `AC12: close fade ≥ 150ms${log}`).toBeGreaterThanOrEqual(150);
    expect([...new Set(close.map((f) => round(rightOf(f))))].length, `AC12: main takes exactly two positions${log}`).toBe(2);
    const moveAt = close.findIndex((f) => Math.abs(rightOf(f) - rightOf(close[0]!)) > 0.5);
    expect(close[moveAt]!.t, `AC12: the layout step comes after the fade${log}`).toBeGreaterThanOrEqual(fadeEnd);
    expect(changes(close, screenKey).length, `AC13 under reduced motion: terminal resized at most once${log}`).toBeLessThanOrEqual(1);
    await expect(win.locator(DOCK)).toHaveCount(0);
    await settle(win);

    // shortcuts: one step, no fade
    await focusOutOfTerminal(win);
    for (const what of ['⌘J open', '⌘J close']) {
      const fr = await sampleDuring(win, T, 800, () => win.keyboard.press('ControlOrMeta+j'));
      const l = logOf(fr, `reduced ${what}`);
      expect([...new Set(fr.map((f) => round(rightOf(f))))].length, `AC12: ${what} takes two positions${l}`).toBe(2);
      expect(fr.every((f) => dockOpacity(f) >= 0.999), `AC12: ${what} has no fade${l}`).toBe(true);
      noTransform(fr, what, l);
      await settle(win);
    }
  });
});

test('AC15: sidebar and dock sliding at once resize the terminal at most once, after the later slide', async () => {
  await withApp(['alpha'], async ({ win }) => {
    await startFrames(win, T, 2500);
    await win.getByTestId(AGENTS_DOCK_TESTIDS.toggle).click();
    await win.waitForTimeout(80);
    await win.getByTestId(SB_TOGGLE).click();
    const frames = await collectFrames(win);
    const log = logOf(frames, 'dock + sidebar');
    const x0 = frames[0]!.s.main!.x;
    const xMove = frames.findIndex((f) => Math.abs(f.s.main!.x - x0) > 0.5);
    expect(xMove, `the sidebar moved main${log}`).toBeGreaterThan(0);
    const fw = foldW(frames[xMove]!);
    const full = foldW(frames.at(-1)!);
    expect(fw > 2 && fw < full - 2, `precondition: the sidebar toggle landed mid dock-slide (fold ${fw}/${full})${log}`).toBe(true);
    let last = 0;
    for (let i = 1; i < frames.length; i++) {
      if (Math.abs(frames[i]!.s.main!.x - frames[i - 1]!.s.main!.x) > 0.5 || Math.abs(rightOf(frames[i]!) - rightOf(frames[i - 1]!)) > 0.5) last = i;
    }
    const tEnd = frames[last]!.t;
    expect(Math.max(...frames.map((f) => f.s.dock!.count)), `one dock${log}`).toBeLessThanOrEqual(1);
    assertRefit(frames, 'dock + sidebar', tEnd);
    expect(changes(frames, screenKey).length, `AC15 control: the terminal did refit (the layout changed)${log}`).toBe(1);
    await settle(win);
  });
});

test('AC19: switching to another local project keeps the same dock mounted, with no slide or fade', async () => {
  await withApp(['alpha', 'beta'], async ({ win }) => {
    await openDock(win);
    await win.locator(DOCK).evaluate((el) => { (el as unknown as { __e2eMark: boolean }).__e2eMark = true; });
    const before = await rest(win);
    const frames = await sampleDuring(win, T, 1200, () => openProject(win, 'beta'));
    const log = logOf(frames, 'project switch');
    expect(await win.title(), 'control: the selection really changed').toBe('beta — MetaLogix IDE');
    expect(await win.locator(DOCK).evaluate((el) => (el as unknown as { __e2eMark?: boolean }).__e2eMark === true), `AC19: the Agents pane element is not replaced${log}`).toBe(true);
    expect(frames.every((f) => f.s.dock!.count === 1), `AC19: the dock was present on every frame${log}`).toBe(true);
    expect(frames.every((f) => Math.abs(f.s.fold!.w - before.fold!.w) <= 1), `AC19: no slide (folding box width constant)${log}`).toBe(true);
    expect(frames.every((f) => dockOpacity(f) >= 0.999), `AC19: no fade${log}`).toBe(true);
    expect(Math.abs((await rest(win)).mainRight - before.mainRight), `AC19: layout unchanged${log}`).toBeLessThanOrEqual(0.5);
  });
});

test('AC23/AC24/AC26: at rest the dock sits exactly where it did, the handle keeps its 4px grab area, dragging and double-click reset work without a slide', async () => {
  await withApp(['alpha'], async ({ win }) => {
    // The row is the main column's parent and carries the workspace-row test id.
    expect(await win.evaluate((m) => document.querySelector(m)!.parentElement!.getAttribute('data-testid'), MAIN), 'the main column sits in workspace-row').toBe(AGENTS_DOCK_TESTIDS.row);

    // closed
    const closed = await rest(win);
    expect(Math.abs(closed.mainRight - closed.rowRight), 'AC23: closed, main right = row content right').toBeLessThanOrEqual(0.5);
    expect(closed.aside, 'control: no dock while closed').toBeNull();
    expect(await win.evaluate(() => localStorage.getItem('metaide.agentsDockOpen')), 'AC24: dock setting not persisted open').not.toBe('true');

    // open
    await openDock(win);
    const o = await rest(win);
    expect(await win.evaluate(() => Number(localStorage.getItem('metaide.agentsDockWidth') ?? 340)), 'AC24: default persisted width 340').toBe(340);
    expect(Math.abs(o.aside!.w - expectedAside(o.rowContentW, 340)), `AC24: default width 340 (shrunk by the window if S=${o.rowContentW} is narrow)`).toBeLessThanOrEqual(0.5);
    expect(Math.abs(o.aside!.x - o.mainRight), 'AC23: aside.left = main.right').toBeLessThanOrEqual(0.5);
    expect(Math.abs(o.aside!.right + 8 - o.rowRight), 'AC23: aside.right + 8px margin = row content right').toBeLessThanOrEqual(0.5);
    expect(Math.abs(o.handle!.w - 4), 'AC23: handle is 4px').toBeLessThanOrEqual(0.5);
    expect(Math.abs(o.handle!.x - (o.mainRight - 2)), 'AC23: handle centred on the boundary').toBeLessThanOrEqual(0.5);
    expect(Math.abs(o.mainRight - (closed.mainRight - (o.aside!.w + MARGIN))), 'AC23: main gave up exactly the dock (aside + 8px margin)').toBeLessThanOrEqual(0.5);
    expect(await win.evaluate(() => localStorage.getItem('metaide.agentsDockOpen')), 'AC24: dock setting persisted open').toBe('true');
    expect(await win.locator(DOCK).getAttribute('aria-label'), 'AC26: pane label').toBe('Agents');
    expect(await win.getByTestId(AGENTS_DOCK_TESTIDS.close).getAttribute('aria-label'), 'AC26: close label').toBe('Close Agents pane');

    // handle grab area and hover
    const cy = await win.evaluate((d) => { const r = document.querySelector(d)!.previousElementSibling!.getBoundingClientRect(); return r.y + r.height / 2; }, DOCK);
    const hitId = (x: number) => win.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.getAttribute('data-testid') ?? null, { x, y: cy });
    for (const dx of [-1.9, -1, 1, 1.9]) expect(await hitId(o.mainRight + dx), `AC23: the handle is hit at main.right${dx > 0 ? '+' : ''}${dx}`).toBe('resize-handle');
    expect(await hitId(o.mainRight - 6), 'AC23 control: 6px into the main column is not the handle').not.toBe('resize-handle');
    const bg = () => win.evaluate((d) => getComputedStyle(document.querySelector(d)!.previousElementSibling!).backgroundColor, DOCK);
    await win.mouse.move(o.mainRight - 40, cy);
    await expect.poll(bg, { message: 'AC23 control: handle is transparent when not hovered' }).toBe('rgba(0, 0, 0, 0)');
    for (const dx of [-1.5, 1.5]) {
      await win.mouse.move(o.mainRight + dx, cy);
      await expect.poll(bg, { message: `AC23: the hover highlight shows at main.right${dx > 0 ? '+' : ''}${dx}` }).not.toBe('rgba(0, 0, 0, 0)');
      await win.mouse.move(o.mainRight - 40, cy);
      await expect.poll(bg).toBe('rgba(0, 0, 0, 0)');
    }

    // drag from the half that overhangs the main column; one pointermove -> no intermediate widths, no folding box animation
    const widthNow = async () => (await rest(win)).aside!.w;
    const persisted = () => win.evaluate(() => Number(localStorage.getItem('metaide.agentsDockWidth')));
    await startFrames(win, T, 1200);
    await win.mouse.move(o.mainRight - 1.5, cy);
    await win.mouse.down();
    await win.mouse.move(o.mainRight - 1.5 + 50, cy, { steps: 1 });
    await win.mouse.up();
    const drag = await collectFrames(win);
    const dl = logOf(drag, 'drag');
    expect(Math.abs((await widthNow()) - expectedAside(o.rowContentW, 290)), `AC24: dragging 50px right shrinks the dock to 290 (a shrink always shows, even in a narrow window)${dl}`).toBeLessThanOrEqual(1);
    expect(await persisted(), 'AC24: the width persists').toBeCloseTo(290, 0);
    expect([...new Set(drag.map((f) => round(rightOf(f))))].length, `AC24: a drag is a single layout step, not a slide${dl}`).toBe(2);
    expect(drag.every((f) => f.s.dock!.count === 1 && dockOpacity(f) >= 0.999), `AC24: the dock never faded or left during the drag${dl}`).toBe(true);
    expect(changes(drag, screenKey).length, `AC24 control: the terminal refit while dragging (no hold)${dl}`).toBeGreaterThanOrEqual(1);
    await settle(win);

    // clamps: 260..640
    const boundary = async () => (await rest(win)).mainRight;
    let b = await boundary();
    await win.mouse.move(b - 1.5, cy);
    await win.mouse.down();
    await win.mouse.move(5, cy, { steps: 4 });
    await win.mouse.up();
    await settle(win);
    expect(await persisted(), 'AC24: max 640 persisted').toBeCloseTo(640, 0);
    expect(Math.abs((await widthNow()) - expectedAside(o.rowContentW, 640)), 'AC24: max 640 (as far as the window allows)').toBeLessThanOrEqual(1);
    b = await boundary();
    await win.mouse.move(b - 1.5, cy);
    await win.mouse.down();
    await win.mouse.move(b - 1.5 + 450, cy, { steps: 4 });
    await win.mouse.up();
    await settle(win);
    expect(await persisted(), 'AC24: min 260 persisted').toBeCloseTo(260, 0);
    expect(Math.abs((await widthNow()) - expectedAside(o.rowContentW, 260)), 'AC24: min 260').toBeLessThanOrEqual(1);

    // double-click reset, still no slide
    b = await boundary();
    await startFrames(win, T, 1000);
    await win.mouse.dblclick(b + 1.5, cy);
    const reset = await collectFrames(win);
    expect(Math.abs((await widthNow()) - expectedAside(o.rowContentW, 340)), 'AC24: double-click resets to 340').toBeLessThanOrEqual(1);
    expect(reset.every((f) => f.s.dock!.count === 1), `AC24: no dock churn on reset${logOf(reset, 'reset')}`).toBe(true);
    expect(await persisted(), 'AC24: reset width persisted').toBeCloseTo(340, 0);

    // closing persists the setting
    await closeDock(win);
    expect(await win.evaluate(() => localStorage.getItem('metaide.agentsDockOpen')), 'AC24: dock setting persisted closed').toBe('false');
    const again = await rest(win);
    expect(Math.abs(again.mainRight - closed.mainRight), 'AC23: closed again, main right where it started').toBeLessThanOrEqual(0.5);
  });
});

/* ───────── narrow window (AC28) ───────── */

const MAIN_MIN = 360;
const DOCK_MIN = 240;
const MARGIN = 8;
const expectedAside = (s: number, w: number) => Math.min(w, Math.max(DOCK_MIN, s - MAIN_MIN - MARGIN));

/** Resizes the window until the row's content width is `target` (±1). BrowserWindow minWidth is 1024. */
async function setRowWidth(win: Page, app: Launched['app'], target: number): Promise<number> {
  let s = (await rest(win)).rowContentW;
  for (let i = 0; i < 4 && Math.abs(s - target) > 1; i++) {
    await app.evaluate(({ BrowserWindow }, d) => {
      const w = BrowserWindow.getAllWindows()[0]!;
      const [cw, ch] = w.getSize();
      w.setSize(Math.round(cw! + d), ch!);
    }, target - s);
    await win.waitForTimeout(350);
    await settle(win);
    s = (await rest(win)).rowContentW;
  }
  return s;
}

test('AC28: in a window too narrow for 360 + the dock, the pane shrinks at rest and during slides, main keeps ≥ 360px', async () => {
  await withApp(['alpha'], async ({ win, app }) => {
    // Make the dock 640 wide so a window above the 1024px minimum is narrow enough for the shrink to apply.
    await openDock(win);
    const o = await rest(win);
    const cy = await win.evaluate((d) => { const r = document.querySelector(d)!.previousElementSibling!.getBoundingClientRect(); return r.y + r.height / 2; }, DOCK);
    await win.mouse.move(o.mainRight - 1.5, cy);
    await win.mouse.down();
    await win.mouse.move(5, cy, { steps: 4 });
    await win.mouse.up();
    await settle(win);
    const W = await win.evaluate(() => Number(localStorage.getItem('metaide.agentsDockWidth')));
    expect(W, 'precondition: persisted dock width 640').toBe(640);
    await closeDock(win);

    const target = 760; // between 608 (360 + 240 + 8) and 1008 (360 + 640 + 8)
    const S = await setRowWidth(win, app, target);
    // A tiling window manager may refuse setSize (observed: stuck at 1024px, S=684); any S in the shrink range works.
    expect(S >= 608 && S < MAIN_MIN + W + MARGIN, `precondition: row content width ${S} is in [608, ${MAIN_MIN + W + MARGIN}) so the shrink applies (target was ${target})`).toBe(true);
    const closedRest = await rest(win);
    expect(Math.abs(closedRest.mainRight - closedRest.rowRight), 'control: closed, main fills the row').toBeLessThanOrEqual(0.5);

    // slide in: AC1's per-frame rules, ends at the shrunk width with no jump
    await startProbe(win, SAMPLE_MS);
    const open = await sampleDuring(win, T, SAMPLE_MS, () => win.getByTestId(AGENTS_DOCK_TESTIDS.toggle).click());
    const openLog = logOf(open, 'narrow open');
    assertSlide(open, 'narrow open', 'open');
    await settle(win);
    const r = await rest(win);
    const wantAside = expectedAside(S, W);
    expect(wantAside, 'control: the shrink applies in this window').toBeLessThan(W - 50);
    expect(Math.abs(r.aside!.w - wantAside), `AC28: aside = min(W, max(240, S-368)) = ${wantAside}${openLog}`).toBeLessThanOrEqual(0.5);
    expect(r.aside!.w, 'AC28: aside ≥ 240').toBeGreaterThanOrEqual(DOCK_MIN);
    expect(r.main.w, 'AC28: main ≥ 360').toBeGreaterThanOrEqual(MAIN_MIN - 0.5);
    expect(Math.abs(r.aside!.x - r.mainRight), 'AC28: aside.left = main.right').toBeLessThanOrEqual(0.5);
    expect(Math.abs(r.aside!.right + MARGIN - r.rowRight), 'AC28: 8px margin at the row edge').toBeLessThanOrEqual(0.5);
    expect(Math.abs(r.handle!.w - 4) <= 0.5 && Math.abs(r.handle!.x - (r.mainRight - 2)) <= 0.5, 'AC28: handle box 4px centred on the boundary').toBe(true);
    const finalFold = r.fold!.w;
    const folds = open.filter((f) => f.s.fold?.present).map((f) => f.s.fold!.w);
    expect(Math.max(...folds), `AC28: no frame exceeds the at-rest folding width ${round(finalFold)}${openLog}`).toBeLessThanOrEqual(finalFold + 0.5);
    expect(Math.abs(open.at(-1)!.s.fold!.w - finalFold), `AC28: the last sampled frame is at the at-rest width (no jump after the slide)${openLog}`).toBeLessThanOrEqual(0.5);
    expect(open.slice(-5).every((f) => Math.abs(f.s.fold!.w - finalFold) <= 0.5), `AC28: stable after the slide${openLog}`).toBe(true);
    expect(open.every((f) => !f.s.dock?.present || f.s.main!.w >= MAIN_MIN - 0.5), `AC28: main ≥ 360 on every frame${openLog}`).toBe(true);
    const narrowProbe = (await collectProbe(win)).frames.filter((p) => p.handleW !== null);
    expect(narrowProbe.filter((p) => p.foldW >= 4).filter((p) => !(p.handleHitL && p.handleHitMid && p.handleHitR)).map((p) => `fold ${round(p.foldW)}px`), 'AC24a in the narrow window: handle hit-testable on every frame').toEqual([]);

    // slide out
    const close = await sampleDuring(win, T, SAMPLE_MS, () => win.getByTestId(AGENTS_DOCK_TESTIDS.close).click());
    assertSlide(close, 'narrow close', 'close');
    await expect(win.locator(DOCK)).toHaveCount(0);
    await settle(win);
    expect(Math.abs((await rest(win)).mainRight - closedRest.mainRight), 'AC28: closed again, main right where it started').toBeLessThanOrEqual(0.5);

    // sidebar toggled with the dock open: the aside follows the formula on every frame
    await openDock(win);
    const sb = await sampleDuring(win, T, SAMPLE_MS, () => win.getByTestId(SB_TOGGLE).click());
    const sbLog = logOf(sb, 'narrow + sidebar');
    const asides: number[] = [];
    for (const f of sb) {
      const s = contentWidth(f.s.row!);
      asides.push(f.s.dock!.w);
      expect(Math.abs(f.s.dock!.w - expectedAside(s, W)), `AC28: aside follows the formula against this frame's S=${round(s)}${sbLog}`).toBeLessThanOrEqual(1);
      expect(f.s.main!.w, `AC28: main ≥ 360 while the sidebar folds${sbLog}`).toBeGreaterThanOrEqual(MAIN_MIN - 1);
    }
    expect(Math.max(...asides) - Math.min(...asides), `AC28 control: the aside's width really moved during the sidebar fold${sbLog}`).toBeGreaterThan(50);
  });
});

/* ───────── optional, best effort ───────── */

/** Installed before the reload: records, on the first mutation that inserts the Agents pane, the fold's width and opacity, then ten frames of the same. */
const FIRST_FRAME_SCRIPT = `
(() => {
  const SEL = '[data-testid="agents-dock"]';
  const w = window;
  w.__dockFirst = { at: null, later: [], done: false };
  const read = () => {
    const a = document.querySelector(SEL);
    if (!a) return null;
    const f = a.parentElement && a.parentElement.parentElement;
    return { foldW: f.getBoundingClientRect().width, asideW: a.getBoundingClientRect().width,
      op: Math.min(parseFloat(getComputedStyle(f).opacity), parseFloat(getComputedStyle(a).opacity)),
      tf: getComputedStyle(f).transform + '|' + getComputedStyle(a).transform };
  };
  const obs = new MutationObserver(() => {
    if (w.__dockFirst.at || !document.querySelector(SEL)) return;
    w.__dockFirst.at = read();
    obs.disconnect();
    let n = 0;
    const tick = () => { const r = read(); if (r) w.__dockFirst.later.push(r); if (++n < 10) requestAnimationFrame(tick); else w.__dockFirst.done = true; };
    requestAnimationFrame(tick);
  });
  obs.observe(document, { childList: true, subtree: true });
})();
`;

for (const c of [
  { ac: 'AC17', what: 'the dock setting was left open', prepare: async (win: Page) => { await openDock(win); } },
  {
    ac: 'AC16',
    what: 'the start-up migration flips an old saved Agents view to an open dock',
    prepare: async (win: Page) => {
      await win.evaluate(() => { localStorage.setItem('metaide.activeView', JSON.stringify('agents')); localStorage.setItem('metaide.agentsDockOpen', 'false'); });
    },
  },
]) {
  test(`${c.ac} (best effort): on start, ${c.what}, so the first frame with the dock shows it fully open and opaque`, async () => {
    await withApp(['alpha'], async ({ win }) => {
      await c.prepare(win);
      await win.addInitScript(FIRST_FRAME_SCRIPT);
      await win.reload();
      await win.waitForLoadState('domcontentloaded');
      // If the selected project is not restored by the reload, pick it: that is a context change too (AC20), also one step.
      try { await expect(win.locator(DOCK)).toHaveCount(1, { timeout: 8000 }); test.info().annotations.push({ type: 'path', description: 'selection restored by the reload' }); } catch { test.info().annotations.push({ type: 'path', description: 'fallback: clicked alpha' }); await openProject(win, 'alpha'); }
      await expect(win.locator(DOCK)).toHaveCount(1);
      await win.waitForFunction(() => (window as unknown as { __dockFirst: { done: boolean } }).__dockFirst.done === true, undefined, { timeout: 5000 });
      const rec = await win.evaluate(() => (window as unknown as { __dockFirst: { at: { foldW: number; asideW: number; op: number; tf: string } | null; later: Array<{ foldW: number; op: number; tf: string }> } }).__dockFirst);
      await settle(win);
      const full = (await rest(win)).fold!.w;
      const log = `\nrecord: ${JSON.stringify(rec)}\nat rest fold ${full}`;
      expect(rec.at, `${c.ac}: the pane was recorded on insertion${log}`).not.toBeNull();
      expect(Math.abs(rec.at!.foldW - full), `${c.ac}: the folding box is at full width on the first frame the pane exists${log}`).toBeLessThanOrEqual(1);
      expect(rec.at!.op, `${c.ac}: the dock is opaque on that frame${log}`).toBeGreaterThanOrEqual(0.999);
      expect(rec.later.length, `${c.ac}: control: later frames recorded${log}`).toBeGreaterThan(5);
      expect(rec.later.every((l) => Math.abs(l.foldW - full) <= 1 && l.op >= 0.999 && l.tf === 'none|none'), `${c.ac}: no slide, fade or transform followed${log}`).toBe(true);
    });
  });
}
