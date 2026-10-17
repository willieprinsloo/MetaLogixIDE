import { test, expect } from '@playwright/test';
import { AGENT_DOT } from '../../src/shared/agent-state';
import {
  launchStatus,
  openProject,
  projectId,
  sendLine,
  expectAgentDot,
  expectAggregate,
  tabDot,
  rowDot,
  inUseDot,
  launchCli,
} from './helpers/agent-status-harness';

test('AC8/AC9: inactive idle tab stays static grey; only its live agent changes its own dot', async () => {
  const h = await launchStatus(['proja', 'projb']);
  try {
    await openProject(h.win, 'proja');
    const a = await projectId(h.win, 'proja');
    const second = await launchCli(h.win, a, 'Claude', [
      h.claude,
      '--settings',
      `${h.home}/unused-settings.json`,
    ]);
    const inactive = tabDot(h.win, second);
    await expect(inactive).toHaveAccessibleName('Claude is idle');
    await expect(inactive).not.toHaveAttribute(AGENT_DOT.stateAttr, /.+/);
    await expect(inactive).not.toHaveClass(/live-dot/);
    await expectAgentDot(tabDot(h.win, 0), 'claude', 'idle'); // control: active idle has a live state dot

    await sendLine(h.win, a, second, '/status-work');
    await expectAgentDot(inactive, 'claude', 'busy');
    await expect(inactive).toHaveClass(/live-dot/);
    await expectAgentDot(tabDot(h.win, 0), 'claude', 'idle');
    await expectAggregate(rowDot(h.win, 'proja'), 'busy');
    await expectAggregate(inUseDot(h.win), 'busy');

    await sendLine(h.win, a, second, '/status-approval');
    await expectAgentDot(inactive, 'claude', 'blocked');
    await expectAggregate(rowDot(h.win, 'proja'), 'blocked');
    await expectAgentDot(tabDot(h.win, 0), 'claude', 'idle');
    await openProject(h.win, 'projb');
    await expectAggregate(rowDot(h.win, 'projb'), 'idle'); // control: other project is live, but not blocked
    await expectAggregate(rowDot(h.win, 'proja'), 'blocked');
    await expectAggregate(inUseDot(h.win), 'blocked');
  } finally {
    await h.close();
  }
});

test('AC8/AC9: ChatTab and unopened project keep their original unrelated indicators', async () => {
  const h = await launchStatus(['proja', 'untouched']);
  try {
    await openProject(h.win, 'proja');
    const a = await projectId(h.win, 'proja');
    await sendLine(h.win, a, 0, '/status-approval');
    await expectAgentDot(tabDot(h.win, 0), 'claude', 'blocked'); // positive control
    await h.win.getByTestId('ab-chat').click();
    const chat = h.win.locator('[data-view="chat"]');
    await expect(chat).toBeVisible();
    await expect(chat.getByTestId(AGENT_DOT.testId)).toHaveCount(0);
    const unopened = h.win
      .locator('[data-testid="project-row"][data-alive="0"]')
      .filter({ has: h.win.getByText('untouched', { exact: true }) })
      .first();
    await expect(unopened).toBeVisible();
    await expect(unopened.getByTestId(AGENT_DOT.testId)).toHaveCount(0);
    await expectAggregate(rowDot(h.win, 'proja'), 'blocked'); // control: status still rendered elsewhere
  } finally {
    await h.close();
  }
});
