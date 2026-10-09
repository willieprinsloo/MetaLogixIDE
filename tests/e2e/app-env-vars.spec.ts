import { test, expect, _electron as electron, type Locator, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_ENV_COPY, APP_ENV_TESTIDS, ENV_COPY, ENV_TESTIDS } from '../../src/renderer/project-env-copy';
import { baseEnv, launch, openProject, projectId, sendLine, type Api, type Harness } from './helpers/claude-harness';

/**
 * App-wide environment variables, masked values and copy (docs/specs/app-env-settings.md).
 *
 * Why this home can observe the behaviour: like project-env-vars.spec.ts, this suite drives
 * the built Electron app with nothing stubbed — real main process and IPC validation, real
 * SQLite under an isolated HOME + userData, real `PtyManager` spawning real shells. What a
 * shell prints is the environment the child actually received, so precedence is observed at
 * the spawn, not in a pure function. The renderer is the real one, so `type=password`,
 * accessible names, focus order and the system clipboard (read back through Electron's main
 * `clipboard`) are what the user gets. The reveal timer is driven by Playwright's clock
 * (`win.clock.install()` after load evaluates into the already-loaded page, playwright-core
 * 1.61.1); it fakes timers and rAF page-wide, so each clock test owns its app instance.
 *
 * Terminal output is read from `shells:snapshot`. Every printf format carries a marker
 * (`APP[` + `%s`) and assertions match the *expanded* output, so the shell's echo of the
 * typed command can never satisfy them.
 */

const PROJECT_A = 'appenva';
const PROJECT_B = 'appenvb';

let h: Harness | undefined;

test.afterEach(async () => {
  await h?.app.close();
  h?.cleanup();
  h = undefined;
});

// ── IPC helpers ──────────────────────────────────────────────────────────────

async function invoke<T>(win: Page, channel: string, request: unknown): Promise<T> {
  return win.evaluate(async (args: { channel: string; request: unknown }) => {
    const api = (window as unknown as { api: Api }).api;
    return (await api.invoke(args.channel, args.request)) as unknown;
  }, { channel, request }) as Promise<T>;
}

/** Invokes and returns the rejection message, or null when the call resolved. */
async function invokeError(win: Page, channel: string, request: unknown): Promise<string | null> {
  return win.evaluate(async (args: { channel: string; request: unknown }) => {
    const api = (window as unknown as { api: Api }).api;
    try {
      await api.invoke(args.channel, args.request);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }, { channel, request });
}

/** The persisted app-wide map (what storage holds, not what the editor shows). */
async function storedAppEnv(win: Page): Promise<Record<string, string>> {
  return (await invoke<{ value: Record<string, string> }>(win, 'settings:get', { key: 'app_env' })).value;
}

async function storedProjectEnv(win: Page, name: string): Promise<Record<string, string> | undefined> {
  const { projects } = await invoke<{ projects: Array<{ name: string; config: { env?: Record<string, string> } }> }>(win, 'projects:list', undefined);
  const p = projects.find((x) => x.name === name);
  if (!p) throw new Error(`project not found: ${name}`);
  return p.config.env;
}

async function projectPath(win: Page, name: string): Promise<string> {
  const { projects } = await invoke<{ projects: Array<{ name: string; path: string }> }>(win, 'projects:list', undefined);
  const p = projects.find((x) => x.name === name);
  if (!p) throw new Error(`project not found: ${name}`);
  return p.path;
}

async function launchPlain(win: Page, projId: number): Promise<number> {
  return (await invoke<{ shellIndex: number }>(win, 'shells:launch-plain', { projectId: projId })).shellIndex;
}

async function snapshot(win: Page, projId: number, shellIndex: number): Promise<string> {
  return (await invoke<{ output: string }>(win, 'shells:snapshot', { projectId: projId, shellIndex })).output;
}

/** Sends `cmd; printf 'DONE<tag>[]'` and resolves the shell output once the DONE marker is expanded. */
async function runInShell(win: Page, projId: number, shellIndex: number, tag: string, cmd: string): Promise<string> {
  await sendLine(win, projId, shellIndex, `${cmd}; printf 'DONE${tag}[%s]\\n' ok`);
  await expect.poll(() => snapshot(win, projId, shellIndex), { timeout: 15000 }).toContain(`DONE${tag}[ok]`);
  return snapshot(win, projId, shellIndex);
}

/** Relaunches against the same HOME + userData (same env as `launch`), replacing the harness app and window. */
async function relaunch(cur: Harness): Promise<Harness> {
  await cur.app.close();
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${join(cur.isolatedHome, 'userData')}`],
    env: {
      ...baseEnv(),
      HOME: cur.isolatedHome,
      SHELL: '/bin/sh',
      METAIDE_TEST_MODE: '1',
      METAIDE_CLAUDE_PERMISSION_MODE: 'bypass',
      METAIDE_DEFAULT_LAUNCH_FIRST:      JSON.stringify({ argv: [cur.shimPath], env: {} }),
      METAIDE_DEFAULT_LAUNCH_SUBSEQUENT: JSON.stringify({ argv: [cur.shimPath, '--continue'], env: {} }),
    },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setSize(1400, 900); });
  return { ...cur, app, win };
}

// ── Settings → Environment ───────────────────────────────────────────────────

function settingsDialog(win: Page): Locator {
  return win.getByRole('dialog', { name: 'Settings' });
}

function settingsNav(win: Page): Locator {
  return settingsDialog(win).getByRole('navigation', { name: 'Settings sections' });
}

/** The Environment nav item under either accessible name (plain or with the unsaved marker). */
function envNavItem(win: Page): Locator {
  return settingsNav(win).getByRole('button', { name: /^Environment(, unsaved changes)?$/ });
}

function appPanel(win: Page): Locator {
  return win.getByTestId(APP_ENV_TESTIDS.panel);
}

async function openSettings(win: Page): Promise<void> {
  if (!(await win.getByTestId('settings-modal').isVisible())) await win.getByTestId('settings-open').click();
  await expect(settingsDialog(win)).toBeVisible();
}

async function openAppEnv(win: Page): Promise<Locator> {
  await openSettings(win);
  await envNavItem(win).click();
  await expect(appPanel(win)).toBeVisible();
  return appPanel(win);
}

async function closeSettings(win: Page): Promise<void> {
  await win.getByTestId('settings-done').click();
  await expect(win.getByTestId('settings-modal')).toBeHidden();
}

async function selectSection(win: Page, name: string): Promise<void> {
  await settingsNav(win).getByRole('button', { name, exact: true }).click();
}

// ── Project Env tab ──────────────────────────────────────────────────────────

function projectPanel(win: Page): Locator {
  return win.getByTestId(ENV_TESTIDS.panel);
}

async function openEnvTab(win: Page): Promise<Locator> {
  await win.getByTestId(ENV_TESTIDS.tab).click();
  await expect(projectPanel(win)).toBeVisible();
  return projectPanel(win);
}

function inheritedSection(win: Page): Locator {
  return win.getByTestId(ENV_TESTIDS.inherited);
}

/** Selects a project by its sidebar row without waiting for a terminal (the Env tab mounts none). */
async function selectProject(win: Page, name: string): Promise<void> {
  const row = win.locator('[data-testid="project-row"]').filter({ has: win.getByText(name, { exact: true }) }).first();
  await expect(row).toBeVisible();
  await row.click();
  await expect.poll(() => win.title(), { timeout: 10000 }).toBe(`${name} — MetaLogix IDE`);
}

// ── Rows (shared by both editors) ────────────────────────────────────────────

async function addRow(panel: Locator, n: number, name: string, value: string): Promise<void> {
  await panel.getByTestId(ENV_TESTIDS.add).click();
  await panel.getByLabel(ENV_COPY.nameLabel(n), { exact: true }).fill(name);
  if (value !== '') await panel.getByLabel(ENV_COPY.valueLabel(n), { exact: true }).fill(value);
}

function valueInput(panel: Locator, n: number): Locator {
  return panel.getByLabel(ENV_COPY.valueLabel(n), { exact: true });
}

function nameInput(panel: Locator, n: number): Locator {
  return panel.getByLabel(ENV_COPY.nameLabel(n), { exact: true });
}

/** The row's reveal toggle, whichever label it currently has. */
function revealButton(panel: Locator, n: number): Locator {
  return panel.getByRole('button', { name: new RegExp(`^(Show|Hide) value, row ${n}$`) });
}

function copyButton(panel: Locator, n: number): Locator {
  return panel.getByRole('button', { name: ENV_COPY.copyLabel(n), exact: true });
}

function inheritedValue(win: Page, n: number): Locator {
  return inheritedSection(win).getByLabel(ENV_COPY.inheritedValueLabel(n), { exact: true });
}

function inheritedReveal(win: Page, n: number): Locator {
  return inheritedSection(win).getByRole('button', { name: new RegExp(`^(Show|Hide) app-wide value, row ${n}$`) });
}

async function expectMasked(input: Locator): Promise<void> {
  await expect(input).toHaveAttribute('type', 'password');
}

async function expectRevealed(input: Locator): Promise<void> {
  await expect(input).toHaveAttribute('type', 'text');
}

function reason(panel: Locator, text: string): Locator {
  return panel.getByTestId(ENV_TESTIDS.reason).filter({ hasText: text }).first();
}

/** Saves the app-wide editor and waits for storage and the unsaved marker to catch up. */
async function saveAppAndWait(win: Page, expected: Record<string, string>): Promise<void> {
  await appPanel(win).getByTestId(ENV_TESTIDS.save).click();
  await expect.poll(() => storedAppEnv(win), { timeout: 10000 }).toEqual(expected);
  await expect(win.getByTestId(APP_ENV_TESTIDS.unsaved)).toHaveCount(0);
}

async function saveProjectAndWait(win: Page, projectName: string, expected: Record<string, string>): Promise<void> {
  await projectPanel(win).getByTestId(ENV_TESTIDS.save).click();
  await expect.poll(() => storedProjectEnv(win, projectName), { timeout: 10000 }).toEqual(expected);
  await expect(win.getByTestId(ENV_TESTIDS.unsaved)).toHaveCount(0);
}

async function activeId(win: Page): Promise<string> {
  return win.evaluate(() => {
    const el = document.activeElement;
    return `${el?.getAttribute('data-testid') ?? ''}|${el?.getAttribute('aria-label') ?? ''}`;
  });
}

async function focusWindow(win: Page): Promise<void> {
  await win.bringToFront();
  await h!.app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.focus(); });
  await expect.poll(() => win.evaluate(() => document.hasFocus())).toBe(true);
}

async function readClipboard(): Promise<string> {
  return h!.app.evaluate(({ clipboard }) => clipboard.readText());
}

async function writeClipboard(text: string): Promise<void> {
  await h!.app.evaluate(({ clipboard }, t) => clipboard.writeText(t), text);
}

async function toastTexts(win: Page): Promise<string[]> {
  return win.getByTestId('toast').allTextContents();
}

/** Both editors share rows, labels and test ids; only the container and unsaved marker differ. */
interface Editor {
  readonly label: string;
  /** Opens the editor on a fresh harness and returns its panel. */
  readonly open: (win: Page) => Promise<Locator>;
}

const EDITORS: readonly Editor[] = [
  { label: 'app-wide editor', open: (win) => openAppEnv(win) },
  {
    label: 'project editor',
    open: async (win) => {
      await openProject(win, PROJECT_A);
      return openEnvTab(win);
    },
  },
];

// ── Editor: AC1–AC8 ──────────────────────────────────────────────────────────

test('Settings → Environment: nav position, empty state, notices, rules, save, order survives relaunch (AC1, AC2, AC3, AC5, AC8)', async ({}, testInfo) => {
  testInfo.setTimeout(90_000);
  h = await launch([PROJECT_A]);
  await openSettings(h.win);

  // AC1: "Environment" sits right after "Launch commands".
  const navTexts = (await settingsNav(h.win).getByRole('button').allTextContents()).map((t) => t.trim());
  const launchAt = navTexts.indexOf('Launch commands');
  expect(launchAt, `nav items: ${navTexts.join(', ')}`).toBeGreaterThanOrEqual(0);
  expect(navTexts[launchAt + 1]).toBe(APP_ENV_COPY.navLabel);

  // AC8 empty state + Add; AC5 every notice and the hint.
  const panel = await openAppEnv(h.win);
  await expect(envNavItem(h.win)).toHaveAttribute('aria-current', 'page');
  await expect(panel.getByText(APP_ENV_COPY.panelTitle, { exact: true })).toBeVisible();
  await expect(panel.getByTestId(APP_ENV_TESTIDS.empty)).toHaveText(APP_ENV_COPY.emptyState);
  await expect(panel.getByTestId(ENV_TESTIDS.row)).toHaveCount(0);
  await expect(panel.getByTestId(ENV_TESTIDS.add)).toBeVisible();
  for (const notice of [ENV_COPY.noticeNewShells, ENV_COPY.noticeUnencrypted, ENV_COPY.noticeLaunchArgs, ENV_COPY.tokensHint]) {
    await expect(panel.getByText(notice, { exact: true })).toBeVisible();
  }

  // AC2: each rule shows the project editor's reason and disables Save.
  const saveBtn = panel.getByTestId(ENV_TESTIDS.save);
  await addRow(panel, 1, 'KEEP', '1');
  await expect(panel.getByTestId(ENV_TESTIDS.empty)).toHaveCount(0);
  await expect(saveBtn, 'positive control: a valid row enables Save').toBeEnabled();
  await addRow(panel, 2, 'MY-VAR', 'x');
  const name2 = nameInput(panel, 2);
  const cases: Array<[string, string]> = [
    ['MY-VAR', ENV_COPY.reason.invalid],
    ['9LIVES', ENV_COPY.reason.invalid],
    ['A'.repeat(256), ENV_COPY.reason['too-long']],
    ['metaide_token', ENV_COPY.reason.reserved],
    ['METAIDE_HOOK_TOKEN', ENV_COPY.reason.reserved],
    ['__proto__', ENV_COPY.reason.reserved],
    ['KEEP', ENV_COPY.reason.duplicate],
  ];
  for (const [bad, text] of cases) {
    await name2.fill(bad);
    await expect(reason(panel, text), `reason for ${bad.slice(0, 20)}`).toBeVisible();
    await expect(saveBtn, `Save disabled for ${bad.slice(0, 20)}`).toBeDisabled();
  }
  // Case-sensitive duplicates only: `keep` beside `KEEP` is valid (positive control for the rules above).
  await name2.fill('keep');
  await expect(panel.getByTestId(ENV_TESTIDS.reason)).toHaveCount(0);
  await expect(saveBtn).toBeEnabled();

  // AC2/AC27: a NUL in a value shows its reason while masked; the reason never carries the value.
  const value2 = valueInput(panel, 2);
  await value2.fill('NULSECRET\u0000tail');
  await expectMasked(value2);
  await expect(reason(panel, ENV_COPY.reason.nul)).toBeVisible();
  await expect(saveBtn).toBeDisabled();
  for (const t of await panel.getByTestId(ENV_TESTIDS.reason).allTextContents()) expect(t).not.toContain('NULSECRET');
  await value2.fill('x');
  await expect(panel.getByTestId(ENV_TESTIDS.reason)).toHaveCount(0);

  // Replace with the rows to persist, in non-alphabetical order so order is observable.
  await panel.getByLabel(ENV_COPY.removeLabel(2), { exact: true }).click();
  await panel.getByLabel(ENV_COPY.removeLabel(1), { exact: true }).click();
  await addRow(panel, 1, 'Z_LAST', 'z-${HOME}');
  await addRow(panel, 2, 'A_FIRST', 'a');
  await addRow(panel, 3, 'M_MID', 'm');
  await saveAppAndWait(h.win, { Z_LAST: 'z-${HOME}', A_FIRST: 'a', M_MID: 'm' });
  expect(Object.keys(await storedAppEnv(h.win))).toEqual(['Z_LAST', 'A_FIRST', 'M_MID']);

  // AC3: after a relaunch the editor shows the same names, values and order, all masked.
  h = await relaunch(h);
  const after = await openAppEnv(h.win);
  const names = after.getByTestId(ENV_TESTIDS.name);
  await expect(names).toHaveCount(3);
  for (const [i, [n, v]] of [['Z_LAST', 'z-${HOME}'], ['A_FIRST', 'a'], ['M_MID', 'm']].entries()) {
    await expect(nameInput(after, i + 1)).toHaveValue(n!);
    await expect(nameInput(after, i + 1)).not.toHaveAttribute('type', 'password');
    await expect(valueInput(after, i + 1)).toHaveValue(v!);
    await expectMasked(valueInput(after, i + 1));
  }
});

test('app-wide drafts survive section switches and closing Settings; nav marker and name; lost on app close (AC7, AC20)', async ({}, testInfo) => {
  testInfo.setTimeout(90_000);
  h = await launch([PROJECT_A]);
  const panel = await openAppEnv(h.win);
  await addRow(panel, 1, 'STORED', 'stored');
  await saveAppAndWait(h.win, { STORED: 'stored' });
  // Control: no draft → plain nav name, no marker.
  await expect(settingsNav(h.win).getByRole('button', { name: APP_ENV_COPY.navLabel, exact: true })).toBeVisible();
  await expect(h.win.getByTestId(APP_ENV_TESTIDS.unsaved)).toHaveCount(0);

  await valueInput(panel, 1).fill('draft-value');
  await addRow(panel, 2, 'ADDED', 'added');
  await expect(h.win.getByTestId(APP_ENV_TESTIDS.unsaved)).toBeVisible();
  await expect(settingsNav(h.win).getByRole('button', { name: APP_ENV_COPY.navUnsavedLabel, exact: true })).toBeVisible();

  const expectDraft = async (where: string): Promise<void> => {
    const p = appPanel(h!.win);
    await expect(p.getByTestId(ENV_TESTIDS.row), where).toHaveCount(2);
    await expect(valueInput(p, 1), where).toHaveValue('draft-value');
    await expect(nameInput(p, 2), where).toHaveValue('ADDED');
    // AC20: rows restored from a draft are masked.
    await expectMasked(valueInput(p, 1));
    await expectMasked(valueInput(p, 2));
    await expect(h!.win.getByTestId(APP_ENV_TESTIDS.unsaved), where).toBeVisible();
  };

  await selectSection(h.win, 'General');
  await expect(appPanel(h.win)).toHaveCount(0);
  // The marker is on the nav item, so it shows while another section is open.
  await expect(settingsNav(h.win).getByRole('button', { name: APP_ENV_COPY.navUnsavedLabel, exact: true })).toBeVisible();
  await envNavItem(h.win).click();
  await expectDraft('after a section switch');

  await closeSettings(h.win);
  await openAppEnv(h.win);
  await expectDraft('after closing and reopening Settings');
  expect(await storedAppEnv(h.win), 'drafts are not persisted').toEqual({ STORED: 'stored' });

  // Lost on app close: the stored map comes back, no marker.
  h = await relaunch(h);
  const fresh = await openAppEnv(h.win);
  await expect(fresh.getByTestId(ENV_TESTIDS.row)).toHaveCount(1);
  await expect(valueInput(fresh, 1)).toHaveValue('stored');
  await expect(h.win.getByTestId(APP_ENV_TESTIDS.unsaved)).toHaveCount(0);
});

test('main rejects an invalid app-wide map over IPC, names the key only, writes nothing; generic settings:set refuses app_env (AC4)', async ({}, testInfo) => {
  testInfo.setTimeout(60_000);
  h = await launch([PROJECT_A]);
  const { win } = h;

  // Positive control: a valid map is accepted, returned and stored.
  expect(await invoke<{ env: Record<string, string> }>(win, 'settings:set-app-env', { env: { KEEP: '1' } })).toEqual({ env: { KEEP: '1' } });
  expect(await storedAppEnv(win)).toEqual({ KEEP: '1' });

  const SECRET = 'S3CRET-AC4-VALUE';
  const bad: Array<{ env: unknown; key: string | null }> = [
    { env: { 'MY-VAR': SECRET }, key: 'MY-VAR' },
    { env: { '9LIVES': SECRET }, key: '9LIVES' },
    { env: { metaide_token: SECRET }, key: 'metaide_token' },
    { env: { ['A'.repeat(256)]: SECRET }, key: 'A'.repeat(256) },
    { env: { GOOD: 'fine', NULVAL: `${SECRET}\u0000x` }, key: 'NULVAL' },
    { env: { NUM: 42 }, key: 'NUM' },
    { env: [SECRET], key: null },
    { env: SECRET, key: null },
  ];
  for (const { env, key } of bad) {
    const msg = await invokeError(win, 'settings:set-app-env', { env });
    expect(msg, `rejected: ${key ?? JSON.stringify(env).slice(0, 30)}`).not.toBeNull();
    expect(msg!).toMatch(/app environment/i);
    if (key) expect(msg!).toContain(key);
    expect(msg!).not.toContain(SECRET);
    expect(await storedAppEnv(win), 'nothing written').toEqual({ KEEP: '1' });
  }

  // The generic setter is not a bypass.
  expect(await invokeError(win, 'settings:set', { key: 'app_env', value: { 'MY-VAR': SECRET } })).not.toBeNull();
  expect(await storedAppEnv(win)).toEqual({ KEEP: '1' });

  // Control: the validated path still works after the rejections.
  await invoke(win, 'settings:set-app-env', { env: { KEEP: '2' } });
  expect(await storedAppEnv(win)).toEqual({ KEEP: '2' });
});

test('app-wide save failure keeps the draft; the value is in no toast, no DOM text and not the log (AC6)', async ({}, testInfo) => {
  testInfo.setTimeout(60_000);
  h = await launch([PROJECT_A]);
  const { app, win } = h;
  const SECRET = 'S3CRET-AC6-VALUE';
  const panel = await openAppEnv(win);
  await addRow(panel, 1, 'E2E_SECRET', SECRET);

  // Force main's handler to fail. Not restored: this test owns its app instance.
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('settings:set-app-env');
    ipcMain.handle('settings:set-app-env', () => { throw new Error('forced failure for KEYNAME'); });
  });
  await panel.getByTestId(ENV_TESTIDS.save).click();

  // Positive control: the failure toast appeared.
  await expect(win.getByTestId('toast').filter({ hasText: ENV_COPY.saveFailed }).first()).toBeVisible({ timeout: 10000 });
  const toasts = await toastTexts(win);
  expect(toasts.length).toBeGreaterThan(0);
  for (const t of toasts) expect(t).not.toContain(SECRET);
  // Rendered text (input values excluded) holds the toast but never the value.
  const bodyText = await win.evaluate(() => document.body.innerText);
  expect(bodyText).toContain(ENV_COPY.saveFailed);
  expect(bodyText).not.toContain(SECRET);

  // Draft and marker kept; nothing stored.
  await expect(nameInput(panel, 1)).toHaveValue('E2E_SECRET');
  await expect(valueInput(panel, 1)).toHaveValue(SECRET);
  await expectMasked(valueInput(panel, 1));
  await expect(win.getByTestId(APP_ENV_TESTIDS.unsaved)).toBeVisible();
  expect(await storedAppEnv(win)).toEqual({});

  // Main-process log: the forced error reached it (positive control), the value did not.
  const { path: logPath } = await invoke<{ path: string }>(win, 'app:get-log-path', undefined);
  await expect.poll(() => readFileSync(logPath, 'utf8'), { timeout: 10000 }).toContain('forced failure for KEYNAME');
  expect(readFileSync(logPath, 'utf8')).not.toContain(SECRET);
});

// ── Spawn precedence: AC9–AC16 ───────────────────────────────────────────────

test('S1: a variable saved in Settings reaches new shells in every project without restart; running shells keep theirs (AC9, AC16)', async ({}, testInfo) => {
  testInfo.setTimeout(90_000);
  h = await launch([PROJECT_A, PROJECT_B]);
  const { win } = h;
  await openProject(win, PROJECT_A);
  const idA = await projectId(win, PROJECT_A);
  const idB = await projectId(win, PROJECT_B);

  const panel = await openAppEnv(win);
  await addRow(panel, 1, 'E2E_APPTOKEN', 'token-one');
  await saveAppAndWait(win, { E2E_APPTOKEN: 'token-one' });
  await closeSettings(win);

  const shellA = await launchPlain(win, idA);
  const shellB = await launchPlain(win, idB);
  expect(await runInShell(win, idA, shellA, 'A1', `printf 'APP1[%s]\\n' "$E2E_APPTOKEN"`)).toContain('APP1[token-one]');
  expect(await runInShell(win, idB, shellB, 'B1', `printf 'APP1[%s]\\n' "$E2E_APPTOKEN"`)).toContain('APP1[token-one]');

  // Change it while both shells run.
  const again = await openAppEnv(win);
  await valueInput(again, 1).fill('token-two');
  await saveAppAndWait(win, { E2E_APPTOKEN: 'token-two' });
  await closeSettings(win);

  // Running shells keep the old value (the APP2 marker printing is the positive control).
  const outA = await runInShell(win, idA, shellA, 'A2', `printf 'APP2[%s]\\n' "$E2E_APPTOKEN"`);
  expect(outA).toContain('APP2[token-one]');
  expect(outA).not.toContain('APP2[token-two]');

  // New shells in both projects get the new value, no restart.
  const newA = await launchPlain(win, idA);
  const newB = await launchPlain(win, idB);
  expect(await runInShell(win, idA, newA, 'A3', `printf 'APP3[%s]\\n' "$E2E_APPTOKEN"`)).toContain('APP3[token-two]');
  expect(await runInShell(win, idB, newB, 'B3', `printf 'APP3[%s]\\n' "$E2E_APPTOKEN"`)).toContain('APP3[token-two]');
});

test('precedence and interpolation at every spawn site: primary, plain, inline CLI, task (AC9–AC14)', async ({}, testInfo) => {
  testInfo.setTimeout(150_000);
  // Inherited-only names, plus a PATH entry that reaches a shell only via ${env.PATH}.
  const inheritedBin = mkdtempSync(join(tmpdir(), 'metaide-e2e-appenv-inh-'));
  const origPath = process.env.PATH;
  process.env.PATH = `${inheritedBin}:${origPath ?? ''}`;
  process.env.E2E_INH = 'inh-val';
  process.env.E2E_SHADOW = 'inh-shadow';
  try {
    h = await launch([PROJECT_A, PROJECT_B]);
  } finally {
    process.env.PATH = origPath;
    delete process.env.E2E_INH;
    delete process.env.E2E_SHADOW;
  }
  const { win, demoRoot, isolatedHome } = h;
  const idA = await projectId(win, PROJECT_A);
  const idB = await projectId(win, PROJECT_B);

  // Primary launch: a plain sh whose argv echoes two `${env.…}` tokens, with template env.
  await invoke(win, 'settings:set', {
    key: 'default_launch_cmd.first',
    value: {
      argv: ['/bin/sh', '-c', "printf 'ARGV[%s|%s]\\n' '${env.E2E_ARGX}' '${env.E2E_TMPL}'; exec /bin/sh"],
      env: { E2E_TMPL: 'tmpl-val', E2E_OVR: 'tmpl-ovr' },
    },
  });
  await invoke(win, 'settings:set-app-env', {
    env: {
      E2E_APP: 'app-val',
      E2E_OVR: 'app-ovr',
      E2E_TMPL: 'app-tmpl',
      E2E_EMPTY: 'app-nonempty',
      E2E_SHADOW: 'app-shadow',
      E2E_ARGX: 'app-argx',
      BASE: '/opt',
      // AC12: paths and ${env.NAME} (inherited only — another app var and an unset name give '').
      E2E_PATHS: '${HOME}|${PROJECT_PATH}|${PROJECT_NAME}|${env.E2E_INH}|${env.E2E_APP}|${env.E2E_UNSET_NAME}',
      PATH: '${env.PATH}:/e2e-app-bin',
    },
  });
  await invoke(win, 'projects:update-config', {
    id: idA,
    config: {
      env: {
        E2E_OVR: 'proj-ovr',
        E2E_EMPTY: '',
        P: '${env.BASE}/x',
        E2E_PT: '${env.E2E_TMPL}',
        PATH: '/e2e-proj-bin:${env.PATH}',
        E2E_ARGX: 'proj-argx',
      },
    },
  });
  // Task site: an npm script in B (no lockfile → `npm run`).
  writeFileSync(join(demoRoot, PROJECT_B, 'package.json'), JSON.stringify({
    name: 'appenvb',
    private: true,
    scripts: { e2eappenv: "printf 'TASK[%s|%s]\\n' \"$E2E_APP\" \"$E2E_OVR\" && sleep 60" },
  }));

  const PRINT_ALL =
    `printf 'APP[%s]\\n' "$E2E_APP"; printf 'OVR[%s]\\n' "$E2E_OVR"; printf 'TMPL[%s]\\n' "$E2E_TMPL"; ` +
    `printf 'EMPTY[%s|%s]\\n' "\${E2E_EMPTY-unset}" "\${E2E_EMPTY+set}"; printf 'SHADOW[%s]\\n' "$E2E_SHADOW"; ` +
    `printf 'P[%s]\\n' "$P"; printf 'PT[%s]\\n' "$E2E_PT"; printf 'PATHS[%s]\\n' "$E2E_PATHS"; ` +
    `pidx() { echo "$PATH" | tr ':' '\\n' | grep -n -x -F -e "$1" | cut -d: -f1 | head -1; }; ` +
    `printf 'PATHIDX[%s,%s,%s]\\n' "$(pidx /e2e-proj-bin)" "$(pidx ${inheritedBin})" "$(pidx /e2e-app-bin)"`;
  const pathIdx = (out: string): [string, string, string] => {
    const m = /PATHIDX\[(\d*),(\d*),(\d*)\]/.exec(out);
    expect(m, 'PATHIDX printed').not.toBeNull();
    return [m![1]!, m![2]!, m![3]!];
  };

  // ── Project A, primary launch (template env present, project vars present) ──
  await openProject(win, PROJECT_A);
  const pathA = await projectPath(win, PROJECT_A);
  await expect.poll(() => snapshot(win, idA, 0), { timeout: 15000 }).toMatch(/ARGV\[[^\]\n]*\|/);
  const primA = await runInShell(win, idA, 0, 'PA', PRINT_ALL);
  expect(primA, 'AC14: argv sees the project value on a clash, template env otherwise').toContain('ARGV[proj-argx|tmpl-val]');
  expect(primA, 'AC9 primary').toContain('APP[app-val]');
  expect(primA, 'AC10 project > template > app').toContain('OVR[proj-ovr]');
  expect(primA, 'AC10 template > app').toContain('TMPL[tmpl-val]');
  expect(primA, 'AC11 set and empty').toContain('EMPTY[|set]');
  expect(primA, 'AC10 app > inherited').toContain('SHADOW[app-shadow]');
  expect(primA, 'AC13 project reads app via ${env}').toContain('P[/opt/x]');
  expect(primA, 'AC13 project reads template via ${env}').toContain('PT[tmpl-val]');
  expect(primA, 'AC12').toContain(`PATHS[${isolatedHome}|${pathA}|${PROJECT_A}|inh-val||]`);
  const [projI, inhI, appI] = pathIdx(primA);
  expect(projI && inhI && appI, `all three PATH entries present: ${projI},${inhI},${appI}`).toBeTruthy();
  expect(Number(projI), 'AC13 PATH: project bin first').toBeLessThan(Number(inhI));
  expect(Number(inhI), 'AC13 PATH: app bin after inherited').toBeLessThan(Number(appI));

  // ── Project A, inline CLI (template env from the request) ──
  const cliA = (await invoke<{ shellIndex: number }>(win, 'shells:launch-cli', {
    projectId: idA, argv: ['/bin/sh'], env: { E2E_TMPL: 'cli-tmpl', E2E_OVR: 'cli-ovr' },
  })).shellIndex;
  const cliOutA = await runInShell(win, idA, cliA, 'CA', PRINT_ALL);
  expect(cliOutA, 'AC9 CLI').toContain('APP[app-val]');
  expect(cliOutA).toContain('TMPL[cli-tmpl]');
  expect(cliOutA).toContain('OVR[proj-ovr]');
  expect(cliOutA).toContain('EMPTY[|set]');

  // ── Project B (no project variables): primary, plain, CLI, task ──
  await openProject(win, PROJECT_B);
  const pathB = await projectPath(win, PROJECT_B);
  await expect.poll(() => snapshot(win, idB, 0), { timeout: 15000 }).toMatch(/ARGV\[[^\]\n]*\|/);
  const primB = await runInShell(win, idB, 0, 'PB', PRINT_ALL);
  expect(primB, 'AC14: no project value → template/app value in argv').toContain('ARGV[app-argx|tmpl-val]');
  expect(primB).toContain('APP[app-val]');
  expect(primB, 'AC10 template > app').toContain('OVR[tmpl-ovr]');
  expect(primB, 'AC11 control: no project override → app value').toContain('EMPTY[app-nonempty|set]');
  expect(primB, 'AC12 resolved for the project being spawned').toContain(`PATHS[${isolatedHome}|${pathB}|${PROJECT_B}|inh-val||]`);
  const [projIB, , appIB] = pathIdx(primB);
  expect(projIB, 'project A bin absent from B').toBe('');
  expect(appIB, 'app bin present in B').not.toBe('');

  const plainB = await launchPlain(win, idB);
  const plainOutB = await runInShell(win, idB, plainB, 'LB', PRINT_ALL);
  expect(plainOutB, 'AC9 plain').toContain('APP[app-val]');
  expect(plainOutB, 'plain: no template → app').toContain('OVR[app-ovr]');
  expect(plainOutB).toContain('TMPL[app-tmpl]');

  const cliB = (await invoke<{ shellIndex: number }>(win, 'shells:launch-cli', {
    projectId: idB, argv: ['/bin/sh'], env: { E2E_OVR: 'cli-ovr' },
  })).shellIndex;
  const cliOutB = await runInShell(win, idB, cliB, 'CB', PRINT_ALL);
  expect(cliOutB).toContain('APP[app-val]');
  expect(cliOutB, 'AC10 template > app').toContain('OVR[cli-ovr]');

  const { tasks } = await invoke<{ tasks: Array<{ id: string }> }>(win, 'tasks:discover', { projectId: idB });
  expect(tasks.map((t) => t.id)).toContain('npm:e2eappenv');
  const taskIdx = (await invoke<{ shellIndex: number }>(win, 'tasks:run', { projectId: idB, taskId: 'npm:e2eappenv' })).shellIndex;
  await expect.poll(() => snapshot(win, idB, taskIdx), { timeout: 30000, message: 'AC9 task run' }).toContain('TASK[app-val|app-ovr]');
});

// ── Inherited view: AC17–AC19 ────────────────────────────────────────────────

test('project Env tab lists app-wide variables read-only, updates live, marks saved overrides, opens Settings (AC17, AC18, AC19, AC20)', async ({}, testInfo) => {
  testInfo.setTimeout(90_000);
  h = await launch([PROJECT_A]);
  const { win } = h;
  await openProject(win, PROJECT_A);
  const panel = await openEnvTab(win);

  // Empty line + open-settings button.
  await expect(inheritedSection(win).getByText(ENV_COPY.inheritedTitle, { exact: true })).toBeVisible();
  await expect(win.getByTestId(ENV_TESTIDS.inheritedEmpty)).toHaveText(ENV_COPY.inheritedEmpty);
  await expect(win.getByTestId(ENV_TESTIDS.inheritedRow)).toHaveCount(0);
  // Sits below Save/Discard (D14).
  const saveBox = await panel.getByTestId(ENV_TESTIDS.save).boundingBox();
  const inhBox = await inheritedSection(win).boundingBox();
  expect(saveBox && inhBox && inhBox.y >= saveBox.y + saveBox.height, 'inherited section below Save').toBe(true);

  // Mark the mounted tab, to prove the later update arrives without a remount.
  await panel.evaluate((el) => { (el as HTMLElement).dataset.e2eMounted = '1'; });

  await win.getByTestId(ENV_TESTIDS.openAppEnv).click();
  await expect(settingsDialog(win)).toBeVisible();
  await expect(envNavItem(win)).toHaveAttribute('aria-current', 'page');
  const app = appPanel(win);
  await expect(app).toBeVisible();
  await addRow(app, 1, 'SHARED', 'app-shared');
  await addRow(app, 2, 'ONLY_APP', 'app-only');
  // A8: an unsaved Settings draft is not listed.
  await expect(win.getByTestId(ENV_TESTIDS.inheritedRow)).toHaveCount(0);
  await saveAppAndWait(win, { SHARED: 'app-shared', ONLY_APP: 'app-only' });
  await closeSettings(win);

  // AC17 live update, same mount.
  await expect(projectPanel(win)).toHaveAttribute('data-e2e-mounted', '1');
  const rows = win.getByTestId(ENV_TESTIDS.inheritedRow);
  await expect(rows).toHaveCount(2);
  await expect(win.getByTestId(ENV_TESTIDS.inheritedEmpty)).toHaveCount(0);
  await expect(rows.nth(0).getByTestId(ENV_TESTIDS.inheritedName)).toHaveText('SHARED');
  await expect(rows.nth(1).getByTestId(ENV_TESTIDS.inheritedName)).toHaveText('ONLY_APP');
  for (const [n, v] of [[1, 'app-shared'], [2, 'app-only']] as const) {
    await expect(inheritedValue(win, n)).toHaveValue(v);
    await expectMasked(inheritedValue(win, n));
    await expect(inheritedValue(win, n)).not.toBeEditable();
  }
  // AC19: no editable inputs (control: two read-only ones exist).
  await expect(inheritedSection(win).locator('input')).toHaveCount(2);
  await expect(inheritedSection(win).locator('input:not([readonly])')).toHaveCount(0);
  await expect(inheritedSection(win).getByRole('button', { name: ENV_COPY.inheritedRevealLabel(1), exact: true })).toBeVisible();
  await expect(inheritedSection(win).getByRole('button', { name: ENV_COPY.inheritedCopyLabel(2), exact: true })).toBeVisible();
  // Distinct names: no editable-row label is reused by an inherited control.
  await expect(inheritedSection(win).getByRole('button', { name: ENV_COPY.revealLabel(1), exact: true })).toHaveCount(0);

  // AC18: a draft-only name is not "overridden"; a saved one is, in text.
  await expect(win.getByTestId(ENV_TESTIDS.inheritedOverridden)).toHaveCount(0);
  await addRow(panel, 1, 'SHARED', 'proj-shared');
  await expect(win.getByTestId(ENV_TESTIDS.inheritedOverridden), 'draft does not mark').toHaveCount(0);
  await saveProjectAndWait(win, PROJECT_A, { SHARED: 'proj-shared' });
  await expect(rows.nth(0).getByTestId(ENV_TESTIDS.inheritedOverridden)).toHaveText(ENV_COPY.inheritedOverridden);
  await expect(rows.nth(0).getByText(ENV_COPY.inheritedOverridden, { exact: true })).toBeVisible();
  await expect(rows.nth(1).getByTestId(ENV_TESTIDS.inheritedOverridden), 'control: ONLY_APP not marked').toHaveCount(0);

  // AC19 reveal on an inherited row: only that row; the editable row stays masked.
  await inheritedReveal(win, 1).click();
  await expectRevealed(inheritedValue(win, 1));
  await expect(inheritedSection(win).getByRole('button', { name: ENV_COPY.inheritedHideLabel(1), exact: true })).toBeVisible();
  await expect(inheritedReveal(win, 1)).not.toHaveAttribute('aria-pressed', /.*/);
  await expectMasked(inheritedValue(win, 2));
  await expectMasked(valueInput(panel, 1));

  // AC19 copy on an inherited row: raw value, row stays masked, toast without value or name.
  await focusWindow(win);
  await writeClipboard('sentinel-before');
  await inheritedSection(win).getByRole('button', { name: ENV_COPY.inheritedCopyLabel(2), exact: true }).click();
  await expect.poll(readClipboard).toBe('app-only');
  await expectMasked(inheritedValue(win, 2));
  await expect(win.getByTestId('toast').filter({ hasText: ENV_COPY.copied }).first()).toBeVisible();
  for (const t of await toastTexts(win)) {
    expect(t).not.toContain('app-only');
    expect(t).not.toContain('ONLY_APP');
  }
});

test('inherited row stays masked after its name is removed and re-added with a new value within the reveal window (AC19, AC20)', async ({}, testInfo) => {
  testInfo.setTimeout(60_000);
  h = await launch([PROJECT_A]);
  const { win } = h;
  await openProject(win, PROJECT_A);
  await openEnvTab(win);

  const app0 = await openAppEnv(win);
  await addRow(app0, 1, 'FOO', 'old-secret');
  await saveAppAndWait(win, { FOO: 'old-secret' });
  await closeSettings(win);

  // Positive control: FOO is actually revealed before the Settings edits, so the
  // masked check below would fail if the reveal state were never keyed to the row.
  await inheritedReveal(win, 1).click();
  await expectRevealed(inheritedValue(win, 1));
  await expect(inheritedReveal(win, 1)).toHaveAccessibleName(ENV_COPY.inheritedHideLabel(1));

  const app1 = await openAppEnv(win);
  await app1.getByLabel(ENV_COPY.removeLabel(1), { exact: true }).click();
  await saveAppAndWait(win, {});
  await addRow(app1, 1, 'FOO', 'new-secret');
  await saveAppAndWait(win, { FOO: 'new-secret' });
  await closeSettings(win);

  // FOO reappears with the new value; it must be masked again, not still revealed.
  await expect(inheritedValue(win, 1)).toHaveValue('new-secret');
  await expectMasked(inheritedValue(win, 1));
  await expect(inheritedReveal(win, 1)).toHaveAccessibleName(ENV_COPY.inheritedRevealLabel(1));
});

// ── Masking, reveal, editing while masked: AC20, AC21, AC26 ──────────────────

for (const editor of EDITORS) {
  test(`${editor.label}: every value masked, reveal is per row, masked fields stay editable (AC20, AC21, AC26)`, async ({}, testInfo) => {
    testInfo.setTimeout(60_000);
    h = await launch([PROJECT_A]);
    const { win } = h;
    const panel = await editor.open(win);
    await addRow(panel, 1, 'ONE', 'one');
    await addRow(panel, 2, 'TWO', 'two');
    await addRow(panel, 3, 'THREE', '');

    // AC20: new rows masked (including the empty one); names never.
    for (const n of [1, 2, 3]) {
      await expectMasked(valueInput(panel, n));
      await expect(nameInput(panel, n)).not.toHaveAttribute('type', 'password');
      await expect(nameInput(panel, n)).toBeVisible();
      await expect(revealButton(panel, n)).toHaveAccessibleName(ENV_COPY.revealLabel(n));
    }

    // AC21: reveal row 2 only; label switches; no aria-pressed.
    await revealButton(panel, 2).click();
    await expectRevealed(valueInput(panel, 2));
    await expect(revealButton(panel, 2)).toHaveAccessibleName(ENV_COPY.hideLabel(2));
    await expect(revealButton(panel, 2)).not.toHaveAttribute('aria-pressed', /.*/);
    await expectMasked(valueInput(panel, 1));
    await expectMasked(valueInput(panel, 3));
    await expect(revealButton(panel, 1)).toHaveAccessibleName(ENV_COPY.revealLabel(1));

    // AC26: type, select, delete and paste into masked row 1; draft updates; stays masked.
    const v1 = valueInput(panel, 1);
    await v1.click();
    await v1.press('End');
    await v1.pressSequentially('-typed');
    await expect(v1).toHaveValue('one-typed');
    await expectMasked(v1);
    await v1.press('ControlOrMeta+a');
    await v1.press('Backspace');
    await expect(v1).toHaveValue('');
    await expectMasked(v1);
    await focusWindow(win);
    await writeClipboard('pasted-value');
    await v1.focus();
    await v1.press('ControlOrMeta+v');
    await expect(v1).toHaveValue('pasted-value');
    await expectMasked(v1);
    // Row 2's reveal is unaffected by edits elsewhere; hiding it masks at once.
    await expectRevealed(valueInput(panel, 2));
    await revealButton(panel, 2).click();
    await expectMasked(valueInput(panel, 2));
    await expect(revealButton(panel, 2)).toHaveAccessibleName(ENV_COPY.revealLabel(2));
  });
}

// ── Row-slot reuse after reveal: AC20 regression ─────────────────────────────

for (const editor of EDITORS) {
  test(`${editor.label}: remove a revealed row then Add reuses its slot masked (AC20)`, async ({}, testInfo) => {
    testInfo.setTimeout(60_000);
    h = await launch([PROJECT_A]);
    const { win } = h;
    const panel = await editor.open(win);
    await addRow(panel, 1, 'ONE', 'one');
    await addRow(panel, 2, 'TWO', 'two');

    // Positive control: row 2 is actually revealed, proving the type=password check
    // below would fail if the bug reopened — type stays 'text' until masked back.
    await revealButton(panel, 2).click();
    await expectRevealed(valueInput(panel, 2));
    await expect(revealButton(panel, 2)).toHaveAccessibleName(ENV_COPY.hideLabel(2));

    await panel.getByLabel(ENV_COPY.removeLabel(2), { exact: true }).click();
    await expect(panel.getByTestId(ENV_TESTIDS.row)).toHaveCount(1);
    await panel.getByTestId(ENV_TESTIDS.add).click();

    const fresh = valueInput(panel, 2);
    await expect(fresh).toHaveValue('');
    await expectMasked(fresh);
    await expect(revealButton(panel, 2)).toHaveAccessibleName(ENV_COPY.revealLabel(2));
  });

  test(`${editor.label}: reveal an added row, Discard, then Add reuses its slot masked (AC20)`, async ({}, testInfo) => {
    testInfo.setTimeout(60_000);
    h = await launch([PROJECT_A]);
    const { win } = h;
    const panel = await editor.open(win);
    await addRow(panel, 1, 'ONE', 'one');

    // Positive control: row 1 is actually revealed before the Discard.
    await revealButton(panel, 1).click();
    await expectRevealed(valueInput(panel, 1));
    await expect(revealButton(panel, 1)).toHaveAccessibleName(ENV_COPY.hideLabel(1));

    await panel.getByTestId(ENV_TESTIDS.discard).click();
    await expect(panel.getByTestId(ENV_TESTIDS.row)).toHaveCount(0);
    await panel.getByTestId(ENV_TESTIDS.add).click();

    const fresh = valueInput(panel, 1);
    await expect(fresh).toHaveValue('');
    await expectMasked(fresh);
    await expect(revealButton(panel, 1)).toHaveAccessibleName(ENV_COPY.revealLabel(1));
  });
}

// ── Copy: AC28–AC32 ──────────────────────────────────────────────────────────

for (const editor of EDITORS) {
  test(`${editor.label}: copy writes the raw draft value while masked; toasts never carry it; empty disables; failure leaves the row alone (AC28–AC32)`, async ({}, testInfo) => {
    testInfo.setTimeout(60_000);
    h = await launch([PROJECT_A]);
    const { win } = h;
    const panel = await editor.open(win);
    const RAW = '${PROJECT_PATH}/raw-${env.HOME}';
    await addRow(panel, 1, 'COPY_ME', RAW);
    await addRow(panel, 2, 'EMPTY_ONE', '');

    // AC31: empty → disabled; a value enables it (positive control).
    await expect(copyButton(panel, 2)).toBeDisabled();
    await expect(copyButton(panel, 1)).toBeEnabled();

    // AC28 tooltip on hover.
    await copyButton(panel, 1).hover();
    await expect(win.getByRole('tooltip').filter({ hasText: ENV_COPY.copyTooltip })).toBeVisible();

    // AC28/AC29/AC30: raw (unexpanded, unsaved) value; row stays masked; toast is constant.
    await focusWindow(win);
    await writeClipboard('sentinel-before');
    await copyButton(panel, 1).click();
    await expect.poll(readClipboard).toBe(RAW);
    await expectMasked(valueInput(panel, 1));
    await expect(revealButton(panel, 1)).toHaveAccessibleName(ENV_COPY.revealLabel(1));
    const ok = win.getByTestId('toast').filter({ hasText: ENV_COPY.copied }).first();
    await expect(ok).toBeVisible();
    for (const t of await toastTexts(win)) {
      expect(t).not.toContain('raw-');
      expect(t).not.toContain('COPY_ME');
    }

    // Copy follows the draft: edit, copy again.
    await valueInput(panel, 2).fill('second');
    await expect(copyButton(panel, 2)).toBeEnabled();
    await copyButton(panel, 2).click();
    await expect.poll(readClipboard).toBe('second');

    // AC32: a rejected write shows the error toast, without the value; the row and clipboard are unchanged.
    await win.evaluate(() => {
      Object.defineProperty(navigator.clipboard, 'writeText', {
        configurable: true,
        value: () => Promise.reject(new DOMException('denied', 'NotAllowedError')),
      });
    });
    await copyButton(panel, 1).click();
    await expect(win.getByTestId('toast').filter({ hasText: ENV_COPY.copyFailed }).first()).toBeVisible();
    for (const t of await toastTexts(win)) {
      expect(t).not.toContain('raw-');
      expect(t).not.toContain('COPY_ME');
    }
    await expectMasked(valueInput(panel, 1));
    await expect(valueInput(panel, 1)).toHaveValue(RAW);
    expect(await readClipboard(), 'failed copy wrote nothing').toBe('second');
  });
}

// ── Keyboard: AC33 ───────────────────────────────────────────────────────────

test('keyboard: app-wide row order, Enter and Space toggle reveal, focus ring and tooltip on focus, Enter in a value does not save (AC33, AC21, AC28)', async ({}, testInfo) => {
  testInfo.setTimeout(60_000);
  h = await launch([PROJECT_A]);
  const { win } = h;
  const panel = await openAppEnv(win);
  await addRow(panel, 1, 'A_ONE', '1');
  await addRow(panel, 2, 'B_TWO', '2');

  await nameInput(panel, 1).focus();
  const seen: string[] = [await activeId(win)];
  for (let i = 0; i < 12; i++) {
    await win.keyboard.press('Tab');
    seen.push(await activeId(win));
  }
  const rowIds = (n: number): string[] => [
    `${ENV_TESTIDS.name}|${ENV_COPY.nameLabel(n)}`,
    `${ENV_TESTIDS.value}|${ENV_COPY.valueLabel(n)}`,
    `${ENV_TESTIDS.reveal}|${ENV_COPY.revealLabel(n)}`,
    `${ENV_TESTIDS.copy}|${ENV_COPY.copyLabel(n)}`,
    `${ENV_TESTIDS.remove}|${ENV_COPY.removeLabel(n)}`,
  ];
  expect(seen).toEqual([...rowIds(1), ...rowIds(2), `${ENV_TESTIDS.add}|`, `${ENV_TESTIDS.discard}|`, `${ENV_TESTIDS.save}|`]);

  // Focus ring: none at rest (control), visible on keyboard focus; tooltip shows on focus.
  const reveal1 = revealButton(panel, 1);
  await nameInput(panel, 1).focus();
  expect(await reveal1.evaluate((el) => getComputedStyle(el).boxShadow)).toBe('none');
  await win.keyboard.press('Tab');
  await win.keyboard.press('Tab');
  await expect(reveal1).toBeFocused();
  await expect.poll(() => reveal1.evaluate((el) => getComputedStyle(el).boxShadow), { message: 'reveal focus ring' }).not.toBe('none');
  await expect(win.getByRole('tooltip').filter({ hasText: ENV_COPY.revealTooltip })).toBeVisible();

  // Enter and Space toggle.
  await win.keyboard.press('Enter');
  await expectRevealed(valueInput(panel, 1));
  await expect(reveal1).toHaveAccessibleName(ENV_COPY.hideLabel(1));
  await win.keyboard.press('Space');
  await expectMasked(valueInput(panel, 1));
  await expect(reveal1).toHaveAccessibleName(ENV_COPY.revealLabel(1));

  // Copy by keyboard; ring on copy too.
  await focusWindow(win);
  await writeClipboard('sentinel-before');
  await reveal1.focus();
  await win.keyboard.press('Tab');
  const copy1 = copyButton(panel, 1);
  await expect(copy1).toBeFocused();
  await expect.poll(() => copy1.evaluate((el) => getComputedStyle(el).boxShadow), { message: 'copy focus ring' }).not.toBe('none');
  await win.keyboard.press('Enter');
  await expect.poll(readClipboard).toBe('1');
  await writeClipboard('sentinel-space');
  await win.keyboard.press('Space');
  await expect.poll(readClipboard).toBe('1');

  // Enter in a value field neither saves nor discards.
  await valueInput(panel, 2).press('Enter');
  await expect(panel.getByTestId(ENV_TESTIDS.row)).toHaveCount(2);
  await expect(win.getByTestId(APP_ENV_TESTIDS.unsaved)).toBeVisible();
  expect(await storedAppEnv(win)).toEqual({});
});

test('keyboard: project tab reaches the inherited rows after Save, reveal then copy per row (AC33)', async ({}, testInfo) => {
  testInfo.setTimeout(60_000);
  h = await launch([PROJECT_A]);
  const { win } = h;
  await invoke(win, 'settings:set-app-env', { env: { APP_ONE: '1', APP_TWO: '2' } });
  await openProject(win, PROJECT_A);
  const panel = await openEnvTab(win);
  await expect(win.getByTestId(ENV_TESTIDS.inheritedRow)).toHaveCount(2);
  await addRow(panel, 1, 'P_ONE', 'p');

  await panel.getByTestId(ENV_TESTIDS.save).focus();
  const seen: string[] = [];
  for (let i = 0; i < 8; i++) {
    await win.keyboard.press('Tab');
    seen.push(await activeId(win));
  }
  const inheritedOrder = seen.filter((s) => / app-wide value, row \d$/.test(s));
  expect(inheritedOrder, seen.join('\n')).toEqual([
    `${ENV_TESTIDS.reveal}|${ENV_COPY.inheritedRevealLabel(1)}`,
    `${ENV_TESTIDS.copy}|${ENV_COPY.inheritedCopyLabel(1)}`,
    `${ENV_TESTIDS.reveal}|${ENV_COPY.inheritedRevealLabel(2)}`,
    `${ENV_TESTIDS.copy}|${ENV_COPY.inheritedCopyLabel(2)}`,
  ]);

  // Space on an inherited reveal toggles it, by keyboard.
  await inheritedReveal(win, 2).focus();
  await win.keyboard.press('Space');
  await expectRevealed(inheritedValue(win, 2));
  await expectMasked(inheritedValue(win, 1));
});

// ── Auto-hide timer (controlled clock): AC22–AC24 ────────────────────────────

/** Installs the fake clock on the loaded page and pauses it, so time moves only through `runFor`. */
async function pauseClock(win: Page): Promise<void> {
  await win.clock.install();
  const now = await win.evaluate(() => Date.now());
  await win.clock.pauseAt(now + 1000);
}

test('app-wide editor: reveal auto-hides at 39 s, timers are per row, hide cancels and re-reveal restarts (AC22, AC23, AC24)', async ({}, testInfo) => {
  testInfo.setTimeout(90_000);
  h = await launch([PROJECT_A]);
  const { win } = h;
  const panel = await openAppEnv(win);
  await addRow(panel, 1, 'ONE', 'one');
  await addRow(panel, 2, 'TWO', 'two');
  await pauseClock(win);
  const v1 = valueInput(panel, 1);
  const v2 = valueInput(panel, 2);

  // AC22 + AC23: row 1 at t=0, row 2 at t=20 s.
  await revealButton(panel, 1).click();
  await expectRevealed(v1);
  await win.clock.runFor(20_000);
  await revealButton(panel, 2).click();
  await expectRevealed(v2);
  await win.clock.runFor(18_900); // t = 38.9 s
  await expectRevealed(v1);
  await expectRevealed(v2);
  await win.clock.runFor(100); // t = 39.0 s
  await expectMasked(v1);
  await expect(revealButton(panel, 1)).toHaveAccessibleName(ENV_COPY.revealLabel(1));
  await expectRevealed(v2);
  await win.clock.runFor(19_900); // t = 58.9 s
  await expectRevealed(v2);
  await win.clock.runFor(100); // t = 59.0 s
  await expectMasked(v2);

  // AC24: hide at 10 s masks at once; re-reveal gets a fresh 39 s, not the old deadline.
  await revealButton(panel, 1).click();
  await win.clock.runFor(10_000);
  await revealButton(panel, 1).click();
  await expectMasked(v1);
  await revealButton(panel, 1).click();
  await expectRevealed(v1);
  await win.clock.runFor(30_000); // past where the cancelled timer would have fired
  await expectRevealed(v1);
  await win.clock.runFor(8_900); // 38.9 s after re-reveal
  await expectRevealed(v1);
  await win.clock.runFor(100);
  await expectMasked(v1);

  // AC26: typing while revealed does not restart the timer (A3).
  await revealButton(panel, 2).click();
  await win.clock.runFor(30_000);
  await v2.focus();
  await v2.press('End');
  await v2.pressSequentially('x');
  await expect(v2).toHaveValue('twox');
  await win.clock.runFor(9_000);
  await expectMasked(v2);
});

test('project editor: editable and inherited rows auto-hide independently at 39 s (AC22, AC23, AC19)', async ({}, testInfo) => {
  testInfo.setTimeout(90_000);
  h = await launch([PROJECT_A]);
  const { win } = h;
  await invoke(win, 'settings:set-app-env', { env: { APP_ONE: 'app-one' } });
  await openProject(win, PROJECT_A);
  const panel = await openEnvTab(win);
  await addRow(panel, 1, 'P_ONE', 'p-one');
  await expect(win.getByTestId(ENV_TESTIDS.inheritedRow)).toHaveCount(1);
  await pauseClock(win);

  await inheritedReveal(win, 1).click();
  await expectRevealed(inheritedValue(win, 1));
  await win.clock.runFor(5_000);
  await revealButton(panel, 1).click();
  await expectRevealed(valueInput(panel, 1));
  await win.clock.runFor(33_900); // inherited at 38.9 s
  await expectRevealed(inheritedValue(win, 1));
  await win.clock.runFor(100); // inherited at 39.0 s, editable at 34.0 s
  await expectMasked(inheritedValue(win, 1));
  await expectRevealed(valueInput(panel, 1));
  await win.clock.runFor(5_000); // editable at 39.0 s
  await expectMasked(valueInput(panel, 1));
});

// ── Leaving the editor masks everything: AC25 ────────────────────────────────

test('leaving either editor masks every value: tab switch, project switch, Settings section, Settings close (AC25)', async ({}, testInfo) => {
  testInfo.setTimeout(90_000);
  h = await launch([PROJECT_A, PROJECT_B]);
  const { win } = h;
  await invoke(win, 'settings:set-app-env', { env: { APP_ONE: 'app-one' } });
  await openProject(win, PROJECT_A);
  let panel = await openEnvTab(win);
  await addRow(panel, 1, 'P_ONE', 'p-one');

  const revealProjectRows = async (): Promise<void> => {
    await revealButton(projectPanel(win), 1).click();
    await inheritedReveal(win, 1).click();
    await expectRevealed(valueInput(projectPanel(win), 1));
    await expectRevealed(inheritedValue(win, 1));
  };
  const expectProjectMasked = async (where: string): Promise<void> => {
    await expect(valueInput(projectPanel(win), 1), where).toHaveValue('p-one');
    await expectMasked(valueInput(projectPanel(win), 1));
    await expectMasked(inheritedValue(win, 1));
  };

  await revealProjectRows();
  await win.getByRole('button', { name: 'Files', exact: true }).click();
  await expect(projectPanel(win)).toHaveCount(0);
  panel = await openEnvTab(win);
  await expectProjectMasked('after Files and back');

  await revealProjectRows();
  await selectProject(win, PROJECT_B);
  await openEnvTab(win);
  await selectProject(win, PROJECT_A);
  await openEnvTab(win);
  await expectProjectMasked('after another project and back');

  const app = await openAppEnv(win);
  await revealButton(app, 1).click();
  await expectRevealed(valueInput(app, 1));
  await selectSection(win, 'General');
  await expect(appPanel(win)).toHaveCount(0);
  await envNavItem(win).click();
  await expectMasked(valueInput(appPanel(win), 1));

  await revealButton(appPanel(win), 1).click();
  await expectRevealed(valueInput(appPanel(win), 1));
  await closeSettings(win);
  const reopened = await openAppEnv(win);
  await expectMasked(valueInput(reopened, 1));
  await expect(valueInput(reopened, 1)).toHaveValue('app-one');
});
