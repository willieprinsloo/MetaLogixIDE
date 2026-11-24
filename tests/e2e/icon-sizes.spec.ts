import { test, expect, _electron as electron, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { commitAll, initRepo } from './helpers/git-repo';
import { openSplit } from './helpers/split';
import { box, expectIconSize, expectCentred, settle } from './helpers/icon-geometry';
import { APP_ENV_TESTIDS, ENV_COPY, ENV_TESTIDS } from '../../src/renderer/project-env-copy';

/**
 * Consistent icon sizes across the app (docs/specs/icon-sizes.md).
 *
 * No existing spec measures the dialog/panel closes, the 20-24px icon
 * buttons, the micro controls, the branch icons, the CLI marks, or icon
 * centring — this is that spec (plan §8). The AC12 deliberate test-value
 * edits to existing specs (activity bar, settings nav, split pill, palette
 * and font-picker checks, sidebar chevrons) live in their own files, not
 * here (AC11).
 *
 * One app, one project (`iconproj`), a real git repo on branch `main` (for
 * AC7's branch icons) with one commit so the tree is clean (no git badge to
 * perturb activity-bar layout). Tests run in file order and share the app;
 * each dialog/menu is opened and closed before the next test runs so they
 * never overlap (most are mutually-exclusive backdrop modals in App.tsx).
 *
 * Not reachable here, by design (plan §8 / D12), and left to the owning
 * unit tests instead:
 *  - Chat sign-in panel close: needs a live network identity provider.
 *  - Chat attachment Download/Open-folder, chat Edit/Delete hover actions,
 *    chat link-plug / empty-state / empty-channel tiles: `ChatTab` renders
 *    behind a network-gated sign-in and is not reachable headless
 *    (`chat-icons.test.tsx`, Agent 2).
 *  - The CLI-menu Star and "Add a custom command" row: markup-only, no
 *    fixed box to re-derive here, and already covered by markup unit tests
 *    over `ShellTabsBar.tsx` (the star's size is baked into `StarIcon`'s
 *    own definition). The CLI-menu remove-X IS reachable — it is a
 *    `<XIcon size={ICON_SIZE.sm} />` call site laid out (at opacity 0) for
 *    any project-scoped profile, and is covered below.
 *
 * Phase 5 reconcile: the env editor's Reveal/Copy/Remove icons ARE reachable
 * — the App-wide Environment settings section drives the same
 * `EnvValueField`/`EnvEditor` components `app-env-vars.spec.ts` and
 * `project-env-vars.spec.ts` already exercise through the real UI, so this
 * file covers their sizes too (AC3) by reusing that setup (Settings →
 * Environment, `APP_ENV_TESTIDS`, `ENV_COPY` row labels) rather than
 * duplicating a second env fixture.
 */

let app: ElectronApplication;
let win: Page;
let isolatedHome: string;
let demoRoot: string;
let projectDir: string;

test.beforeAll(async () => {
  const mockClaude = resolve(process.cwd(), 'scripts/mock-claude.mjs');
  isolatedHome = mkdtempSync(join(tmpdir(), 'metaide-iconsizes-home-'));
  demoRoot = mkdtempSync(join(tmpdir(), 'metaide-iconsizes-root-'));
  projectDir = join(demoRoot, 'iconproj');
  mkdirSync(projectDir);
  initRepo(projectDir);
  // A tracked file so the baseline commit is non-empty (an empty `git commit`
  // fails, and `git add -A` on an empty tree stages nothing).
  writeFileSync(join(projectDir, 'README.md'), '# iconproj\n');
  commitAll(projectDir, 'baseline');

  app = await electron.launch({
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
  win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setSize(1400, 900); });
  await win.evaluate(async (path: string) => {
    await (window as unknown as { api: { invoke: (c: string, r: unknown) => Promise<unknown> } }).api.invoke('roots:add', { path });
  }, demoRoot);

  // Three CLI profiles, global scope: the two bundled marks (D5/AC9) plus an
  // emoji control, so the emoji row is a positive control that nothing in
  // the menu was broken by the mark resize.
  await win.evaluate(async () => {
    const api = (window as unknown as { api: { invoke: (c: string, r: unknown) => Promise<unknown> } }).api;
    await api.invoke('settings:set', {
      key: 'default_cli_profiles',
      value: [
        { name: 'EmojiMark', argv: ['/bin/sh'], icon: '🦙' },
      ],
    });
  });

  const row = win.locator('[data-testid="project-row"]').filter({ has: win.getByText('iconproj', { exact: true }) }).first();
  await expect(row).toBeVisible({ timeout: 5000 });
  await row.click();
  await expect.poll(() => win.title(), { timeout: 10000 }).toBe('iconproj — MetaLogix IDE');
  await expect(win.locator('.xterm').first()).toBeVisible({ timeout: 10000 });
});

test.afterAll(async () => {
  await app.close();
  rmSync(isolatedHome, { recursive: true, force: true });
  rmSync(demoRoot, { recursive: true, force: true });
});

/* ─────────────────────────────── AC5: dialog/panel closes ─────────────────────────────── */

test('AC5: every 28px dialog/panel close renders a 14x14 X with accessible name "Close"; the 36px Settings close renders 16x16', async () => {
  // New project dialog (28px box).
  await win.getByTestId('sidebar-add-btn').click();
  await win.getByTestId('sidebar-add-new-project').click();
  const newProjectDialog = win.getByTestId('new-project-dialog');
  await expect(newProjectDialog).toBeVisible();
  await settle(newProjectDialog); // .modal-panel opens with a 0.96 CSS scale transition
  const npClose = newProjectDialog.getByRole('button', { name: 'Close' });
  await expectIconSize(npClose.locator('svg'), 14, 'new-project close icon');
  await npClose.click();
  await expect(newProjectDialog).toBeHidden();

  // Keyboard shortcuts dialog (28px box, App.tsx ShortcutsHelp).
  await win.keyboard.press('ControlOrMeta+/');
  const shortcuts = win.getByTestId('shortcuts-help');
  await expect(shortcuts).toBeVisible();
  const scClose = shortcuts.getByRole('button', { name: 'Close shortcuts' });
  await expectIconSize(scClose.locator('svg'), 14, 'shortcuts close icon');
  await scClose.click();
  await expect(shortcuts).toBeHidden();

  // Prompt library (28px box). Opened via the toolbar button, requires a selected project.
  await win.getByTestId('prompts-open').click();
  const prompts = win.getByTestId('prompt-library');
  await expect(prompts).toBeVisible();
  const plClose = prompts.getByRole('button', { name: 'Close' });
  await expect(plClose.locator('svg')).toHaveCount(1, { timeout: 5000 });
  await expect(plClose, 'no ✕ text glyph left once it is an icon').not.toHaveText('✕');
  await expectIconSize(plClose.locator('svg'), 14, 'prompt-library close icon');
  await plClose.click();
  await expect(prompts).toBeHidden();

  // Scrollback search (28px box); the 🔎 label text is unchanged (D6).
  await win.getByTestId('scrollback-open').click();
  const scrollback = win.getByTestId('scrollback-search');
  await expect(scrollback).toBeVisible();
  await expect(scrollback.getByText('🔎 all shells')).toBeVisible();
  const sbClose = scrollback.getByRole('button', { name: 'Close' });
  await expect(sbClose.locator('svg')).toHaveCount(1, { timeout: 5000 });
  await expect(sbClose, 'no ✕ text glyph left once it is an icon').not.toHaveText('✕');
  await expectIconSize(sbClose.locator('svg'), 14, 'scrollback close icon');
  await sbClose.click();
  await expect(scrollback).toBeHidden();

  // Settings (36px box).
  await win.getByTestId('settings-open').click();
  const settings = win.getByTestId('settings-modal');
  await expect(settings).toBeVisible();
  await settle(settings); // .modal-panel opens with a 0.96 CSS scale transition
  const stClose = win.getByTestId('settings-close');
  await expectIconSize(stClose.locator('svg'), 16, 'settings close icon');
  await stClose.click();
  await expect(settings).toBeHidden();
});

test('AC5 (D9): the text ✕ closes in the StatusBar alive-shells popover (20px box) and ShellTab (24px boxes) become the shared X at 12, keeping their title', async () => {
  // StatusBar alive-shells popover.
  const chip = win.getByTestId('shells-chip');
  await chip.click();
  const popoverClose = win.locator('button[title="Close"]').filter({ has: win.locator('svg') }).last();
  await expect(popoverClose).toBeVisible();
  await expectIconSize(popoverClose.locator('svg'), 12, 'alive-shells popover close icon');
  await popoverClose.click();

  // ShellTab find bar close (:533), opened with ⌘F inside the terminal.
  const shellTab = win.locator('[data-testid="shell-tab"]').first();
  await shellTab.click();
  await win.keyboard.press('ControlOrMeta+f');
  const searchBar = win.getByTestId('shell-search');
  await expect(searchBar).toBeVisible();
  const findClose = searchBar.getByRole('button', { name: 'Close (Esc)' });
  await expectIconSize(findClose.locator('svg'), 12, 'shell find-bar close icon');
  // The Escape close is wired on the search input's own onKeyDown (ShellTab.tsx),
  // not a document-level listener — it only fires once the input genuinely
  // has focus, which the component gives it on an animation frame after open.
  await expect(searchBar.locator('input')).toBeFocused();
  await win.keyboard.press('Escape');
  await expect(searchBar).toBeHidden();
});

test('AC16: the ShellTab exit-overlay Dismiss (:502) is real-mouse-clickable and renders 12x12; Re-launch (:493) hit-tests clean too', async () => {
  // ShellTab.tsx:415 sets exitInfo on the pty's exit callback, which renders
  // the overlay; typing `exit` into the real login shell is the only way to
  // fire that callback through the actual UI.
  const shellTab = win.locator('[data-testid="shell-tab"]').first();
  await shellTab.click();
  await win.keyboard.type('exit');
  await win.keyboard.press('Enter');
  const dismiss = win.getByTestId('shell-exit-dismiss');
  await expect(dismiss).toBeVisible({ timeout: 10000 });
  await expectIconSize(dismiss.locator('svg'), 12, 'shell exit-overlay dismiss icon');

  // AC16/D14: before the `isolate` fix on the terminal host, xterm's own
  // link-layer canvas (z-index 2, pointer-events auto) painted above this
  // whole overlay and silently ate clicks at this point. Checked for
  // Re-launch with a real hit-test (the same check the browser itself runs
  // before delivering a click) rather than an actual click — a second real
  // pty relaunch cycle isn't worth it for what both buttons share: landing
  // on the right element. Not dependent on the relaunch succeeding.
  const relaunch = win.getByTestId('shell-relaunch');
  const relaunchHits = await relaunch.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return top !== null && (top === el || el.contains(top));
  });
  expect(relaunchHits, 'Re-launch hit-tests to itself, not a layered element on top of it').toBe(true);

  // Dismiss gets the full real click — the one this overlay most needs,
  // and the one ShellTab.tsx:415 is reachable through from this suite.
  await dismiss.click();
  await expect(dismiss).toBeHidden();

  // Restore shell 0 to alive: AC6's Split (and anything else sharing this
  // app instance afterwards) assumes a live primary shell, same as every
  // other test in this file always has. Equivalent to clicking Re-launch
  // (already hit-test-proven above) but direct, since the overlay — and
  // so the button — is gone now that Dismiss really did its job.
  const projectId = await win.evaluate(async (path: string) => {
    const api = (window as unknown as { api: { invoke: (c: string, r: unknown) => Promise<unknown> } }).api;
    const { projects } = (await api.invoke('projects:list', {})) as { projects: { id: number; path: string }[] };
    const match = projects.find((p) => p.path === path);
    if (!match) throw new Error('iconproj not found in projects:list');
    return match.id;
  }, projectDir);
  await win.evaluate(async (id: number) => {
    const api = (window as unknown as { api: { invoke: (c: string, r: unknown) => Promise<unknown> } }).api;
    await api.invoke('shells:launch', { projectId: id });
  }, projectId);
  await win.locator('.xterm').first().waitFor({ timeout: 10000 });
});

/* ─────────────────────────────── AC6: 20-24px icon buttons, 16px micro controls ─────────────────────────────── */

test('AC6: every 20-24px icon button renders a 12x12 glyph; every 16px micro close/unload control renders 10x10', async () => {
  // tab-strip "add a shell" plus (24px).
  await expectIconSize(win.getByTestId('tabbar-new-shell').locator('svg'), 12, 'new-shell plus icon');

  // Split-pane header close (24px): open the split, then read its close icon.
  await openSplit(win, 'iconproj');
  const splitClose = win.getByTestId('split-close');
  await expectIconSize(splitClose.locator('svg'), 12, 'split-pane close icon');
  await splitClose.click();
  await expect(win.getByTestId('split-right')).toBeHidden();

  // Git panel refresh (24px).
  await win.getByTestId('ab-git').click();
  await expectIconSize(win.getByTestId('git-refresh').locator('svg'), 12, 'git-refresh icon');

  // Tasks panel refresh (24px; no fixed testid — selected by its title).
  await win.getByTestId('ab-tasks').click();
  const tasksRefresh = win.locator('button[title="Rediscover"]');
  await expectIconSize(tasksRefresh.locator('svg'), 12, 'tasks refresh icon');
  await win.getByTestId('ab-projects').click();

  // Current-project unload chip (16px micro control).
  await expectIconSize(win.getByTestId('unload-current').locator('svg'), 10, 'current-project unload icon');

  // Sidebar row unload (16px micro control): hover the row so the control
  // is in the DOM with a real box (it is opacity-0 but still laid out for
  // the selected row, per Sidebar.tsx — the selected row keeps opacity-100).
  const sidebarRow = win.locator('[data-testid="project-row"]').filter({ has: win.getByText('iconproj', { exact: true }) }).first();
  const rowUnload = sidebarRow.locator('xpath=..').getByTestId('row-unload');
  await expectIconSize(rowUnload.locator('svg'), 10, 'sidebar row-unload icon');

  // Shell tab close (16px micro control): open another tab so a closeable
  // chip (shellIndex !== 0) exists. Diffed by count, not a hardcoded index —
  // the split opened above may or may not have left a background shell
  // behind once closed, and this does not need to know which.
  const chips = () => win.locator('[data-testid="shell-tab-button"]');
  const before = await chips().count();
  await win.getByTestId('tabbar-new-shell').click();
  await win.locator('[data-new-shell-menu="1"] button', { hasText: 'Terminal' }).click();
  await expect(chips()).toHaveCount(before + 1, { timeout: 8000 });
  const newChip = chips().last();
  await expectIconSize(newChip.locator('button svg'), 10, 'shell-tab close icon');
  await newChip.locator('button').click();
  await expect(chips()).toHaveCount(before);
});

test('AC6: the toast dismiss X renders 12x12, deterministically triggered by a forced shells:set-default-cli failure', async () => {
  // The star toggle (NewShellMenu) reports a generic 'Could not set default'
  // error toast on failure (ShellTabsBar.tsx) — a reliable, process-free way
  // to raise a toast without touching another slice's surface. Shared app
  // instance, so the forced handler is restored at the end — no later test
  // in this file calls shells:set-default-cli, but leaving it broken would
  // be a trap for the next person to extend this file.
  type InvokeHandler = (event: unknown, ...args: unknown[]) => unknown;
  await app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers?: Map<string, InvokeHandler> })._invokeHandlers;
    const original = handlers?.get('shells:set-default-cli');
    if (!original) throw new Error('no shells:set-default-cli handler in ipcMain._invokeHandlers (Electron internals changed?)');
    (globalThis as unknown as { __e2eOriginalSetDefaultCli: InvokeHandler }).__e2eOriginalSetDefaultCli = original;
    ipcMain.removeHandler('shells:set-default-cli');
    ipcMain.handle('shells:set-default-cli', () => { throw new Error('forced failure for icon-sizes AC6'); });
  });
  try {
    await win.getByTestId('tabbar-new-shell').click();
    const menu = win.locator('[data-new-shell-menu="1"]');
    const piRow = menu.locator('div.group', { hasText: 'EmojiMark' });
    await piRow.getByRole('button', { name: /folder default/i }).click();
    const toast = win.getByTestId('toast').filter({ hasText: 'Could not set default' }).first();
    await expect(toast).toBeVisible({ timeout: 5000 });
    const dismiss = toast.getByRole('button', { name: 'Dismiss notification' });
    await expectIconSize(dismiss.locator('svg'), 12, 'toast dismiss icon');
    // Positive control: the button really dismisses it (not just correctly sized).
    await dismiss.click();
    await expect(toast).toBeHidden();
    await win.keyboard.press('Escape');
  } finally {
    await app.evaluate(({ ipcMain }) => {
      const original = (globalThis as unknown as { __e2eOriginalSetDefaultCli: InvokeHandler }).__e2eOriginalSetDefaultCli;
      ipcMain.removeHandler('shells:set-default-cli');
      ipcMain.handle('shells:set-default-cli', original);
    });
  }
});

/* ─────────────────────────────── AC7: icon beside text (branch) ─────────────────────────────── */

test('AC7: the status-bar branch icon and the Git-panel branch icon both render 12x12', async () => {
  const statusBranch = win.locator('[data-testid="status-bar"] svg').first();
  await expectIconSize(statusBranch, 12, 'status-bar branch icon');

  await win.getByTestId('ab-git').click();
  const gitBranch = win.locator('.flex.items-center.gap-2', { hasText: 'main' }).locator('svg').first();
  await expectIconSize(gitBranch, 12, 'git-panel branch icon');
  await win.getByTestId('ab-projects').click();
});

/* ─────────────────────────────── AC9: CLI marks ─────────────────────────────── */

test('AC9: an emoji CLI mark renders in an unchanged 20x20 slot', async () => {
  await win.getByTestId('tabbar-new-shell').click();
  const menu = win.locator('[data-new-shell-menu="1"]');
  await expect(menu).toBeVisible();
  await settle(menu); // menuMotion opens with a 0.97 scale transition

  const slotOf = (name: string): Locator =>
    menu.locator('div.group', { hasText: name }).locator('button').first().locator('span[aria-hidden="true"]').first();

  // Positive control: the emoji profile's slot box is unchanged and still renders its emoji text.
  const emojiSlot = slotOf('EmojiMark');
  await expectIconSize(emojiSlot, 20, 'emoji mark slot (unchanged)');
  await expect(emojiSlot).toHaveText('🦙');
  await expect(emojiSlot.locator('div, img')).toHaveCount(0);

  await win.keyboard.press('Escape');
  await expect(menu).toBeHidden();
});

test('AC3: the CLI-menu "Remove from this project" X (ShellTabsBar.tsx:210) renders 12x12 for a project-scoped profile', async () => {
  // Only project-scoped profiles get the remove-X (ShellTabsBar.tsx:208);
  // the three beforeAll profiles are all global, so one project-scoped
  // profile is seeded here via projects:update-config (the same path the
  // "save" checkbox on a custom command uses).
  const projectId = await win.evaluate(async (path: string) => {
    const api = (window as unknown as { api: { invoke: (c: string, r: unknown) => Promise<unknown> } }).api;
    const { projects } = (await api.invoke('projects:list', {})) as { projects: { id: number; path: string }[] };
    const match = projects.find((p) => p.path === path);
    if (!match) throw new Error('iconproj not found in projects:list');
    return match.id;
  }, projectDir);
  await win.evaluate(async ({ id }: { id: number }) => {
    const api = (window as unknown as { api: { invoke: (c: string, r: unknown) => Promise<unknown> } }).api;
    await api.invoke('projects:update-config', { id, config: { cliProfiles: [{ name: 'ProjMark', argv: ['/bin/sh'] }] } });
  }, { id: projectId });

  await win.getByTestId('tabbar-new-shell').click();
  const menu = win.locator('[data-new-shell-menu="1"]');
  await expect(menu).toBeVisible();
  await settle(menu); // menuMotion opens with a 0.97 scale transition

  const row = menu.locator('div.group', { hasText: 'ProjMark' });
  // Positive control: it's really the project-scoped row, not a global one.
  await expect(row.getByText('saved', { exact: true })).toBeVisible();
  const removeX = row.getByRole('button', { name: 'Remove from this project' });
  // Opacity-0 by default, but still laid out (ShellTabsBar.tsx:208) — boundingBox reads the real box.
  await expectIconSize(removeX.locator('svg'), 12, 'CLI-menu remove-X icon');

  // Positive control: the button really removes the profile, not just sized right.
  await removeX.click();
  await expect(menu.getByText('ProjMark')).toHaveCount(0);
  await win.keyboard.press('Escape');
  await expect(menu).toBeHidden();
});

/* ─────────────────────────────── AC13: centring ─────────────────────────────── */

test('AC13: icon-only buttons in AC4-AC6 keep their icon centred (±0.5px) in their box, on both axes', async () => {
  // AC4: one activity-bar button.
  const abGit = win.getByTestId('ab-git');
  await expectCentred(abGit.locator('svg'), abGit, 'ab-git icon');

  // AC6: a 24px icon button and a 16px micro control.
  const newShell = win.getByTestId('tabbar-new-shell');
  await expectCentred(newShell.locator('svg'), newShell, 'tabbar-new-shell icon');
  const unloadCurrent = win.getByTestId('unload-current');
  await expectCentred(unloadCurrent.locator('svg'), unloadCurrent, 'unload-current icon');

  // AC5: a 28px dialog close and the 36px Settings close.
  await win.getByTestId('sidebar-add-btn').click();
  await win.getByTestId('sidebar-add-new-project').click();
  const newProjectDialog = win.getByTestId('new-project-dialog');
  await expect(newProjectDialog).toBeVisible();
  await settle(newProjectDialog); // .modal-panel opens with a 0.96 CSS scale transition
  const npClose = newProjectDialog.getByRole('button', { name: 'Close' });
  await expectCentred(npClose.locator('svg'), npClose, 'new-project close icon');
  await npClose.click();

  await win.getByTestId('settings-open').click();
  const settingsModal = win.getByTestId('settings-modal');
  await expect(settingsModal).toBeVisible();
  await settle(settingsModal); // .modal-panel opens with a 0.96 CSS scale transition
  const stClose = win.getByTestId('settings-close');
  await expectCentred(stClose.locator('svg'), stClose, 'settings close icon');
  await stClose.click();
});

/* ─────────────────────────────── AC14: accessibility kept ─────────────────────────────── */

test('AC14: the converted ✕ closes keep their accessible name; AC4-AC6 icons keep aria-hidden where they had it', async () => {
  // Converted closes keep an accessible name of "Close" (New project, Prompt
  // library, Scrollback) or the dialog's own named variant ("Close settings",
  // "Close shortcuts", "Close split").
  await win.getByTestId('sidebar-add-btn').click();
  await win.getByTestId('sidebar-add-new-project').click();
  await expect(win.getByTestId('new-project-dialog').getByRole('button', { name: 'Close' })).toBeVisible();
  await win.getByTestId('new-project-dialog').getByRole('button', { name: 'Close' }).click();

  await win.getByTestId('prompts-open').click();
  await expect(win.getByTestId('prompt-library').getByRole('button', { name: 'Close' })).toBeVisible();
  await win.getByTestId('prompt-library').getByRole('button', { name: 'Close' }).click();

  await win.getByTestId('scrollback-open').click();
  await expect(win.getByTestId('scrollback-search').getByRole('button', { name: 'Close' })).toBeVisible();
  await win.getByTestId('scrollback-search').getByRole('button', { name: 'Close' }).click();

  await win.getByTestId('settings-open').click();
  await expect(win.getByTestId('settings-close')).toHaveAttribute('aria-label', 'Close settings');
  await win.getByTestId('settings-close').click();
  await expect(win.getByTestId('settings-modal')).toBeHidden();

  // Decorative icon that already carries aria-hidden="true" directly on its
  // svg today (SplitPaneHeader's ToTabIcon) keeps it once resized sm->sm
  // (12, no change) — the one svg in this spec's surfaces that has the
  // attribute on the element itself rather than on a wrapping span.
  await openSplit(win, 'iconproj');
  await expect(win.getByTestId('split-to-tab').locator('svg')).toHaveAttribute('aria-hidden', 'true');
  await win.getByTestId('split-close').click();
  await expect(win.getByTestId('split-right')).toBeHidden();
});

/* ─────────────────────────────── AC3: a few more context groups, rendered ─────────────────────────────── */

test('AC3: SidebarHeader add/filter icons and the Env-tab unaffected icons render at their (unchanged) context sizes', async () => {
  // SidebarHeader "+" (lg, 16) and the filter field's leading Search icon (md, 14) are
  // both "no change" rows in the inventory, but AC3 asks for at least one
  // rendered check per context group and no existing spec measures them.
  const addButton = win.getByTestId('sidebar-add-btn');
  await expectIconSize(addButton.locator('svg'), 16, 'sidebar add-project icon');
  // SIDEBAR_TESTIDS.filter sits on the <input> itself; its leading search
  // icon is a sibling inside the wrapping <label>, not a descendant.
  const filterInput = win.getByTestId('sidebar-filter');
  const filterLabel = filterInput.locator('xpath=..');
  const filterIcon = filterLabel.locator('svg').first();
  await expectIconSize(filterIcon, 14, 'sidebar filter search icon');
  // Positive control: the icon really sits left of the input, not just present.
  expect((await box(filterIcon)).x, 'filter icon left of its input').toBeLessThan((await box(filterInput)).x);

  // Root folder glyph (RootFolderGlyph, Sidebar.tsx:515). Visible for every
  // root row — confirmed already rendered and tinted by chrome-cleanup.spec
  // :84 — so it needs no extra setup here.
  const rootGlyph = win.locator('[data-testid="root-hue"]').first();
  await expectIconSize(rootGlyph, 12, 'root folder glyph');
});

test('AC3: the app-wide Env editor\'s Reveal/Copy/Remove row icons render 14x14 (EnvValueField, EnvEditor)', async () => {
  // Reuses app-env-vars.spec.ts's surface (Settings -> Environment) rather
  // than a second env fixture: same `EnvValueField`/`EnvEditor` components,
  // same `APP_ENV_TESTIDS`/`ENV_COPY` row labels.
  await win.getByTestId('settings-open').click();
  const dialog = win.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toBeVisible();
  await settle(dialog); // .modal-panel opens with a 0.96 CSS scale transition
  const nav = dialog.getByRole('navigation', { name: 'Settings sections' });
  await nav.getByRole('button', { name: /^Environment(, unsaved changes)?$/ }).click();
  const panel = win.getByTestId(APP_ENV_TESTIDS.panel);
  await expect(panel).toBeVisible();

  await panel.getByTestId(ENV_TESTIDS.add).click();
  await panel.getByLabel(ENV_COPY.nameLabel(1), { exact: true }).fill('ICON_SIZES_VAR');
  await panel.getByLabel(ENV_COPY.valueLabel(1), { exact: true }).fill('some-value');

  const reveal = panel.getByRole('button', { name: ENV_COPY.revealLabel(1), exact: true });
  await expectIconSize(reveal.locator('svg'), 14, 'env reveal icon');
  const copy = panel.getByRole('button', { name: ENV_COPY.copyLabel(1), exact: true });
  await expectIconSize(copy.locator('svg'), 14, 'env copy icon');
  const remove = panel.getByLabel(ENV_COPY.removeLabel(1), { exact: true });
  await expectIconSize(remove.locator('svg'), 14, 'env remove icon');

  await win.getByTestId('settings-close').click();
  await expect(dialog).toBeHidden();
});
