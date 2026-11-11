import { test, expect, type Locator, type Page } from '@playwright/test';
import {
  PROJECT_SETTINGS_COPY as COPY,
  PROJECT_SETTINGS_TESTIDS as IDS,
} from '../../src/renderer/project-settings-contract';
import type { Project, ProjectConfig } from '../../src/shared/types';
import {
  assertLaunch,
  assertMenuDefault,
  automaticSpawn,
  choice,
  choose,
  leaveSettingsTab,
  command,
  settingsView,
  displayedChoice,
  gateEvidence,
  installGate,
  ipc,
  killPrimary,
  AGENT_SHELL,
  launchAgents,
  enterSettingsTab,
  openShellMenu,
  output,
  profile,
  project,
  releaseGate,
  replaceLegacy,
  resize,
  restartAgents,
  restoreGate,
  row,
  seedProject,
  selectProject,
  setGlobals,
  setSetting,
  setting,
  shellState,
  type AgentHarness,
} from './helpers/project-default-agent';

/**
 * Real Electron renderer -> preload invoke -> real main repositories/SQLite -> real PTY.
 * Only explicit failure/delay cases wrap an existing transport handler; successful
 * calls still use the original. Marker executables replace paid agent binaries,
 * never profile lookup, setting persistence, argv/env resolution or process spawn.
 * Tab-revision authoring only: reconciliation and execution require Main's runner release.
 */
const A = 'default-agent-a';
const B = 'default-agent-b';
const PRIMARY = 'Primary agent';
const OTHER = 'Saved custom agent';
const GLOBAL_ONLY = 'Global only agent';
let activeHarness: AgentHarness | undefined;

test.afterEach(async () => {
  try {
    if (activeHarness && !activeHarness.win.isClosed())
      await activeHarness.win.keyboard.press('Escape');
    await activeHarness?.app.close();
  } finally {
    activeHarness?.cleanup();
    activeHarness = undefined;
  }
});

async function start(names = [A, B]): Promise<{ h: AgentHarness; a: Project; b: Project }> {
  const h = await launchAgents(names);
  activeHarness = h;
  await setSetting(h.win, 'default_cli_profiles', [
    profile(h, PRIMARY, 'global-shadow'),
    profile(h, GLOBAL_ONLY, 'global-only'),
  ]);
  const a = await seedProject(h, names[0] ?? A, {
    cliProfiles: [profile(h, PRIMARY, 'project-primary'), profile(h, OTHER, 'project-other')],
    defaultCliName: PRIMARY,
    env: { E2E_LAYER: 'project', E2E_PROJECT: names[0] ?? A },
    model: 'keep-model',
    notes: 'Keep project notes',
    linkedMetaprojectProjectId: 'keep-link',
  });
  const b = await seedProject(h, names[1] ?? B, {
    cliProfiles: [profile(h, OTHER, 'b-other')],
    defaultCliName: OTHER,
    env: { E2E_LAYER: 'project', E2E_PROJECT: names[1] ?? B },
    notes: 'B untouched',
  });
  expect(a.firstLaunchedAt, 'seed: A has never launched').toBeNull();
  expect(b.firstLaunchedAt, 'seed: B has never launched').toBeNull();
  return { h, a, b };
}

async function confirmed(win: Page, target: Project, name: string | null): Promise<Project> {
  await expect.poll(async () => (await project(win, target.name)).config.defaultCliName).toBe(name);
  const saved = await project(win, target.name);
  expect(saved.config, 'only explicit default and both-variant legacy replacement changed').toEqual(
    {
      ...target.config,
      defaultCliName: name,
      launchCmd: null,
    },
  );
  return saved;
}

async function reopenAndCheck(
  h: AgentHarness,
  target: Project,
  name: string | null,
): Promise<void> {
  await enterSettingsTab(h.win, target);
  await expect(choice(h.win)).toBeEnabled();
  expect(await displayedChoice(h.win)).toBe(name ?? COPY.globalDefault);
  await leaveSettingsTab(h.win);
}

async function usableBox(control: Locator): Promise<void> {
  await expect(control).toBeVisible();
  await control.scrollIntoViewIfNeeded();
  const metrics = await control.evaluate((element) => {
    const r = element.getBoundingClientRect();
    const panel = element.closest('[data-testid="project-settings-view"]');
    if (!panel) throw new Error('geometry assertion requires actual settings tab');
    const bounds = panel.getBoundingClientRect();
    return {
      x: r.x,
      y: r.y,
      right: r.right,
      bottom: r.bottom,
      width: r.width,
      height: r.height,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      panelX: bounds.x,
      panelY: bounds.y,
      panelRight: bounds.right,
      panelBottom: bounds.bottom,
    };
  });
  expect(metrics.width).toBeGreaterThan(16);
  expect(metrics.height).toBeGreaterThan(16);
  expect(metrics.x).toBeGreaterThanOrEqual(0);
  expect(metrics.y).toBeGreaterThanOrEqual(0);
  expect(metrics.right).toBeLessThanOrEqual(metrics.viewportWidth);
  expect(metrics.bottom).toBeLessThanOrEqual(metrics.viewportHeight);
  expect(metrics.x).toBeGreaterThanOrEqual(metrics.panelX);
  expect(metrics.y).toBeGreaterThanOrEqual(metrics.panelY);
  expect(metrics.right).toBeLessThanOrEqual(metrics.panelRight);
  expect(metrics.bottom).toBeLessThanOrEqual(metrics.panelBottom);
}

async function paintedFocus(control: Locator): Promise<void> {
  await expect(control).toBeFocused();
  const style = await control.evaluate((element) => {
    const computed = getComputedStyle(element);
    return {
      outline: computed.outlineStyle !== 'none' && parseFloat(computed.outlineWidth) > 0,
      shadow: computed.boxShadow !== 'none',
    };
  });
  expect(style.outline || style.shadow, 'focused keyboard control has a painted indicator').toBe(
    true,
  );
}

test('E1 settings follows Env and shows a truthful selection prompt before any project is selected (AC1/12)', async () => {
  const { h, a, b } = await start();
  const tabs = h.win.getByTestId('main-tab-bar').getByRole('button');
  await expect(tabs.nth(3)).toHaveText('Env');
  await expect(tabs.nth(4)).toHaveText(COPY.tab);
  await expect(tabs.nth(4)).toHaveAttribute('data-testid', IDS.tab);
  await installGate(h.app, 'shells:set-default-cli', 'pass');
  try {
    await tabs.nth(4).click();
    await expect(h.win.getByText(COPY.noProject, { exact: true })).toBeVisible();
    await expect(h.win.getByRole('dialog')).toHaveCount(0);
    await expect(h.win.getByRole('combobox', { name: COPY.defaultAgentLabel })).toHaveCount(0);
    await expect(h.win.getByTestId(IDS.projectName)).toHaveCount(0);
    await expect(h.win).toHaveTitle('MetaLogix IDE');
    expect(await shellState(h.win)).toEqual([]);
    expect(await project(h.win, A)).toEqual(a);
    expect(await project(h.win, B)).toEqual(b);
    expect((await gateEvidence(h.app, 'shells:set-default-cli')).requests).toEqual([]);
    await h.win.getByRole('button', { name: 'Env', exact: true }).click();
    await expect(h.win.getByText(COPY.noProject, { exact: true })).toHaveCount(0);
    await h.win.getByRole('button', { name: COPY.tab, exact: true }).click();
    await expect(h.win.getByText(COPY.noProject, { exact: true })).toBeVisible();
    // An explicit row target works even without an active project or any shell.
    await enterSettingsTab(h.win, b, true);
    await expect(choice(h.win)).toBeEnabled();
    expect(await displayedChoice(h.win)).toBe(OTHER);
    await expect(h.win.getByText(COPY.noProject, { exact: true })).toHaveCount(0);
    await expect(h.win).toHaveTitle('MetaLogix IDE');
    expect(await shellState(h.win)).toEqual([]);
    await h.win.getByRole('button', { name: COPY.tab, exact: true }).click();
    await expect(h.win.getByText(COPY.noProject, { exact: true })).toBeVisible();
    await expect(h.win.getByTestId(IDS.projectName)).toHaveCount(0);
    expect((await gateEvidence(h.app, 'shells:set-default-cli')).requests).toEqual([]);
  } finally {
    await restoreGate(h.app, 'shells:set-default-cli');
  }
});

test('E1 visible and inactive-row settings identify scope without writing, switching or touching a live shell (AC1/3/9/10)', async () => {
  const { h, a, b } = await start();
  const legacy = { first: command(h, 'legacy-first'), subsequent: command(h, 'legacy-subsequent') };
  const seededA = await seedProject(h, A, { launchCmd: legacy });
  const seededB = await seedProject(h, B, { launchCmd: legacy });
  await selectProject(h.win, A);
  await assertLaunch(h, seededA, 'legacy-first');
  const before = await shellState(h.win);
  const beforeA = await project(h.win, A);
  await installGate(h.app, 'shells:set-default-cli', 'pass');
  try {
    await expect(h.win.getByRole('button', { name: COPY.tab, exact: true })).toBeVisible();
    await enterSettingsTab(h.win, a);
    await expect(choice(h.win)).toBeEnabled();
    expect(await displayedChoice(h.win)).toBe(PRIMARY);
    await expect(
      settingsView(h.win).getByText(COPY.customCommandsNotice, { exact: true }),
    ).toBeVisible();
    await expect(
      settingsView(h.win).getByRole('button', { name: COPY.replaceCustomCommands, exact: true }),
    ).toBeVisible();
    await h.win.screenshot({ path: '.claude/reports/project-settings-tab-legacy.png' });
    await leaveSettingsTab(h.win);
    await enterSettingsTab(h.win, b, true);
    await expect(choice(h.win)).toBeEnabled();
    expect(await displayedChoice(h.win)).toBe(OTHER);
    await expect(
      settingsView(h.win).getByText(COPY.customCommandsNotice, { exact: true }),
    ).toBeVisible();
    await expect(h.win).toHaveTitle(`${A} — MetaLogix IDE`);
    await expect(h.win.getByTestId('settings-modal')).toHaveCount(0);
    expect(await shellState(h.win), 'inactive B entry neither switches nor spawns').toEqual(before);
    expect(await project(h.win, A)).toEqual(beforeA);
    expect(await project(h.win, B)).toEqual(seededB);
    // A normal selection clears the explicit B target without leaving this tab.
    await selectProject(h.win, A);
    await expect(settingsView(h.win).getByTestId(IDS.projectName)).toHaveText(A);
    await expect(choice(h.win)).toBeEnabled();
    expect(await displayedChoice(h.win)).toBe(PRIMARY);
    await enterSettingsTab(h.win, b, true);
    await enterSettingsTab(h.win, a);
    await expect(choice(h.win)).toBeEnabled();
    expect(await displayedChoice(h.win)).toBe(PRIMARY);
    await leaveSettingsTab(h.win);
    expect((await project(h.win, A)).config).toEqual(beforeA.config);
    expect(await project(h.win, B)).toEqual(seededB);
    expect(await shellState(h.win), 'positive live A remains; B has no shell').toEqual(before);
    expect(
      (await gateEvidence(h.app, 'shells:set-default-cli')).requests,
      'loaded both target controls; no enter/leave write',
    ).toEqual([]);
    // Input transport positive control proves the unchanged live executable still responds.
    await ipc(h.win, 'shells:write', { projectId: a.id, shellIndex: 0, data: 'after-readonly\n' });
    await expect.poll(() => output(h.win, a.id)).toContain('INPUT[after-readonly]');
    const text = await output(h.win, a.id);
    expect(text.match(/INPUT\[/g)).toHaveLength(1);
    await h.win.getByTestId('settings-open').click();
    await expect(h.win.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible();
    await expect(settingsView(h.win)).toHaveCount(0);
  } finally {
    await restoreGate(h.app, 'shells:set-default-cli');
  }
});

test('E2 merged choices deduplicate, match shell menu, retain custom sentinel names and isolate immediate saves (AC2/3/6)', async () => {
  const { h, a, b } = await start();
  const locals = [
    profile(h, PRIMARY, 'project-primary'),
    profile(h, OTHER, 'project-other'),
    profile(h, 'global', 'custom-global'),
    profile(h, 'profile:Primary', 'custom-tag'),
    profile(h, COPY.globalDefault, 'custom-global-label'),
  ];
  const seededA = await seedProject(h, A, { cliProfiles: locals });
  await selectProject(h.win, A);
  await assertLaunch(h, seededA, 'project-primary', true);
  const globalsBefore = await setting(h.win, 'default_cli_profiles');
  const launchBefore = [
    await setting(h.win, 'default_launch_cmd.first'),
    await setting(h.win, 'default_launch_cmd.subsequent'),
  ];
  const menu = await openShellMenu(h.win);
  for (const name of [
    PRIMARY,
    OTHER,
    'global',
    'profile:Primary',
    COPY.globalDefault,
    GLOBAL_ONLY,
  ]) {
    await expect(
      menu.getByRole('button').filter({ has: h.win.getByText(name, { exact: true }) }),
    ).toHaveCount(1);
  }
  await h.win.keyboard.press('Escape');
  await enterSettingsTab(h.win, a);
  await expect(choice(h.win)).toBeEnabled();
  await expect(choice(h.win).locator('option')).toHaveText([
    COPY.globalDefault,
    COPY.terminalAgent,
    PRIMARY,
    OTHER,
    'global',
    'profile:Primary',
    COPY.globalDefault,
    GLOBAL_ONLY,
  ]);
  await h.win.screenshot({ path: '.claude/reports/project-settings-tab-normal.png' });
  for (const name of ['global', 'profile:Primary']) {
    await choose(h.win, name);
    await confirmed(h.win, seededA, name);
  }
  // Two identical visible labels still have distinct option values: real profile vs inheritance.
  const duplicateLabels = choice(h.win)
    .locator('option')
    .filter({ hasText: /^Use global default$/ });
  await expect(duplicateLabels).toHaveCount(2);
  const fallbackValue = await duplicateLabels.nth(0).getAttribute('value');
  const customValue = await duplicateLabels.nth(1).getAttribute('value');
  if (fallbackValue === null || customValue === null)
    throw new Error('options must expose native select values');
  expect(customValue).not.toBe(fallbackValue);
  await choice(h.win).selectOption(customValue);
  await expect(settingsView(h.win).getByTestId(IDS.status)).toHaveText(COPY.saved);
  await confirmed(h.win, seededA, COPY.globalDefault);
  await choice(h.win).selectOption(fallbackValue);
  await expect(settingsView(h.win).getByTestId(IDS.status)).toHaveText(COPY.saved);
  await confirmed(h.win, seededA, null);
  expect((await project(h.win, B)).config).toEqual(b.config);
  expect(await setting(h.win, 'default_cli_profiles')).toEqual(globalsBefore);
  expect([
    await setting(h.win, 'default_launch_cmd.first'),
    await setting(h.win, 'default_launch_cmd.subsequent'),
  ]).toEqual(launchBefore);
});

test('E2 successful empty catalog retains enabled global fallback without missing/error state or load-time writes (AC2/3/12)', async () => {
  const { h, a } = await start();
  await setSetting(h.win, 'default_cli_profiles', []);
  const empty = await seedProject(
    h,
    A,
    { cliProfiles: [], defaultCliName: null },
    { emptyCatalog: true },
  );
  await installGate(h.app, 'shells:set-default-cli', 'pass');
  try {
    await enterSettingsTab(h.win, a, true);
    await expect(choice(h.win)).toBeEnabled();
    await expect(choice(h.win).locator('option')).toHaveText([COPY.globalDefault, COPY.terminalAgent]);
    expect(await displayedChoice(h.win)).toBe(COPY.globalDefault);
    await expect(
      settingsView(h.win).getByText(COPY.nextLaunchNotice, { exact: true }),
    ).toBeVisible();
    await expect(settingsView(h.win).getByTestId(IDS.error)).toHaveCount(0);
    await expect(settingsView(h.win).getByTestId(IDS.missingProfile)).toHaveCount(0);
    await leaveSettingsTab(h.win);
    expect((await project(h.win, A)).config).toEqual(empty.config);
    expect((await gateEvidence(h.app, 'shells:set-default-cli')).requests).toEqual([]);
  } finally {
    await restoreGate(h.app, 'shells:set-default-cli');
  }
});

for (const recovery of [OTHER, null]) {
  test(`E2/E3 unavailable saved profile stays truthful, falls back by variant and recovers to ${recovery ?? 'global'} (AC3/6/11)`, async () => {
    const { h, a, b } = await start();
    const missing = await seedProject(
      h,
      A,
      { defaultCliName: 'Removed agent' },
      { unavailableName: 'Removed agent' },
    );
    await enterSettingsTab(h.win, a, true);
    await expect(choice(h.win)).toBeEnabled();
    expect(await displayedChoice(h.win)).toBe(COPY.unavailableProfile('Removed agent'));
    await expect(
      choice(h.win).getByRole('option', {
        name: COPY.unavailableProfile('Removed agent'),
        exact: true,
      }),
    ).toBeDisabled();
    await expect(
      settingsView(h.win).getByText(COPY.missingProfileNotice('Removed agent'), { exact: true }),
    ).toBeVisible();
    await expect(
      settingsView(h.win).getByText(COPY.missingProfileFallback, { exact: true }),
    ).toBeVisible();
    await expect(choice(h.win).getByRole('option', { name: OTHER, exact: true })).toBeEnabled();
    await leaveSettingsTab(h.win);
    expect((await project(h.win, A)).config).toEqual(missing.config);
    await selectProject(h.win, A);
    await assertLaunch(h, missing, 'global-first');
    await killPrimary(h, a);
    await automaticSpawn(h, a);
    await assertLaunch(h, missing, 'global-subsequent');
    await enterSettingsTab(h.win, a);
    await choose(h.win, recovery);
    await expect(settingsView(h.win).getByTestId(IDS.missingProfile)).toHaveCount(0);
    const saved = await confirmed(h.win, missing, recovery);
    await leaveSettingsTab(h.win);
    await killPrimary(h, a);
    await automaticSpawn(h, a);
    await assertLaunch(
      h,
      saved,
      recovery === null ? 'global-subsequent' : 'project-other',
      recovery !== null,
    );
    expect((await project(h.win, B)).config).toEqual(b.config);
  });
}

test('E2 unavailable named choice with active legacy commands cannot apply that missing choice (AC3/10/11)', async () => {
  const { h, a } = await start();
  const missing = await seedProject(
    h,
    A,
    { defaultCliName: 'Removed agent', launchCmd: { first: command(h, 'legacy-first') } },
    { unavailableName: 'Removed agent' },
  );
  await enterSettingsTab(h.win, a, true);
  await expect(choice(h.win)).toBeEnabled();
  await expect(
    settingsView(h.win).getByText(COPY.customCommandsNotice, { exact: true }),
  ).toBeVisible();
  await expect(settingsView(h.win).getByTestId(IDS.missingProfile)).toBeVisible();
  await expect(
    settingsView(h.win).getByRole('button', { name: COPY.replaceCustomCommands, exact: true }),
  ).toHaveCount(0);
  await choose(h.win, PRIMARY);
  await confirmed(h.win, missing, PRIMARY);
});

for (const variants of ['both', 'first-only', 'subsequent-only'] as const) {
  test(`E3 untouched legacy ${variants} retains variant-specific precedence merely opening settings (AC4/9/10)`, async () => {
    const { h, a } = await start();
    const legacy: ProjectConfig['launchCmd'] = {};
    if (variants !== 'subsequent-only') legacy.first = command(h, 'legacy-first');
    if (variants !== 'first-only') legacy.subsequent = command(h, 'legacy-subsequent');
    const untouched = await seedProject(h, A, { launchCmd: legacy });
    await enterSettingsTab(h.win, a, true);
    await expect(choice(h.win)).toBeEnabled();
    await expect(
      settingsView(h.win).getByText(COPY.customCommandsNotice, { exact: true }),
    ).toBeVisible();
    await leaveSettingsTab(h.win);
    expect((await project(h.win, A)).config).toEqual(untouched.config);
    await selectProject(h.win, A);
    await assertLaunch(
      h,
      untouched,
      variants === 'subsequent-only' ? 'project-primary' : 'legacy-first',
      variants === 'subsequent-only',
    );
    await killPrimary(h, a);
    await automaticSpawn(h, a);
    await assertLaunch(
      h,
      untouched,
      variants === 'first-only' ? 'project-primary' : 'legacy-subsequent',
      variants === 'first-only',
    );
    expect((await project(h.win, A)).config).toEqual(untouched.config);
  });
}

for (const scenario of [
  { name: 'new named choice', saved: PRIMARY, next: OTHER, same: false },
  { name: 'same named choice', saved: PRIMARY, next: PRIMARY, same: true },
  { name: 'new global reset', saved: PRIMARY, next: null, same: false },
  { name: 'same global choice', saved: null, next: null, same: true },
]) {
  test(`E3 ${scenario.name} explicitly replaces both variants before first and subsequent actual launches (AC3/4/6/7/10)`, async () => {
    const { h, a, b } = await start();
    const legacy = await seedProject(h, A, {
      defaultCliName: scenario.saved,
      launchCmd: { first: command(h, 'legacy-first'), subsequent: command(h, 'legacy-subsequent') },
      cwdOverride: a.path,
    });
    const globalBefore = [
      await setting(h.win, 'default_launch_cmd.first'),
      await setting(h.win, 'default_launch_cmd.subsequent'),
    ];
    await enterSettingsTab(h.win, a, true);
    await expect(choice(h.win)).toBeEnabled();
    expect(await displayedChoice(h.win)).toBe(scenario.saved ?? COPY.globalDefault);
    await expect(
      settingsView(h.win).getByText(COPY.customCommandsNotice, { exact: true }),
    ).toBeVisible();
    if (scenario.same) await replaceLegacy(h.win);
    else await choose(h.win, scenario.next);
    const saved = await confirmed(h.win, legacy, scenario.next);
    expect(saved.firstLaunchedAt, 'settings did not mark first launch').toBeNull();
    expect((await project(h.win, B)).config).toEqual(b.config);
    expect([
      await setting(h.win, 'default_launch_cmd.first'),
      await setting(h.win, 'default_launch_cmd.subsequent'),
    ]).toEqual(globalBefore);
    await expect(settingsView(h.win).getByTestId(IDS.replaceCustomCommands)).toHaveCount(0);
    await expect(
      settingsView(h.win).getByText(COPY.nextLaunchNotice, { exact: true }),
    ).toBeVisible();
    await leaveSettingsTab(h.win);
    await selectProject(h.win, A);
    const namedMarker = scenario.next === PRIMARY ? 'project-primary' : 'project-other';
    const pid = await assertLaunch(
      h,
      saved,
      scenario.next === null ? 'global-first' : namedMarker,
      scenario.next !== null,
    );
    await killPrimary(h, a);
    await automaticSpawn(h, a);
    const nextPid = await assertLaunch(
      h,
      saved,
      scenario.next === null ? 'global-subsequent' : namedMarker,
      scenario.next !== null,
    );
    expect(nextPid, 'positive new process after deliberate kill').not.toBe(pid);
  });
}

test('E3 global fallback reads later global first/subsequent edits without copying them into project config (AC6/7)', async () => {
  const { h, a, b } = await start();
  await enterSettingsTab(h.win, a, true);
  await expect(choice(h.win)).toBeEnabled();
  await choose(h.win, null);
  const reset = await confirmed(h.win, a, null);
  await leaveSettingsTab(h.win);
  await setGlobals(h, 'edited-first', 'edited-subsequent');
  await selectProject(h.win, A);
  await assertLaunch(h, reset, 'edited-first');
  await killPrimary(h, a);
  await automaticSpawn(h, a);
  await assertLaunch(h, reset, 'edited-subsequent');
  await setGlobals(h, 'latest-first', 'latest-subsequent');
  await killPrimary(h, a);
  await automaticSpawn(h, a);
  await assertLaunch(h, reset, 'latest-subsequent');
  // B has never launched: a later first command remains live, too.
  const resetB = await seedProject(h, B, { defaultCliName: null, launchCmd: null });
  await selectProject(h.win, B);
  await assertLaunch(h, resetB, 'latest-first');
  expect((await project(h.win, A)).config).toEqual(reset.config);
  expect((await project(h.win, B)).config).toEqual(resetB.config);
  expect(b.firstLaunchedAt).toBeNull();
});

for (const selection of [OTHER, null]) {
  test(`E4 ${selection ?? 'global reset'} persists through tab/project reopen and same-userData restart with matching spawns (AC5/7/8)`, async ({}, testInfo) => {
    testInfo.setTimeout(120_000);
    const { h, a } = await start();
    await selectProject(h.win, A);
    await assertLaunch(h, a, 'project-primary', true);
    await enterSettingsTab(h.win, a);
    await choose(h.win, selection);
    const saved = await confirmed(h.win, a, selection);
    await leaveSettingsTab(h.win);
    const marker = selection === null ? 'global-subsequent' : 'project-other';
    await reopenAndCheck(h, a, selection);
    await assertMenuDefault(h.win, selection);
    await killPrimary(h, a);
    await automaticSpawn(h, a);
    await assertLaunch(h, saved, marker, selection !== null);
    await selectProject(h.win, B);
    await killPrimary(h, a);
    await selectProject(h.win, A);
    await assertLaunch(h, saved, marker, selection !== null);
    await reopenAndCheck(h, a, selection);
    await assertMenuDefault(h.win, selection);
    const originalHome = h.isolatedHome;
    const originalPath = h.demoRoot;
    await restartAgents(h);
    expect(h.isolatedHome).toBe(originalHome);
    expect(h.demoRoot).toBe(originalPath);
    expect((await project(h.win, A)).config).toEqual(saved.config);
    await selectProject(h.win, A);
    await reopenAndCheck(h, a, selection);
    await assertLaunch(h, saved, marker, selection !== null);
    await assertMenuDefault(h.win, selection);
  });
}

test('E4 existing star sets and clears the same persistent default and both legacy variants without changing explicit profile launches (AC4/5/8/9)', async () => {
  const { h, a } = await start();
  const legacy = await seedProject(h, A, {
    launchCmd: { first: command(h, 'legacy-first'), subsequent: command(h, 'legacy-subsequent') },
  });
  await selectProject(h.win, A);
  await assertLaunch(h, legacy, 'legacy-first');
  const before = await shellState(h.win);
  let menu = await openShellMenu(h.win);
  const setStar = menu.getByRole('button', { name: `Set ${OTHER} as folder default`, exact: true });
  await setStar.hover();
  await setStar.click();
  const saved = await confirmed(h.win, legacy, OTHER);
  await h.win.keyboard.press('Escape');
  expect(await shellState(h.win)).toEqual(before);
  await reopenAndCheck(h, a, OTHER);
  await assertMenuDefault(h.win, OTHER);
  // Same-name star-set is not needed: clearing the starred default must also replace newly added legacy data.
  const secondLegacy = await seedProject(h, A, {
    launchCmd: { first: command(h, 'legacy-first'), subsequent: command(h, 'legacy-subsequent') },
  });
  menu = await openShellMenu(h.win);
  await expect(menu.getByText('auto', { exact: true })).toHaveCount(1);
  await menu.getByRole('button', { name: 'Clear folder default', exact: true }).click();
  const reset = await confirmed(h.win, secondLegacy, null);
  await h.win.keyboard.press('Escape');
  await reopenAndCheck(h, a, null);
  await assertMenuDefault(h.win, null);
  await killPrimary(h, a);
  await automaticSpawn(h, a);
  await assertLaunch(h, reset, 'global-subsequent');
  // Explicit alternate launch remains independent of the reset global default.
  menu = await openShellMenu(h.win);
  await menu
    .getByRole('button')
    .filter({ has: h.win.getByText(PRIMARY, { exact: true }) })
    .click();
  await expect
    .poll(
      async () =>
        (await ipc(h.win, 'shells:alive-list', undefined)).shells.filter(
          (s) => s.projectId === a.id,
        ).length,
    )
    .toBe(2);
  const extra = (await ipc(h.win, 'shells:alive-list', undefined)).shells.find(
    (s) => s.projectId === a.id && s.shellIndex !== 0,
  );
  if (!extra) throw new Error('explicit profile did not create a shell');
  await assertLaunch(h, saved, 'project-primary', true, {
    shellIndex: extra.shellIndex,
    explicit: true,
  });
  expect((await project(h.win, A)).config).toEqual(reset.config);
});

for (const channel of ['shells:cli-profiles-list', 'projects:list'] as const) {
  test(`E5 ${channel} loading failure is visible, not an empty success, and explicit recovery enables real saving (AC3/12)`, async () => {
    const { h, a } = await start();
    await selectProject(h.win, A);
    await assertLaunch(h, a, 'project-primary', true);
    await installGate(h.app, channel, 'fail');
    try {
      await enterSettingsTab(h.win, a);
      await expect(settingsView(h.win).getByTestId(IDS.error)).toContainText(COPY.loadFailed);
      await expect(settingsView(h.win).getByTestId(IDS.error)).toContainText(
        `E2E controlled ${channel} failure`,
      );
      // Failed loads may omit the control; neither enabled choice nor legacy apply may exist.
      await expect(settingsView(h.win).locator('select:not(:disabled)')).toHaveCount(0);
      await expect(
        settingsView(h.win).getByRole('button', { name: COPY.retry, exact: true }),
      ).toBeEnabled();
      await expect(settingsView(h.win).getByText(COPY.saved, { exact: true })).toHaveCount(0);
      expect((await gateEvidence(h.app, channel)).requests.length).toBeGreaterThan(0);
    } finally {
      await restoreGate(h.app, channel);
    }
    await settingsView(h.win).getByRole('button', { name: COPY.retry, exact: true }).click();
    await expect(choice(h.win)).toBeEnabled();
    await expect(choice(h.win).getByRole('option', { name: PRIMARY, exact: true })).toBeEnabled();
    expect((await project(h.win, A)).config).toEqual(a.config);
    await choose(h.win, OTHER);
    await confirmed(h.win, a, OTHER);
  });
}

test('E5 failed immediate save restores confirmed value, retains config and live process, then actual handler recovers (AC3/6/9/12)', async () => {
  const { h, a, b } = await start();
  await selectProject(h.win, A);
  await assertLaunch(h, a, 'project-primary', true);
  const before = await shellState(h.win);
  await installGate(h.app, 'shells:set-default-cli', 'fail', a.id);
  try {
    await enterSettingsTab(h.win, a);
    await expect(choice(h.win)).toBeEnabled();
    await choice(h.win).selectOption({ label: OTHER });
    await expect(settingsView(h.win).getByTestId(IDS.error)).toContainText(COPY.saveFailed);
    await expect(settingsView(h.win).getByTestId(IDS.error)).toContainText('retry after recovery');
    await expect(choice(h.win)).toBeEnabled();
    expect(await displayedChoice(h.win)).toBe(PRIMARY);
    await expect(settingsView(h.win).getByText(COPY.saved, { exact: true })).toHaveCount(0);
    expect((await project(h.win, A)).config).toEqual(a.config);
    expect((await project(h.win, B)).config).toEqual(b.config);
    expect(await shellState(h.win)).toEqual(before);
    expect((await gateEvidence(h.app, 'shells:set-default-cli')).requests).toEqual([
      { projectId: a.id, name: OTHER },
    ]);
  } finally {
    await restoreGate(h.app, 'shells:set-default-cli');
  }
  await choose(h.win, OTHER);
  await expect(settingsView(h.win).getByTestId(IDS.error)).toHaveCount(0);
  await confirmed(h.win, a, OTHER);
  expect(await shellState(h.win)).toEqual(before);
});

for (const leaveWhilePending of [false, true]) {
  test(`E5 held save stays bound to A ${leaveWhilePending ? 'after leaving its tab' : 'during normal project selection'}; saving B cannot consume A completion (AC3/6/9/12)`, async () => {
    const { h, a, b } = await start();
    await selectProject(h.win, A);
    await assertLaunch(h, a, 'project-primary', true);
    await installGate(h.app, 'shells:set-default-cli', 'hold', a.id);
    try {
      await enterSettingsTab(h.win, a);
      await expect(choice(h.win)).toBeEnabled();
      await choice(h.win).selectOption({ label: OTHER });
      await expect(settingsView(h.win).getByText(COPY.saving, { exact: true })).toBeVisible();
      await expect(choice(h.win)).toBeDisabled();
      await expect
        .poll(async () => (await gateEvidence(h.app, 'shells:set-default-cli')).held)
        .toBe(true);
      expect((await project(h.win, A)).config).toEqual(a.config);
      if (leaveWhilePending) await leaveSettingsTab(h.win, 'Files');
      await selectProject(h.win, B);
      await assertLaunch(h, b, 'b-other', true);
      if (leaveWhilePending) await enterSettingsTab(h.win, b);
      await expect(choice(h.win)).toBeEnabled();
      expect(await displayedChoice(h.win)).toBe(OTHER);
      await choose(h.win, GLOBAL_ONLY);
      const savedB = await confirmed(h.win, b, GLOBAL_ONLY);
      const processes = await shellState(h.win);
      await releaseGate(h.app, 'shells:set-default-cli');
      await expect
        .poll(async () => (await gateEvidence(h.app, 'shells:set-default-cli')).completed)
        .toBe(2);
      await confirmed(h.win, a, OTHER);
      await h.win.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
      );
      expect(await displayedChoice(h.win)).toBe(GLOBAL_ONLY);
      await expect(settingsView(h.win).getByTestId(IDS.projectName)).toHaveText(B);
      expect((await project(h.win, B)).config).toEqual(savedB.config);
      expect(await shellState(h.win)).toEqual(processes);
      expect((await gateEvidence(h.app, 'shells:set-default-cli')).requests).toEqual([
        { projectId: a.id, name: OTHER },
        { projectId: b.id, name: GLOBAL_ONLY },
      ]);
      await leaveSettingsTab(h.win);
      await assertMenuDefault(h.win, GLOBAL_ONLY);
      await enterSettingsTab(h.win, a, true);
      await expect(choice(h.win)).toBeEnabled();
      expect(await displayedChoice(h.win)).toBe(OTHER);
      await expect(h.win).toHaveTitle(`${B} — MetaLogix IDE`);
      await leaveSettingsTab(h.win);
      await killPrimary(h, b);
      await automaticSpawn(h, b);
      await assertLaunch(h, savedB, 'global-only', true);
    } finally {
      await restoreGate(h.app, 'shells:set-default-cli');
    }
  });
}

test('E5 delayed star response remains attached to A after switching to B (AC6/8/9)', async () => {
  const { h, a, b } = await start();
  await selectProject(h.win, A);
  await assertLaunch(h, a, 'project-primary', true);
  await installGate(h.app, 'shells:set-default-cli', 'hold', a.id);
  try {
    const menu = await openShellMenu(h.win);
    const star = menu.getByRole('button', {
      name: `Set ${GLOBAL_ONLY} as folder default`,
      exact: true,
    });
    await star.hover();
    await star.click();
    await expect
      .poll(async () => (await gateEvidence(h.app, 'shells:set-default-cli')).held)
      .toBe(true);
    await h.win.keyboard.press('Escape');
    await selectProject(h.win, B);
    await assertLaunch(h, b, 'b-other', true);
    const processes = await shellState(h.win);
    await releaseGate(h.app, 'shells:set-default-cli');
    await expect
      .poll(async () => (await gateEvidence(h.app, 'shells:set-default-cli')).completed)
      .toBe(1);
    await confirmed(h.win, a, GLOBAL_ONLY);
    await h.win.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    await assertMenuDefault(h.win, OTHER);
    await reopenAndCheck(h, b, OTHER);
    expect((await project(h.win, B)).config).toEqual(b.config);
    expect(await shellState(h.win)).toEqual(processes);
    await enterSettingsTab(h.win, a, true);
    await expect(choice(h.win)).toBeEnabled();
    expect(await displayedChoice(h.win)).toBe(GLOBAL_ONLY);
    await expect(h.win).toHaveTitle(`${B} — MetaLogix IDE`);
    expect((await gateEvidence(h.app, 'shells:set-default-cli')).requests).toEqual([
      { projectId: a.id, name: GLOBAL_ONLY },
    ]);
  } finally {
    await restoreGate(h.app, 'shells:set-default-cli');
  }
});

for (const channel of ['projects:list', 'shells:cli-profiles-list'] as const) {
  test(`E5 held ${channel} load cannot publish A into newly selected B settings (AC6/12)`, async () => {
    const { h, a, b } = await start();
    await selectProject(h.win, A);
    await assertLaunch(h, a, 'project-primary', true);
    await installGate(h.app, channel, 'hold', channel === 'projects:list' ? null : a.id);
    try {
      await enterSettingsTab(h.win, a);
      await expect(settingsView(h.win).getByTestId(IDS.loading)).toHaveText(COPY.loading);
      await expect(settingsView(h.win).locator('select:not(:disabled)')).toHaveCount(0);
      await expect.poll(async () => (await gateEvidence(h.app, channel)).held).toBe(true);
      await selectProject(h.win, B);
      await assertLaunch(h, b, 'b-other', true);
      await expect(choice(h.win)).toBeEnabled();
      expect(await displayedChoice(h.win)).toBe(OTHER);
      const countBefore = (await gateEvidence(h.app, channel)).completed;
      await releaseGate(h.app, channel);
      await expect
        .poll(async () => (await gateEvidence(h.app, channel)).completed)
        .toBeGreaterThan(countBefore);
      await h.win.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
      );
      await expect(settingsView(h.win).getByTestId(IDS.projectName)).toHaveText(B);
      await expect(settingsView(h.win).getByTestId(IDS.projectPath)).toHaveText(b.path);
      expect(await displayedChoice(h.win)).toBe(OTHER);
      expect((await project(h.win, A)).config).toEqual(a.config);
      expect((await project(h.win, B)).config).toEqual(b.config);
    } finally {
      await restoreGate(h.app, channel);
    }
  });
}

test('E5 live primary survives named save/reset, reattaches on return, then new automatic spawn adopts choice; explicit and plain launches remain explicit (AC4/7/9)', async () => {
  const { h, a, b } = await start();
  await selectProject(h.win, A);
  const originalPid = await assertLaunch(h, a, 'project-primary', true);
  const before = await shellState(h.win);
  await enterSettingsTab(h.win, a);
  await expect(choice(h.win)).toBeEnabled();
  await choose(h.win, OTHER);
  await confirmed(h.win, a, OTHER);
  expect(await shellState(h.win)).toEqual(before);
  await choose(h.win, null);
  await confirmed(h.win, a, null);
  expect(await shellState(h.win)).toEqual(before);
  await choose(h.win, OTHER);
  const saved = await confirmed(h.win, a, OTHER);
  await leaveSettingsTab(h.win);
  await selectProject(h.win, B);
  await assertLaunch(h, b, 'b-other', true);
  await selectProject(h.win, A);
  expect(
    await assertLaunch(h, a, 'project-primary', true),
    'return reattaches same primary PID',
  ).toBe(originalPid);
  const oldOutput = await output(h.win, a.id);
  expect(oldOutput).toContain('AGENT[project-primary]');
  expect(oldOutput).not.toContain('INPUT[');
  await ipc(h.win, 'shells:write', { projectId: a.id, shellIndex: 0, data: 'still-original\n' });
  await expect.poll(() => output(h.win, a.id)).toContain('INPUT[still-original]');
  await killPrimary(h, a);
  await selectProject(h.win, B);
  await selectProject(h.win, A);
  const newPid = await assertLaunch(h, saved, 'project-other', true);
  expect(newPid).not.toBe(originalPid);
  const menu = await openShellMenu(h.win);
  await menu
    .getByRole('button')
    .filter({ has: h.win.getByText(PRIMARY, { exact: true }) })
    .click();
  await expect
    .poll(
      async () =>
        (await ipc(h.win, 'shells:alive-list', undefined)).shells.filter(
          (s) => s.projectId === a.id,
        ).length,
    )
    .toBe(2);
  const explicit = (await ipc(h.win, 'shells:alive-list', undefined)).shells.find(
    (s) => s.projectId === a.id && s.shellIndex !== 0,
  );
  if (!explicit) throw new Error('explicit profile shell missing');
  await assertLaunch(h, saved, 'project-primary', true, {
    shellIndex: explicit.shellIndex,
    explicit: true,
  });
  await h.win.keyboard.press(process.platform === 'darwin' ? 'Meta+t' : 'Control+t');
  await expect
    .poll(
      async () =>
        (await ipc(h.win, 'shells:alive-list', undefined)).shells.filter(
          (s) => s.projectId === a.id,
        ).length,
    )
    .toBe(3);
  const plain = (await ipc(h.win, 'shells:alive-list', undefined)).shells.find(
    (s) => s.projectId === a.id && s.shellIndex !== 0 && s.shellIndex !== explicit.shellIndex,
  );
  if (!plain) throw new Error('plain-terminal shortcut did not spawn a shell');
  expect(plain.launchArgv[0]).toBe(AGENT_SHELL);
  expect(plain.launchArgv).not.toContain(h.executable);
  await ipc(h.win, 'shells:write', {
    projectId: a.id,
    shellIndex: plain.shellIndex,
    data: `printf 'PLAIN[%s]\\n' "$E2E_PROJECT"\n`,
  });
  await expect.poll(() => output(h.win, a.id, plain.shellIndex)).toContain(`PLAIN[${A}]`);
  expect((await project(h.win, A)).config).toEqual(saved.config);
});

test('E6 main tab and sidebar entry work by keyboard, native choice saves and focus traverses without a modal trap (AC1/3/9/12)', async () => {
  const { h, a, b } = await start();
  await selectProject(h.win, A);
  await assertLaunch(h, a, 'project-primary', true);
  const before = await shellState(h.win);
  await h.app.evaluate(({ app, BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(
      (candidate) => !candidate.webContents.getURL().includes('popout=1'),
    );
    if (!window) throw new Error('keyboard fixture requires the actual main window');
    app.focus({ steal: true });
    window.show();
    window.focus();
    window.webContents.focus();
  });
  await expect.poll(() => h.win.evaluate(() => document.hasFocus())).toBe(true);
  const settingsTab = h.win.getByRole('button', { name: COPY.tab, exact: true });
  const envTab = h.win.getByRole('button', { name: 'Env', exact: true });
  await h.win.keyboard.press('Tab'); // Keyboard modality for focus-visible assertions.
  await envTab.focus();
  await h.win.keyboard.press('Tab');
  await paintedFocus(settingsTab);
  await h.win.keyboard.press('Enter');
  await expect(settingsView(h.win)).toBeVisible();
  await expect(h.win.getByRole('dialog')).toHaveCount(0);
  await expect(choice(h.win)).toBeEnabled();
  await choice(h.win).focus();
  await paintedFocus(choice(h.win));
  await usableBox(choice(h.win));
  // The closed native select supports real typeahead without opening Cocoa's
  // NSMenu, whose key events are outside Playwright's renderer CDP client.
  await h.win.keyboard.press('s');
  await h.win.keyboard.press('Tab');
  await expect.poll(() => displayedChoice(h.win)).toBe(OTHER);
  await expect(settingsView(h.win).getByTestId(IDS.status)).toHaveText(COPY.saved);
  await confirmed(h.win, a, OTHER);
  await choice(h.win).focus();
  await h.win.keyboard.press('Tab');
  expect(
    await settingsView(h.win).evaluate((panel) => panel.contains(document.activeElement)),
    'Tab leaves the only settings control rather than wrapping inside',
  ).toBe(false);
  await h.win.keyboard.press('Shift+Tab');
  await expect(choice(h.win)).toBeFocused();
  await h.win.keyboard.press('Shift+Tab');
  expect(
    await settingsView(h.win).evaluate((panel) => panel.contains(document.activeElement)),
    'Shift+Tab traverses back into ordinary chrome',
  ).toBe(false);
  await settingsTab.focus();
  await paintedFocus(settingsTab);
  await h.win.keyboard.press('Shift+Tab');
  await paintedFocus(envTab);
  await h.win.keyboard.press('Enter');
  await expect(settingsView(h.win)).toHaveCount(0);
  await expect(
    h.win.getByRole('heading', { name: 'Environment variables', exact: true }),
  ).toBeVisible();
  const stableRow = row(h.win, B);
  await stableRow.focus();
  await paintedFocus(stableRow);
  await h.win.keyboard.press('Shift+F10');
  const item = h.win.getByRole('menuitem', { name: COPY.contextMenuItem, exact: true });
  await expect(item).toBeVisible();
  const itemCount = await h.win.getByRole('menu').getByRole('menuitem').count();
  for (
    let i = 0;
    i < itemCount && !(await item.evaluate((el) => document.activeElement === el));
    i++
  )
    await h.win.keyboard.press('ArrowDown');
  await expect(item).toBeFocused();
  await h.win.keyboard.press('Enter');
  await expect(settingsView(h.win).getByTestId(IDS.projectName)).toHaveText(B);
  await expect(choice(h.win)).toBeEnabled();
  await expect(h.win).toHaveTitle(`${A} — MetaLogix IDE`);
  expect(
    await shellState(h.win),
    'keyboard inactive-row entry leaves A live and B unlaunched',
  ).toEqual(before);
  expect((await project(h.win, B)).config).toEqual(b.config);
  await settingsTab.focus();
  await h.win.keyboard.press('Enter');
  await expect(settingsView(h.win).getByTestId(IDS.projectName)).toHaveText(A);
  await expect(choice(h.win)).toBeEnabled();
  expect(await displayedChoice(h.win)).toBe(OTHER);
  const shellTab = h.win
    .getByTestId('main-tab-bar')
    .getByRole('button', { name: 'Shell', exact: true });
  await shellTab.focus();
  await h.win.keyboard.press('Enter');
  await expect(settingsView(h.win)).toHaveCount(0);
  await expect(h.win.getByTestId('shell-tab')).toBeVisible();
  await expect(
    h.win.getByTestId('shell-tab').locator('textarea.xterm-helper-textarea'),
  ).not.toBeFocused();
  expect(await shellState(h.win)).toEqual(before);
});

test('E6 long project identity and profile remain usable in both active themes at normal and constrained desktop sizes (AC1/2/12)', async () => {
  const longName = 'project-with-a-long-descriptive-name-and-nested-looking-identity-'.repeat(3);
  const longProfile =
    'A saved custom agent with a deliberately long descriptive profile name '.repeat(3);
  const { h, a } = await start([longName, B]);
  await seedProject(h, longName, {
    cliProfiles: [profile(h, longProfile, 'long-profile')],
    defaultCliName: longProfile,
  });
  await selectProject(h.win, longName);
  await assertLaunch(h, a, 'long-profile', true);
  const paints: string[] = [];
  for (const theme of ['dark', 'light'] as const) {
    await h.win.getByTestId('settings-open').click();
    const appSettings = h.win.getByRole('dialog', { name: 'Settings', exact: true });
    await appSettings
      .getByRole('navigation', { name: 'Settings sections' })
      .getByRole('button', { name: 'General', exact: true })
      .click();
    await appSettings
      .getByRole('radio', { name: theme === 'dark' ? 'Dark' : 'Light', exact: true })
      .click();
    await expect(h.win.locator('html')).toHaveAttribute('data-theme', theme);
    await h.win.getByTestId('settings-done').click();
    for (const [width, height] of [
      [1400, 900],
      [900, 620],
    ] as const) {
      await resize(h.app, width, height);
      await enterSettingsTab(h.win, a);
      await expect(choice(h.win)).toBeEnabled();
      expect(await displayedChoice(h.win)).toBe(longProfile);
      await expect(settingsView(h.win).getByTestId(IDS.projectPath)).toHaveText(a.path);
      await h.win.screenshot({
        path: `.claude/reports/project-settings-tab-${theme}-${width}x${height}.png`,
      });
      for (const control of [
        choice(h.win),
        settingsView(h.win).getByTestId(IDS.projectName),
        settingsView(h.win).getByTestId(IDS.projectPath),
        settingsView(h.win).getByRole('heading', { name: COPY.title, exact: true }),
        settingsView(h.win).getByText(COPY.nextLaunchNotice, { exact: true }),
      ])
        await usableBox(control);
      await usableBox(settingsView(h.win));
      const paint = await settingsView(h.win).evaluate((panel) => {
        const main = panel.closest('main');
        if (!main) throw new Error('settings tab must be part of the actual main sheet');
        const style = getComputedStyle(main);
        const probe = document.createElement('span');
        probe.style.backgroundColor = 'var(--surface-sheet)';
        main.appendChild(probe);
        const token = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return {
          background: style.backgroundColor,
          token,
          color: getComputedStyle(panel).color,
          overflow: panel.scrollWidth > panel.clientWidth + 1,
        };
      });
      expect(paint.background, 'settings tab inherits the active main-sheet surface token').toBe(
        paint.token,
      );
      expect(paint.background).not.toBe('rgba(0, 0, 0, 0)');
      expect(paint.color).not.toBe(paint.background);
      expect(paint.overflow, 'long content does not cause horizontal clipping').toBe(false);
      if (width === 1400) paints.push(paint.background);
      await leaveSettingsTab(h.win);
    }
  }
  expect(paints).toHaveLength(2);
  expect(paints[0], 'real theme controls repaint the project settings tab').not.toBe(paints[1]);
});
