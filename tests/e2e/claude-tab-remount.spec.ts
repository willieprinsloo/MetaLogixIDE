/**
 * Claude tab remount — after a long session, switching away from the Claude
 * tab and back must show Claude's input box and status line again, without
 * a window resize.
 *
 * Regression: leaving the tab (Files tab, another shell tab) unmounts
 * ShellTab; coming back mounts a fresh xterm that replays `shells:snapshot`.
 * The snapshot used to be PtyManager's rolling raw-byte tail (256 KiB).
 * Claude Code redraws only the cells that change, so once a session passed
 * 256 KiB the tail no longer held the bytes that drew the input box and
 * status line — they were missing until a resize made Claude redraw.
 *
 * mock-claude's `/flood` reproduces that TUI pattern (see the mock): footer
 * drawn once, more than 256 KiB of cursor-addressed patches after it, only
 * the status line's counter digits re-patched, and no output afterwards.
 * The mock never redraws on SIGWINCH, so nothing but the snapshot can bring
 * the footer back.
 *
 * What the remounted terminal shows is read two ways, both black-box to the
 * fix:
 *  1. the remounted xterm's own buffer. The WebGL renderer leaves no DOM
 *     text and the Terminal is private to ShellTab, so the spec reaches it
 *     through React's fiber on the terminal host element — the ref whose
 *     value is an xterm Terminal. The buffer is what the renderer paints.
 *  2. `shells:snapshot`, replayed verbatim into an `@xterm/headless`
 *     terminal of the same size — the IPC contract alone must reconstitute
 *     the screen.
 * Positive control on both: the flood's last line (FLOOD-END, row 1) is on
 * screen — it is in the raw tail too, so it proves the reading works and
 * that only the footer is at stake.
 *
 * The last test covers ShellTab's replay itself (gate finding M1): ShellTab
 * stripped a "partial ANSI head" — output starting with ESC and no letter in
 * its first 32 characters lost everything up to the first newline. A
 * serialized snapshot whose first cell has a truecolor fg and bg starts with
 * exactly such an SGR, so row 1 was deleted and the screen and cursor moved
 * up a row. mock-claude's `/truecolor-top` draws that screen.
 */

import { test, expect, _electron as electron, type Page, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

type HeadlessModule = typeof import('@xterm/headless');
// @xterm/headless is a webpack CJS bundle whose named exports Node's ESM
// loader cannot detect, so load it through require.
const { Terminal: HeadlessTerminal } = createRequire(resolve(process.cwd(), 'package.json'))(
  '@xterm/headless',
) as HeadlessModule;

const WIDE = { width: 1600, height: 1000 };
/** Raw tail PtyManager kept before the fix; the flood must exceed it. */
const OLD_SCROLLBACK_CAP = 256 * 1024;
const FLOOD_KB = 512;
// Must match scripts/mock-claude.mjs.
const INPUT_BOX = '| > INPUT-BOX-MARK';
const STATUS_PREFIX = 'STATUS-LINE-MARK model=mock tokens=';
const FLOOD_END_RE = /FLOOD-END lines=(\d+) bytes=(\d+) size=(\d+)x(\d+)/;
const SIZE_RE = /size: (\d+)x(\d+)/g;
// /truecolor-top: row 1 marker with fg rgb(255,200,100) and bg rgb(100,150,200),
// footer on the last row, cursor parked at row 3, column 5.
const TC_TOP = 'TRUECOLOR-TOP-MARK';
const TC_FOOTER_RE = /^TRUECOLOR-FOOTER-MARK size=(\d+)x(\d+)$/;
const TC_FIRST_CELL = { fgRGB: true, bgRGB: true, fg: 0xffc864, bg: 0x6496c8 };
const TC_CURSOR = { x: 4, y: 2 };

type Size = { cols: number; rows: number };
type Api = { invoke: (c: string, r: unknown) => Promise<never> };
type AliveShell = { projectId: number; projectName: string; shellIndex: number };
/** First cell's colours: `fg`/`bg` are 0xRRGGBB when the matching `*RGB` flag is set. */
type Cell = { fgRGB: boolean; bgRGB: boolean; fg: number; bg: number };
type Screen = { cols: number; rows: number; lines: string[]; cursor: { x: number; y: number }; firstCell: Cell | null };
type Flood = { lines: number; bytes: number; size: Size };

/** `shells:snapshot` output of one of the project's live shells. */
async function snapshotOutput(win: Page, projectName: string, shellIndex = 0): Promise<string> {
  return win.evaluate(async ({ name, idx }: { name: string; idx: number }) => {
    const api = (window as unknown as { api: Api }).api;
    const { shells } = (await api.invoke('shells:alive-list', undefined)) as { shells: AliveShell[] };
    const shell = shells.find((s) => s.projectName === name && s.shellIndex === idx);
    if (!shell) return '';
    const snap = (await api.invoke('shells:snapshot', { projectId: shell.projectId, shellIndex: shell.shellIndex })) as { output: string };
    return snap.output;
  }, { name: projectName, idx: shellIndex });
}

/** Writes to the project's primary shell over the same channel xterm's onData uses. */
async function writeToShell(win: Page, projectName: string, data: string): Promise<void> {
  await win.evaluate(async ({ name, data }: { name: string; data: string }) => {
    const api = (window as unknown as { api: Api }).api;
    const { shells } = (await api.invoke('shells:alive-list', undefined)) as { shells: AliveShell[] };
    const shell = shells.find((s) => s.projectName === name && s.shellIndex === 0);
    if (!shell) throw new Error(`no live shell for ${name}`);
    await api.invoke('shells:write', { projectId: shell.projectId, shellIndex: shell.shellIndex, data });
  }, { name: projectName, data });
}

/** Sends `/size` to the primary shell and returns mock-claude's report. */
async function ptySize(win: Page, projectName: string): Promise<Size> {
  const count = async () => [...(await snapshotOutput(win, projectName)).matchAll(SIZE_RE)];
  const before = (await count()).length;
  await writeToShell(win, projectName, '/size\r');
  let reports: RegExpMatchArray[] = [];
  await expect.poll(async () => {
    reports = await count();
    return reports.length;
  }, { timeout: 10000 }).toBeGreaterThan(before);
  const last = reports[reports.length - 1]!;
  return { cols: Number(last[1]), rows: Number(last[2]) };
}

/**
 * Waits until the PTY size stops changing — ShellTab fits on mount and again
 * at 150 ms and 400 ms — so the flood draws its footer at the size the tab
 * keeps. A later size change would reflow the screen and void the test.
 */
async function settledPtySize(win: Page, projectName: string): Promise<Size> {
  let previous = await ptySize(win, projectName);
  await expect.poll(async () => {
    const current = await ptySize(win, projectName);
    const stable = current.cols === previous.cols && current.rows === previous.rows;
    previous = current;
    return stable;
  }, { timeout: 15000, intervals: [500] }).toBe(true);
  return previous;
}

/**
 * Screen rows of the visible ShellTab's xterm, read from the Terminal
 * instance itself (see header). Null while no terminal is mounted/opened.
 */
async function visibleTerminalScreen(win: Page): Promise<Screen | null> {
  return win.evaluate(() => {
    type BufCell = { isFgRGB: () => boolean; isBgRGB: () => boolean; getFgColor: () => number; getBgColor: () => number };
    type Line = { translateToString: (trim: boolean) => string; getCell: (x: number) => BufCell | undefined };
    type Buf = { viewportY: number; baseY: number; cursorX: number; cursorY: number; getLine: (y: number) => Line | undefined };
    type Term = { cols: number; rows: number; buffer: { active: Buf } };
    type Hook = { memoizedState: unknown; next: Hook | null };
    type Fiber = { tag: number; memoizedState: unknown; return: Fiber | null };
    const isTerm = (v: unknown): v is Term =>
      !!v && typeof v === 'object' && 'buffer' in v && 'cols' in v && 'rows' in v
      && !!(v as { buffer?: { active?: unknown } }).buffer?.active;

    const xterms = [...document.querySelectorAll<HTMLElement>('.xterm')].filter((el) => el.offsetParent !== null);
    if (xterms.length !== 1) return null;
    let el: HTMLElement | null = xterms[0]!;
    let fiber: Fiber | null = null;
    while (el && !fiber) {
      const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
      if (key) fiber = (el as unknown as Record<string, Fiber>)[key] ?? null;
      el = el.parentElement;
    }
    let term: Term | null = null;
    for (let f = fiber; f && !term; f = f.return) {
      if (f.tag !== 0) continue; // FunctionComponent
      for (let h = f.memoizedState as Hook | null; h && !term; h = h.next) {
        const ref = h.memoizedState as { current?: unknown } | null;
        if (ref && typeof ref === 'object' && 'current' in ref && isTerm(ref.current)) term = ref.current;
      }
    }
    if (!term) return null;
    const buf = term.buffer.active;
    const lines: string[] = [];
    for (let r = 0; r < term.rows; r++) lines.push(buf.getLine(buf.viewportY + r)?.translateToString(true) ?? '');
    const c = buf.getLine(buf.viewportY)?.getCell(0);
    const firstCell = c ? { fgRGB: c.isFgRGB(), bgRGB: c.isBgRGB(), fg: c.getFgColor(), bg: c.getBgColor() } : null;
    // cursorY is relative to baseY; report it relative to the visible top row.
    return { cols: term.cols, rows: term.rows, lines, cursor: { x: buf.cursorX, y: buf.baseY + buf.cursorY - buf.viewportY }, firstCell };
  });
}

/**
 * Replays a snapshot verbatim — write, then SGR reset — into a headless xterm
 * of the tab's size, and returns what is on screen. Deliberately NOT a copy
 * of ShellTab's replay: whatever ShellTab does to the snapshot beyond this
 * (it used to strip a "partial ANSI head", which ate row 0 of a serialized
 * snapshot starting with a long truecolor SGR) is what the remounted-xterm
 * reading is there to catch; this reading checks the IPC contract alone.
 */
async function replaySnapshot(output: string, size: Size): Promise<Screen> {
  const term = new HeadlessTerminal({ cols: size.cols, rows: size.rows, scrollback: 10000, allowProposedApi: true });
  try {
    await new Promise<void>((done) => term.write(output + '\x1b[0m', done));
    const buf = term.buffer.active;
    const lines: string[] = [];
    for (let r = 0; r < size.rows; r++) lines.push(buf.getLine(buf.viewportY + r)?.translateToString(true) ?? '');
    const c = buf.getLine(buf.viewportY)?.getCell(0);
    const firstCell = c ? { fgRGB: c.isFgRGB(), bgRGB: c.isBgRGB(), fg: c.getFgColor(), bg: c.getBgColor() } : null;
    return { cols: size.cols, rows: size.rows, lines, cursor: { x: buf.cursorX, y: buf.baseY + buf.cursorY - buf.viewportY }, firstCell };
  } finally {
    term.dispose();
  }
}

/** Runs `/flood` in the primary shell and waits for it to finish. */
async function floodClaude(win: Page, projectName: string): Promise<Flood> {
  await writeToShell(win, projectName, `/flood ${FLOOD_KB}\r`);
  let m: RegExpMatchArray | null = null;
  await expect.poll(async () => {
    m = (await snapshotOutput(win, projectName)).match(FLOOD_END_RE);
    return m !== null;
  }, { timeout: 30000 }).toBe(true);
  const [, lines, bytes, cols, rows] = m as unknown as RegExpMatchArray;
  return { lines: Number(lines), bytes: Number(bytes), size: { cols: Number(cols), rows: Number(rows) } };
}

/** The footer and positive control every reading of the Claude screen must show. */
function expectClaudeScreen(lines: string[], flood: Flood, source: string): void {
  const { rows } = flood.size;
  expect(lines, `${source}: one line per terminal row`).toHaveLength(rows);
  // Positive control — the flood's last line is in any snapshot, old or new.
  expect(lines[0]!.trimEnd(), `${source}: FLOOD-END on row 1 (positive control)`).toMatch(FLOOD_END_RE);
  // The AC: footer drawn once, >256 KiB earlier, is on screen again, with
  // the status line's latest patched counter applied on top of it.
  expect(lines[rows - 2]!.trimEnd(), `${source}: input box on row ${rows - 1}`).toBe(INPUT_BOX);
  expect(lines[rows - 1]!.trimEnd(), `${source}: status line on the last row`).toBe(`${STATUS_PREFIX}${String(flood.lines).padStart(6, '0')}`);
}

/** Asserts what the remounted Claude tab shows, by both readings (see header). */
async function expectRemountedClaudeTab(win: Page, flood: Flood): Promise<void> {
  // The remounted xterm writes the snapshot asynchronously — wait for the
  // positive control to land, then check the whole screen.
  let screen: Screen | null = null;
  await expect.poll(async () => {
    screen = await visibleTerminalScreen(win);
    return screen?.lines.some((l) => FLOOD_END_RE.test(l)) ?? false;
  }, { timeout: 10000, message: 'remounted Claude terminal shows the FLOOD-END line' }).toBe(true);
  const s = screen as unknown as Screen;
  // Same size as when the flood drew — no resize happened, and it is the
  // size the snapshot replay below uses.
  expect({ cols: s.cols, rows: s.rows }, 'remounted xterm size vs size the flood drew at').toEqual(flood.size);
  expectClaudeScreen(s.lines, flood, 'remounted xterm');

  const replayed = await replaySnapshot(await snapshotOutput(win, 'demo'), flood.size);
  expectClaudeScreen(replayed.lines, flood, 'shells:snapshot replay');
}

async function setWindowSize(app: ElectronApplication, size: { width: number; height: number }): Promise<void> {
  await app.evaluate(({ BrowserWindow }, s) => {
    BrowserWindow.getAllWindows()[0]!.setSize(s.width, s.height);
  }, size);
}

/** Launches the app on an isolated HOME with project `demo` open on mock-claude (see claude-tab-width.spec.ts). */
async function openDemoProject(): Promise<{ app: ElectronApplication; win: Page; cleanup: () => void }> {
  const mockClaude = resolve(process.cwd(), 'scripts/mock-claude.mjs');
  const isolatedHome = mkdtempSync(join(tmpdir(), 'metaide-home-'));
  const demoRoot     = mkdtempSync(join(tmpdir(), 'metaide-demo-'));
  const proj         = join(demoRoot, 'demo');
  mkdirSync(proj); mkdirSync(join(proj, '.git'));
  // The "Claude" CLI profile in "+ new shell" runs this shim, which execs mock-claude.
  const claudeShim = join(isolatedHome, 'bin', 'claude');
  mkdirSync(join(isolatedHome, 'bin'));
  writeFileSync(claudeShim, `#!/bin/sh\nexec node ${JSON.stringify(mockClaude)} "$@"\n`);
  chmodSync(claudeShim, 0o755);

  const app = await electron.launch({
    args: ['.', `--user-data-dir=${join(isolatedHome, 'userData')}`],
    env: {
      ...process.env,
      HOME: isolatedHome,
      METAIDE_TEST_MODE: '1',
      METAIDE_CLAUDE_PERMISSION_MODE: 'bypass',
      METAIDE_DEFAULT_LAUNCH_FIRST:      JSON.stringify({ argv: ['node', mockClaude],               env: {} }),
      METAIDE_DEFAULT_LAUNCH_SUBSEQUENT: JSON.stringify({ argv: ['node', mockClaude, '--continue'], env: {} }),
    },
  });
  const cleanup = () => {
    rmSync(isolatedHome, { recursive: true, force: true });
    rmSync(demoRoot, { recursive: true, force: true });
  };
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await setWindowSize(app, WIDE);

  await win.evaluate(async ({ path, claudeShim }: { path: string; claudeShim: string }) => {
    const api = (window as unknown as { api: Api }).api;
    await api.invoke('settings:set', { key: 'default_cli_profiles', value: [{ name: 'Claude', argv: [claudeShim] }] });
    await api.invoke('roots:add', { path });
  }, { path: demoRoot, claudeShim });
  const projectButton = win.getByRole('button', { name: 'demo', exact: true });
  await expect(projectButton).toBeVisible({ timeout: 5000 });
  await projectButton.click();

  await expect(win.locator('.xterm').first()).toBeVisible({ timeout: 10000 });
  await expect.poll(() => snapshotOutput(win, 'demo'), { timeout: 10000 }).toContain('mock-claude ready');
  return { app, win, cleanup };
}

/** Settles the PTY size, floods Claude past the old 256 KiB tail, and checks the live tab. */
async function longClaudeSession(win: Page): Promise<Flood> {
  const settled = await settledPtySize(win, 'demo');
  const flood = await floodClaude(win, 'demo');
  test.info().annotations.push({ type: 'flood', description: `lines=${flood.lines} bytes=${flood.bytes} size=${flood.size.cols}x${flood.size.rows}` });
  expect(flood.size, 'flood drew at the settled PTY size').toEqual(settled);
  expect(flood.bytes, 'session output exceeds the old 256 KiB raw tail').toBeGreaterThan(OLD_SCROLLBACK_CAP);
  // Control: the tab that stayed mounted during the flood shows the footer —
  // the mock's drawing is right, so only the remount is under test.
  await expect.poll(async () => (await visibleTerminalScreen(win))?.lines.some((l) => FLOOD_END_RE.test(l)) ?? false,
    { timeout: 10000 }).toBe(true);
  expectClaudeScreen((await visibleTerminalScreen(win))!.lines, flood, 'live xterm before leaving the tab');
  return flood;
}

test('Claude tab shows its input box and status line after a long session when you come back from the Files tab', async () => {
  const { app, win, cleanup } = await openDemoProject();
  try {
    const flood = await longClaudeSession(win);

    await win.getByRole('button', { name: 'Files', exact: true }).click();
    // ShellTab is unmounted while Files is showing.
    await expect(win.locator('.xterm')).toHaveCount(0, { timeout: 5000 });

    await win.getByRole('button', { name: 'Shell', exact: true }).click();
    await expect(win.locator('.xterm').first()).toBeVisible({ timeout: 10000 });

    await expectRemountedClaudeTab(win, flood);
  } finally {
    await app.close();
    cleanup();
  }
});

test('Claude tab shows its input box and status line after a long session when you come back from another shell tab', async () => {
  const { app, win, cleanup } = await openDemoProject();
  try {
    const flood = await longClaudeSession(win);

    // Open a second Claude from "+ new shell"; it becomes the active tab and
    // the first tab's ShellTab unmounts (ShellTab is keyed by shell index).
    await win.getByTestId('tabbar-new-shell').click();
    await win.locator('[data-new-shell-menu]').locator('button', { hasText: 'Claude' }).first().click();
    await expect.poll(() => snapshotOutput(win, 'demo', 1), { timeout: 10000 }).toContain('mock-claude ready');
    // The visible terminal is now shell 1's, not the flooded one.
    await expect.poll(async () => {
      const lines = (await visibleTerminalScreen(win))?.lines ?? [];
      return lines.some((l) => l.includes('mock-claude ready')) && !lines.some((l) => FLOOD_END_RE.test(l));
    }, { timeout: 10000, message: 'second shell tab is showing' }).toBe(true);

    // Back to the first tab. Shell 0 was spawned from `node mock-claude.mjs`,
    // so its tab is labelled "Node"; the profile's tab is "Claude".
    await win.getByText('Node', { exact: true }).click();

    await expectRemountedClaudeTab(win, flood);
  } finally {
    await app.close();
    cleanup();
  }
});

/** What every reading of the /truecolor-top screen must show. */
function expectTruecolorScreen(screen: Screen, size: Size, source: string): void {
  // Positive control — the footer text survives the old strip (it only moves up a row).
  expect(screen.lines.some((l) => TC_FOOTER_RE.test(l.trimEnd())), `${source}: footer somewhere on screen (positive control)`).toBe(true);
  expect(screen.lines, `${source}: one line per terminal row`).toHaveLength(size.rows);
  expect(screen.lines[0]!.trimEnd(), `${source}: truecolor marker on row 1`).toBe(TC_TOP);
  expect(screen.firstCell, `${source}: row 1 first cell keeps its truecolor fg and bg`).toEqual(TC_FIRST_CELL);
  expect(screen.lines[size.rows - 1]!.trimEnd(), `${source}: footer on the last row`).toBe(`TRUECOLOR-FOOTER-MARK size=${size.cols}x${size.rows}`);
  expect(screen.cursor, `${source}: cursor at row 3, column 5`).toEqual(TC_CURSOR);
}

test('Claude tab keeps its first row and cursor after a remount when the screen starts with a truecolor cell', async () => {
  const { app, win, cleanup } = await openDemoProject();
  try {
    const size = await settledPtySize(win, 'demo');
    await writeToShell(win, 'demo', '/truecolor-top\r');
    let output = '';
    await expect.poll(async () => {
      output = await snapshotOutput(win, 'demo');
      return output.includes('TRUECOLOR-FOOTER-MARK');
    }, { timeout: 10000 }).toBe(true);
    // Precondition: the snapshot really opens with an ESC and no letter in
    // its first 32 characters — the shape the old ShellTab strip cut.
    expect(output.startsWith('\x1b') && !/[A-Za-z]/.test(output.slice(1, 32)),
      `snapshot opens with a long SGR: ${JSON.stringify(output.slice(0, 48))}`).toBe(true);

    // Control: the tab that stayed mounted shows the screen as drawn.
    await expect.poll(async () => (await visibleTerminalScreen(win))?.lines.some((l) => TC_FOOTER_RE.test(l.trimEnd())) ?? false,
      { timeout: 10000 }).toBe(true);
    expectTruecolorScreen((await visibleTerminalScreen(win))!, size, 'live xterm before leaving the tab');

    await win.getByRole('button', { name: 'Files', exact: true }).click();
    await expect(win.locator('.xterm')).toHaveCount(0, { timeout: 5000 });
    await win.getByRole('button', { name: 'Shell', exact: true }).click();
    await expect(win.locator('.xterm').first()).toBeVisible({ timeout: 10000 });

    let screen: Screen | null = null;
    await expect.poll(async () => {
      screen = await visibleTerminalScreen(win);
      return screen?.lines.some((l) => TC_FOOTER_RE.test(l.trimEnd())) ?? false;
    }, { timeout: 10000, message: 'remounted Claude terminal shows the footer' }).toBe(true);
    const remounted = screen as unknown as Screen;
    expect({ cols: remounted.cols, rows: remounted.rows }, 'remounted xterm size vs size the screen was drawn at').toEqual(size);
    expectTruecolorScreen(remounted, size, 'remounted xterm');

    expectTruecolorScreen(await replaySnapshot(await snapshotOutput(win, 'demo'), size), size, 'shells:snapshot replay');
  } finally {
    await app.close();
    cleanup();
  }
});
