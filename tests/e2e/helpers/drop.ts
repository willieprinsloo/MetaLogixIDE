/**
 * Helpers for the terminal drop and clipboard-paste suites
 * (tests/e2e/terminal-drop.spec.ts, tests/e2e/terminal-paste-clipboard.spec.ts).
 *
 * Drops are synthetic: an in-page `DataTransfer` carrying `File`s and string
 * data, dispatched as `dragenter` → `dragover` → `drop`. A synthetic `File`
 * has no path on disk, so `webUtils.getPathForFile` returns '' for it.
 *
 * What reached the PTY is read from a main-process spy on `shells:write`
 * (the `ipcMain._invokeHandlers` swap from helpers/terminal-probe.ts), so
 * assertions see the exact bytes, bracketed-paste markers included.
 */

import { expect, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installInvokeRecorder, invokeCalls } from './terminal-probe';
import { closeApp } from './claude-harness';
import { launch, newShellTab, openProject, PRIMARY, type Launched } from './focus';
import { openSplit, RIGHT } from './split';

export { PRIMARY, RIGHT };

export const PROJECT = 'alpha';
export const BP_START = '\x1b[200~';
export const BP_END = '\x1b[201~';

/** A valid 1x1 PNG, so `nativeImage` can decode it and the staged copy can be compared byte for byte. */
export const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
export const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export interface DropFile { name: string; type: string; bytes?: number[]; size?: number }
export interface DropSpec {
  files?: DropFile[];
  text?: string;
  uriList?: string;
  /** The Files-tree payload, set under `APP_FILE_DRAG_TYPE`. */
  appFile?: { type: string; payload: string };
}
export interface DispatchResult { dragoverPrevented: boolean; dropPrevented: boolean }

type BuilderWindow = Window & { __e2eBuildTransfer?: (spec: DropSpec) => DataTransfer };

/**
 * Defines the in-page `DataTransfer` builder once per page load. It is
 * installed as a function literal inside `evaluate` because the renderer's
 * CSP (`script-src 'self'`) forbids building it from a string.
 */
async function ensureBuilder(win: Page): Promise<void> {
  await win.evaluate(() => {
    const w = window as BuilderWindow;
    w.__e2eBuildTransfer ??= (spec: DropSpec): DataTransfer => {
      const dt = new DataTransfer();
      if (spec.appFile) dt.setData(spec.appFile.type, spec.appFile.payload);
      if (spec.uriList !== undefined) dt.setData('text/uri-list', spec.uriList);
      if (spec.text !== undefined) dt.setData('text/plain', spec.text);
      for (const f of spec.files ?? []) {
        const bytes = f.size !== undefined ? new Uint8Array(f.size) : new Uint8Array(f.bytes ?? []);
        dt.items.add(new File([bytes], f.name, { type: f.type }));
      }
      return dt;
    };
  });
}

/**
 * Dispatches `dragenter` → `dragover` → `drop` on `target` with one shared
 * `DataTransfer`, and reports whether the page cancelled `dragover` and `drop`.
 */
export async function dropOn(target: Locator, spec: DropSpec): Promise<DispatchResult> {
  await ensureBuilder(target.page());
  return target.evaluate((el, s) => {
    const dt = (window as BuilderWindow).__e2eBuildTransfer!(s);
    const fire = (type: string): boolean => {
      const ev = new DragEvent(type, { bubbles: true, cancelable: true, composed: true, dataTransfer: dt });
      el.dispatchEvent(ev);
      return ev.defaultPrevented;
    };
    fire('dragenter');
    const dragoverPrevented = fire('dragover');
    const dropPrevented = fire('drop');
    return { dragoverPrevented, dropPrevented };
  }, spec);
}

/** Dispatches a single drag event of `type` (no drop): overlay tests, and `dragstart` to mark a drag as in-app. */
export async function dragEventOn(
  target: Locator, type: 'dragstart' | 'dragend' | 'dragenter' | 'dragover' | 'dragleave', spec: DropSpec,
): Promise<void> {
  await ensureBuilder(target.page());
  await target.evaluate((el, args) => {
    const dt = (window as BuilderWindow).__e2eBuildTransfer!(args.spec);
    el.dispatchEvent(new DragEvent(args.type, { bubbles: true, cancelable: true, composed: true, dataTransfer: dt }));
  }, { spec, type });
}

/**
 * Dispatches `dragover` and `drop` on an element that is not in the document,
 * so no app listener can see it. The AC22 positive control: a synthetic event
 * is not default-prevented unless the app cancels it.
 */
export async function detachedDragPrevented(win: Page, spec: DropSpec): Promise<DispatchResult> {
  await ensureBuilder(win);
  return win.evaluate((s) => {
    const dt = (window as BuilderWindow).__e2eBuildTransfer!(s);
    const el = document.createElement('div');
    const fire = (type: string): boolean => {
      const ev = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt });
      el.dispatchEvent(ev);
      return ev.defaultPrevented;
    };
    return { dragoverPrevented: fire('dragover'), dropPrevented: fire('drop') };
  }, spec);
}

/* ───────────────────────────── recorders ───────────────────────────── */

interface ShellWrite { projectId: number; shellIndex: number; data: string }

/** Spies on `shells:write` in the main process; the real handler still runs. */
export async function recordShellWrites(app: ElectronApplication): Promise<void> {
  await installInvokeRecorder(app, 'shells:write');
}

/** Every `data` written to one shell since `recordShellWrites`, in order. */
export async function shellWrites(app: ElectronApplication, shellIndex: number): Promise<string[]> {
  const calls = (await invokeCalls(app, 'shells:write')) as ShellWrite[];
  return calls.filter((c) => c.shellIndex === shellIndex).map((c) => c.data);
}

/** Waits until `expected` is one complete `shells:write` payload for the shell. */
export async function expectWrite(app: ElectronApplication, shellIndex: number, expected: string, what: string): Promise<void> {
  await expect.poll(() => shellWrites(app, shellIndex), { timeout: 8000, message: what }).toContain(expected);
}

/** Waits for the first write to the shell that contains `needle`, and returns it. */
export async function writeContaining(app: ElectronApplication, shellIndex: number, needle: string, what: string): Promise<string> {
  let found: string | undefined;
  await expect.poll(async () => {
    found = (await shellWrites(app, shellIndex)).find((d) => d.includes(needle));
    return found !== undefined;
  }, { timeout: 8000, message: what }).toBe(true);
  return found!;
}

type InvokeHandler = (event: unknown, request: unknown) => unknown;
type DropCallGlobals = typeof globalThis & { __e2eDropCalls?: Record<string, unknown[]> };

/**
 * Spies on a `drops:*` channel; the real handler still runs. Byte arrays are
 * recorded as `{ byteLength }`: a regression that stages a 50 MB drop would
 * otherwise copy the bytes into the test worker and kill it, instead of
 * failing the assertion that reads these calls.
 */
export async function recordChannel(app: ElectronApplication, channel: string): Promise<void> {
  await app.evaluate(({ ipcMain }, name) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers?: Map<string, InvokeHandler> })._invokeHandlers;
    const original = handlers?.get(name);
    if (!original) throw new Error(`${name} handler unavailable`);
    const globals = globalThis as DropCallGlobals;
    globals.__e2eDropCalls ??= {};
    const calls: unknown[] = (globals.__e2eDropCalls[name] = []);
    ipcMain.removeHandler(name);
    ipcMain.handle(name, (event, request: unknown) => {
      const summary = request && typeof request === 'object'
        ? Object.fromEntries(Object.entries(request).map(([k, v]) => [k, v instanceof Uint8Array ? { byteLength: v.byteLength } : v]))
        : request;
      calls.push(summary);
      return original(event, request);
    });
  }, channel);
}

export async function channelCalls(app: ElectronApplication, channel: string): Promise<unknown[]> {
  return app.evaluate((_electron, name) => [...((globalThis as DropCallGlobals).__e2eDropCalls?.[name] ?? [])], channel);
}

/** Collects uncaught page errors (including unhandled rejections) from now on. */
export function collectPageErrors(win: Page): Error[] {
  const errors: Error[] = [];
  win.on('pageerror', (e) => errors.push(e));
  return errors;
}

/* ───────────────────────────── terminals ───────────────────────────── */

/** The visible `ShellTab` container inside a pane. */
export function shellTab(win: Page, pane: string): Locator {
  return win.locator(`${pane} [data-testid="shell-tab"]`).filter({ visible: true }).first();
}

/** The visible terminal screen inside a pane: where a user drops. */
export function screen(win: Page, pane: string): Locator {
  return win.locator(`${pane} [data-testid="shell-tab"] .xterm-screen`).filter({ visible: true }).first();
}

/** `term.modes.bracketedPasteMode` of the pane's xterm, read through React's fiber (helpers/split.ts technique). */
export async function bracketedPasteMode(win: Page, pane: string): Promise<boolean | null> {
  return win.evaluate((sel: string) => {
    type Term = { modes: { bracketedPasteMode: boolean }; buffer: { active: unknown } };
    type Hook = { memoizedState: unknown; next: Hook | null };
    type Fiber = { tag: number; memoizedState: unknown; return: Fiber | null };
    const isTerm = (v: unknown): v is Term =>
      !!v && typeof v === 'object' && 'modes' in v && 'buffer' in v
      && !!(v as { buffer?: { active?: unknown } }).buffer?.active;
    const host = [...document.querySelectorAll<HTMLElement>(`${sel} [data-testid="shell-tab"] .xterm`)]
      .find((n) => n.offsetParent !== null);
    if (!host) return null;
    let el: HTMLElement | null = host;
    let fiber: Fiber | null = null;
    while (el && !fiber) {
      const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
      if (key) fiber = (el as unknown as Record<string, Fiber>)[key] ?? null;
      el = el.parentElement;
    }
    for (let f = fiber; f; f = f.return) {
      if (f.tag !== 0) continue;
      for (let h = f.memoizedState as Hook | null; h; h = h.next) {
        const ref = h.memoizedState as { current?: unknown } | null;
        if (ref && typeof ref === 'object' && 'current' in ref && isTerm(ref.current)) return ref.current.modes.bracketedPasteMode;
      }
    }
    return null;
  }, pane);
}

export async function expectBracketedPaste(win: Page, pane: string, on: boolean): Promise<void> {
  await expect.poll(() => bracketedPasteMode(win, pane), {
    timeout: 8000, message: `${pane} xterm has bracketed paste ${on ? 'on' : 'off'}`,
  }).toBe(on);
}

/** Focuses the pane's terminal and types a command line + Enter. */
export async function runInPane(win: Page, pane: string, command: string): Promise<void> {
  await screen(win, pane).click();
  await win.keyboard.type(command);
  await win.keyboard.press('Enter');
}

/**
 * Leaves `cat` holding the pane's PTY with DECSET 2004 set (`on`) or reset,
 * so the mode is deterministic whatever the shell would do, and waits until
 * the pane's xterm reports that mode.
 */
export async function holdBracketedPaste(win: Page, pane: string, on: boolean): Promise<void> {
  await runInPane(win, pane, `printf '\\033[?2004${on ? 'h' : 'l'}'; cat`);
  await expectBracketedPaste(win, pane, on);
}

/** Ends the foreground `cat` in a pane. */
export async function interrupt(win: Page, pane: string): Promise<void> {
  await screen(win, pane).click();
  await win.keyboard.press('Control+c');
}

export interface DropFixture extends Launched {
  /** Shell index of the primary (left-pane) plain shell. */
  left: number;
  /** Shell index of the split's right-pane plain shell. */
  right: number;
  projectId: number;
  projectRoot: string;
  pageErrors: Error[];
}

/**
 * Launches the app with one project, makes the primary pane a plain `sh`
 * (shell 0 runs mock Claude), opens the split (a second plain `sh`), and
 * starts the `shells:write` and `drops:stage-file` spies.
 */
export async function launchDropFixture(): Promise<DropFixture> {
  const h = await launch([PROJECT]);
  try {
    await openProject(h.win, PROJECT);
    const left = await newShellTab(h.win, PROJECT);
    const right = await openSplit(h.win, PROJECT);
    const { projectId, projectRoot } = await h.win.evaluate(async (name: string) => {
      const api = (window as unknown as { api: { invoke: (c: string, r: unknown) => Promise<unknown> } }).api;
      const { projects } = (await api.invoke('projects:list', undefined)) as { projects: Array<{ id: number; name: string; path: string }> };
      const p = projects.find((x) => x.name === name);
      if (!p) throw new Error(`project not found in projects:list: ${name}`);
      return { projectId: p.id, projectRoot: p.path };
    }, PROJECT);
    await recordShellWrites(h.app);
    await recordChannel(h.app, 'drops:stage-file');
    return { ...h, left, right, projectId, projectRoot, pageErrors: collectPageErrors(h.win) };
  } catch (e) {
    await closeApp(h.app);
    h.cleanup();
    throw e;
  }
}

/* ───────────────────────────── paths ───────────────────────────── */

/** Ghostty's macOS escape set (spec AC3), written out independently of the app's escaper. */
const POSIX_ESCAPED = new Set(['\\', ' ', '(', ')', '[', ']', '{', '}', '<', '>', '"', "'", '`', '!', '#', '$', '&', ';', '|', '*', '?']);

/** AC3a then AC3: every C0 control (TAB included) and DEL becomes a space, then the AC3 set is escaped. */
export function expectedEscape(path: string): string {
  return [...path.replace(/[\x00-\x1f\x7f]/g, ' ')].map((c) => (POSIX_ESCAPED.has(c) ? `\\${c}` : c)).join('');
}

/** Reverses backslash escaping, to turn an inserted path back into a filesystem path. */
export function unescapePath(escaped: string): string {
  return escaped.replace(/\\(.)/gs, '$1');
}

/**
 * Where a test-mode launch stages dropped and pasted bytes:
 * `<userData>/drops`, userData being the `--user-data-dir` the launch helper
 * passed, so a run never touches the user's real drop directory.
 */
export function dropDir(launched: Pick<Launched, 'userData'>): string {
  return join(launched.userData, 'drops');
}

/** The real per-user drop directory (AC17) as this process sees the OS temp dir; test runs must not write here. */
export function realDropDir(): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  return join(tmpdir(), uid === null ? 'metaide-drops' : `metaide-drops-${uid}`);
}

/** Names of entries in `dir` that start with `prefix`; empty when `dir` does not exist. */
export function stagedWithPrefix(dir: string, prefix: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.startsWith(prefix));
}
