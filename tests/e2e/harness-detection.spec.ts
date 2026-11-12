import { test, expect } from '@playwright/test';
import { SHELL_TAB_TEST_ID } from '../../src/shared/agent-state';
import { launchStatus, launchPlain, openProject, projectId, sendLine, statusSnapshot } from './helpers/agent-status-harness';

type Api = { invoke: (channel: string, request?: unknown) => Promise<unknown> };

/** A harness typed into a plain terminal is recognised: the tab is labelled as it, and the project remembers it for resume. */
test('typing codex into a terminal labels the tab Codex, reports the agent, and marks Codex resumable for the project', async () => {
  const h = await launchStatus(['proja']);
  try {
    await openProject(h.win, 'proja');
    const a = await projectId(h.win, 'proja');
    const plain = await launchPlain(h.win, a);
    const chip = h.win.locator(`[data-testid="${SHELL_TAB_TEST_ID}"][data-shell-index="${plain}"]`);
    await expect(chip, 'positive control: a plain shell is labelled Terminal').toContainText('Terminal');

    await sendLine(h.win, a, plain, 'codex');
    await expect.poll(async () => (await statusSnapshot(h.win)).find((e) => e.projectId === a && e.shellIndex === plain)?.agent ?? null,
      { timeout: 10_000 }).toBe('codex');
    await expect(chip).toContainText('Codex');
    await expect.poll(async () => {
      const { projects } = await h.win.evaluate(async () => (window as unknown as { api: Api }).api.invoke('projects:list')) as { projects: { id: number; config: { resumableAgents?: string[] } }[] };
      return projects.find((p) => p.id === a)?.config.resumableAgents ?? [];
    }).toContain('codex');
  } finally {
    await h.close();
  }
});
