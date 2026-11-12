/**
 * Keep-awake timer: docs/specs/keep-awake-timer.md AC1-AC6, AC8-AC12, AC14, AC15, AC17.
 * Plan: docs/plan/keep-awake-timer.md §8 "Agent 3". Not covered here: AC7 / AC12a (manual, real
 * display), AC13 (unit: wall-clock jump), AC16 (non-darwin: unit tests only, no mac E2E exists),
 * and the "Keep awake ended" OS notification (not observable in E2E; state is asserted instead).
 *
 * Why this home can observe the behaviour: tests/e2e launches the real built Electron app (real
 * main process, real IPC, real React, real `powerSaveBlocker`) and reads the real macOS
 * `pmset -g assertions` for the app's main pid. The only substitution is the darken action, via
 * the contract's env seam (METAIDE_TEST_MODE=1 + METAIDE_KEEP_AWAKE_DARKEN_LOG), so the screen is
 * never darkened (AC17). The other homes were rejected: tests/unit stubs the assertion and cannot
 * see the OS; a renderer-only harness has no main process or pmset.
 *
 * Every test is darwin-only, stops or closes the app so no assertion outlives it, and pairs each
 * negative assertion (no assertion / no chip / no toast) with a positive control.
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { closeApp, guardedLaunch } from './helpers/claude-harness';
import { PALETTE_TESTIDS } from '../../src/renderer/command-palette-contract';
import {
  KEEP_AWAKE_COPY, KEEP_AWAKE_ENV, KEEP_AWAKE_PRESETS, KEEP_AWAKE_TESTIDS,
  type KeepAwakeStartResult, type KeepAwakeState,
} from '../../src/shared/keep-awake-contract';
import {
  assertionsFor, displaySleepCount, idleSleepCount, parsePmsetAssertions,
} from './helpers/pmset-assertions';

test.skip(process.platform !== 'darwin', 'keep-awake is macOS-only (AC16)');

const T = KEEP_AWAKE_TESTIDS;
const C = KEEP_AWAKE_COPY;
const MIN = 60_000;

type Api = {
  invoke: (c: string, r: unknown) => Promise<unknown>;
  on: (c: string, cb: (p: unknown) => void) => () => void;
};

interface Launched {
  app: ElectronApplication;
  win: Page;
  pid: number;
  home: string;
  darkenLog: string;
  cleanup: () => void;
}

interface LaunchOpts {
  /** Reuse a previous launch's home (relaunch). */
  home?: string;
  darkenFail?: boolean;
  /** Add and open a project so a shell exists (needed for pop-out). */
  project?: boolean;
}

async function launchApp(opts: LaunchOpts = {}): Promise<Launched> {
  const mockClaude = resolve(process.cwd(), 'scripts/mock-claude.mjs');
  const dirs: string[] = [];
  const l = await guardedLaunch(async (scope) => {
    const home = opts.home ?? scope.tempDir('metaide-ka-home-');
    const root = scope.tempDir('metaide-ka-root-');
    const logDir = scope.tempDir('metaide-ka-log-');
    dirs.push(root, logDir);
    if (!opts.home) dirs.push(home);
    mkdirSync(join(root, 'alpha', '.git'), { recursive: true });
    const darkenLog = join(logDir, 'darken.log');
    const app = scope.own(await electron.launch({
      args: ['.', `--user-data-dir=${join(home, 'userData')}`],
      env: {
        ...process.env,
        HOME: home,
        SHELL: '/bin/bash',
        METAIDE_TEST_MODE: '1',
        [KEEP_AWAKE_ENV.darkenLog]: darkenLog,
        ...(opts.darkenFail ? { [KEEP_AWAKE_ENV.darkenFail]: '1' } : {}),
        METAIDE_CLAUDE_PERMISSION_MODE: 'bypass',
        METAIDE_DEFAULT_LAUNCH_FIRST: JSON.stringify({ argv: ['node', mockClaude], env: {} }),
        METAIDE_DEFAULT_LAUNCH_SUBSEQUENT: JSON.stringify({ argv: ['node', mockClaude, '--continue'], env: {} }),
      },
    }));
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setSize(1400, 900); });
    if (opts.project) {
      await win.evaluate(async (path: string) => {
        await (window as unknown as { api: Api }).api.invoke('roots:add', { path });
      }, root);
      await win.locator('[data-testid="project-row"]', { hasText: 'alpha' }).first().click();
      await expect(win.locator('[data-testid="shell-tab"]')).toBeVisible({ timeout: 10000 });
    }
    const pid = app.process().pid;
    if (pid === undefined) throw new Error('app has no pid');
    return { app, win, pid, home, darkenLog };
  });
  return {
    ...l,
    cleanup: () => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); },
  };
}

async function ipc<T>(win: Page, channel: string, req: unknown = undefined): Promise<T> {
  return win.evaluate(
    ({ channel, req }) => (window as unknown as { api: Api }).api.invoke(channel, req),
    { channel, req },
  ) as Promise<T>;
}

const getState = (win: Page) => ipc<KeepAwakeState>(win, 'keep-awake:get');
const startAt = (win: Page, endsAt: number) => ipc<KeepAwakeStartResult>(win, 'keep-awake:start', { endsAt });

function darkenLines(path: string): string[] {
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter((s) => s.length > 0) : [];
}

/** Runs `fn` against a fresh app; always stops keep-awake and closes the app, so no assertion outlives the test. */
async function withApp(opts: LaunchOpts, fn: (l: Launched) => Promise<void>): Promise<void> {
  const l = await launchApp(opts);
  try {
    await fn(l);
  } finally {
    try { await ipc(l.win, 'keep-awake:stop'); } catch { /* window may be gone */ }
    await closeApp(l.app);
    l.cleanup();
  }
}

const chip = (win: Page) => win.getByTestId(T.chip);

/** Opens the palette with the real chord; retries the chord because a freshly launched window may not have focus or its key listener yet. */
async function openPalette(win: Page) {
  const input = win.getByTestId(PALETTE_TESTIDS.input);
  await expect(async () => {
    await win.locator('body').click({ position: { x: 5, y: 5 } });
    await win.keyboard.press('ControlOrMeta+Shift+P');
    await expect(input).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 10_000 });
  return input;
}

async function runPaletteCommand(win: Page, title: string): Promise<void> {
  const input = await openPalette(win);
  await input.fill(`>${title}`);
  const row = win.getByTestId(PALETTE_TESTIDS.option).filter({ hasText: title });
  await expect(row, `"${title}" is listed`).toHaveCount(1);
  await row.click();
  await expect(win.getByTestId(PALETTE_TESTIDS.root)).toHaveCount(0);
}

async function paletteHas(win: Page, title: string): Promise<boolean> {
  const input = await openPalette(win);
  await input.fill(`>${title}`);
  // Positive control: the palette is open and filtering, so a miss is a real miss.
  await expect(input).toHaveValue(`>${title}`);
  const n = await win.getByTestId(PALETTE_TESTIDS.option).filter({ hasText: title }).count();
  await win.keyboard.press('Escape');
  await expect(win.getByTestId(PALETTE_TESTIDS.root)).toHaveCount(0);
  return n > 0;
}

/** Tooltip text of the chip: the `title` attribute (reconcile in Phase 5 if the tooltip is custom). */
async function chipTooltip(win: Page): Promise<string> {
  return (await chip(win).getAttribute('title')) ?? '';
}

function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/* ─────────────────────────────── helper self-check ─────────────────────────────── */

const FIXTURE = `2026-10-19 10:00:00 +0200
Assertion status system-wide:
   BackgroundTask                 0
   PreventUserIdleSystemSleep     1
   PreventUserIdleDisplaySleep    0
Listed by owning process:
   pid 4242(Electron): [0x0000a1b2000188c3] 00:00:07 NoIdleSleepAssertion named: "Electron"
\tTimeout will fire in 1700 secs Action=TimeoutActionRelease
   pid 99(powerd): [0x0000a1b2000188c4] 00:10:00 PreventUserIdleDisplaySleep named: "com.apple.x"
Kernel Assertions: 0x4=USB
`;

test('pmset parser: extracts per-process lines only (helper self-check)', () => {
  const parsed = parsePmsetAssertions(FIXTURE);
  expect(parsed).toEqual([
    { pid: 4242, process: 'Electron', type: 'NoIdleSleepAssertion', name: 'Electron' },
    { pid: 99, process: 'powerd', type: 'PreventUserIdleDisplaySleep', name: 'com.apple.x' },
  ]);
  // Positive control: an output with no process lines parses to nothing.
  expect(parsePmsetAssertions('Listed by owning process:\n')).toEqual([]);
});

/* ─────────────────────────────── AC1 / AC4 / AC6 ─────────────────────────────── */

test('AC1/AC4/AC6/AC17: palette lists presets; 30 minutes holds one idle-sleep assertion, no display one, darkens once via the seam', async () => {
  test.setTimeout(90_000);
  await withApp({}, async ({ win, pid, darkenLog }) => {
    // AC1: all presets plus "until…" are listed with no project open.
    for (const p of KEEP_AWAKE_PRESETS) expect(await paletteHas(win, p.title), p.title).toBe(true);
    expect(await paletteHas(win, C.palette.until)).toBe(true);
    // Not listed while inactive.
    expect(await paletteHas(win, C.palette.stop)).toBe(false);
    expect(await paletteHas(win, C.palette.darkenNow)).toBe(false);

    // Baseline: nothing held, nothing darkened, no indicator.
    expect(await idleSleepCount(pid)).toBe(0);
    expect(darkenLines(darkenLog)).toHaveLength(0);
    await expect(chip(win)).toHaveCount(0);

    const before = Date.now();
    await runPaletteCommand(win, KEEP_AWAKE_PRESETS[0]!.title);

    await expect(chip(win)).toBeVisible({ timeout: 5000 });
    await expect.poll(() => idleSleepCount(pid), { timeout: 5000 }).toBe(1);
    expect(await displaySleepCount(pid)).toBe(0);
    const state = await getState(win);
    expect(state.active).toBe(true);
    if (state.active) {
      expect(state.endsAt).toBeGreaterThan(before + 29 * MIN);
      expect(state.endsAt).toBeLessThan(Date.now() + 31 * MIN);
    }

    // AC6: exactly one darken within 2 s of start, and it does not fire a second time.
    await expect.poll(() => darkenLines(darkenLog).length, { timeout: 2500 }).toBe(1);
    await win.waitForTimeout(2500);
    expect(darkenLines(darkenLog)).toHaveLength(1);
    // AC4 still holds after the darken: the assertion is independent of the display.
    expect(await idleSleepCount(pid)).toBe(1);
    // Positive control for "no toast": the darken seam succeeded, so no failure toast.
    await expect(win.getByTestId('toast').filter({ hasText: C.toast.darkenFailed })).toHaveCount(0);
  });
});

/* ─────────────────────────────── AC5 ─────────────────────────────── */

test('AC5: starting while active replaces the deadline; still exactly one assertion and the tooltip shows the new end', async () => {
  test.setTimeout(90_000);
  await withApp({}, async ({ win, pid }) => {
    await runPaletteCommand(win, KEEP_AWAKE_PRESETS[0]!.title); // 30 minutes
    await expect(chip(win)).toBeVisible({ timeout: 5000 });
    await expect.poll(() => idleSleepCount(pid), { timeout: 5000 }).toBe(1);
    const first = await getState(win);
    const firstTip = await chipTooltip(win);
    expect(firstTip).toContain('Keep awake until');

    await runPaletteCommand(win, KEEP_AWAKE_PRESETS[2]!.title); // 2 hours
    await expect.poll(async () => {
      const s = await getState(win);
      return s.active ? s.endsAt : 0;
    }, { timeout: 5000 }).toBeGreaterThan((first.active ? first.endsAt : 0) + 60 * MIN);
    await expect.poll(() => chipTooltip(win), { timeout: 5000 }).not.toBe(firstTip);
    // Let any (wrongly) duplicated assertion show up before counting.
    await win.waitForTimeout(1000);
    expect(await idleSleepCount(pid)).toBe(1);
    await expect(chip(win)).toHaveCount(1);
  });
});

/* ─────────────────────────────── AC2 / AC3 ─────────────────────────────── */

test('AC2/AC3: dialog rejects empty and malformed input with no assertion; a valid time shows a preview and starts', async () => {
  test.setTimeout(90_000);
  await withApp({}, async ({ win, pid }) => {
    await runPaletteCommand(win, C.palette.until);
    const dialog = win.getByTestId(T.dialog);
    await expect(dialog).toBeVisible({ timeout: 3000 });
    await expect(dialog).toContainText(C.dialog.title);
    const input = win.getByTestId(T.input);

    // Empty.
    await input.fill('');
    await input.press('Enter');
    await expect(win.getByTestId(T.error)).toHaveText(C.dialog.errorEmpty);
    // Malformed variants.
    for (const bad of ['abc', '25:00', '12:60', '7', '12:5']) {
      await input.fill(bad);
      await input.press('Enter');
      await expect(win.getByTestId(T.error), bad).toHaveText(C.dialog.errorMalformed);
    }
    // Nothing started: dialog still open, inactive, no assertion, no chip, no darken.
    await expect(dialog).toBeVisible();
    expect(await getState(win)).toEqual({ active: false });
    expect(await idleSleepCount(pid)).toBe(0);
    await expect(chip(win)).toHaveCount(0);

    // Valid: 90 minutes from now. Positive control for the negatives above.
    const target = new Date(Date.now() + 90 * MIN);
    await input.fill(hhmm(target));
    await expect(win.getByTestId(T.preview)).toContainText('Until');
    await expect(win.getByTestId(T.error)).toHaveCount(0);
    await win.getByTestId(T.confirm).click();
    await expect(dialog).toHaveCount(0);
    await expect(chip(win)).toBeVisible({ timeout: 5000 });
    await expect.poll(() => idleSleepCount(pid), { timeout: 5000 }).toBe(1);
    const s = await getState(win);
    expect(s.active).toBe(true);
    if (s.active) expect(Math.abs(s.endsAt - target.getTime())).toBeLessThanOrEqual(MIN + 5000);
  });
});

test('AC3: IPC boundary rejects a past deadline and one beyond 24 h; no assertion, no state change', async () => {
  test.setTimeout(60_000);
  await withApp({}, async ({ win, pid }) => {
    const past = await startAt(win, Date.now() - 1000);
    expect(past).toEqual({ ok: false, error: 'invalid' });
    const far = await startAt(win, Date.now() + 24 * 60 * MIN + 10 * MIN);
    expect(far).toEqual({ ok: false, error: 'invalid' });
    expect(await getState(win)).toEqual({ active: false });
    expect(await idleSleepCount(pid)).toBe(0);
    await expect(chip(win)).toHaveCount(0);

    // Positive control: a valid deadline on the same channel succeeds and holds the assertion.
    const ok = await startAt(win, Date.now() + 30 * MIN);
    expect(ok.ok).toBe(true);
    await expect.poll(() => idleSleepCount(pid), { timeout: 5000 }).toBe(1);
  });
});

/* ─────────────────────────────── AC8 ─────────────────────────────── */

test('AC8: darken failure shows a warning toast; keep-awake stays active and the assertion stays held', async () => {
  test.setTimeout(90_000);
  await withApp({ darkenFail: true }, async ({ win, pid, darkenLog }) => {
    await runPaletteCommand(win, KEEP_AWAKE_PRESETS[0]!.title);
    await expect(win.getByTestId('toast').filter({ hasText: C.toast.darkenFailed }).first())
      .toBeVisible({ timeout: 8000 });
    await expect(chip(win)).toBeVisible();
    expect((await getState(win)).active).toBe(true);
    expect(await idleSleepCount(pid)).toBe(1);
    // The recorder was still called once (the failure came from the seam, not a skipped call).
    expect(darkenLines(darkenLog)).toHaveLength(1);
  });
});

/* ─────────────────────────────── AC9 ─────────────────────────────── */

test('AC9: "Turn screen off now" runs the darken action again', async () => {
  test.setTimeout(90_000);
  await withApp({}, async ({ win, darkenLog }) => {
    await runPaletteCommand(win, KEEP_AWAKE_PRESETS[0]!.title);
    await expect.poll(() => darkenLines(darkenLog).length, { timeout: 2500 }).toBe(1);
    expect(await paletteHas(win, C.palette.darkenNow)).toBe(true);
    await runPaletteCommand(win, C.palette.darkenNow);
    await expect.poll(() => darkenLines(darkenLog).length, { timeout: 3000 }).toBe(2);
    await win.waitForTimeout(2000);
    expect(darkenLines(darkenLog)).toHaveLength(2);
    expect((await getState(win)).active).toBe(true);
  });
});

/* ─────────────────────────────── AC10 / AC11 ─────────────────────────────── */

test('AC10/AC11: chip shows remaining time; Stop in the popover releases the assertion and removes chip and Stop row', async () => {
  test.setTimeout(90_000);
  await withApp({}, async ({ win, pid, darkenLog }) => {
    await expect(chip(win)).toHaveCount(0);
    const r = await startAt(win, Date.now() + 102 * MIN + 30_000);
    expect(r.ok).toBe(true);
    await expect(chip(win)).toBeVisible({ timeout: 5000 });
    await expect(chip(win)).toHaveText(/^1h 4[23]m$/);
    await expect(chip(win)).toHaveAttribute('aria-label', /^Keep awake active, .+ left$/);
    expect(await chipTooltip(win)).toContain('Keep awake until');
    expect(await paletteHas(win, C.palette.stop)).toBe(true);
    await expect.poll(() => idleSleepCount(pid), { timeout: 5000 }).toBe(1);
    await expect.poll(() => darkenLines(darkenLog).length, { timeout: 2500 }).toBe(1);

    await chip(win).click();
    const popover = win.getByTestId(T.popover);
    await expect(popover).toBeVisible();
    await expect(popover).toContainText(C.popover.lidHint);
    await win.getByTestId(T.stop).click();

    await expect.poll(async () => (await assertionsFor(pid)).length, { timeout: 1500, intervals: [100, 200] }).toBe(0);
    await expect(chip(win)).toHaveCount(0);
    expect(await getState(win)).toEqual({ active: false });
    expect(await paletteHas(win, C.palette.stop)).toBe(false);
  });
});

test('AC11: the "Keep awake: Stop" palette command releases the assertion', async () => {
  test.setTimeout(90_000);
  await withApp({}, async ({ win, pid }) => {
    await runPaletteCommand(win, KEEP_AWAKE_PRESETS[1]!.title);
    await expect.poll(() => idleSleepCount(pid), { timeout: 5000 }).toBe(1);
    await runPaletteCommand(win, C.palette.stop);
    await expect.poll(() => idleSleepCount(pid), { timeout: 1500, intervals: [100, 200] }).toBe(0);
    await expect(chip(win)).toHaveCount(0);
  });
});

test('AC6/AC11: Stop before the darken delay fires cancels the pending darken', async () => {
  test.setTimeout(60_000);
  await withApp({}, async ({ win, darkenLog }) => {
    expect((await startAt(win, Date.now() + 30 * MIN)).ok).toBe(true);
    await ipc(win, 'keep-awake:stop'); // immediately, well inside the 1.5 s delay
    await win.waitForTimeout(2500);
    expect(darkenLines(darkenLog)).toHaveLength(0);
    // Positive control: without the early stop the same start does darken.
    expect((await startAt(win, Date.now() + 30 * MIN)).ok).toBe(true);
    await expect.poll(() => darkenLines(darkenLog).length, { timeout: 3000 }).toBe(1);
  });
});

/* ─────────────────────────────── AC12 ─────────────────────────────── */

test('AC12: at the deadline the assertion is released within 5 s and the chip disappears', async () => {
  test.setTimeout(60_000);
  await withApp({}, async ({ win, pid }) => {
    expect((await startAt(win, Date.now() + 3000)).ok).toBe(true);
    // Positive control: it is held and shown before the deadline.
    await expect.poll(() => idleSleepCount(pid), { timeout: 2000 }).toBe(1);
    await expect(chip(win)).toBeVisible();
    await expect.poll(() => getState(win), { timeout: 8000, intervals: [250] }).toEqual({ active: false });
    expect(await idleSleepCount(pid)).toBe(0);
    await expect(chip(win)).toHaveCount(0);
  });
});

/* ─────────────────────────────── AC14 ─────────────────────────────── */

test('AC14: quitting while active releases the assertion; a relaunch with the same home is inactive', async () => {
  test.setTimeout(120_000);
  const first = await launchApp();
  let second: Launched | undefined;
  try {
    expect((await startAt(first.win, Date.now() + 30 * MIN)).ok).toBe(true);
    await expect.poll(() => idleSleepCount(first.pid), { timeout: 5000 }).toBe(1);
    await closeApp(first.app);
    expect(await idleSleepCount(first.pid)).toBe(0);

    second = await launchApp({ home: first.home });
    expect(second.pid).not.toBe(first.pid);
    expect(await getState(second.win)).toEqual({ active: false });
    await expect(chip(second.win)).toHaveCount(0);
    expect(await idleSleepCount(second.pid)).toBe(0);
    // Positive control: the relaunched app can still hold one.
    expect((await startAt(second.win, Date.now() + 30 * MIN)).ok).toBe(true);
    await expect.poll(() => idleSleepCount(second!.pid), { timeout: 5000 }).toBe(1);
  } finally {
    if (second) {
      try { await ipc(second.win, 'keep-awake:stop'); } catch { /* gone */ }
      await closeApp(second.app);
      second.cleanup();
    }
    await closeApp(first.app);
    first.cleanup();
  }
});

/* ─────────────────────────────── AC15 ─────────────────────────────── */

test('AC15: keep-awake:changed reaches the pop-out window; only the main window renders the chip', async () => {
  test.setTimeout(120_000);
  await withApp({ project: true }, async ({ app, win, pid }) => {
    const [popout] = await Promise.all([
      app.waitForEvent('window'),
      win.getByTestId('popout-shell').click(),
    ]);
    await popout.waitForLoadState('domcontentloaded');
    await expect(popout.locator('[data-testid="shell-tab"]')).toBeVisible({ timeout: 10000 });
    await popout.evaluate(() => {
      const w = window as unknown as { api: Api; __ka: unknown[] };
      w.__ka = [];
      w.api.on('keep-awake:changed', (p) => { w.__ka.push(p); });
    });
    const events = () => popout.evaluate(() => (window as unknown as { __ka: Array<{ active: boolean }> }).__ka);

    expect((await startAt(win, Date.now() + 30 * MIN)).ok).toBe(true);
    await expect(chip(win)).toBeVisible({ timeout: 5000 });
    await expect.poll(async () => (await events()).some((e) => e.active), { timeout: 5000 }).toBe(true);
    // No indicator in the pop-out (positive control: the main window has one).
    await expect(chip(popout)).toHaveCount(0);
    await expect(chip(win)).toHaveCount(1);

    await chip(win).click();
    await win.getByTestId(T.stop).click();
    await expect.poll(async () => (await events()).at(-1)?.active, { timeout: 5000 }).toBe(false);
    await expect.poll(() => idleSleepCount(pid), { timeout: 1500, intervals: [100, 200] }).toBe(0);
  });
});
