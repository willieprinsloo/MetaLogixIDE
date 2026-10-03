/**
 * Claude Code system notifications (needs input / finished).
 *
 * Spec: docs/specs/claude-code-notifications.md (AC1-AC27, AC25 is manual —
 * not covered here). Plan: docs/plan/claude-code-notifications.md §8 "Agent
 * 3 — E2E" is the scenario list this file implements.
 *
 * Claude-shell mechanism: like claude-permission-mode.spec.ts and
 * claude-tab-width.spec.ts, a tiny shell shim literally named `claude` execs
 * mock-claude.mjs, because `isClaudeArgv` only recognises `claude`/
 * `claude.exe`/`claude.cmd` as argv[0] — `node mock-claude.mjs` is not a
 * Claude argv and is used deliberately for the AC5/AC19 non-Claude-shell
 * contrast. mock-claude.mjs reads its own `--settings <path>` (the app
 * writes one per instance) and POSTs Notification/Stop/UserPromptSubmit
 * hook events to the receiver via `/hook-notify`, `/hook-stop`,
 * `/hook-raw <event>` and plain lines — see that script's own docblock.
 *
 * OS notifications are observed without any production test seam: the
 * Electron `Notification` class is patched from the test via
 * `electronApp.evaluate` (prototype `show`/`close`), recording
 * `{ title, body, closed }` for every notification the main process
 * constructs — both the Claude notifier's and the pre-existing generic
 * "Command finished" notifier's, since both build on the same imported
 * `Notification` class. Each recorded entry keeps its live instance so a
 * test can fire `instance.emit('click')`, exactly what a real click does
 * (Electron's `Notification` is an EventEmitter).
 *
 * "Not viewing" a shell is driven by real navigation (switching project/tab
 * in the UI), which is what feeds the renderer's `useReportViewedShells`
 * hook — not a raw `notifications:viewed-shells` IPC call — so the
 * suppression tests exercise the real reporting path end to end. "No
 * focused window" (AC17) uses `BrowserWindow.minimize()`, which
 * deterministically clears `getFocusedWindow()` — real cross-application
 * OS focus handoff (`blur()` with nothing else to hand focus to) is
 * documented as unreliable in this environment
 * (tests/e2e/terminal-window-focus.spec.ts, top-of-file comment) and is not
 * needed here since AC17's own wording includes "all app windows minimised".
 */

import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Api, MOCK_CLAUDE, makeClaudeShim, launch, projectId, openProject, sendLine, waitForShell, aliveShells,
  waitForClaudeState, installNotificationSpy, notifications, clickNotification, baseEnv,
  hookCredentials, postRawHook,
} from './helpers/claude-harness';

type ClaudePathSnapshot =
  | { present: false }
  | { present: true; kind: 'dir'; entries: string[] }
  | { present: true; kind: 'file'; size: number; mtimeMs: number };

/**
 * Snapshots one path under the isolated HOME for the AC7 before/after
 * comparison. `~/.claude` is a directory (entries); `~/.claude.json` is a
 * FILE — `readdirSync` on a file throws ENOTDIR, which a bare try/catch
 * conflates with "absent", making a file-content or file-creation change
 * invisible. Distinguish by `statSync`, snapshotting a file's size + mtime
 * (real Claude rewrites it every session — content, not just presence, is
 * what must stay untouched here) and a directory's entry list.
 */
function snapshotClaudePath(path: string): ClaudePathSnapshot {
  if (!existsSync(path)) return { present: false };
  const st = statSync(path);
  if (st.isDirectory()) return { present: true, kind: 'dir', entries: readdirSync(path).sort() };
  return { present: true, kind: 'file', size: st.size, mtimeMs: st.mtimeMs };
}

test.describe('Claude Code system notifications', () => {
  /* ── Detection, content, attribution, click, dedup ──────────────────── */
  test('AC1/AC9/AC2/AC10/AC3/AC4/AC11/AC13/AC14: needs-input and finished events notify correctly, ignored events do not, per-shell attribution and click navigation', async () => {
    const h = await launch(['proja', 'projb']);
    try {
      await installNotificationSpy(h.app);
      await openProject(h.win, 'proja');
      await waitForShell(h.win, await projectId(h.win, 'proja'), 0, 'mock-claude ready');
      const projA = await projectId(h.win, 'proja');

      await openProject(h.win, 'projb');
      await waitForShell(h.win, await projectId(h.win, 'projb'), 0, 'mock-claude ready');
      const projB = await projectId(h.win, 'projb');
      // Confirm both shells so they're hook-confirmed (AC18 depends on this
      // elsewhere) and to establish a UserPromptSubmit baseline.
      await sendLine(h.win, projA, 0, 'hello');
      await sendLine(h.win, projB, 0, 'hello');
      // Resolve proja shell 0's real hook credentials now, while it's busy
      // (safe — AC7 only answers a BLOCKED shell). Needed below: once this
      // shell is blocked, any further typed command's own submit Enter would
      // itself answer it (AC7), so the second permission_prompt has to be
      // posted directly rather than typed.
      const projACreds = await hookCredentials(h.win, h.isolatedHome, projA, 0);

      // Currently viewing projb: an event on proja (not viewed) must notify.
      await sendLine(h.win, projA, 0, '/hook-notify permission_prompt Claude needs your permission to run rm -rf');
      await expect.poll(() => notifications(h.app), { timeout: 2000 }).toHaveLength(1);
      let list = await notifications(h.app);
      expect(list[0]!.title, 'AC9 title').toBe('proja — shell 0');
      expect(list[0]!.body, 'AC9 body is Claude\'s message').toBe('Claude needs your permission to run rm -rf');
      expect(list[0]!.closed).toBe(false);

      // AC9 truncation: a message over 200 chars is cut to exactly 200.
      // Posted directly (not typed): proja's shell 0 is now BLOCKED from the
      // event above, and typing anything here would submit an Enter that
      // answers it (AC7/AC12c stale-needs-input), suppressing this exact
      // notification instead of testing truncation.
      const longMessage = 'x'.repeat(250);
      await postRawHook(projACreds, { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: longMessage });
      await expect.poll(() => notifications(h.app), { timeout: 2000 }).toHaveLength(2);
      list = await notifications(h.app);
      expect(list[1]!.body).toHaveLength(200);
      expect(list[1]!.body).toBe(longMessage.slice(0, 200));
      // AC14: the second event for the same shell closed the first.
      expect(list[0]!.closed, 'AC14 previous notification for the shell closed').toBe(true);
      expect(list[1]!.closed).toBe(false);

      // AC2/AC10: a Stop event finishes with a fixed body, no response text.
      // "Finished" is now shown only for a Stop that moves busy -> idle
      // (amended AC12a). The shell is already blocked here (the permission
      // Notification above), so `/hook-stop`'s own submit Enter would answer
      // it into busy anyway (AC7) — but make the busy precondition explicit
      // and deterministic rather than relying on that side effect.
      await sendLine(h.win, projA, 0, 'hello');
      await waitForClaudeState(h.win, projA, 0, 'busy');
      await sendLine(h.win, projA, 0, '/hook-stop');
      await expect.poll(() => notifications(h.app), { timeout: 2000 }).toHaveLength(3);
      list = await notifications(h.app);
      expect(list[2]!.title).toBe('proja — shell 0');
      expect(list[2]!.body).toBe('Claude finished and is waiting for you');
      expect(list[1]!.closed, 'AC14 the needs-input notification closed when finished replaced it').toBe(true);

      // AC3: ignored events never notify. idle_prompt (a Notification type
      // outside the needs-input set) and SubagentStop (a whole other
      // hook_event_name) must both produce nothing.
      await sendLine(h.win, projA, 0, '/hook-notify idle_prompt should be ignored');
      await sendLine(h.win, projA, 0, '/hook-raw SubagentStop');
      // No poll-to-appear here (we're proving absence); give the pipeline
      // the same 2s budget AC1/AC2 use, then assert the count is unchanged.
      await h.win.waitForTimeout(2000);
      expect(await notifications(h.app), 'AC3 ignored events produce no notification').toHaveLength(3);

      // AC4: an event on the OTHER shell (projb) is attributed to it, not
      // proja. Switch the view to proja first — we're still on projb from
      // the openProject above, and projb's own event must not be suppressed
      // by AC15 (viewing it) for this assertion to mean anything.
      await openProject(h.win, 'proja');
      await sendLine(h.win, projB, 0, '/hook-notify permission_prompt projb needs you');
      await expect.poll(() => notifications(h.app), { timeout: 2000 }).toHaveLength(4);
      list = await notifications(h.app);
      expect(list[3]!.title).toBe('projb — shell 0');
      expect(list[3]!.body).toBe('projb needs you');

      // AC11: clicking the projb notification switches to projb (already
      // shown) with the main window focused and its terminal active — the
      // click must not touch proja.
      await h.win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await clickNotification(h.app, 3);
      await expect.poll(() => h.win.title(), { timeout: 5000 }).toBe('projb — MetaLogix IDE');
      const active = await h.win.evaluate(() => {
        const el = document.activeElement;
        return el instanceof HTMLElement && el.classList.contains('xterm-helper-textarea');
      });
      expect(active, 'AC11 terminal focused after click').toBe(true);

      // AC4 continued: clicking the proja notification (index 2, its
      // "finished" one — still the most recent live one for that shell)
      // navigates to proja, never to projb.
      await clickNotification(h.app, 2);
      await expect.poll(() => h.win.title(), { timeout: 5000 }).toBe('proja — MetaLogix IDE');

      // AC13: kill proja's shell, then click its now-stale notification
      // (index 2). Only main-window focus happens: no project/tab switch
      // (we're currently on proja already — switch to projb first so a
      // spurious switch back to proja would be observable), no new shell,
      // no error.
      await h.win.evaluate(async (id: number) => {
        await (window as unknown as { api: Api }).api.invoke('shells:kill', { projectId: id, shellIndex: 0 });
      }, projA);
      await openProject(h.win, 'projb');
      const beforeShells = await aliveShells(h.win);
      await clickNotification(h.app, 2);
      await h.win.waitForTimeout(500);
      expect(await h.win.title(), 'AC13 no project switch for an exited shell\'s notification').toBe('projb — MetaLogix IDE');
      const afterShells = await aliveShells(h.win);
      expect(afterShells.length, 'AC13 no new shell launched').toBe(beforeShells.length);
    } finally {
      await h.app.close();
      h.cleanup();
    }
  });

  /* ── Suppression / de-duplication / generic-notifier interplay ──────── */
  test('AC15/AC16/AC17/AC18/AC19: suppressed while viewing, shown otherwise, generic notifier deference', async () => {
    const h = await launch(['proja', 'projb']);
    try {
      await installNotificationSpy(h.app);
      await openProject(h.win, 'proja');
      const projA = await projectId(h.win, 'proja');
      await waitForShell(h.win, projA, 0, 'mock-claude ready');
      // Resolve credentials now, while idle (safe) — the shell is blocked
      // by the next step, and a second typed command's own submit Enter
      // would answer a blocked shell (AC7), so the AC16 event below has to
      // be posted directly.
      const projACreds = await hookCredentials(h.win, h.isolatedHome, projA, 0);

      // AC15: main window focused and showing proja's shell 0 — an event on
      // that exact shell must not notify.
      await sendLine(h.win, projA, 0, '/hook-notify permission_prompt while viewing');
      await h.win.waitForTimeout(2000);
      expect(await notifications(h.app), 'AC15 suppressed while viewing the shell').toHaveLength(0);

      // Positive control: the pipeline is alive — switching away and
      // repeating the exact same event now notifies (AC16 proper, below,
      // also serves as the positive control for AC15's assertion of "0").
      await openProject(h.win, 'projb');
      const projB = await projectId(h.win, 'projb');
      await waitForShell(h.win, projB, 0, 'mock-claude ready');

      // AC16: main window focused, but on a different project — now notify.
      // Posted directly: proja's shell 0 is BLOCKED from the AC15 step
      // above, and typing here would submit an Enter that answers it
      // (AC7/AC12c), suppressing this exact notification as stale instead
      // of testing AC16.
      await postRawHook(projACreds, { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'now on a different project' });
      await expect.poll(() => notifications(h.app), { timeout: 2000 }).toHaveLength(1);

      // AC17: no focused window at all (minimised) — still notifies.
      await h.app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.minimize(); });
      // Amended AC12a: "finished" requires busy -> idle. Make that explicit
      // rather than relying on `/hook-stop`'s own submit Enter answering the
      // still-blocked shell (AC7).
      await sendLine(h.win, projA, 0, 'hello');
      await waitForClaudeState(h.win, projA, 0, 'busy');
      await sendLine(h.win, projA, 0, '/hook-stop');
      await expect.poll(() => notifications(h.app), { timeout: 2000 }).toHaveLength(2);
      await h.app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.restore(); });

      // AC18/AC19: once proja's shell is hook-confirmed (it delivered
      // events above), a long "command" running in it must NOT also fire
      // the generic "Command finished" notifier — only the Claude one
      // covers it. A sibling non-Claude shell's generic notifier must keep
      // working unchanged (AC19 positive control the same test proves).
      // The generic notifier's own pre-existing rule (src/main/index.ts,
      // the done-poll loop) skips every shell while the main window is
      // focused and the shell isn't popped out — unrelated to and
      // unaffected by hook-confirmation, so it must not confound this
      // assertion. Minimise (real BrowserWindow-level, not a renderer
      // document.activeElement blur, which doesn't touch main-process
      // focus state at all) so the ONLY thing standing between "8s+ of
      // work" and a generic notification is hook-confirmation.
      await openProject(h.win, 'proja');
      await h.app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.minimize(); });
      await sendLine(h.win, projA, 0, '/work 9');
      // DONE_MIN_MS=8000, DONE_IDLE_MS=1200 (src/main/pty/manager.ts):
      // give the heuristic enough time to have fired if it were going to.
      await h.win.waitForTimeout(11000);
      const beforeGeneric = await notifications(h.app);
      expect(
        beforeGeneric.some((n) => n.body.startsWith('Command finished')),
        'AC18 generic notifier never fires for a hook-confirmed shell',
      ).toBe(false);

      // Positive control for AC18: a plain (non-Claude, never hook-confirmed)
      // shell in the same project running the same workload, main window
      // still minimised, DOES get the generic notification — proving the
      // heuristic and the assertion above can both actually detect it (and
      // that minimising didn't silently suppress everything).
      const plainIdx = await h.win.evaluate(async (id: number) => {
        const api = (window as unknown as { api: Api }).api;
        return (await api.invoke('shells:launch-plain', { projectId: id }) as unknown as { shellIndex: number }).shellIndex;
      }, projA);
      await waitForShell(h.win, projA, plainIdx, '$');
      await sendLine(h.win, projA, plainIdx, 'sleep 9 && echo done');
      await h.win.waitForTimeout(11000);
      const afterGeneric = await notifications(h.app);
      expect(
        afterGeneric.some((n) => n.title === `proja — shell ${plainIdx}` && n.body.startsWith('Command finished')),
        'AC19 positive control: generic notifier still fires for a non-Claude shell',
      ).toBe(true);
      await h.app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.restore(); });
    } finally {
      await h.app.close();
      h.cleanup();
    }
  });

  /* ── Popout click ─────────────────────────────────────────────────────*/
  test('AC12: clicking a popped-out shell\'s notification focuses the popout window', async () => {
    const h = await launch(['proja']);
    try {
      await installNotificationSpy(h.app);
      await openProject(h.win, 'proja');
      const projA = await projectId(h.win, 'proja');
      await waitForShell(h.win, projA, 0, 'mock-claude ready');
      await sendLine(h.win, projA, 0, 'hello');

      const [popout] = await Promise.all([
        h.app.waitForEvent('window'),
        h.win.getByTestId('popout-shell').click(),
      ]);
      await popout.waitForLoadState('domcontentloaded');
      await expect(popout.locator('[data-testid="shell-tab"] .xterm-screen')).toBeVisible({ timeout: 8000 });

      // The popout opens already focused (AC9, terminal-window-focus.spec.ts),
      // so the shell would count as "viewed" (AC15) until we move focus back
      // to main. Same blur()/show()/focus() sequence as
      // focus.ts's sendNotificationFocusRequest — proven reliable for
      // same-app window switching in this environment, unlike the cross-app
      // blur() limitation documented at the top of this file. Poll
      // `isFocused()` rather than assume the call landed synchronously.
      // Identify the two windows by URL (popout carries `popout=1`), not by
      // array position — getAllWindows()'s order is not documented to be
      // creation order.
      await h.app.evaluate(({ BrowserWindow }) => {
        const wins = BrowserWindow.getAllWindows();
        const popoutWin = wins.find((w) => w.webContents.getURL().includes('popout=1'));
        const mainWin = wins.find((w) => !w.webContents.getURL().includes('popout=1'));
        if (!popoutWin || !mainWin) throw new Error(`expected one main + one popout window, got ${wins.length}`);
        popoutWin.blur();
        mainWin.show();
        mainWin.focus();
      });
      await expect.poll(
        () => h.app.evaluate(({ BrowserWindow }) => {
          const main = BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('popout=1'));
          return main?.isFocused() ?? false;
        }),
        { timeout: 3000, message: 'main window regains focus after the popout opened' },
      ).toBe(true);

      await sendLine(h.win, projA, 0, '/hook-notify permission_prompt popped out and needs you');
      await expect.poll(() => notifications(h.app), { timeout: 2000 }).toHaveLength(1);

      await clickNotification(h.app, 0);
      await expect.poll(() => popout.evaluate(() => document.hasFocus()), { timeout: 5000 }).toBe(true);
    } finally {
      await h.app.close();
      h.cleanup();
    }
  });

  /* ── Configuration safety ─────────────────────────────────────────────*/
  test('AC7/AC8: no Claude config file is touched; the injected --settings flag never leaks into recorded/edited launch commands', async () => {
    const h = await launch(['proja']);
    let appClosed = false;
    try {
      // Snapshot every path under ~/.claude* and the project's .claude/
      // before opening anything. Real Claude writes to ~/.claude* every
      // session, so this is compared to mock-claude, which writes nothing
      // itself, isolating the app's own writes. `~/.claude.json` is a FILE,
      // not a directory (snapshotClaudePath distinguishes — a bare
      // readdirSync/catch would silently read both "absent" and "present
      // but changed" as the same thing here).
      const claudeHomeNames = ['.claude', '.claude.json'];
      const before = claudeHomeNames.map((n) => snapshotClaudePath(join(h.isolatedHome, n)));
      const projectClaudeDir = join(h.demoRoot, 'proja', '.claude');
      const beforeProjectDir = (() => { try { return readdirSync(projectClaudeDir).sort(); } catch { return null; } })();

      await openProject(h.win, 'proja');
      const projA = await projectId(h.win, 'proja');
      await waitForShell(h.win, projA, 0, 'mock-claude ready');
      // Amended AC12a: "finished" requires busy -> idle.
      await sendLine(h.win, projA, 0, 'hello');
      await waitForClaudeState(h.win, projA, 0, 'busy');
      await sendLine(h.win, projA, 0, '/hook-stop');
      await h.win.evaluate(async (id: number) => {
        await (window as unknown as { api: Api }).api.invoke('shells:kill', { projectId: id, shellIndex: 0 });
      }, projA);

      const after = claudeHomeNames.map((n) => snapshotClaudePath(join(h.isolatedHome, n)));
      expect(after, 'AC7 nothing under ~/.claude* changed').toEqual(before);
      const afterProjectDir = (() => { try { return readdirSync(projectClaudeDir).sort(); } catch { return null; } })();
      expect(afterProjectDir, 'AC7 project .claude/ unchanged/absent').toEqual(beforeProjectDir);

      // The app's own settings file lives only under ~/.metaide/claude-hooks/.
      const hooksDir = join(h.isolatedHome, '.metaide', 'claude-hooks');
      const hookFiles = readdirSync(hooksDir);
      expect(hookFiles.length, 'AC7 app-owned settings file was written').toBeGreaterThan(0);
      for (const f of hookFiles) {
        expect(join(hooksDir, f)).not.toContain('.claude');
      }
      const hookFilePath = join(hooksDir, hookFiles[0]!);

      // AC8: the recorded launchArgv (re-open to relaunch it) never carries
      // --settings, and the Launch commands editors don't show it either.
      const relaunched = await h.win.evaluate(async (id: number) => {
        const api = (window as unknown as { api: Api }).api;
        return (await api.invoke('shells:launch', { projectId: id }) as unknown as { shellIndex: number }).shellIndex;
      }, projA);
      await waitForShell(h.win, projA, relaunched, 'mock-claude resumed');
      const alive = await aliveShells(h.win);
      const shell0 = alive.find((s) => s.projectId === projA && s.shellIndex === relaunched);
      expect(shell0, 'relaunched shell present in alive-list').toBeTruthy();
      expect(shell0!.launchArgv, 'AC8 launchArgv has no --settings').not.toContain('--settings');
      expect(shell0!.launchArgv.some((a) => a.startsWith('--settings=')), 'AC8 launchArgv has no --settings=').toBe(false);

      await h.win.getByTestId('settings-open').click();
      const settingsModal = h.win.getByTestId('settings-modal');
      await expect(settingsModal).toBeVisible({ timeout: 5000 });
      await settingsModal.getByRole('button', { name: 'Launch commands' }).click();
      const firstEditor = settingsModal.getByTestId('launch-editor-first');
      await expect(firstEditor).not.toHaveValue(/--settings/);
      await h.win.getByTestId('settings-done').click();

      // The settings file is this running instance's own — it must be
      // removed on quit (ClaudeHookRuntime.stop() via the `before-quit`
      // handler, src/main/index.ts), not left behind for the next launch to
      // find stale. The isolated HOME makes this observable: nothing else
      // writes here.
      expect(existsSync(hookFilePath), 'settings file present before quit').toBe(true);
      await h.app.close();
      appClosed = true;
      expect(existsSync(hookFilePath), 'settings file removed after quit').toBe(false);
    } finally {
      if (!appClosed) await h.app.close();
      h.cleanup();
    }
  });

  /* ── Non-Claude shells and user-supplied --settings ──────────────────*/
  test('AC5/AC27: non-Claude shells and a user-supplied --settings are launched untouched and never notify', async () => {
    const h = await launch(['proja', 'projb']);
    try {
      await installNotificationSpy(h.app);
      await openProject(h.win, 'proja');
      const projA = await projectId(h.win, 'proja');
      await waitForShell(h.win, projA, 0, 'mock-claude ready');

      /** Reads `/hook-argv`'s `count=<n> path=<p>` output for a shell (n as a number, path as a string). */
      async function hookArgv(shellIndex: number): Promise<{ count: number; path: string }> {
        await sendLine(h.win, projA, shellIndex, '/hook-argv');
        await waitForShell(h.win, projA, shellIndex, 'HOOK-ARGV count=');
        const out = await h.win.evaluate(async (args: { projectId: number; shellIndex: number }) => {
          const api = (window as unknown as { api: Api }).api;
          const s = await api.invoke('shells:snapshot', args) as unknown as { output: string };
          return s.output;
        }, { projectId: projA, shellIndex });
        const m = /HOOK-ARGV count=(\d+) path=(\S+)/.exec(out);
        if (!m) throw new Error(`no HOOK-ARGV line in shell ${shellIndex} output`);
        return { count: Number(m[1]), path: m[2]! };
      }

      // Prove the /hook-argv + /hook-env assertions below are meaningful
      // (would actually fail if decoration were broken): shell 0 IS a
      // decorated Claude shell (opened via the shim), so it must show
      // exactly one --settings pointing at the app's own hooks dir, and a
      // real METAIDE_HOOK_* env pair.
      const decorated = await hookArgv(0);
      expect(decorated.count, 'positive control: a real Claude shell gets exactly one --settings').toBe(1);
      expect(decorated.path, 'positive control: pointed at the app-owned hooks dir').toContain('.metaide/claude-hooks/settings-');
      await sendLine(h.win, projA, 0, '/hook-env');
      await waitForShell(h.win, projA, 0, 'HOOK-ENV shell=');
      const decoratedEnv = await h.win.evaluate(async (args: { projectId: number; shellIndex: number }) => {
        const api = (window as unknown as { api: Api }).api;
        const s = await api.invoke('shells:snapshot', args) as unknown as { output: string };
        return s.output;
      }, { projectId: projA, shellIndex: 0 });
      expect(decoratedEnv, 'positive control: real METAIDE_HOOK_* env reached a decorated shell').toMatch(/HOOK-ENV shell=(?!none)\S+ token=(?!none)\S+/);

      // AC5: a plain terminal (⌘T-equivalent IPC) is not a Claude argv and
      // is never decorated — its environment has no METAIDE_HOOK_* at all
      // (checked from inside the shell itself, not mock-claude, since it
      // isn't running mock-claude).
      const plainIdx = await h.win.evaluate(async (id: number) => {
        const api = (window as unknown as { api: Api }).api;
        return (await api.invoke('shells:launch-plain', { projectId: id }) as unknown as { shellIndex: number }).shellIndex;
      }, projA);
      await waitForShell(h.win, projA, plainIdx, '$');
      await sendLine(h.win, projA, plainIdx, 'echo "PLAIN-ENV shell=${METAIDE_HOOK_SHELL:-none} token=${METAIDE_HOOK_TOKEN:-none}"');
      await waitForShell(h.win, projA, plainIdx, 'PLAIN-ENV shell=none token=none');

      // AC5: a non-Claude CLI profile — `node mock-claude.mjs` directly —
      // is also not a Claude argv (argv[0] is `node`), so mock-claude never
      // receives --settings and its /hook-* commands become no-ops.
      const nodeProfileIdx = await h.win.evaluate(async (args: { id: number; mockClaude: string }) => {
        const api = (window as unknown as { api: Api }).api;
        return (await api.invoke('shells:launch-cli', {
          projectId: args.id, profileName: 'node-claude', argv: ['node', args.mockClaude], save: false,
        }) as unknown as { shellIndex: number }).shellIndex;
      }, { id: projA, mockClaude: MOCK_CLAUDE });
      await waitForShell(h.win, projA, nodeProfileIdx, 'mock-claude ready');
      const nodeArgv = await hookArgv(nodeProfileIdx);
      expect(nodeArgv.count, 'AC5 node profile: no --settings at all').toBe(0);
      await sendLine(h.win, projA, nodeProfileIdx, '/hook-notify permission_prompt should not notify');
      await sendLine(h.win, projA, nodeProfileIdx, '/hook-stop');

      // AC27: a Claude argv that ALREADY specifies --settings is launched
      // exactly as given — no injection. Checked at the process, not from
      // the app's own (pre-decoration, AC8) launch record: exactly one
      // --settings, pointing at the USER's file, and no METAIDE_HOOK_* env.
      const userSettingsDir = mkdtempSync(join(tmpdir(), 'metaide-user-settings-'));
      const userSettingsPath = join(userSettingsDir, 'user-settings.json');
      writeFileSync(userSettingsPath, JSON.stringify({ hooks: {} }));
      const userSettingsIdx = await h.win.evaluate(async (args: { id: number; shim: string; settingsPath: string }) => {
        const api = (window as unknown as { api: Api }).api;
        return (await api.invoke('shells:launch-cli', {
          projectId: args.id, profileName: 'claude-user-settings', argv: [args.shim, '--settings', args.settingsPath], save: false,
        }) as unknown as { shellIndex: number }).shellIndex;
      }, { id: projA, shim: h.shimPath, settingsPath: userSettingsPath });
      await waitForShell(h.win, projA, userSettingsIdx, 'mock-claude ready');
      const userArgv = await hookArgv(userSettingsIdx);
      expect(userArgv.count, 'AC27 exactly one --settings, never two').toBe(1);
      expect(userArgv.path, 'AC27 it is the USER\'s own file, not the app\'s').toBe(userSettingsPath);
      await sendLine(h.win, projA, userSettingsIdx, '/hook-env');
      await waitForShell(h.win, projA, userSettingsIdx, 'HOOK-ENV shell=');
      const userEnv = await h.win.evaluate(async (args: { projectId: number; shellIndex: number }) => {
        const api = (window as unknown as { api: Api }).api;
        const s = await api.invoke('shells:snapshot', args) as unknown as { output: string };
        return s.output;
      }, { projectId: projA, shellIndex: userSettingsIdx });
      expect(userEnv, 'AC27 no METAIDE_HOOK_* env — never decorated').toMatch(/HOOK-ENV shell=none token=none/);

      await h.win.waitForTimeout(2000);
      expect(await notifications(h.app), 'AC5/AC27 no notifications from non-decorated shells so far').toHaveLength(0);

      // Positive control: a decorated shell that IS Claude and IS NOT
      // viewed still notifies normally — proves the "0" above reflects
      // AC5/AC27 exemptions, not a broken spy or receiver. Switch away from
      // proja first.
      await openProject(h.win, 'projb');
      await waitForShell(h.win, await projectId(h.win, 'projb'), 0, 'mock-claude ready');
      await sendLine(h.win, projA, 0, '/hook-notify permission_prompt unrelated decorated shell still works');
      await expect.poll(() => notifications(h.app), { timeout: 2000 }).toHaveLength(1);

      rmSync(userSettingsDir, { recursive: true, force: true });
    } finally {
      await h.app.close();
      h.cleanup();
    }
  });

  /* ── AC6: subsequent (--continue) and CLI-profile launches also notify ─*/
  test('AC6: the --continue relaunch and a CLI-profile Claude launch both produce notifications', async () => {
    const h = await launch(['proja', 'projb']);
    try {
      await installNotificationSpy(h.app);
      await openProject(h.win, 'proja');
      const projA = await projectId(h.win, 'proja');
      await waitForShell(h.win, projA, 0, 'mock-claude ready');
      await sendLine(h.win, projA, 0, 'hello');

      // Kill shell 0 and relaunch the primary slot: firstLaunchedAt is
      // already set, so this resolves to the `subsequent` (--continue) variant.
      await h.win.evaluate(async (id: number) => {
        await (window as unknown as { api: Api }).api.invoke('shells:kill', { projectId: id, shellIndex: 0 });
      }, projA);
      const relaunchedIdx = await h.win.evaluate(async (id: number) => {
        const api = (window as unknown as { api: Api }).api;
        return (await api.invoke('shells:launch', { projectId: id }) as unknown as { shellIndex: number }).shellIndex;
      }, projA);
      await waitForShell(h.win, projA, relaunchedIdx, 'mock-claude resumed');
      const relaunchedArgv = (await aliveShells(h.win)).find((s) => s.shellIndex === relaunchedIdx)!.launchArgv;
      expect(relaunchedArgv, 'subsequent launch carries --continue').toContain('--continue');
      // The RECORDED launchArgv is deliberately the pre-decoration argv
      // (AC8 — the injected --settings never leaks into it), so decoration
      // can only be checked from inside the spawned process itself.
      await sendLine(h.win, projA, relaunchedIdx, '/hook-env');
      await waitForShell(h.win, projA, relaunchedIdx, 'HOOK-ENV shell=');
      const hookEnvOutput = await h.win.evaluate(async (args: { projectId: number; shellIndex: number }) => {
        const api = (window as unknown as { api: Api }).api;
        const s = await api.invoke('shells:snapshot', args) as unknown as { output: string };
        return s.output;
      }, { projectId: projA, shellIndex: relaunchedIdx });
      expect(hookEnvOutput, 'subsequent launch is still decorated (real METAIDE_HOOK_* env reached the process)').toMatch(/HOOK-ENV shell=(?!none)\S+ token=(?!none)\S+/);

      // Switch to a different project so proja is no longer viewed (AC16):
      // the notifier's suppression rule is exercised elsewhere; here we
      // only need the event to actually surface a notification.
      await openProject(h.win, 'projb');
      await waitForShell(h.win, await projectId(h.win, 'projb'), 0, 'mock-claude ready');

      // Amended AC12a: "finished" requires busy -> idle. The relaunched
      // shell is a fresh session (idle baseline) — the `/hook-env` line just
      // sent posts no hook, so establish busy explicitly.
      await sendLine(h.win, projA, relaunchedIdx, 'hello');
      await waitForClaudeState(h.win, projA, relaunchedIdx, 'busy');
      await sendLine(h.win, projA, relaunchedIdx, '/hook-stop');
      await expect.poll(() => notifications(h.app), { timeout: 2000 }).toHaveLength(1);
      expect((await notifications(h.app))[0]!.title).toBe(`proja — shell ${relaunchedIdx}`);

      // CLI-profile launch of Claude (a fresh shell slot via shells:launch-cli
      // with the shim argv) also gets decorated and notifies.
      const cliIdx = await h.win.evaluate(async (args: { id: number; shim: string }) => {
        const api = (window as unknown as { api: Api }).api;
        return (await api.invoke('shells:launch-cli', {
          projectId: args.id, profileName: 'Claude', argv: [args.shim], save: false,
        }) as unknown as { shellIndex: number }).shellIndex;
      }, { id: projA, shim: h.shimPath });
      await waitForShell(h.win, projA, cliIdx, 'mock-claude ready');
      await sendLine(h.win, projA, cliIdx, 'hello');
      await waitForClaudeState(h.win, projA, cliIdx, 'busy');
      await sendLine(h.win, projA, cliIdx, '/hook-stop');
      await expect.poll(() => notifications(h.app), { timeout: 2000 }).toHaveLength(2);
      expect((await notifications(h.app))[1]!.title).toBe(`proja — shell ${cliIdx}`);
    } finally {
      await h.app.close();
      h.cleanup();
    }
  });

  /* ── Settings toggles ─────────────────────────────────────────────────*/
  test('AC20/AC21: toggles are on by default, take effect live, and persist across restart', async () => {
    const h = await launch(['proja']);
    try {
      await installNotificationSpy(h.app);
      await openProject(h.win, 'proja');
      const projA = await projectId(h.win, 'proja');
      await waitForShell(h.win, projA, 0, 'mock-claude ready');

      // AC20: both on by default.
      await h.win.getByTestId('settings-open').click();
      const settingsModal = h.win.getByTestId('settings-modal');
      await expect(settingsModal).toBeVisible({ timeout: 5000 });
      const needsInputToggle = settingsModal.getByTestId('notify-needs-input-toggle');
      const finishedToggle = settingsModal.getByTestId('notify-finished-toggle');
      await expect(needsInputToggle).toBeChecked();
      await expect(finishedToggle).toBeChecked();

      // AC21: turning "finished" off takes effect for the very next event —
      // in the same already-running shell, no restart.
      await finishedToggle.click();
      await expect(finishedToggle).not.toBeChecked();
      await h.win.getByTestId('settings-done').click();

      // We're still viewing proja's shell 0 (never switched away) — a
      // renderer document.activeElement blur does not change that (AC15
      // suppression is keyed on the reported project/tab + main-process
      // window focus, not DOM focus). Minimise for real so the toggle, not
      // AC15, is what's under test here.
      await h.app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.minimize(); });
      // Amended AC12a: "finished" requires busy -> idle — establish busy
      // first so this is a real test of the toggle, not just "no hook fired".
      await sendLine(h.win, projA, 0, 'hello');
      await waitForClaudeState(h.win, projA, 0, 'busy');
      await sendLine(h.win, projA, 0, '/hook-stop');
      await h.win.waitForTimeout(2000);
      expect(await notifications(h.app), 'finished toggle off: no notification').toHaveLength(0);

      // needs-input is still on: positive control the pipeline is alive.
      await sendLine(h.win, projA, 0, '/hook-notify permission_prompt still on');
      await expect.poll(() => notifications(h.app), { timeout: 2000 }).toHaveLength(1);

      // AC20 persistence: relaunch with the same HOME, toggle still off.
      await h.app.close();
      const app2 = await electron.launch({
        args: ['.', `--user-data-dir=${join(h.isolatedHome, 'userData')}`],
        env: {
          ...baseEnv(),
          HOME: h.isolatedHome,
          SHELL: '/bin/sh',
          METAIDE_TEST_MODE: '1',
          METAIDE_CLAUDE_PERMISSION_MODE: 'bypass',
          METAIDE_DEFAULT_LAUNCH_FIRST:      JSON.stringify({ argv: [h.shimPath], env: {} }),
          METAIDE_DEFAULT_LAUNCH_SUBSEQUENT: JSON.stringify({ argv: [h.shimPath, '--continue'], env: {} }),
        },
      });
      const win2 = await app2.firstWindow();
      await win2.waitForLoadState('domcontentloaded');
      await win2.getByTestId('settings-open').click();
      const modal2 = win2.getByTestId('settings-modal');
      await expect(modal2).toBeVisible({ timeout: 5000 });
      await expect(modal2.getByTestId('notify-finished-toggle'), 'AC20 toggle persisted across restart').not.toBeChecked();
      await expect(modal2.getByTestId('notify-needs-input-toggle')).toBeChecked();
      await win2.getByTestId('settings-done').click();
      await app2.close();
    } finally {
      try { await h.app.close(); } catch { /* already closed above */ }
      h.cleanup();
    }
  });

  /* ── Robustness: receiver unavailable, auth, shell-exit cleanup ───────*/
  test('AC22/AC23/AC24/AC26: receiver unavailable falls back cleanly, unauthenticated POSTs are rejected, exit cleans up', async () => {
    const isolatedHome = mkdtempSync(join(tmpdir(), 'metaide-notif-robust-home-'));
    const demoRoot = mkdtempSync(join(tmpdir(), 'metaide-notif-robust-root-'));
    const proj = join(demoRoot, 'proja');
    mkdirSync(proj);
    mkdirSync(join(proj, '.git'));
    const shimPath = makeClaudeShim(isolatedHome);
    try {
      // AC22: make the hook settings file unwritable by pre-creating its
      // parent directory as a plain FILE (mkdirSync then throws ENOTDIR
      // regardless of which port the receiver ends up on) — no production
      // code change, just a filesystem precondition ClaudeHookRuntime.start()
      // already has to handle (settings-file.ts / runtime.ts).
      const metaideDir = join(isolatedHome, '.metaide');
      mkdirSync(metaideDir, { recursive: true });
      writeFileSync(join(metaideDir, 'claude-hooks'), 'not a directory');

      const app = await electron.launch({
        args: ['.', `--user-data-dir=${join(isolatedHome, 'userData')}`],
        env: {
          ...baseEnv(),
          HOME: isolatedHome,
          SHELL: '/bin/sh',
          METAIDE_TEST_MODE: '1',
          METAIDE_CLAUDE_PERMISSION_MODE: 'bypass',
          METAIDE_DEFAULT_LAUNCH_FIRST:      JSON.stringify({ argv: [shimPath], env: {} }),
          METAIDE_DEFAULT_LAUNCH_SUBSEQUENT: JSON.stringify({ argv: [shimPath, '--continue'], env: {} }),
        },
      });
      try {
        await installNotificationSpy(app);
        const win = await app.firstWindow();
        await win.waitForLoadState('domcontentloaded');
        let dialogShown = false;
        win.on('dialog', (d) => { dialogShown = true; void d.dismiss(); });
        await win.evaluate(async (path: string) => {
          await (window as unknown as { api: Api }).api.invoke('roots:add', { path });
        }, demoRoot);
        await openProject(win, 'proja');
        const projA = await projectId(win, 'proja');
        // AC22: Claude still launches and runs normally, no error dialog.
        await waitForShell(win, projA, 0, 'mock-claude ready');
        expect(dialogShown, 'AC22 no error dialog when the receiver is unavailable').toBe(false);
        // Never decorated (no working settings path to inject).
        const alive = await aliveShells(win);
        expect(alive[0]!.launchArgv).not.toContain('--settings');

        // AC22/AC18 corollary: the shell was never hook-confirmed, so the
        // generic notifier still covers it. Minimise for real (main-process
        // BrowserWindow, not a renderer document.activeElement blur, which
        // does not touch the generic notifier's own "is main focused" rule
        // at all — src/main/index.ts's done-poll loop).
        await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.minimize(); });
        await sendLine(win, projA, 0, '/work 9');
        await win.waitForTimeout(11000);
        expect(
          (await notifications(app)).some((n) => n.body.startsWith('Command finished')),
          'AC22 generic notifier covers a shell whose hooks never connected',
        ).toBe(true);

        // AC23: the app's own echo behaviour is unaffected by hook reporting
        // (which is a no-op here since there is no receiver) — round trip
        // stays fast.
        const start = Date.now();
        await sendLine(win, projA, 0, 'ping-after-fallback');
        await waitForShell(win, projA, 0, 'echo: ping-after-fallback');
        expect(Date.now() - start, 'AC23 turn not delayed').toBeLessThan(5000);
      } finally {
        await app.close();
      }
    } finally {
      rmSync(isolatedHome, { recursive: true, force: true });
      rmSync(demoRoot, { recursive: true, force: true });
    }

    // ── AC24/AC26: a working receiver, but forged/dead credentials ──────
    const h2 = await launch(['projb']);
    try {
      await installNotificationSpy(h2.app);
      await openProject(h2.win, 'projb');
      const projB = await projectId(h2.win, 'projb');
      await waitForShell(h2.win, projB, 0, 'mock-claude ready');
      await sendLine(h2.win, projB, 0, 'hello');
      // Real main-process unfocus (see the AC18/19 fix above for why a
      // renderer document.activeElement blur does not achieve this) — the
      // positive control below needs projb's shell 0 to not be "viewed".
      await h2.app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.minimize(); });

      // Discover this instance's settings file (one per running receiver
      // port) and the shell's real id/token via /hook-env.
      const hooksDir = join(h2.isolatedHome, '.metaide', 'claude-hooks');
      const settingsFile = readdirSync(hooksDir).find((f) => f.startsWith('settings-'));
      expect(settingsFile, 'AC24 setup: app-owned settings file exists').toBeTruthy();
      const settings = JSON.parse(readFileSync(join(hooksDir, settingsFile!), 'utf8')) as {
        hooks: { Notification: Array<{ hooks: Array<{ url: string }> }> };
      };
      const url = settings.hooks.Notification[0]!.hooks[0]!.url;

      await sendLine(h2.win, projB, 0, '/hook-env');
      await waitForShell(h2.win, projB, 0, 'HOOK-ENV shell=');
      const snap = await h2.win.evaluate(async (args: { projectId: number; shellIndex: number }) => {
        const api = (window as unknown as { api: Api }).api;
        const s = await api.invoke('shells:snapshot', args) as unknown as { output: string };
        return s.output;
      }, { projectId: projB, shellIndex: 0 });
      const m = /HOOK-ENV shell=(\S+) token=(\S+)/.exec(snap);
      expect(m, 'parsed HOOK-ENV line').toBeTruthy();
      const [, realShellId, realToken] = m!;

      // AC24: missing token → 401, no notification.
      const noAuthRes = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Metaide-Shell': realShellId! },
        body: JSON.stringify({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'forged, no token' }),
      });
      expect(noAuthRes.status, 'AC24 missing token rejected').toBe(401);

      // AC24: wrong token → 401, no notification.
      const wrongAuthRes = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Metaide-Shell': realShellId!, Authorization: 'Bearer not-the-real-token' },
        body: JSON.stringify({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'forged, wrong token' }),
      });
      expect(wrongAuthRes.status, 'AC24 wrong token rejected').toBe(401);
      await h2.win.waitForTimeout(1000);
      expect(await notifications(h2.app), 'AC24 no notification from either forged POST').toHaveLength(0);

      // Positive control: the real id + token DOES authenticate and notify —
      // proves the 401s above are about the credential, not a broken URL.
      const validRes = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Metaide-Shell': realShellId!, Authorization: `Bearer ${realToken}` },
        body: JSON.stringify({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'real credential' }),
      });
      expect(validRes.status, 'AC24 positive control: real credential accepted').toBe(204);
      await expect.poll(() => notifications(h2.app), { timeout: 2000 }).toHaveLength(1);
      expect((await notifications(h2.app))[0]!.closed).toBe(false);

      // AC26: kill the shell — its outstanding notification closes.
      await h2.win.evaluate(async (id: number) => {
        await (window as unknown as { api: Api }).api.invoke('shells:kill', { projectId: id, shellIndex: 0 });
      }, projB);
      await expect.poll(async () => (await notifications(h2.app))[0]!.closed, { timeout: 3000 }).toBe(true);

      // AC26: a stray event with the now-dead id/token is rejected (401),
      // and produces no new notification.
      const staleRes = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Metaide-Shell': realShellId!, Authorization: `Bearer ${realToken}` },
        body: JSON.stringify({ hook_event_name: 'Stop' }),
      });
      expect(staleRes.status, 'AC26 dead session id rejected').toBe(401);
      await h2.win.waitForTimeout(1000);
      expect(await notifications(h2.app), 'AC26 no new notification from a stray event').toHaveLength(1);
    } finally {
      await h2.app.close();
      h2.cleanup();
    }
  });
});
