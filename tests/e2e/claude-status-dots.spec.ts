/**
 * Claude status dots (idle green / busy amber / blocked red).
 *
 * Spec: docs/specs/claude-status-dots.md, AC14-AC18, AC20, AC22 (rendering
 * and E2E), plus the amended AC12a-e and new AC24-AC28 (background work and
 * transition-driven notifications, R1/R2) — the state-model ACs (AC1-AC11,
 * AC13) are unit-tested against `state-tracker.ts`/`claude-notifier.ts` and
 * are not repeated here. Plan: docs/plan/claude-status-dots.md §11 "Agent 3"
 * and §12.4 "Agent 3b" are the scenario lists this file implements.
 *
 * This suite is NOT adversarial (no pen-testing track): it covers each
 * listed AC's happy path plus the failure paths those ACs themselves name
 * (an arrow key must not clear red; a non-alive project's dot and the
 * ChatTab connection dot must be untouched; a background-work Stop and a
 * stale needs-input Notification must not fire "finished"/"needs input").
 *
 * Shares its Claude-shell mechanism (a `claude`-named shim execing
 * scripts/mock-claude.mjs) and app-launch/shell helpers with
 * claude-notifications.spec.ts via tests/e2e/helpers/claude-harness.ts.
 * Selectors come from the fixed contract, src/shared/claude-state.ts:
 * `CLAUDE_DOT` (testId + the state attribute) and `SHELL_TAB_TEST_ID` (the
 * per-shell tab strip element, which also carries `data-shell-index` —
 * distinct from ShellTab.tsx's own same-named `data-testid="shell-tab"` on
 * the xterm container, so every tab-strip lookup here matches on both
 * attributes together).
 *
 * R1/R2 tests below reuse the notification spy
 * (`installNotificationSpy`/`notifications`) from the harness — dots and
 * Claude notifications now share one state tracker (spec, Constraints), so
 * asserting both from the same hook sequence is the point.
 */

import { test, expect, type Page, type Locator, type ElectronApplication } from '@playwright/test';
import {
  type Api, launch, projectId, openProject, sendLine, waitForShell,
  installNotificationSpy, notifications, hookCredentials, postRawHook,
} from './helpers/claude-harness';
import { CLAUDE_DOT, CLAUDE_STATE_LABEL, SHELL_TAB_TEST_ID, type ClaudeShellState } from '../../src/shared/claude-state';

/** Writes raw bytes to a shell's PTY (no line semantics), regardless of which tab is on screen. */
async function writeRaw(win: Page, projId: number, shellIndex: number, data: string): Promise<void> {
  await win.evaluate(async (args: { projectId: number; shellIndex: number; data: string }) => {
    const api = (window as unknown as { api: Api }).api;
    await api.invoke('shells:write', { projectId: args.projectId, shellIndex: args.shellIndex, data: args.data });
  }, { projectId: projId, shellIndex, data });
}

/**
 * Minimises the main window (real main-process `BrowserWindow`, not a
 * renderer `document.activeElement` blur — see claude-notifications.spec.ts's
 * own note on this) so the shell under test is no longer "viewed". The
 * pre-existing notifier suppression rule (independent of this feature, see
 * spec Non-goals: "the one-outstanding-notification-per-shell rule... stays
 * exactly as it is") means a notification assertion with the project still
 * selected in the foreground would always be silently suppressed, whatever
 * the R1/R2 transition logic decides.
 */
async function notViewing(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.minimize(); });
}

/** The tab-strip dot for one shell (App.tsx's shells.map site, not ShellTab.tsx's xterm container). */
function tabDot(win: Page, shellIndex: number): Locator {
  return win.locator(`[data-testid="${SHELL_TAB_TEST_ID}"][data-shell-index="${shellIndex}"]`).getByTestId(CLAUDE_DOT.testId);
}

/** The selected-project chip in the main tab bar (App.tsx ~756) — identified by its sibling "unload-current" button. */
function chipDot(win: Page): Locator {
  return win.locator('span').filter({ has: win.getByTestId('unload-current') }).first().getByTestId(CLAUDE_DOT.testId);
}

/** A project's sidebar row dot, scoped by exact project name (there are two rows once a project is "in use" — take the first, like the harness's openProject). */
function projectRowDot(win: Page, name: string): Locator {
  return win.locator('[data-testid="project-row"]').filter({ has: win.getByText(name, { exact: true }) }).first().getByTestId(CLAUDE_DOT.testId);
}

/** The "In use" section header accent dot (worst state across all live shells of all projects — D4). */
function inUseHeaderDot(win: Page): Locator {
  return win.getByTestId('section-in-use-toggle').getByTestId(CLAUDE_DOT.testId);
}

async function dotState(locator: Locator): Promise<string | null> {
  return locator.getAttribute(CLAUDE_DOT.stateAttr);
}

/** Polls a dot's `data-claude-state` to the expected value (the state push is async over IPC). */
async function expectState(locator: Locator, state: ClaudeShellState, opts?: { timeout?: number }): Promise<void> {
  await expect.poll(() => dotState(locator), { timeout: opts?.timeout ?? 3000, message: `dot reaches ${state}` }).toBe(state);
}

/**
 * D1 correction (reconciled against the landed `StatusDot.tsx`): the
 * inactive+idle tab dot is the *static grey* exception, and the component
 * omits `data-claude-state` entirely for it (`undefined`, not `"idle"`) —
 * the contract only fixed the attribute's name, not that it's always
 * present. `title`/`aria-label` are unconditional, so those still carry
 * "Idle" even here (AC18); this polls for the attribute's absence instead
 * of a value.
 */
async function expectAbsentState(locator: Locator): Promise<void> {
  await expect.poll(() => dotState(locator), { timeout: 3000, message: 'dot has no data-claude-state (D1 static grey)' }).toBeNull();
}

test.describe('Claude status dots', () => {
  /* ── AC22/AC18: the fixed hook + keystroke sequence, tab and project dots, with labels ── */
  test('AC22/AC18: UserPromptSubmit, PermissionRequest, an arrow key, then Ctrl-U+Enter and Stop drive the tab and chip dots through busy/blocked/busy/idle, with the right labels', async () => {
    const h = await launch(['proja']);
    try {
      await openProject(h.win, 'proja');
      const projA = await projectId(h.win, 'proja');
      await waitForShell(h.win, projA, 0, 'mock-claude ready');

      const tab = tabDot(h.win, 0);
      const chip = chipDot(h.win);

      // AC1 baseline: idle before any hook event, both sites, both labelled "Idle".
      await expectState(tab, 'idle');
      await expectState(chip, 'idle');
      await expect(tab).toHaveAttribute('title', CLAUDE_STATE_LABEL.idle);
      await expect(tab).toHaveAccessibleName(CLAUDE_STATE_LABEL.idle);
      await expect(chip).toHaveAttribute('title', CLAUDE_STATE_LABEL.idle);
      await expect(chip).toHaveAccessibleName(CLAUDE_STATE_LABEL.idle);

      // Step 1: a plain line -> UserPromptSubmit -> busy.
      await sendLine(h.win, projA, 0, 'hello');
      await expectState(tab, 'busy');
      await expectState(chip, 'busy');
      await expect(tab).toHaveAttribute('title', CLAUDE_STATE_LABEL.busy);
      await expect(tab).toHaveAccessibleName(CLAUDE_STATE_LABEL.busy);

      // Step 2: PermissionRequest -> blocked, both sites.
      await sendLine(h.win, projA, 0, '/hook-raw PermissionRequest');
      await expectState(tab, 'blocked');
      await expectState(chip, 'blocked');
      await expect(tab).toHaveAttribute('title', CLAUDE_STATE_LABEL.blocked);
      await expect(tab).toHaveAccessibleName(CLAUDE_STATE_LABEL.blocked);

      // Step 3: an arrow key is not an answering keystroke — still blocked after
      // a full second (a fixed wait, not a poll, since we're proving absence
      // of a transition, not waiting for one).
      await writeRaw(h.win, projA, 0, '\x1b[A');
      await h.win.waitForTimeout(1000);
      expect(await dotState(tab), 'arrow key does not clear blocked').toBe('blocked');
      expect(await dotState(chip), 'arrow key does not clear blocked (project level)').toBe('blocked');

      // Step 4: Ctrl-U (kills the buffered arrow-key bytes at the tty) then
      // Enter. Enter alone is an answering keystroke (contains \r) and flips
      // blocked -> busy from the input rule itself; mock-claude receives an
      // empty line and posts no hook (scripts/mock-claude.mjs: `if (line !== '')`).
      await writeRaw(h.win, projA, 0, '\x15');
      await writeRaw(h.win, projA, 0, '\r');
      await expectState(tab, 'busy');
      await expectState(chip, 'busy');

      // Step 5: Stop -> idle.
      await sendLine(h.win, projA, 0, '/hook-stop');
      await expectState(tab, 'idle');
      await expectState(chip, 'idle');
      await expect(tab).toHaveAttribute('title', CLAUDE_STATE_LABEL.idle);
    } finally {
      await h.app.close();
      h.cleanup();
    }
  });

  /* ── AC15/D4: project-level worst state, and the cross-project "In use" header ── */
  test('AC15/D4: a project\'s dot shows the worst state of its own shells; the "In use" header shows the worst across every project; other projects/shells are unaffected', async () => {
    const h = await launch(['proja', 'projb']);
    try {
      await openProject(h.win, 'proja');
      const projA = await projectId(h.win, 'proja');
      await waitForShell(h.win, projA, 0, 'mock-claude ready');

      // A second hook-tracked Claude shell in the same project.
      const cliIdx = await h.win.evaluate(async (args: { id: number; shim: string }) => {
        const api = (window as unknown as { api: Api }).api;
        return (await api.invoke('shells:launch-cli', {
          projectId: args.id, profileName: 'Claude', argv: [args.shim], save: false,
        }) as unknown as { shellIndex: number }).shellIndex;
      }, { id: projA, shim: h.shimPath });
      await waitForShell(h.win, projA, cliIdx, 'mock-claude ready');

      // Baseline: both proja shells idle -> its row and the header read idle.
      await expectState(projectRowDot(h.win, 'proja'), 'idle');
      await expectState(inUseHeaderDot(h.win), 'idle');

      // Only the second proja shell goes busy then blocked. shell 0 in proja
      // is untouched throughout (positive control that "worst of" isn't
      // simply "last written"). Tab-level dots only render for the
      // CURRENTLY VIEWED project, so this has to happen before switching to
      // projb below (proja's tab strip wouldn't be in the DOM once projb is
      // selected).
      await sendLine(h.win, projA, cliIdx, 'hello');
      await expectState(tabDot(h.win, cliIdx), 'busy');
      await expectState(tabDot(h.win, 0), 'idle'); // untouched shell stays idle
      await expectState(projectRowDot(h.win, 'proja'), 'busy'); // {idle, busy} -> busy

      await sendLine(h.win, projA, cliIdx, '/hook-raw PermissionRequest');
      await expectState(projectRowDot(h.win, 'proja'), 'blocked'); // {idle, blocked} -> blocked
      await expectState(tabDot(h.win, 0), 'idle'); // still untouched

      // A sibling project with its own alive (idle) shell, opened AFTER
      // proja is already blocked — proves the header and proja's own row
      // aren't just "always red" once anything is alive, and that switching
      // the view away doesn't affect proja's own (still-rendered-elsewhere)
      // row state.
      await openProject(h.win, 'projb');
      const projB = await projectId(h.win, 'projb');
      await waitForShell(h.win, projB, 0, 'mock-claude ready');

      // projb's own row stays idle — the worst state is scoped per project.
      await expectState(projectRowDot(h.win, 'projb'), 'idle');
      // proja's row is still blocked, even though it's no longer the viewed
      // project (the sidebar row doesn't depend on selection).
      await expectState(projectRowDot(h.win, 'proja'), 'blocked');
      // The "In use" header is the worst across ALL projects (D4): proja's
      // blocked shell makes it red even though projb is all-idle.
      await expectState(inUseHeaderDot(h.win), 'blocked');
    } finally {
      await h.app.close();
      h.cleanup();
    }
  });

  /* ── AC14/D1: inactive tab is grey+static when idle, coloured+pulsing when busy/blocked ── */
  test('AC14/D1: an inactive shell tab renders the existing grey static dot when idle, and a pulsing amber/red dot when busy/blocked', async () => {
    const h = await launch(['proja']);
    try {
      await openProject(h.win, 'proja');
      const projA = await projectId(h.win, 'proja');
      await waitForShell(h.win, projA, 0, 'mock-claude ready');

      // Second shell — never selected, so its tab stays inactive throughout.
      const cliIdx = await h.win.evaluate(async (args: { id: number; shim: string }) => {
        const api = (window as unknown as { api: Api }).api;
        return (await api.invoke('shells:launch-cli', {
          projectId: args.id, profileName: 'Claude', argv: [args.shim], save: false,
        }) as unknown as { shellIndex: number }).shellIndex;
      }, { id: projA, shim: h.shimPath });
      await waitForShell(h.win, projA, cliIdx, 'mock-claude ready');

      const inactiveTab = tabDot(h.win, cliIdx);
      const activeTab = tabDot(h.win, 0); // shell 0 stays the active/selected tab

      // Idle: inactive tab is grey and static (D1 exception) — no pulse
      // class, and (reconciled against StatusDot.tsx) no `data-claude-state`
      // attribute at all, though its title/aria-label still read "Idle".
      await expectAbsentState(inactiveTab);
      await expect(inactiveTab).not.toHaveClass(/live-dot/);
      await expect(inactiveTab).toHaveAttribute('title', CLAUDE_STATE_LABEL.idle);
      await expect(inactiveTab).toHaveAccessibleName(CLAUDE_STATE_LABEL.idle);
      // Positive control: the ACTIVE tab pulses even at idle (today's existing
      // behaviour, unaffected by D1, which only carves out the inactive case)
      // and DOES carry the attribute, since it isn't the static-grey case.
      await expectState(activeTab, 'idle');
      await expect(activeTab).toHaveClass(/live-dot/);

      // Busy: inactive tab now shows the state colour AND pulses.
      await sendLine(h.win, projA, cliIdx, 'hello');
      await expectState(inactiveTab, 'busy');
      await expect(inactiveTab).toHaveClass(/live-dot/);

      // Blocked: same — coloured and pulsing even while inactive.
      await sendLine(h.win, projA, cliIdx, '/hook-raw PermissionRequest');
      await expectState(inactiveTab, 'blocked');
      await expect(inactiveTab).toHaveClass(/live-dot/);

      // The active tab (shell 0) was never touched — still idle throughout.
      await expectState(activeTab, 'idle');
    } finally {
      await h.app.close();
      h.cleanup();
    }
  });

  /* ── AC16/AC17: fan-out to every open window within 500ms; correct state on first render ── */
  test('AC16/AC17: a popout title-bar dot updates within 500ms of a hook; a reloaded window\'s sidebar dot is already correct on first render', async () => {
    const h = await launch(['proja']);
    try {
      await openProject(h.win, 'proja');
      const projA = await projectId(h.win, 'proja');
      await waitForShell(h.win, projA, 0, 'mock-claude ready');

      const [popout] = await Promise.all([
        h.app.waitForEvent('window'),
        h.win.getByTestId('popout-shell').click(),
      ]);
      await popout.waitForLoadState('domcontentloaded');
      await expect(popout.locator('[data-testid="shell-tab"] .xterm-screen')).toBeVisible({ timeout: 8000 });
      const popoutDot = popout.getByTestId(CLAUDE_DOT.testId).first();
      await expect(popoutDot).toHaveAttribute(CLAUDE_DOT.stateAttr, 'idle');

      // AC16: fire the hook and require the popout to reflect it within 500ms.
      await sendLine(h.win, projA, 0, '/hook-raw PermissionRequest');
      await expect.poll(
        () => popoutDot.getAttribute(CLAUDE_DOT.stateAttr),
        { timeout: 500, intervals: [25, 50, 100], message: 'popout dot updates within 500ms of the hook' },
      ).toBe('blocked');

      // AC17: reload the MAIN window while blocked. Read the sidebar's project
      // row (alive regardless of whether a project is currently "selected" —
      // `selected` is plain React state and does not survive a reload) the
      // moment it's visible, with only a short poll budget: a bug that shows
      // green-until-the-next-event would still read idle at the end of that
      // budget, since no new hook fires after the reload.
      await h.win.reload();
      await h.win.waitForLoadState('domcontentloaded');
      const row = h.win.locator('[data-testid="project-row"][data-alive="1"]').filter({ has: h.win.getByText('proja', { exact: true }) }).first();
      await expect(row).toBeVisible({ timeout: 10000 });
      const rowDot = row.getByTestId(CLAUDE_DOT.testId);
      await expect.poll(
        () => rowDot.getAttribute(CLAUDE_DOT.stateAttr),
        { timeout: 500, intervals: [25, 50, 100], message: 'reloaded window shows blocked on first render, no lingering idle flash' },
      ).toBe('blocked');
    } finally {
      await h.app.close();
      h.cleanup();
    }
  });

  /* ── AC20: the ChatTab connection dot and a never-opened project's dot are untouched ── */
  test('AC20: the ChatTab connection dot and a non-alive project row render exactly as before, carrying no Claude state', async () => {
    const h = await launch(['proja', 'untouched']);
    try {
      await openProject(h.win, 'proja');
      const projA = await projectId(h.win, 'proja');
      await waitForShell(h.win, projA, 0, 'mock-claude ready');
      // Drive proja's shell to blocked, so a regression that leaked Claude
      // state into unrelated dots would have something non-idle to leak.
      await sendLine(h.win, projA, 0, '/hook-raw PermissionRequest');
      await expectState(tabDot(h.win, 0), 'blocked');

      // The ChatTab connection dot: switch to the Chat view. It has its own
      // green/amber convention (connected/reconnecting), unrelated to Claude
      // state, and must not expose CLAUDE_DOT's test id or state attribute.
      // ChatTab.tsx renders a "connected"/"reconnecting…" row only once a
      // metaproject session resolves as logged in; this isolated test HOME
      // has no account, so ChatTab shows its login card instead and that
      // text never appears. Scope on App.tsx's `[data-view="chat"]` wrapper
      // instead, which is present for every ChatTab branch (loading, login,
      // or connected), and check its ENTIRE subtree for a Claude dot.
      await h.win.getByTestId('ab-chat').click();
      const chatView = h.win.locator('[data-view="chat"]');
      await expect(chatView).toBeVisible({ timeout: 5000 });
      const chatDotCount = await chatView.getByTestId(CLAUDE_DOT.testId).count();
      expect(chatDotCount, 'AC20 the ChatTab connection dot is not a Claude status dot').toBe(0);

      // A never-opened project (`untouched`, no alive shells at all): the
      // existing non-alive (hollow/grey) markup is unchanged — no Claude
      // state attribute, `data-alive="0"`.
      const untouchedRow = h.win.locator('[data-testid="project-row"][data-alive="0"]').filter({ has: h.win.getByText('untouched', { exact: true }) }).first();
      await expect(untouchedRow).toBeVisible({ timeout: 5000 });
      const untouchedRowDotCount = await untouchedRow.getByTestId(CLAUDE_DOT.testId).count();
      expect(untouchedRowDotCount, 'AC20 a non-alive row never renders a Claude status dot').toBe(0);
    } finally {
      await h.app.close();
      h.cleanup();
    }
  });

  /* ── R1: background work stays busy/amber and suppresses "finished" until real Stop ── */
  test('AC24/AC25/AC26: a Stop with background_tasks keeps the dot busy and shows no "finished"; idle_prompt is suppressed while waiting; a later plain Stop clears it and notifies', async () => {
    const h = await launch(['proja']);
    try {
      await installNotificationSpy(h.app);
      await openProject(h.win, 'proja');
      const projA = await projectId(h.win, 'proja');
      await waitForShell(h.win, projA, 0, 'mock-claude ready');
      const tab = tabDot(h.win, 0);
      await notViewing(h.app);

      // Establish busy, then a positive control: idle_prompt on a plain
      // (non-waiting) busy shell DOES idle it (AC6) — proves the suppression
      // asserted below is specifically about "waiting on background work",
      // not a broken idle_prompt path.
      await sendLine(h.win, projA, 0, 'hello');
      await expectState(tab, 'busy');
      await sendLine(h.win, projA, 0, '/hook-notify idle_prompt');
      await expectState(tab, 'idle');

      // AC24: a Stop with background_tasks -> busy, waiting on background
      // work (from idle here).
      await sendLine(h.win, projA, 0, '/hook-stop-bg 2');
      await expectState(tab, 'busy');

      // AC25/AC26 negative: while waiting, idle_prompt is a no-op (contrast
      // with the positive control above, same shell) — still busy after a
      // real wait, and no "finished" notification has appeared.
      await sendLine(h.win, projA, 0, '/hook-notify idle_prompt');
      await h.win.waitForTimeout(2000);
      expect(await dotState(tab), 'idle_prompt does not clear waiting-on-background').toBe('busy');
      expect(await notifications(h.app), 'no "finished" while waiting on background work').toHaveLength(0);

      // AC26: a later Stop with no background_tasks ends waiting -> idle,
      // and (AC12a) shows exactly one "finished" — the positive control that
      // the suppression above is real, not a broken notifier/spy.
      await sendLine(h.win, projA, 0, '/hook-stop');
      await expectState(tab, 'idle');
      await expect.poll(() => notifications(h.app), { timeout: 2000 }).toHaveLength(1);
      const list = await notifications(h.app);
      expect(list[0]!.title).toBe('proja — shell 0');
      expect(list[0]!.body).toBe('Claude finished and is waiting for you');
    } finally {
      await h.app.close();
      h.cleanup();
    }
  });

  /* ── AC27: session_crons alone never counts as background work ── */
  test('AC27: a Stop with empty background_tasks but non-empty session_crons still counts as "finished"', async () => {
    const h = await launch(['proja']);
    try {
      await installNotificationSpy(h.app);
      await openProject(h.win, 'proja');
      const projA = await projectId(h.win, 'proja');
      await waitForShell(h.win, projA, 0, 'mock-claude ready');
      const tab = tabDot(h.win, 0);
      await notViewing(h.app);

      await sendLine(h.win, projA, 0, 'hello');
      await expectState(tab, 'busy');

      // Negative-adjacent contrast, same shell: a background_tasks Stop DOES
      // suppress "finished" and stays busy...
      await sendLine(h.win, projA, 0, '/hook-stop-bg 1');
      await expectState(tab, 'busy');
      expect(await notifications(h.app), 'background Stop: no "finished" yet').toHaveLength(0);

      // ...re-establish plain busy (UserPromptSubmit ends waiting, AC26)...
      await sendLine(h.win, projA, 0, 'hello again');
      await expectState(tab, 'busy');

      // ...then a crons-only Stop (background_tasks empty) DOES count as
      // "finished" (AC27: only background_tasks matters, session_crons never read).
      await sendLine(h.win, projA, 0, '/hook-stop-crons');
      await expectState(tab, 'idle');
      await expect.poll(() => notifications(h.app), { timeout: 2000 }).toHaveLength(1);
      expect((await notifications(h.app))[0]!.body).toBe('Claude finished and is waiting for you');
    } finally {
      await h.app.close();
      h.cleanup();
    }
  });

  /* ── AC12b: a Stop that arrives while already idle never notifies ── */
  test('AC12b: a Stop on an already-idle shell shows no "finished"', async () => {
    const h = await launch(['proja']);
    try {
      await installNotificationSpy(h.app);
      await openProject(h.win, 'proja');
      const projA = await projectId(h.win, 'proja');
      await waitForShell(h.win, projA, 0, 'mock-claude ready');
      const tab = tabDot(h.win, 0);
      await notViewing(h.app);

      // Negative: idle baseline (AC1, no hook yet) -> Stop -> still idle, no notification.
      await expectState(tab, 'idle');
      await sendLine(h.win, projA, 0, '/hook-stop');
      await h.win.waitForTimeout(2000);
      expect(await dotState(tab), 'Stop from idle stays idle').toBe('idle');
      expect(await notifications(h.app), 'no "finished" for a Stop that arrives already idle').toHaveLength(0);

      // Positive control, same shell: establish busy first, then the exact
      // same command DOES notify — proves the "0" above is AC12b, not a
      // broken notifier/spy.
      await sendLine(h.win, projA, 0, 'hello');
      await expectState(tab, 'busy');
      await sendLine(h.win, projA, 0, '/hook-stop');
      await expectState(tab, 'idle');
      await expect.poll(() => notifications(h.app), { timeout: 2000 }).toHaveLength(1);
    } finally {
      await h.app.close();
      h.cleanup();
    }
  });

  /* ── AC12c: a stale needs-input Notification (answered before it arrived) shows nothing ── */
  test('AC12c: a needs-input Notification that arrives after an answering keystroke is stale — no red, no notification', async () => {
    const h = await launch(['proja']);
    try {
      await installNotificationSpy(h.app);
      await openProject(h.win, 'proja');
      const projA = await projectId(h.win, 'proja');
      await waitForShell(h.win, projA, 0, 'mock-claude ready');
      const tab = tabDot(h.win, 0);
      await notViewing(h.app);
      // Resolve credentials now, while idle (safe). The positive control
      // below posts its needs-input Notification while the shell is BLOCKED
      // (deliberately, to prove staleness is cleared) — typing there would
      // submit an Enter that answers it (AC7), turning the positive control
      // into another stale case instead of a genuine one.
      const projACreds = await hookCredentials(h.win, h.isolatedHome, projA, 0);

      // Block, then answer with Enter (clears blocked -> busy, and marks
      // "answered since the last hook event").
      await sendLine(h.win, projA, 0, '/hook-raw PermissionRequest');
      await expectState(tab, 'blocked');
      await writeRaw(h.win, projA, 0, '\r');
      await expectState(tab, 'busy');

      // Negative: a late needs-input Notification, with no hook event since
      // the answer, is stale — no state change, no "needs input" notification.
      await sendLine(h.win, projA, 0, '/hook-notify permission_prompt late');
      await h.win.waitForTimeout(1000);
      expect(await dotState(tab), 'stale needs-input Notification does not turn the dot red').toBe('busy');
      expect(await notifications(h.app), 'stale needs-input Notification shows nothing').toHaveLength(0);

      // Positive control, same shell: a fresh PermissionRequest clears
      // staleness (every confirmed hook event does, per spec), so the SAME
      // needs-input Notification type now applies normally — blocked, with
      // a "needs input" notification.
      await sendLine(h.win, projA, 0, '/hook-raw PermissionRequest');
      await expectState(tab, 'blocked');
      // Posted directly (not typed): the shell is BLOCKED again here, and
      // typing would submit an Enter that answers it (AC7), making this a
      // second stale case instead of the genuine one under test.
      await postRawHook(projACreds, { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'now genuine' });
      await expectState(tab, 'blocked');
      await expect.poll(() => notifications(h.app), { timeout: 2000 }).toHaveLength(1);
      expect((await notifications(h.app))[0]!.body).toBe('now genuine');
    } finally {
      await h.app.close();
      h.cleanup();
    }
  });

  /* ── AC9 (renderer half): a relaunched shell's dot resets to idle on its own ── */
  test('AC9: a shell\'s dot resets to idle after it is killed and relaunched into the same slot, with no further hook', async () => {
    const h = await launch(['proja']);
    try {
      await openProject(h.win, 'proja');
      const projA = await projectId(h.win, 'proja');
      await waitForShell(h.win, projA, 0, 'mock-claude ready');

      // Drive shell 0 busy, then blocked.
      await sendLine(h.win, projA, 0, 'hello');
      await expectState(tabDot(h.win, 0), 'busy');
      await sendLine(h.win, projA, 0, '/hook-raw PermissionRequest');
      // Positive control: definitely blocked immediately before the kill —
      // proves the "idle" read below is a real reset, not a shell that was
      // never anything else.
      await expectState(tabDot(h.win, 0), 'blocked');

      // Kill and relaunch into the same slot (`firstLaunchedAt` is already
      // set, so this resolves to the `subsequent`/--continue variant) —
      // the same relaunch step claude-notifications.spec.ts's AC6 test uses.
      // `PtyManager.kill` doesn't await the child's exit, so the OLD
      // process's exit event arrives after the new spawn and is correctly
      // ignored by the respawn guard (`claude-status/install.ts`) — the
      // tracker's lazy session validation (AC9) is what makes the OLD
      // (blocked) entry stop counting once the new session replaces it in
      // the registry, without any explicit "idle" transition ever firing.
      await h.win.evaluate(async (id: number) => {
        await (window as unknown as { api: Api }).api.invoke('shells:kill', { projectId: id, shellIndex: 0 });
      }, projA);
      const relaunchedIdx = await h.win.evaluate(async (id: number) => {
        const api = (window as unknown as { api: Api }).api;
        return (await api.invoke('shells:launch', { projectId: id }) as unknown as { shellIndex: number }).shellIndex;
      }, projA);
      await waitForShell(h.win, projA, relaunchedIdx, 'mock-claude resumed');

      // No hook is posted to the relaunched shell at all — if the dot goes
      // idle here, it's the relaunch path itself doing it (the renderer
      // refetching its snapshot on `alive-shells:changed`, which
      // `shells:launch` fires), not a fresh `Stop`/exit transition.
      await expectState(tabDot(h.win, relaunchedIdx), 'idle', { timeout: 2000 });
    } finally {
      await h.app.close();
      h.cleanup();
    }
  });
});
