import { test, expect } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SHELL_TAB_TEST_ID } from '../../src/shared/agent-state';
import { launch, openProject, type Harness } from './helpers/claude-harness';
import { MOCK_CLAUDE_BANNER } from './helpers/focus';
import { terminalProbes } from './helpers/terminal-probe';

/**
 * A task run from the Tasks panel spawns a new shell. The shell must appear in
 * the project's tab strip and its terminal must show the task's output,
 * without any other action refreshing the shell list, and show it again after
 * the user switches to another tab and back.
 */
const PROJECT = 'task-visibility';
const MARKER = 'TASK-VISIBLE-OUTPUT';

let h: Harness | undefined;
test.afterEach(async () => { await h?.app.close(); h?.cleanup(); h = undefined; });

test('a task run from the Tasks panel shows its shell tab and terminal', async ({}, testInfo) => {
  testInfo.setTimeout(60_000);
  h = await launch([PROJECT]);
  const { win, demoRoot } = h;
  writeFileSync(
    join(demoRoot, PROJECT, 'package.json'),
    JSON.stringify({ scripts: { e2eprobe: `printf '${MARKER}\\n'; sleep 60` } }),
  );
  await openProject(win, PROJECT);
  const tabs = win.locator(`[data-testid="${SHELL_TAB_TEST_ID}"]`);
  await expect(tabs).toHaveCount(1);

  await win.locator('[data-testid="ab-tasks"]').click();
  const row = win.getByRole('button', { name: /e2eprobe/ });
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.click();

  await expect(tabs).toHaveCount(2, { timeout: 5_000 });
  // xterm renders to a canvas, so read the visible terminal's buffer instead of DOM text.
  const visibleScreens = async () => (await terminalProbes(win)).map((t) => t.screen).join('\n');
  await expect.poll(visibleScreens, { timeout: 10_000 }).toContain(MARKER);

  // Switch to the other tab (shell 0, the mock Claude session) and back.
  const otherTab = win.locator(`[data-testid="${SHELL_TAB_TEST_ID}"][data-shell-index="0"]`);
  const taskTab = win.locator(`[data-testid="${SHELL_TAB_TEST_ID}"]:not([data-shell-index="0"])`);
  await expect(taskTab).toHaveCount(1);
  await otherTab.click();
  // Positive control: the probe reads the now-visible terminal (it shows the other tab's banner)...
  await expect
    .poll(visibleScreens, { timeout: 10_000, message: 'the other tab\'s terminal is on screen' })
    .toMatch(MOCK_CLAUDE_BANNER);
  // ...so the marker's absence proves the task terminal really left the screen.
  expect(await visibleScreens(), 'the task\'s output is not on screen while the other tab is selected').not.toContain(MARKER);

  await taskTab.click();
  await expect
    .poll(visibleScreens, { timeout: 10_000, message: 'the task\'s terminal shows its output again' })
    .toContain(MARKER);
});
