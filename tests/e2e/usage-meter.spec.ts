import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { join } from 'node:path';
import { USAGE_FIXTURE_ENV, USAGE_TESTIDS, type UsageFixture } from '../../src/shared/usage-contract';
import { closeApp, guardedLaunch } from './helpers/claude-harness';

/**
 * The activity-bar AI usage meter against canned endpoint responses (METAIDE_USAGE_FIXTURE):
 * no test reads real credentials or calls a real usage endpoint.
 */

const WEEK_FROM_NOW = new Date(Date.now() + 3 * 86_400_000).toISOString();
const FIXTURE: UsageFixture = {
  claude: { status: 200, body: { five_hour: { utilization: 12, resets_at: WEEK_FROM_NOW }, seven_day: { utilization: 93, resets_at: WEEK_FROM_NOW }, limits: [
    { kind: 'weekly_all', group: 'weekly', percent: 93, resets_at: WEEK_FROM_NOW, scope: null },
    { kind: 'weekly_scoped', group: 'weekly', percent: 74, resets_at: WEEK_FROM_NOW, scope: { model: { id: null, display_name: 'Fable' }, surface: null } },
  ] } },
  codex: { status: 429, retryAfter: '900' },
};

let app: ElectronApplication;
let win: Page;

test.beforeAll(async () => {
  await guardedLaunch(async (scope) => {
    const home = scope.tempDir('metaide-usage-home-');
    app = scope.own(await electron.launch({
      args: ['.', `--user-data-dir=${join(home, 'userData')}`],
      env: { ...process.env, HOME: home, METAIDE_TEST_MODE: '1', METAIDE_CLAUDE_PERMISSION_MODE: 'bypass', [USAGE_FIXTURE_ENV]: JSON.stringify(FIXTURE) },
    }));
    win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
  });
});

test.afterAll(async () => {
  if (app) await closeApp(app);
});

test('the meter shows a weekly bar for each provider with figures, and the popover explains a rate limit', async () => {
  const button = win.getByTestId(USAGE_TESTIDS.button);
  await expect(button).toBeVisible();
  await expect(button).toHaveAttribute('aria-label', 'AI usage — weekly peak 93%');
  await expect(win.getByTestId(USAGE_TESTIDS.meter('claude')), 'Claude has weekly figures').toBeVisible();
  await expect(win.getByTestId(USAGE_TESTIDS.meter('claude')).locator('[data-level]'), 'high usage is red').toHaveAttribute('data-level', 'critical');
  await expect(button, 'the icon itself is never coloured').not.toHaveAttribute('data-level');
  await expect(win.getByTestId(USAGE_TESTIDS.meter('claude-fable')), 'Fable shows only in the popover').toHaveCount(0);
  await expect(win.getByTestId(USAGE_TESTIDS.meter('codex')), 'rate-limited Codex has no bar').toHaveCount(0);

  const popover = win.getByTestId(USAGE_TESTIDS.popover);
  // The first synthetic hover after launch is sometimes not delivered; move off and back until it opens.
  await expect(async () => {
    await win.mouse.move(400, 300);
    await button.hover();
    await expect(popover).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 10_000 });
  await expect(popover).toContainText('Weekly · 93%');
  await expect(popover).toContainText('5-hour · 12%');
  await expect(popover.getByTestId(USAGE_TESTIDS.modelRow('claude', 'fable'))).toContainText('Weekly · Fable · 74%');
  await expect(popover).toContainText(/resets in 2d 2\dh|resets in 3d 0h/);
  await expect(popover).toContainText(/Rate limited by the provider — retrying in 1\dm/);
});
