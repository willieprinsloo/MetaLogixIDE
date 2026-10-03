/**
 * Shared helpers for the project-switch focus suite
 * (tests/e2e/terminal-project-switch-focus.spec.ts).
 *
 * `launch`, `openProject`, `blurToBody`, `terminalActiveIn`,
 * `focusedTerminalCount` and `projectIdByName` mirror the private helpers in
 * terminal-window-focus.spec.ts, which stays untouched (plan §8.3). The rest
 * are specific to project switches.
 */

import { expect, _electron as electron, type Page, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

type Api = { invoke: (c: string, r: unknown) => Promise<never> };

export interface Launched {
  app: ElectronApplication;
  win: Page;
  demoRoot: string;
  cleanup: () => void;
}

/** Banner mock-claude prints on start: `ready` on a first launch, `resumed` with `--continue`. */
export const MOCK_CLAUDE_BANNER = /mock-claude (ready|resumed)/;

/** Container of the primary (left-pane, active-tab) terminal. */
export const PRIMARY = '.split-left';

/**
 * Launches the app with an isolated profile and one project dir per name
 * (each with a `.git` and a `notes.txt`).
 *
 * `SHELL=/bin/sh` makes new Terminal tabs and the split's auto-spawned shell a plain POSIX
 * shell: with the isolated HOME, the user's own shell (zsh) would show its
 * new-user setup menu instead of echoing typed commands.
 */
export async function launch(projectNames: string[] = ['alpha']): Promise<Launched> {
  const mockClaude = resolve(process.cwd(), 'scripts/mock-claude.mjs');
  const isolatedHome = mkdtempSync(join(tmpdir(), 'metaide-switch-home-'));
  const demoRoot = mkdtempSync(join(tmpdir(), 'metaide-switch-root-'));
  for (const name of projectNames) {
    const proj = join(demoRoot, name);
    mkdirSync(proj);
    mkdirSync(join(proj, '.git'));
    writeFileSync(join(proj, 'notes.txt'), 'hello from notes\n');
  }
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${join(isolatedHome, 'userData')}`],
    env: {
      ...process.env,
      HOME: isolatedHome,
      SHELL: '/bin/sh',
      METAIDE_TEST_MODE: '1',
      METAIDE_CLAUDE_PERMISSION_MODE: 'bypass',
      METAIDE_DEFAULT_LAUNCH_FIRST:      JSON.stringify({ argv: ['node', mockClaude],               env: {} }),
      METAIDE_DEFAULT_LAUNCH_SUBSEQUENT: JSON.stringify({ argv: ['node', mockClaude, '--continue'], env: {} }),
    },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setSize(1400, 900); });
  await win.evaluate(async (path: string) => {
    await (window as unknown as { api: Api }).api.invoke('roots:add', { path });
  }, demoRoot);
  return {
    app, win, demoRoot,
    cleanup: () => {
      rmSync(isolatedHome, { recursive: true, force: true });
      rmSync(demoRoot, { recursive: true, force: true });
    },
  };
}

/** The sidebar row button for a project, by exact name. */
export function projectRow(win: Page, name: string) {
  return win.locator('[data-testid="project-row"]').filter({ has: win.getByText(name, { exact: true }) }).first();
}

/** Selects a project by sidebar row and waits for its terminal to render. */
export async function openProject(win: Page, name: string): Promise<void> {
  const row = projectRow(win, name);
  await expect(row).toBeVisible({ timeout: 5000 });
  await row.click();
  await waitForProjectShown(win, name);
  await expect(win.locator(`[data-testid="shell-tab"] .xterm-screen`)).toBeVisible({ timeout: 10000 });
}

/** Waits until the main window's title names `name` as the selected project. */
export async function waitForProjectShown(win: Page, name: string): Promise<void> {
  await expect.poll(() => win.title(), { timeout: 10000 }).toBe(`${name} — MetaLogix IDE`);
}

/** Forces `document.activeElement` to `<body>`, as if nothing had been clicked. */
export async function blurToBody(win: Page): Promise<void> {
  await win.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); });
}

/** True iff the active element is an xterm helper textarea inside the given container selector. */
export async function terminalActiveIn(win: Page, containerSelector: string): Promise<boolean> {
  return win.evaluate((sel: string) => {
    const el = document.activeElement;
    if (!el || !(el instanceof HTMLElement)) return false;
    if (!el.classList.contains('xterm-helper-textarea')) return false;
    return !!el.closest(sel);
  }, containerSelector);
}

/**
 * True iff, in one synchronous read, `name` is the selected project (window
 * title) and its primary terminal's helper textarea is the active element.
 * Reading both together rules out a stale focus on the previous project's
 * terminal before the switch commits.
 */
export async function primaryTerminalFocusedFor(win: Page, name: string): Promise<boolean> {
  return win.evaluate(({ title, sel }: { title: string; sel: string }) => {
    if (document.title !== title) return false;
    const el = document.activeElement;
    return el instanceof HTMLElement
      && el.classList.contains('xterm-helper-textarea')
      && !!el.closest(sel);
  }, { title: `${name} — MetaLogix IDE`, sel: PRIMARY });
}

/** Count of xterm helper textareas holding focus anywhere in the page (0 or 1). */
export async function focusedTerminalCount(win: Page): Promise<number> {
  return win.evaluate(() => {
    const el = document.activeElement;
    return el instanceof HTMLElement && el.classList.contains('xterm-helper-textarea') ? 1 : 0;
  });
}

export async function projectIdByName(win: Page, name: string): Promise<number> {
  return win.evaluate(async (n: string) => {
    const api = (window as unknown as { api: Api }).api;
    const { projects } = (await api.invoke('projects:list', undefined)) as unknown as {
      projects: Array<{ id: number; name: string }>;
    };
    const p = projects.find((x) => x.name === n);
    if (!p) throw new Error(`project not found in projects:list: ${n}`);
    return p.id;
  }, name);
}

/** Names of projects with at least one live pty. */
export async function aliveProjectNames(win: Page): Promise<string[]> {
  const { shells } = await win.evaluate(() => (window as unknown as { api: Api }).api
    .invoke('shells:alive-list', undefined) as unknown as Promise<{ shells: Array<{ projectName: string }> }>);
  return [...new Set(shells.map((s) => s.projectName))];
}

/** `shells:snapshot` output of one shell of a project ('' if the shell is not live). */
export async function shellOutput(win: Page, projectName: string, shellIndex: number): Promise<string> {
  const projectId = await projectIdByName(win, projectName);
  return win.evaluate(async (args: { projectId: number; shellIndex: number }) => {
    try {
      const snap = await ((window as unknown as { api: Api }).api
        .invoke('shells:snapshot', args) as unknown as Promise<{ output: string }>);
      return snap.output;
    } catch { return ''; }
  }, { projectId, shellIndex });
}

/** Waits until a shell has printed `pattern` (e.g. the mock-claude banner or a prompt). */
export async function waitForShellOutput(win: Page, projectName: string, shellIndex: number, pattern: RegExp | string): Promise<void> {
  const poll = expect.poll(() => shellOutput(win, projectName, shellIndex), {
    timeout: 10000,
    message: `${projectName} shell ${shellIndex} prints ${String(pattern)}`,
  });
  if (typeof pattern === 'string') await poll.toContain(pattern);
  else await poll.toMatch(pattern);
}

/**
 * Types `text` + Enter at whatever holds keyboard focus, then waits until
 * `expected` (default: `text`) appears in the given shell's pty output. This
 * is the "typed text reaches that shell's pty" half of the spec's definition
 * of a focused terminal.
 */
export async function typeReachesPty(
  win: Page, projectName: string, shellIndex: number, text: string, expected: string = text,
): Promise<void> {
  await win.keyboard.type(text);
  await win.keyboard.press('Enter');
  await expect.poll(() => shellOutput(win, projectName, shellIndex), {
    timeout: 5000,
    message: `typed "${text}" reaches ${projectName} shell ${shellIndex}`,
  }).toContain(expected);
}

/** A marker unlikely to appear in any shell output by accident. */
export function marker(label: string): string {
  return `${label}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * The persisted per-project UI state (`metaide.projectStates`), i.e. what
 * the Shell tab restores for a project: its active shell index and split.
 * `undefined` when the project has no entry yet (it then shows shell 0).
 */
export async function rememberedState(
  win: Page, projectId: number,
): Promise<{ activeShellIndex: number; rightShellIndex: number | null } | undefined> {
  return win.evaluate((id: number) => {
    const raw = localStorage.getItem('metaide.projectStates');
    if (!raw) return undefined;
    const all = JSON.parse(raw) as Record<string, { activeShellIndex: number; rightShellIndex: number | null }>;
    return all[String(id)];
  }, projectId);
}

/**
 * Clicks sidebar rows for each name in order inside ONE page task, so every
 * click's handler runs before any IPC reply can arrive. `HTMLElement.click()`
 * runs the React handler but does not move DOM focus. `after` runs in the
 * same task, right after the last click.
 */
export async function clickRowsInOneTask(
  win: Page, names: string[], after: 'none' | 'focus-sidebar-filter' | 'open-switcher' = 'none',
): Promise<void> {
  await win.evaluate(({ names, after }: { names: string[]; after: string }) => {
    const rows = [...document.querySelectorAll<HTMLElement>('[data-testid="project-row"]')];
    for (const n of names) {
      const row = rows.find((r) => r.textContent?.trim() === n);
      if (!row) throw new Error(`no sidebar row for ${n}`);
      row.click();
    }
    if (after === 'focus-sidebar-filter') {
      const filter = document.querySelector<HTMLInputElement>('input[placeholder="Filter…"]');
      if (!filter) throw new Error('sidebar filter input not found');
      filter.focus();
    } else if (after === 'open-switcher') {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }));
    }
  }, { names, after });
}

/** The project switcher's search input (the switcher has no test id). */
export function switcherInput(win: Page) {
  return win.locator('input[placeholder="Switch to project…"]');
}

/** A project's result button in the open project switcher. */
export function switcherResult(win: Page, name: string) {
  return win.locator('div.fixed', { has: switcherInput(win) })
    .locator('li button')
    .filter({ has: win.getByText(name, { exact: true }) })
    .first();
}

/**
 * Opens a plain shell tab in the selected project from the tab strip's
 * "+" menu ("Terminal") and waits for its prompt. Returns the new shell's
 * index (the project's remembered active shell becomes that index).
 *
 * Not ⌘T: its window keydown handler is registered once and keeps the
 * first render's `setActiveShellIndex`, bound to no project, so ⌘T launches
 * the shell but never switches to its tab (pre-existing, App.tsx).
 */
export async function newShellTab(win: Page, projectName: string): Promise<number> {
  const projectId = await projectIdByName(win, projectName);
  const before = (await rememberedState(win, projectId))?.activeShellIndex ?? 0;
  await win.getByTestId('tabbar-new-shell').click();
  await win.locator('[data-new-shell-menu="1"] button', { hasText: 'Terminal' }).click();
  let idx = before;
  await expect.poll(async () => {
    idx = (await rememberedState(win, projectId))?.activeShellIndex ?? 0;
    return idx;
  }, { timeout: 8000, message: `${projectName} gets a new active shell tab` }).not.toBe(before);
  // `sh -l` prompt (`sh-3.2$ `); the snapshot is serialized terminal state,
  // so match the sigil rather than an anchored line.
  await waitForShellOutput(win, projectName, idx, '$');
  return idx;
}

/**
 * Sends the notification-click IPC (`shell:focus-request`) the way the main
 * process does on a notification click (same pattern as
 * terminal-window-focus.spec.ts AC10).
 */
export async function sendNotificationFocusRequest(
  app: ElectronApplication, payload: { projectId: number; shellIndex: number },
): Promise<void> {
  await app.evaluate(({ BrowserWindow }, p) => {
    const w = BrowserWindow.getAllWindows()[0]!;
    w.blur();
    w.show();
    w.focus();
    w.webContents.send('shell:focus-request', p);
  }, payload);
}

type InvokeHandler = (event: unknown, ...args: unknown[]) => unknown;
interface OpenHold { received: boolean; release: () => void }

/**
 * Holds the main process's `projects:open` reply for one project until
 * `release()`, so a switch to it stays in flight for as long as the test
 * needs (a slow `projects:open`, the case `pick`'s supersede guard exists
 * for). Other projects' opens pass straight through. Replaces the
 * registered handler via Electron's `ipcMain._invokeHandlers` map; the
 * app is closed after each test, so it is never restored.
 */
export async function holdProjectOpen(app: ElectronApplication, projectId: number): Promise<{
  waitReceived: () => Promise<void>;
  release: () => Promise<void>;
}> {
  await app.evaluate(({ ipcMain }, id: number) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers?: Map<string, InvokeHandler> })._invokeHandlers;
    const original = handlers?.get('projects:open');
    if (!original) throw new Error('holdProjectOpen: no projects:open handler in ipcMain._invokeHandlers (Electron internals changed?)');
    let release = (): void => {};
    const gate = new Promise<void>((r) => { release = r; });
    const hold: OpenHold = { received: false, release };
    (globalThis as unknown as { __e2eOpenHold: OpenHold }).__e2eOpenHold = hold;
    ipcMain.removeHandler('projects:open');
    ipcMain.handle('projects:open', async (event, req: { id?: number } | undefined) => {
      if (req?.id === id) { hold.received = true; await gate; }
      return original(event, req);
    });
  }, projectId);
  return {
    waitReceived: () => expect.poll(
      () => app.evaluate(() => (globalThis as unknown as { __e2eOpenHold: OpenHold }).__e2eOpenHold.received),
      { timeout: 5000, message: 'the held projects:open call reached the main process' },
    ).toBe(true),
    release: () => app.evaluate(() => { (globalThis as unknown as { __e2eOpenHold: OpenHold }).__e2eOpenHold.release(); }),
  };
}

/**
 * Keeps every terminal's host at zero size, so ShellTab's open gate (wait
 * for a laid-out host, bail after ~2 s) holds `term.open()` back until
 * `showTerminalHosts`. Stands in for a layout that is not ready yet.
 */
export async function hideTerminalHosts(win: Page): Promise<void> {
  await win.evaluate(() => {
    const style = document.createElement('style');
    style.id = 'e2e-hide-terminal-hosts';
    style.textContent = '[data-testid="shell-tab"] { display: none !important; }';
    document.head.appendChild(style);
  });
}

export async function showTerminalHosts(win: Page): Promise<void> {
  await win.evaluate(() => { document.getElementById('e2e-hide-terminal-hosts')?.remove(); });
}

/**
 * Records every element that gains focus from now on (capturing `focusin`
 * on the document), so a test can prove an element NEVER became
 * `document.activeElement`, not just that it is not focused at the end.
 */
export async function recordFocusins(win: Page): Promise<void> {
  await win.evaluate(() => {
    const w = window as unknown as { __e2eFocusins: EventTarget[] };
    w.__e2eFocusins = [];
    document.addEventListener('focusin', (e) => { if (e.target) w.__e2eFocusins.push(e.target); }, true);
  });
}

/** Stashes the primary pane's current xterm textarea under `label` for a later `focusinsInclude`. */
export async function rememberPrimaryTextarea(win: Page, label: string): Promise<void> {
  await win.evaluate(({ sel, label }: { sel: string; label: string }) => {
    const el = document.querySelector(`${sel} .xterm-helper-textarea`);
    if (!el) throw new Error(`no xterm textarea in ${sel} to remember as ${label}`);
    const w = window as unknown as { __e2eRemembered?: Record<string, Element> };
    (w.__e2eRemembered ??= {})[label] = el;
  }, { sel: PRIMARY, label });
}

/** Whether the element remembered under `label` ever received `focusin` since `recordFocusins`. */
export async function focusinsInclude(win: Page, label: string): Promise<boolean> {
  return win.evaluate((label: string) => {
    const w = window as unknown as { __e2eFocusins: EventTarget[]; __e2eRemembered?: Record<string, Element> };
    const el = w.__e2eRemembered?.[label];
    if (!el) throw new Error(`nothing remembered as ${label}`);
    return w.__e2eFocusins.includes(el);
  }, label);
}
