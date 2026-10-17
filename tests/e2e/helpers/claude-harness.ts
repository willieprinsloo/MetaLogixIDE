/**
 * Real Electron/PTY harness shared by Claude notification and agent-status
 * journeys. The fake CLI renders deterministic terminal screens and, only
 * when the app supplies settings, forwards Claude notification hooks.
 */
import { _electron as electron, expect, type Page, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

export type Api = { invoke: (c: string, r: unknown) => Promise<never> };
export type Recorded = { title: string; body: string; closed: boolean };

export const MOCK_CLAUDE = resolve(process.cwd(), 'scripts/mock-claude.mjs');

/**
 * `process.env` with any ambient `METAIDE_HOOK_SHELL`/`METAIDE_HOOK_TOKEN`
 * stripped, for spreading into `electron.launch({ env })`. This suite's own
 * process can inherit those two vars for real — this dev environment runs
 * this very session as a hook-decorated Claude shell inside MetaLogixIDE
 * itself, so `process.env` here genuinely carries a live session's
 * credentials. `PtyManager` merges `{...process.env, ...launch.env}` for
 * every spawn, so without this, a plain (non-Claude) shell in the launched
 * test app would inherit those leaked credentials and falsely appear
 * hook-decorated (AC5's "no METAIDE_HOOK_* env at all" only holds for a
 * properly isolated launch).
 */
export function baseEnv(): NodeJS.ProcessEnv {
  const rest = { ...process.env };
  delete rest.METAIDE_HOOK_SHELL;
  delete rest.METAIDE_HOOK_TOKEN;
  delete rest.METAIDE_OMP_STATUS_PORT;
  delete rest.METAIDE_OMP_STATUS_TOKEN;
  delete rest.METAIDE_OMP_STATUS_SPAWN;
  // This test runner itself can be nested in OMP. App-launched child OMP is a
  // new root session, not a child of the runner's ambient OMP process.
  delete rest.OMPCODE;
  return rest;
}

/** A named executable on both POSIX and Windows (ConPTY launches .cmd via cmd.exe /c). */
export function makeClaudeShim(homeDir: string): string {
  const binDir = join(homeDir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const windows = process.platform === 'win32';
  const shimPath = join(binDir, windows ? 'claude.cmd' : 'claude');
  if (windows) writeFileSync(shimPath, `@echo off\r\n"${process.execPath}" "${MOCK_CLAUDE}" %*\r\n`);
  else {
    writeFileSync(shimPath, `#!/bin/bash\nexec -a claude "${process.execPath}" "${MOCK_CLAUDE}" "$@"\n`);
    chmodSync(shimPath, 0o755);
  }
  return shimPath;
}

export interface Harness {
  app: ElectronApplication;
  win: Page;
  isolatedHome: string;
  demoRoot: string;
  shimPath: string;
  cleanup: () => void;
}

/**
 * Launches the app with an isolated HOME + userData, bypass permission mode
 * (so no first-run dialog), and the `claude` shim wired as both the
 * `first` and `subsequent` (`--continue`) default launch commands. Creates
 * one project directory per name under a fresh demo root, but does not open
 * any of them.
 */
export async function launch(projectNames: string[]): Promise<Harness> {
  return guardedLaunch(async (scope) => {
    const isolatedHome = scope.tempDir('metaide-notif-home-');
    const demoRoot = scope.tempDir('metaide-notif-root-');
    for (const name of projectNames) {
      const proj = join(demoRoot, name);
      mkdirSync(proj);
      mkdirSync(join(proj, '.git'));
    }
    const shimPath = makeClaudeShim(isolatedHome);
    const app = scope.own(await electron.launch({
      ...(process.env.METAIDE_PACKAGED_APP ? { executablePath: process.env.METAIDE_PACKAGED_APP } : {}),
      args: [...(process.env.METAIDE_PACKAGED_APP ? [] : ['.']), `--user-data-dir=${join(isolatedHome, 'userData')}`],
      env: {
        ...baseEnv(),
        HOME: isolatedHome,
        ...(process.platform === 'win32' ? { USERPROFILE: isolatedHome } : { SHELL: '/bin/bash' }),
        PATH: `${join(isolatedHome, 'bin')}${delimiter}${process.env.PATH ?? ''}`,
        METAIDE_TEST_MODE: '1',
        METAIDE_CLAUDE_PERMISSION_MODE: 'bypass',
        METAIDE_DEFAULT_LAUNCH_FIRST: JSON.stringify({ argv: [shimPath], env: {} }),
        METAIDE_DEFAULT_LAUNCH_SUBSEQUENT: JSON.stringify({ argv: [shimPath, '--continue'], env: {} }),
      },
    }));
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setSize(1400, 900); });
    await win.evaluate(async (path: string) => {
      await (window as unknown as { api: Api }).api.invoke('roots:add', { path });
    }, demoRoot);
    return {
      app, win, isolatedHome, demoRoot, shimPath,
      cleanup: () => {
        rmSync(isolatedHome, { recursive: true, force: true });
        rmSync(demoRoot, { recursive: true, force: true });
      },
    };
  });
}

/* ───────────────────────── launch teardown guard ───────────────────────── */

/**
 * Launch setup must finish within this budget, so a wedged launch fails
 * inside `guardedLaunch` (and is torn down) rather than at the 60 s test
 * timeout, which abandons the helper mid-await and runs no catch block.
 */
export const LAUNCH_BUDGET_MS = 45_000;

/** How long `closeApp` waits for a graceful `app.close()` before SIGKILLing the process group. */
const CLOSE_GRACE_MS = 10_000;

export interface LaunchScope {
  /** Creates a temp dir that is removed if the launch fails. */
  tempDir(prefix: string): string;
  /** Registers the launched app so a failed launch closes it; returns it unchanged. */
  own(app: ElectronApplication): ElectronApplication;
}

/**
 * Closes `app` without ever throwing: a graceful `close()` bounded by
 * `CLOSE_GRACE_MS`, then SIGKILL of the Electron process group (Playwright
 * spawns it detached on POSIX, so `-pid` also reaches its PTY children).
 */
export async function closeApp(app: ElectronApplication): Promise<void> {
  const proc = app.process();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      app.close(),
      new Promise((resolveGrace) => { timer = setTimeout(resolveGrace, CLOSE_GRACE_MS); }),
    ]);
  } catch {
    // Best effort: fall through to the kill below.
  } finally {
    clearTimeout(timer);
  }
  if (proc.exitCode !== null || proc.signalCode !== null || proc.pid === undefined) return;
  try {
    if (process.platform === 'win32') proc.kill('SIGKILL');
    else process.kill(-proc.pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

/**
 * Runs a launch helper's setup so a throw, or overrunning `budgetMs`, closes
 * any app it registered with `scope.own` and removes every `scope.tempDir`,
 * then rethrows the original error. An app registered after the budget has
 * already failed the launch is closed as soon as it is registered.
 */
export async function guardedLaunch<T>(
  setup: (scope: LaunchScope) => Promise<T>,
  budgetMs: number = LAUNCH_BUDGET_MS,
): Promise<T> {
  const dirs: string[] = [];
  const apps: ElectronApplication[] = [];
  let failed = false;
  const scope: LaunchScope = {
    tempDir(prefix) {
      const dir = mkdtempSync(join(tmpdir(), prefix));
      dirs.push(dir);
      if (failed) rmSync(dir, { recursive: true, force: true });
      return dir;
    },
    own(app) {
      apps.push(app);
      if (failed) void closeApp(app);
      return app;
    },
  };
  let timer: NodeJS.Timeout | undefined;
  const budget = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`launch setup exceeded ${budgetMs} ms`)), budgetMs);
  });
  try {
    return await Promise.race([setup(scope), budget]);
  } catch (error) {
    failed = true;
    await Promise.all(apps.map(closeApp));
    for (const dir of dirs) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Resolves a project's id by name via `projects:list`. */
export async function projectId(win: Page, name: string): Promise<number> {
  return win.evaluate(async (n: string) => {
    const api = (window as unknown as { api: Api }).api;
    const { projects } = (await api.invoke('projects:list', undefined)) as unknown as { projects: Array<{ id: number; name: string }> };
    const p = projects.find((x) => x.name === n);
    if (!p) throw new Error(`project not found: ${n}`);
    return p.id;
  }, name);
}

/** Opens a project via its sidebar row and waits for its primary shell to render. */
export async function openProject(win: Page, name: string): Promise<void> {
  // A project already open shows its sidebar row twice — under "In use" and
  // under "All projects" (project-lifecycle sections) — so scope by exact
  // text and take the first match, like focus.ts's projectRow.
  const row = win.locator('[data-testid="project-row"]').filter({ has: win.getByText(name, { exact: true }) }).first();
  await expect(row).toBeVisible({ timeout: 5000 });
  await row.click();
  await expect.poll(() => win.title(), { timeout: 10000 }).toBe(`${name} — MetaLogix IDE`);
  await expect(win.locator('.xterm').first()).toBeVisible({ timeout: 10000 });
  // `useReportViewedShells` reports the new view asynchronously over IPC;
  // give it a beat so a suppression assertion right after this call doesn't
  // race the report (a race would show as a spurious notification, not a
  // real bug).
  await win.waitForTimeout(300);
}

/** Sends a line of input directly to a shell's PTY, regardless of which tab is on screen (`prompts:paste`). */
export async function sendLine(win: Page, projId: number, shellIndex: number, text: string): Promise<void> {
  await win.evaluate(async (args: { projectId: number; shellIndex: number; text: string }) => {
    const api = (window as unknown as { api: Api }).api;
    await api.invoke('prompts:paste', { projectId: args.projectId, shellIndex: args.shellIndex, text: args.text, submit: true });
  }, { projectId: projId, shellIndex, text });
}

/** Waits until a shell's serialized terminal output contains `pattern`. */
export async function waitForShell(win: Page, projId: number, shellIndex: number, pattern: string): Promise<void> {
  await expect.poll(async () => {
    return win.evaluate(async (args: { projectId: number; shellIndex: number }) => {
      const api = (window as unknown as { api: Api }).api;
      const snap = await api.invoke('shells:snapshot', args) as unknown as { output: string };
      return snap.output;
    }, { projectId: projId, shellIndex });
  }, { timeout: 10000, message: `shell ${projId}:${shellIndex} prints ${pattern}` }).toContain(pattern);
}

/** Waits for a confirmed hook receipt, not a screen state: Stop eligibility uses hook history. */
export async function sendAndConfirmUserPrompt(win: Page, projectId: number, shellIndex: number, text: string): Promise<void> {
  const count = async (): Promise<number> => win.evaluate(async (shell: { projectId: number; shellIndex: number }) => {
    const appWindow = window as unknown as { api: Api };
    const snap = await appWindow.api.invoke('shells:snapshot', shell) as unknown as { output: string };
    return snap.output.split('HOOK-ACK UserPromptSubmit').length - 1;
  }, { projectId, shellIndex });
  const before = await count();
  await sendLine(win, projectId, shellIndex, text);
  await expect.poll(count, { timeout: 5000, message: `UserPromptSubmit accepted for ${projectId}:${shellIndex}` }).toBeGreaterThan(before);
}

export async function aliveShells(win: Page): Promise<Array<{ projectId: number; shellIndex: number; launchArgv: string[] }>> {
  return win.evaluate(async () => {
    const api = (window as unknown as { api: Api }).api;
    const { shells } = await api.invoke('shells:alive-list', undefined) as unknown as { shells: Array<{ projectId: number; shellIndex: number; launchArgv: string[] }> };
    return shells;
  });
}


/** A shell's real hook credentials plus the receiver's authenticated POST URL. */
export interface HookCredentials { url: string; shellId: string; token: string }

/**
 * Resolves a hook-tracked shell's real session id + token (via `/hook-env`)
 * and the receiver's URL (from the app's own settings file under
 * `isolatedHome`), so a test can POST a hook event directly to the
 * receiver — bypassing the PTY entirely. Call this ONLY while the shell is
 * idle or busy, never while it might be blocked: `/hook-env` is itself
 * typed through the PTY (`sendLine`), and its own submit Enter would answer
 * a blocked shell (AC7), contaminating the very state under test. The
 * returned credentials are then safe to reuse for the rest of the test,
 * since a session's id/token never change for the life of its spawn.
 */
export async function hookCredentials(win: Page, isolatedHome: string, projId: number, shellIndex: number): Promise<HookCredentials> {
  const hooksDir = join(isolatedHome, '.metaide', 'claude-hooks');
  const settingsFile = readdirSync(hooksDir).find((f) => f.startsWith('settings-'));
  if (!settingsFile) throw new Error(`no app-owned hook settings file found under ${hooksDir}`);
  const settings = JSON.parse(readFileSync(join(hooksDir, settingsFile), 'utf8')) as {
    hooks: { Notification: Array<{ hooks: Array<{ url: string }> }> };
  };
  const url = settings.hooks.Notification[0]!.hooks[0]!.url;
  await sendLine(win, projId, shellIndex, '/hook-env');
  await waitForShell(win, projId, shellIndex, 'HOOK-ENV shell=');
  const snap = await win.evaluate(async (args: { projectId: number; shellIndex: number }) => {
    const api = (window as unknown as { api: Api }).api;
    const s = await api.invoke('shells:snapshot', args) as unknown as { output: string };
    return s.output;
  }, { projectId: projId, shellIndex });
  const m = /HOOK-ENV shell=(\S+) token=(\S+)/.exec(snap);
  if (!m) throw new Error(`no HOOK-ENV line in shell ${shellIndex} output`);
  return { url, shellId: m[1]!, token: m[2]! };
}

/**
 * POSTs one hook event straight to the receiver (authenticated), bypassing
 * the PTY entirely — for a diagnostic event that must reach an
 * already-blocked shell without the delivery mechanism itself answering
 * the prompt (see `hookCredentials`).
 */
export async function postRawHook(creds: HookCredentials, body: Record<string, unknown>): Promise<Response> {
  return fetch(creds.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Metaide-Shell': creds.shellId, Authorization: `Bearer ${creds.token}` },
    body: JSON.stringify(body),
  });
}

/**
 * Patches the main process's `Notification` class so every instance is
 * recorded instead of actually shown (deterministic across platforms/CI —
 * no dependency on a real OS notification daemon), and `isSupported()`
 * always reports true. Must run before the event that would construct one.
 */
export async function installNotificationSpy(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ Notification }) => {
    type Rec = { title: string; body: string; closed: boolean; instance: { emit: (e: string) => void } };
    const g = globalThis as unknown as { __e2eNotifications: Rec[] };
    g.__e2eNotifications = [];
    (Notification as unknown as { isSupported: () => boolean }).isSupported = () => true;
    const proto = Notification.prototype as unknown as {
      show: () => void; close: () => void; title: string; body: string; emit: (e: string) => void;
    };
    proto.show = function (this: Rec & { title: string; body: string }) {
      g.__e2eNotifications.push({ title: this.title, body: this.body, closed: false, instance: this as unknown as Rec['instance'] });
    };
    proto.close = function (this: { emit: (e: string) => void }) {
      const rec = g.__e2eNotifications.find((r) => r.instance === (this as unknown as Rec['instance']));
      if (rec) rec.closed = true;
      this.emit('close');
    };
  });
}

/** Every notification recorded so far, in show() order. */
export async function notifications(app: ElectronApplication): Promise<Recorded[]> {
  return app.evaluate(() => {
    const g = globalThis as unknown as { __e2eNotifications: Recorded[] };
    return g.__e2eNotifications.map(({ title, body, closed }) => ({ title, body, closed }));
  });
}

/** Fires a `click` on the notification at `index`, exactly what a real OS click does (Notification is an EventEmitter). */
export async function clickNotification(app: ElectronApplication, index: number): Promise<void> {
  await app.evaluate((_electron, idx: number) => {
    const g = globalThis as unknown as { __e2eNotifications: Array<{ instance: { emit: (e: string) => void } }> };
    const rec = g.__e2eNotifications[idx];
    if (!rec) throw new Error(`no recorded notification at index ${idx}`);
    rec.instance.emit('click');
  }, index);
}
