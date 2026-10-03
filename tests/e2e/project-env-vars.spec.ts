import { test, expect, type Locator, type Page } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ENV_COPY, ENV_TESTIDS } from '../../src/renderer/project-env-copy';
import { launch, openProject, projectId, sendLine, type Api, type Harness } from './helpers/claude-harness';

/**
 * Per-project environment variables (docs/specs/project-env-vars.md).
 *
 * Why this home can observe the behaviour: this suite drives the built
 * Electron app — real main process, real `PtyManager` spawning a real login
 * shell, real SQLite under an isolated HOME. Nothing is stubbed, so whatever
 * the shell prints is the environment `node-pty` actually handed the child.
 * `launch()` gives an isolated HOME with no rc files and SHELL=/bin/sh, so the
 * login shell has no profile that could overwrite the variables under test.
 * (macOS /etc/profile still runs `path_helper`, which reorders PATH entries
 * but keeps their relative order — PATH assertions below check relative order,
 * not a literal prefix.)
 *
 * Terminal output is read from `shells:snapshot` (xterm renders via WebGL, so
 * there is no DOM text). Every printf format below carries a marker like
 * `ENV1[` followed by `%s`, and every regex asserts the *expanded* output, so
 * the shell's echo of the typed command can never satisfy an assertion.
 */

const PROJECT_A = 'envproja';
const PROJECT_B = 'envprojb';
const VAR_URL = 'E2E_API_URL';

let h: Harness | undefined;

test.afterEach(async () => {
  await h?.app.close();
  h?.cleanup();
  h = undefined;
});

/** Plain shell for a project; returns its shellIndex. */
async function launchPlain(win: Page, projId: number): Promise<number> {
  return win.evaluate(async (id: number) => {
    const api = (window as unknown as { api: Api }).api;
    return (await api.invoke('shells:launch-plain', { projectId: id }) as unknown as { shellIndex: number }).shellIndex;
  }, projId);
}

async function snapshot(win: Page, projId: number, shellIndex: number): Promise<string> {
  return win.evaluate(async (args: { projectId: number; shellIndex: number }) => {
    const api = (window as unknown as { api: Api }).api;
    return (await api.invoke('shells:snapshot', args) as unknown as { output: string }).output;
  }, { projectId: projId, shellIndex });
}

/** The project's persisted `config.env`, read from `projects:list` (what storage holds, not what the tab shows). */
async function storedEnv(win: Page, name: string): Promise<Record<string, string> | undefined> {
  return win.evaluate(async (n: string) => {
    const api = (window as unknown as { api: Api }).api;
    const { projects } = (await api.invoke('projects:list', undefined)) as unknown as {
      projects: Array<{ name: string; config: { env?: Record<string, string> } }>;
    };
    const p = projects.find((x) => x.name === n);
    if (!p) throw new Error(`project not found: ${n}`);
    return p.config.env;
  }, name);
}

/** True iff the active element is an xterm helper textarea inside `containerSelector` (pattern from terminal-window-focus.spec.ts). */
async function terminalActiveIn(win: Page, containerSelector: string): Promise<boolean> {
  return win.evaluate((sel: string) => {
    const el = document.activeElement;
    if (!el || !(el instanceof HTMLElement)) return false;
    if (!el.classList.contains('xterm-helper-textarea')) return false;
    return !!el.closest(sel);
  }, containerSelector);
}

/** `data-testid|aria-label` of the focused element, to tell rows apart in tab-order assertions. */
async function activeId(win: Page): Promise<string> {
  return win.evaluate(() => {
    const el = document.activeElement;
    return `${el?.getAttribute('data-testid') ?? ''}|${el?.getAttribute('aria-label') ?? ''}`;
  });
}

/**
 * Selects a project by its sidebar row without waiting for a terminal: with
 * the Env tab active no `.xterm` is mounted, which `openProject` requires.
 */
async function selectProject(win: Page, name: string): Promise<void> {
  const row = win.locator('[data-testid="project-row"]').filter({ has: win.getByText(name, { exact: true }) }).first();
  await expect(row).toBeVisible();
  await row.click();
  await expect.poll(() => win.title(), { timeout: 10000 }).toBe(`${name} — MetaLogix IDE`);
}

function envTab(win: Page): Locator {
  return win.getByTestId(ENV_TESTIDS.tab);
}

function panelOf(win: Page): Locator {
  return win.getByTestId(ENV_TESTIDS.panel);
}

async function openEnvTab(win: Page): Promise<Locator> {
  await envTab(win).click();
  const panel = panelOf(win);
  await expect(panel).toBeVisible();
  return panel;
}

async function clickTab(win: Page, label: 'Shell' | 'Files'): Promise<void> {
  await win.getByRole('button', { name: label, exact: true }).click();
}

/** Appends a row and fills it; `n` is the 1-based row number the new row gets. */
async function addRow(panel: Locator, n: number, name: string, value: string): Promise<void> {
  await panel.getByTestId(ENV_TESTIDS.add).click();
  await panel.getByLabel(ENV_COPY.nameLabel(n), { exact: true }).fill(name);
  await panel.getByLabel(ENV_COPY.valueLabel(n), { exact: true }).fill(value);
}

/** Clicks Save and waits for storage to catch up and the unsaved marker to clear. */
async function saveAndWait(win: Page, projectName: string, expected: Record<string, string>): Promise<void> {
  await panelOf(win).getByTestId(ENV_TESTIDS.save).click();
  await expect.poll(() => storedEnv(win, projectName), { timeout: 10000 }).toEqual(expected);
  await expect(win.getByTestId(ENV_TESTIDS.unsaved)).toHaveCount(0);
}

function reason(panel: Locator, text: string): Locator {
  return panel.getByTestId(ENV_TESTIDS.reason).filter({ hasText: text }).first();
}

test('Env tab journey: empty state, notices, save, tab switch, plain shell sees interpolated vars (AC1, AC2, AC4, AC6, AC10, AC12)', async ({}, testInfo) => {
  testInfo.setTimeout(60_000);
  // A directory that exists only in the *inherited* PATH: if `${env.PATH}`
  // resolved to '' (or the project var replaced PATH wholesale), it vanishes.
  const inheritedMarker = mkdtempSync(join(tmpdir(), 'metaide-e2e-inheritedbin-'));
  const origPath = process.env.PATH;
  process.env.PATH = `${inheritedMarker}:${origPath ?? ''}`;
  try {
    h = await launch([PROJECT_A, PROJECT_B]);
  } finally {
    process.env.PATH = origPath;
  }
  const { win } = h;
  await openProject(win, PROJECT_A);
  const idA = await projectId(win, PROJECT_A);

  // AC1: the Env tab sits next to Shell and Files, with no header button or modal.
  await expect(win.getByRole('button', { name: 'Shell', exact: true })).toBeVisible();
  await expect(win.getByRole('button', { name: 'Files', exact: true })).toBeVisible();
  await expect(envTab(win)).toHaveText(ENV_COPY.tabLabel);
  await expect(win.getByRole('dialog')).toHaveCount(0);

  // AC2 (empty state), AC6 (all three notices + tokens, visible without hover).
  const panel = await openEnvTab(win);
  await expect(panel.getByText(ENV_COPY.panelTitle, { exact: true })).toBeVisible();
  await expect(panel.getByTestId(ENV_TESTIDS.empty)).toHaveText(ENV_COPY.emptyState);
  await expect(panel.getByTestId(ENV_TESTIDS.row)).toHaveCount(0);
  await expect(panel.getByText(ENV_COPY.noticeNewShells)).toBeVisible();
  await expect(panel.getByText(ENV_COPY.noticeUnencrypted)).toBeVisible();
  await expect(panel.getByText(ENV_COPY.noticeLaunchArgs)).toBeVisible();
  await expect(panel.getByText(ENV_COPY.tokensHint)).toBeVisible();

  await addRow(panel, 1, VAR_URL, 'http://localhost:4000');
  await addRow(panel, 2, 'PATH', '${PROJECT_PATH}/bin:${env.PATH}');
  await addRow(panel, 3, 'E2E_GREETING', 'hi-${PROJECT_NAME}');
  // Positive control: empty state gone, draft marker shown, Save enabled; then Save clears the marker.
  await expect(panel.getByTestId(ENV_TESTIDS.empty)).toHaveCount(0);
  await expect(win.getByTestId(ENV_TESTIDS.unsaved)).toBeVisible();
  await expect(panel.getByTestId(ENV_TESTIDS.save)).toBeEnabled();
  await saveAndWait(win, PROJECT_A, {
    [VAR_URL]: 'http://localhost:4000',
    PATH: '${PROJECT_PATH}/bin:${env.PATH}',
    E2E_GREETING: 'hi-${PROJECT_NAME}',
  });

  // AC4: storage holds exactly the rows saved, in saved order, token text raw.
  expect(Object.keys((await storedEnv(win, PROJECT_A)) ?? {})).toEqual([VAR_URL, 'PATH', 'E2E_GREETING']);

  // Switch to Files and back: rows shown in saved order.
  await clickTab(win, 'Files');
  await expect(panelOf(win)).toHaveCount(0);
  const reopened = await openEnvTab(win);
  await expect(reopened.getByTestId(ENV_TESTIDS.empty)).toHaveCount(0);
  const names = reopened.getByTestId(ENV_TESTIDS.name);
  const values = reopened.getByTestId(ENV_TESTIDS.value);
  await expect(names).toHaveCount(3);
  await expect(names.nth(0)).toHaveValue(VAR_URL);
  await expect(names.nth(1)).toHaveValue('PATH');
  await expect(names.nth(2)).toHaveValue('E2E_GREETING');
  await expect(values.nth(0)).toHaveValue('http://localhost:4000');
  await expect(values.nth(1)).toHaveValue('${PROJECT_PATH}/bin:${env.PATH}');

  // AC10 (plain shell site), AC12: values interpolated at spawn.
  const idx = await launchPlain(win, idA);
  await sendLine(win, idA, idx,
    `printf 'ENV1[%s]\\n' "$${VAR_URL}"; printf 'GREET[%s]\\n' "$E2E_GREETING"; ` +
    `pidx() { echo "$PATH" | tr ':' '\\n' | grep -n -F -e "$1" | cut -d: -f1 | head -1; }; ` +
    `printf 'PATHIDX[%s,%s]\\n' "$(pidx /${PROJECT_A}/bin)" "$(pidx ${inheritedMarker})"`);
  await expect.poll(() => snapshot(win, idA, idx), { timeout: 15000 }).toMatch(/PATHIDX\[\d+,\d+\]/);
  const out = await snapshot(win, idA, idx);
  expect(out).toContain('ENV1[http://localhost:4000]');
  expect(out).toContain('GREET[hi-envproja]');
  // `${PROJECT_PATH}/bin` entry exists and comes before the inherited marker
  // entry (extends, not replaces: the marker only reaches the shell via ${env.PATH}).
  const m = /PATHIDX\[(\d+),(\d+)\]/.exec(out);
  expect(m).not.toBeNull();
  expect(Number(m![1])).toBeLessThan(Number(m![2]));
});

test('validation and discard: invalid / reserved / __proto__ / duplicate names disable Save with a reason; Discard reverts (AC3, AC5)', async ({}, testInfo) => {
  testInfo.setTimeout(60_000);
  h = await launch([PROJECT_A, PROJECT_B]);
  const { win } = h;
  await openProject(win, PROJECT_A);
  const panel = await openEnvTab(win);
  const saveBtn = panel.getByTestId(ENV_TESTIDS.save);

  // A stored baseline for Discard to revert to.
  await addRow(panel, 1, 'KEEP', '1');
  await saveAndWait(win, PROJECT_A, { KEEP: '1' });

  await addRow(panel, 2, 'MY-VAR', 'x');
  await expect(reason(panel, ENV_COPY.reason.invalid)).toBeVisible();
  await expect(saveBtn).toBeDisabled();

  const name2 = panel.getByLabel(ENV_COPY.nameLabel(2), { exact: true });
  await name2.fill('METAIDE_HOOK_TOKEN');
  await expect(reason(panel, ENV_COPY.reason.reserved)).toBeVisible();
  await expect(saveBtn).toBeDisabled();

  await name2.fill('__proto__');
  await expect(reason(panel, ENV_COPY.reason.reserved)).toBeVisible();
  await expect(saveBtn).toBeDisabled();

  // Duplicate (case-sensitive): row 2 repeats KEEP.
  await name2.fill('KEEP');
  await expect(reason(panel, ENV_COPY.reason.duplicate)).toBeVisible();
  await expect(saveBtn).toBeDisabled();

  // Positive control: a valid distinct name clears every reason and re-enables Save,
  // so the disabled state above came from the rows, not a stuck button.
  await name2.fill('KEEP2');
  await expect(panel.getByTestId(ENV_TESTIDS.reason)).toHaveCount(0);
  await expect(saveBtn).toBeEnabled();

  // Discard reverts to the stored rows; marker disappears; nothing persisted.
  await name2.fill('MY-VAR');
  await expect(reason(panel, ENV_COPY.reason.invalid)).toBeVisible();
  await expect(win.getByTestId(ENV_TESTIDS.unsaved)).toBeVisible();
  await panel.getByTestId(ENV_TESTIDS.discard).click();
  await expect(panel.getByTestId(ENV_TESTIDS.row)).toHaveCount(1);
  await expect(panel.getByLabel(ENV_COPY.nameLabel(1), { exact: true })).toHaveValue('KEEP');
  await expect(panel.getByLabel(ENV_COPY.valueLabel(1), { exact: true })).toHaveValue('1');
  await expect(panel.getByTestId(ENV_TESTIDS.reason)).toHaveCount(0);
  await expect(win.getByTestId(ENV_TESTIDS.unsaved)).toHaveCount(0);
  expect(await storedEnv(win, PROJECT_A)).toEqual({ KEEP: '1' });
});

test('drafts survive tab and project switches and are marked as unsaved (AC3, D12)', async ({}, testInfo) => {
  testInfo.setTimeout(60_000);
  h = await launch([PROJECT_A, PROJECT_B]);
  const { win } = h;
  await openProject(win, PROJECT_A);
  const panel = await openEnvTab(win);
  await addRow(panel, 1, VAR_URL, 'stored');
  await saveAndWait(win, PROJECT_A, { [VAR_URL]: 'stored' });
  // Control: with no draft the tab has the plain name.
  await expect(envTab(win)).not.toHaveAttribute('aria-label', ENV_COPY.tabUnsavedLabel);

  // Edit without saving: marker visible and the accessible name announces it.
  const value1 = panel.getByLabel(ENV_COPY.valueLabel(1), { exact: true });
  await value1.fill('draft');
  await expect(win.getByTestId(ENV_TESTIDS.unsaved)).toBeVisible();
  await expect(envTab(win)).toHaveAttribute('aria-label', ENV_COPY.tabUnsavedLabel);
  await expect(win.getByRole('button', { name: ENV_COPY.tabUnsavedLabel, exact: true })).toBeVisible();

  // Files and back: the draft is still there.
  await clickTab(win, 'Files');
  await expect(panelOf(win)).toHaveCount(0);
  const back = await openEnvTab(win);
  await expect(back.getByLabel(ENV_COPY.valueLabel(1), { exact: true })).toHaveValue('draft');
  await expect(win.getByTestId(ENV_TESTIDS.unsaved)).toBeVisible();

  // Project B shows B's own empty state and no marker (A's marker is not leaked).
  await selectProject(win, PROJECT_B);
  const panelB = await openEnvTab(win);
  await expect(panelB.getByTestId(ENV_TESTIDS.empty)).toBeVisible();
  await expect(panelB.getByTestId(ENV_TESTIDS.row)).toHaveCount(0);
  await expect(win.getByTestId(ENV_TESTIDS.unsaved)).toHaveCount(0);

  // Back to A: the draft is intact and marked; storage still holds the old value.
  await selectProject(win, PROJECT_A);
  const panelA = await openEnvTab(win);
  await expect(panelA.getByLabel(ENV_COPY.valueLabel(1), { exact: true })).toHaveValue('draft');
  await expect(win.getByTestId(ENV_TESTIDS.unsaved)).toBeVisible();
  expect(await storedEnv(win, PROJECT_A)).toEqual({ [VAR_URL]: 'stored' });
});

test('drafts for two projects are held at once and each survives switching (AC3, D12)', async ({}, testInfo) => {
  testInfo.setTimeout(60_000);
  h = await launch([PROJECT_A, PROJECT_B]);
  const { win } = h;
  await openProject(win, PROJECT_A);
  const panelA = await openEnvTab(win);
  await addRow(panelA, 1, 'DRAFT_A', 'a');
  await expect(win.getByTestId(ENV_TESTIDS.unsaved)).toBeVisible();

  // B gets its own draft while A's is still pending.
  await selectProject(win, PROJECT_B);
  const panelB = await openEnvTab(win);
  // Control: B starts clean (A's draft/marker is not shown on B).
  await expect(panelB.getByTestId(ENV_TESTIDS.empty)).toBeVisible();
  await expect(win.getByTestId(ENV_TESTIDS.unsaved)).toHaveCount(0);
  await addRow(panelB, 1, 'DRAFT_B', 'b');
  await expect(win.getByTestId(ENV_TESTIDS.unsaved)).toBeVisible();

  // Back and forth: each project shows exactly its own draft and marker.
  for (const [name, varName, value] of [[PROJECT_A, 'DRAFT_A', 'a'], [PROJECT_B, 'DRAFT_B', 'b'], [PROJECT_A, 'DRAFT_A', 'a']] as const) {
    await selectProject(win, name);
    const panel = await openEnvTab(win);
    await expect(panel.getByTestId(ENV_TESTIDS.row)).toHaveCount(1);
    await expect(panel.getByLabel(ENV_COPY.nameLabel(1), { exact: true })).toHaveValue(varName);
    await expect(panel.getByLabel(ENV_COPY.valueLabel(1), { exact: true })).toHaveValue(value);
    await expect(win.getByTestId(ENV_TESTIDS.unsaved)).toBeVisible();
  }

  // Neither draft was persisted.
  expect(Object.keys((await storedEnv(win, PROJECT_A)) ?? {})).toEqual([]);
  expect(Object.keys((await storedEnv(win, PROJECT_B)) ?? {})).toEqual([]);
});

test('removing a stored row deletes it from storage on Save and moves focus sensibly (AC3, AC4)', async ({}, testInfo) => {
  testInfo.setTimeout(60_000);
  h = await launch([PROJECT_A, PROJECT_B]);
  const { win } = h;
  await openProject(win, PROJECT_A);
  const panel = await openEnvTab(win);
  await addRow(panel, 1, 'RM_ONE', '1');
  await addRow(panel, 2, 'RM_TWO', '2');
  await addRow(panel, 3, 'RM_THREE', '3');
  await saveAndWait(win, PROJECT_A, { RM_ONE: '1', RM_TWO: '2', RM_THREE: '3' });

  // Remove the middle row: it is a draft until Save, then gone from storage.
  await panel.getByLabel(ENV_COPY.removeLabel(2), { exact: true }).click();
  await expect(panel.getByTestId(ENV_TESTIDS.row)).toHaveCount(2);
  await expect(win.getByTestId(ENV_TESTIDS.unsaved)).toBeVisible();
  expect((await storedEnv(win, PROJECT_A))?.RM_TWO, 'control: not persisted before Save').toBe('2');
  // Focus lands on the row that took its place (RM_THREE, now row 2).
  const row2Name = panel.getByLabel(ENV_COPY.nameLabel(2), { exact: true });
  await expect(row2Name).toHaveValue('RM_THREE');
  await expect(row2Name).toBeFocused();
  await saveAndWait(win, PROJECT_A, { RM_ONE: '1', RM_THREE: '3' });

  // Remove the last row: focus falls back to the previous row's name input.
  await panel.getByLabel(ENV_COPY.removeLabel(2), { exact: true }).click();
  await expect(panel.getByTestId(ENV_TESTIDS.row)).toHaveCount(1);
  const row1Name = panel.getByLabel(ENV_COPY.nameLabel(1), { exact: true });
  await expect(row1Name).toHaveValue('RM_ONE');
  await expect(row1Name).toBeFocused();

  // Remove the only row left: focus moves to Add, empty state returns, Save stores {}.
  await panel.getByLabel(ENV_COPY.removeLabel(1), { exact: true }).click();
  await expect(panel.getByTestId(ENV_TESTIDS.row)).toHaveCount(0);
  await expect(panel.getByTestId(ENV_TESTIDS.add)).toBeFocused();
  await expect(panel.getByTestId(ENV_TESTIDS.empty)).toBeVisible();
  await saveAndWait(win, PROJECT_A, {});
});

test('running shells keep old values; new shells get new; other projects stay empty (AC15, AC16)', async ({}, testInfo) => {
  testInfo.setTimeout(90_000);
  h = await launch([PROJECT_A, PROJECT_B]);
  const { win } = h;
  await openProject(win, PROJECT_A);
  const idA = await projectId(win, PROJECT_A);
  const idB = await projectId(win, PROJECT_B);

  const panel = await openEnvTab(win);
  await addRow(panel, 1, VAR_URL, 'old-value');
  await saveAndWait(win, PROJECT_A, { [VAR_URL]: 'old-value' });

  const shellOld = await launchPlain(win, idA);
  await sendLine(win, idA, shellOld, `printf 'ENV1[%s]\\n' "$${VAR_URL}"`);
  await expect.poll(() => snapshot(win, idA, shellOld), { timeout: 15000 }).toContain('ENV1[old-value]');

  // Change the value while shellOld is still running.
  await panel.getByLabel(ENV_COPY.valueLabel(1), { exact: true }).fill('new-value');
  await saveAndWait(win, PROJECT_A, { [VAR_URL]: 'new-value' });

  // AC15: the running shell still has the old value. The ENV2 marker printing
  // is the positive control for the absence of the new value.
  await sendLine(win, idA, shellOld, `printf 'ENV2[%s]\\n' "$${VAR_URL}"`);
  await expect.poll(() => snapshot(win, idA, shellOld), { timeout: 15000 }).toContain('ENV2[old-value]');
  expect(await snapshot(win, idA, shellOld)).not.toContain('ENV2[new-value]');

  // A fresh shell in the same project sees the new value.
  const shellNew = await launchPlain(win, idA);
  await sendLine(win, idA, shellNew, `printf 'ENV2[%s]\\n' "$${VAR_URL}"`);
  await expect.poll(() => snapshot(win, idA, shellNew), { timeout: 15000 }).toContain('ENV2[new-value]');

  // AC16: project B's shell printed the marker (shell works, printf ran) with an empty value.
  const shellB = await launchPlain(win, idB);
  await sendLine(win, idB, shellB, `printf 'ENV2[%s]\\n' "$${VAR_URL}"`);
  await expect.poll(() => snapshot(win, idB, shellB), { timeout: 15000 }).toContain('ENV2[]');
  const outB = await snapshot(win, idB, shellB);
  expect(outB).not.toContain('old-value');
  expect(outB).not.toContain('new-value');
});

test('sidebar item selects the project and shows its Env tab; Env to Shell does not focus the terminal (AC1, AC18)', async ({}, testInfo) => {
  testInfo.setTimeout(60_000);
  h = await launch([PROJECT_A, PROJECT_B]);
  const { win } = h;
  // A is selected on the Shell tab; the menu is opened on B to prove the item
  // selects the right-clicked project and switches to its Env tab.
  await openProject(win, PROJECT_A);

  const rowB = win.locator('[data-testid="project-row"]').filter({ has: win.getByText(PROJECT_B, { exact: true }) }).first();
  await expect(rowB).toBeVisible();
  // Right-click near the row's left edge: the menu is a `fixed` child of the
  // sidebar `<aside>`, whose backdrop-filter makes it the containing block and
  // a stacking context, so any part of the menu that spills past the sidebar's
  // right edge is painted under <main> and cannot be clicked (pre-existing,
  // affects every sidebar context-menu item).
  await rowB.click({ button: 'right', position: { x: 8, y: 8 } });
  await win.getByRole('menuitem', { name: ENV_COPY.contextMenuItem, exact: true }).click();

  await expect.poll(() => win.title(), { timeout: 10000 }).toBe(`${PROJECT_B} — MetaLogix IDE`);
  const panel = panelOf(win);
  await expect(panel).toBeVisible();
  // Control: the panel is B's (empty) and the terminal is unmounted on the Env tab.
  await expect(panel.getByTestId(ENV_TESTIDS.empty)).toBeVisible();
  await expect(win.locator('[data-testid="shell-tab"]')).toHaveCount(0);

  await addRow(panel, 1, 'E2E_FROM_MENU', '1');
  await saveAndWait(win, PROJECT_B, { E2E_FROM_MENU: '1' });
  // Saved onto B; A (control: B has it) is untouched.
  expect(Object.keys((await storedEnv(win, PROJECT_A)) ?? {})).toEqual([]);

  // AC18: in-app Env -> Shell does not auto-focus the terminal, like Files -> Shell.
  await clickTab(win, 'Shell');
  await expect(win.locator('[data-testid="shell-tab"] .xterm-screen'), 'positive control: the shell tab is rendered').toBeVisible({ timeout: 10000 });
  await expect(terminalActiveIn(win, '[data-testid="shell-tab"]'), 'Env to Shell does not auto-focus the terminal').resolves.toBe(false);
});

test('keyboard: Env tab reachable from Files, tab order through rows, Enter neither saves nor discards, inputs labelled (AC7)', async ({}, testInfo) => {
  testInfo.setTimeout(60_000);
  h = await launch([PROJECT_A, PROJECT_B]);
  const { win } = h;
  await openProject(win, PROJECT_A);
  await clickTab(win, 'Files');
  await win.getByRole('button', { name: 'Files', exact: true }).focus();
  await win.keyboard.press('Tab');
  expect(await activeId(win), 'Tab from Files lands on the Env tab button').toBe(`${ENV_TESTIDS.tab}|`);
  await win.keyboard.press('Enter');
  const panel = panelOf(win);
  await expect(panel).toBeVisible();

  await addRow(panel, 1, 'A_ONE', '1');
  await addRow(panel, 2, 'B_TWO', '2');

  // Every input has a non-empty accessible label (control: there are 4 inputs).
  const labels = await panel.locator('input').evaluateAll((els) =>
    els.map((el) => (el.getAttribute('aria-label') ?? '').trim() || ((el as HTMLInputElement).labels?.[0]?.textContent ?? '').trim()));
  expect(labels).toHaveLength(4);
  expect(labels.every((l) => l.length > 0)).toBe(true);

  // Tab order from row 1's name: name, value, remove per row, then Add, Discard, Save.
  await panel.getByLabel(ENV_COPY.nameLabel(1), { exact: true }).focus();
  const seen: string[] = [await activeId(win)];
  for (let i = 0; i < 8; i++) {
    await win.keyboard.press('Tab');
    seen.push(await activeId(win));
  }
  expect(seen).toEqual([
    `${ENV_TESTIDS.name}|${ENV_COPY.nameLabel(1)}`,
    `${ENV_TESTIDS.value}|${ENV_COPY.valueLabel(1)}`,
    `${ENV_TESTIDS.remove}|${ENV_COPY.removeLabel(1)}`,
    `${ENV_TESTIDS.name}|${ENV_COPY.nameLabel(2)}`,
    `${ENV_TESTIDS.value}|${ENV_COPY.valueLabel(2)}`,
    `${ENV_TESTIDS.remove}|${ENV_COPY.removeLabel(2)}`,
    `${ENV_TESTIDS.add}|`,
    `${ENV_TESTIDS.discard}|`,
    `${ENV_TESTIDS.save}|`,
  ]);

  // Enter in a name input and in a value input: rows unchanged, still a draft, nothing stored.
  await panel.getByLabel(ENV_COPY.nameLabel(1), { exact: true }).press('Enter');
  await panel.getByLabel(ENV_COPY.valueLabel(2), { exact: true }).press('Enter');
  await expect(panel.getByTestId(ENV_TESTIDS.row)).toHaveCount(2);
  await expect(panel.getByLabel(ENV_COPY.nameLabel(1), { exact: true })).toHaveValue('A_ONE');
  await expect(panel.getByLabel(ENV_COPY.valueLabel(2), { exact: true })).toHaveValue('2');
  await expect(win.getByTestId(ENV_TESTIDS.unsaved), 'neither saved nor discarded').toBeVisible();
  await expect(panel.getByTestId(ENV_TESTIDS.save)).toBeEnabled();
  expect(Object.keys((await storedEnv(win, PROJECT_A)) ?? {})).toEqual([]);
});

test('save failure keeps the draft and never shows the value in a toast (AC3, AC17)', async ({}, testInfo) => {
  testInfo.setTimeout(60_000);
  h = await launch([PROJECT_A, PROJECT_B]);
  const { app, win } = h;
  await openProject(win, PROJECT_A);
  const panel = await openEnvTab(win);
  await addRow(panel, 1, 'E2E_SECRET', 'S3CRET-E2E');

  // Force main's handler to fail. Not restored: this test owns its app instance.
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('projects:update-config');
    ipcMain.handle('projects:update-config', () => { throw new Error('forced failure for KEYNAME'); });
  });
  await panel.getByTestId(ENV_TESTIDS.save).click();

  // Positive control: the failure toast did appear.
  const failToast = win.getByTestId('toast').filter({ hasText: ENV_COPY.saveFailed });
  await expect(failToast.first()).toBeVisible({ timeout: 10000 });
  const toastTexts = await win.getByTestId('toast').allTextContents();
  expect(toastTexts.length).toBeGreaterThan(0);
  for (const t of toastTexts) expect(t).not.toContain('S3CRET-E2E');

  // The draft and the unsaved marker are kept; nothing was stored.
  await expect(panel.getByLabel(ENV_COPY.nameLabel(1), { exact: true })).toHaveValue('E2E_SECRET');
  await expect(panel.getByLabel(ENV_COPY.valueLabel(1), { exact: true })).toHaveValue('S3CRET-E2E');
  await expect(win.getByTestId(ENV_TESTIDS.unsaved)).toBeVisible();
  expect(Object.keys((await storedEnv(win, PROJECT_A)) ?? {})).toEqual([]);
});
