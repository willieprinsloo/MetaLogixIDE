import { expect, test as base, type Page, type Locator } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  assertAssignment,
  attachedGuests,
  chooseProject,
  createBoardProfile,
  guest,
  openAssignment,
  openBoard,
  openProject,
  PROJECT,
  showServiceSettings,
  signIn,
  switchOrigin,
  YAML_ORIGINAL,
  type BoardProfile,
} from './helpers/metaproject-board';
import {
  BOARD_ENTRY,
  CHANNEL_ID,
  CHAT_PATH,
  EDIT,
  LOGIN,
  LOGOUT,
  REMOTE_ID,
  startMetaprojectFixture,
  type MetaprojectFixture,
} from './helpers/metaproject-fixture';

const test = base.extend<{
  profile: BoardProfile;
  originA: MetaprojectFixture;
  originB: MetaprojectFixture;
}>({
  profile: async ({}, provide) => {
    const profile = await createBoardProfile();
    try {
      await provide(profile);
    } finally {
      await profile.cleanup();
    }
  },
  originA: async ({}, provide) => {
    const fixture = await startMetaprojectFixture('A');
    try {
      await provide(fixture);
    } finally {
      await fixture.close();
    }
  },
  originB: async ({}, provide) => {
    const fixture = await startMetaprojectFixture('B');
    try {
      await provide(fixture);
    } finally {
      await fixture.close();
    }
  },
});

test.use({ trace: 'off', video: 'off', screenshot: 'off' });
test.describe.configure({ mode: 'default', timeout: 55_000 });

async function configure(win: Page, fixture: MetaprojectFixture): Promise<Locator> {
  const settings = await showServiceSettings(win);
  await switchOrigin(settings, fixture);
  return settings;
}

async function saveInitialLink(
  win: Page,
  profile: BoardProfile,
  fixture: MetaprojectFixture,
  remember = false,
): Promise<void> {
  const settings = await configure(win, fixture);
  await settings.getByRole('button', { name: 'Close settings' }).click();
  await openProject(win);
  const assignment = await openAssignment(win);
  await expect(assignment.getByText('No Metaproject assignment for this folder.')).toBeVisible();
  await assignment.getByRole('button', { name: 'Sign in to Metaproject' }).click();
  await signIn(win, fixture, remember);
  await chooseProject(assignment);
  await assignment.getByRole('button', { name: 'Save assignment' }).click();
  await assertAssignment(assignment, profile, fixture);
}

async function openChat(win: Page): Promise<void> {
  await win.getByRole('button', { name: /^Chat(?: —|$)/ }).click();
}

test('one assignment sign-in opens the real Board, edits a card, drives Chat and logs out from the site', async ({
  profile,
  originA,
}) => {
  const built = await profile.launch();
  const { app, win } = built;
  await test.step('link the local project using the real picker and save the YAML', async () => {
    await saveInitialLink(win, profile, originA);
    expect(originA.state.logins).toBe(1);
  });

  await test.step('load and edit the same-origin Board in the attached native view', async () => {
    await openBoard(built, originA);
    expect(await guest(app, originA)).toMatchObject({ draft: 'Published', cardOpened: false });
    await guest(app, originA, 'draft');
    await expect
      .poll(() => guest(app, originA))
      .toMatchObject({ draft: 'Draft', cardOpened: true });
    expect(originA.state.edits).toBe(1);
    expect(originA.requests).toContainEqual({ path: EDIT, method: 'PUT', authenticated: true });
    await win.getByRole('button', { name: 'Return to workspace' }).click();
    await expect.poll(() => attachedGuests(app)).toBe(0);
    await expect(win.getByRole('button', { name: 'Board', exact: true })).toBeFocused();
  });

  await test.step('read Chat history and render a live message from the real direct Socket.IO connection', async () => {
    await openChat(win);
    await expect(win.getByText(`${originA.name} REST history`, { exact: true })).toBeVisible();
    expect(originA.requests).toContainEqual({
      path: CHAT_PATH,
      method: 'GET',
      authenticated: true,
    });
    await expect.poll(() => originA.joined).toContain(CHANNEL_ID);
    expect(originA.upgrades).toEqual([
      {
        actor: originA.actorId,
        exactOrigin: true,
        transport: 'websocket',
        eio: '4',
        cookieCount: 1,
      },
    ]);
    expect(originA.state.polls).toBe(0);
    originA.publishChat('Fixture Socket.IO update');
    await expect(win.getByText('Fixture Socket.IO update', { exact: true })).toBeVisible();
    expect(originA.state.logins).toBe(1);
  });

  await test.step('site logout detaches the guest and clears Chat without removing assignment', async () => {
    await openBoard(built, originA);
    expect(await guest(app, originA)).toMatchObject({ draft: 'Draft' });
    await guest(app, originA, 'logout');
    await expect.poll(() => attachedGuests(app)).toBe(0);
    const signInPrompt = win.getByRole('dialog', { name: 'Sign in to Metaproject' });
    await expect(win.getByText('Signed out of Metaproject.').first()).toBeVisible();
    await signInPrompt.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(win.getByText('Signed out of Metaproject.').first()).toBeVisible();
    await expect(win.getByText('Fixture Socket.IO update', { exact: true })).toHaveCount(0);
    await expect.poll(() => originA.state.sockets).toBe(0);
    await expect.poll(() => originA.state.logouts).toBe(1);
    expect(originA.requests).toContainEqual({ path: LOGOUT, method: 'GET', authenticated: true });
    expect(await readFile(profile.yaml, 'utf8')).toContain(`metaproject_origin: ${originA.origin}`);
    await win.getByRole('button', { name: 'Open in Browser', exact: true }).click();
    await expect
      .poll(() =>
        readFile(join(profile.userData, 'metaproject-fixture', 'opened.jsonl'), 'utf8').catch(
          () => '',
        ),
      )
      .toBe(`${JSON.stringify(originA.origin + BOARD_ENTRY)}\n`);
  });
});

test('Remember restores once on full quit; offline sign-out forgets and session-only does not restore', async ({
  profile,
  originA,
  originB,
}) => {
  let { app, win } = await profile.launch();
  let settings = await configure(win, originA);
  await settings.getByRole('button', { name: 'Sign in to Metaproject' }).click();
  await signIn(win, originA, true);
  await expect(settings.getByRole('status')).toHaveText(
    `Signed in as ${originA.name} Member · Remembered on this device`,
  );
  const firstPid = app.process().pid;
  await profile.close();
  ({ app, win } = await profile.launch());
  expect(app.process().pid).not.toBe(firstPid);
  settings = await showServiceSettings(win);
  await expect(settings.getByRole('status')).toHaveText(
    `Signed in as ${originA.name} Member · Remembered on this device`,
  );
  expect(originA.state.logins).toBe(2);
  await expect.poll(() => originA.upgrades.length).toBe(2);

  await originA.close();
  await settings.getByRole('button', { name: 'Sign out and forget' }).click();
  await expect(settings.getByRole('status')).toHaveText('Signed out of Metaproject.');
  await profile.close();
  ({ win } = await profile.launch());
  settings = await showServiceSettings(win);
  await expect(settings.getByRole('status')).toHaveText('Signed out of Metaproject.');
  await expect(settings.getByRole('button', { name: 'Retry remembered sign-in' })).toHaveCount(0);

  await switchOrigin(settings, originB);
  await settings.getByRole('button', { name: 'Sign in to Metaproject' }).click();
  await signIn(win, originB);
  await expect(settings.getByRole('status')).toHaveText(`Signed in as ${originB.name} Member`);
  await profile.close();
  ({ win } = await profile.launch());
  settings = await showServiceSettings(win);
  await expect(settings.getByRole('status')).toHaveText('Signed out of Metaproject.');
  expect(originB.state.logins).toBe(1);
  expect(
    originB.requests.filter((entry) => entry.path === LOGIN && entry.method === 'POST'),
  ).toHaveLength(1);
});

test('same project number on a second origin does not rebase; login and Board redirects do not follow', async ({
  profile,
  originA,
  originB,
}) => {
  const built = await profile.launch();
  const { win } = built;
  await saveInitialLink(win, profile, originA, true);
  const original = await readFile(profile.yaml, 'utf8');
  await openBoard(built, originA);
  await win.getByRole('button', { name: 'Return to workspace' }).click();
  const control = await fetch(`${originB.origin}/landing`, { signal: AbortSignal.timeout(3_000) });
  expect(control.status).toBe(200);

  originA.state.redirects.board = `${originB.origin}/landing`;
  await win.getByRole('button', { name: 'Board', exact: true }).click();
  await expect(win.getByRole('button', { name: 'Retry Board' })).toBeVisible();
  expect(originB.requests).toEqual([{ path: '/landing', method: 'GET', authenticated: false }]);
  await win.getByRole('button', { name: 'Return to workspace' }).click();

  const settings = await showServiceSettings(win);
  await switchOrigin(settings, originB);
  expect(originB.state.logins).toBe(0);
  expect(originB.upgrades).toHaveLength(0);
  await settings.getByRole('button', { name: 'Sign in to Metaproject' }).click();
  await signIn(win, originB);
  await expect(settings.getByRole('status')).toHaveText(`Signed in as ${originB.name} Member`);
  await settings.getByRole('button', { name: 'Close settings' }).click();
  const assignment = await openAssignment(win);
  await expect(assignment.getByText(/Linked to another service: project #11/)).toBeVisible();
  expect(await readFile(profile.yaml, 'utf8')).toBe(original);
  expect(originB.requests.some((entry) => entry.path === BOARD_ENTRY)).toBe(false);
  await chooseProject(assignment);
  await expect(assignment.getByRole('option', { name: /Fixture B/ })).toBeAttached();

  const after = await showServiceSettings(win);
  await after.getByRole('button', { name: 'Sign out and forget' }).click();
  await expect(after.getByRole('button', { name: 'Sign in to Metaproject' })).toBeVisible();
  originB.state.redirects.login = `${originA.origin}/landing`;
  await after.getByRole('button', { name: 'Sign in to Metaproject' }).click();
  await signIn(win, originB);
  const prompt = win.getByRole('dialog', { name: 'Sign in to Metaproject' });
  await expect(prompt.getByRole('alert')).toContainText('unexpected response');
  expect(
    originB.requests.filter((entry) => entry.path === LOGIN && entry.method === 'POST'),
  ).toHaveLength(2);
  expect(originA.requests.some((entry) => entry.path === '/landing')).toBe(false);
});

test('an external YAML edit conflicts, and removing the assignment does not relink on restart', async ({
  profile,
  originA,
}) => {
  let { win } = await profile.launch();
  await saveInitialLink(win, profile, originA);
  const assignment = win.getByRole('region', { name: 'Metaproject assignment' });
  await chooseProject(assignment, 'Change assignment');
  const modified = (await readFile(profile.yaml, 'utf8')) + '# external update\r\n';
  await writeFile(profile.yaml, modified);
  await assignment.getByRole('button', { name: 'Save assignment' }).click();
  await expect(assignment.getByRole('alert')).toContainText('assignment changed on disk');
  expect(await readFile(profile.yaml, 'utf8')).toBe(modified);
  await assignment.getByRole('button', { name: 'Reload assignment' }).click();
  await assignment.getByRole('button', { name: 'Remove assignment' }).click();
  await assignment.getByRole('button', { name: 'Confirm removal' }).click();
  await expect(assignment.getByText('No Metaproject assignment for this folder.')).toBeVisible();
  expect(await readFile(profile.yaml, 'utf8')).toBe(`${YAML_ORIGINAL}# external update\r\n`);
  await profile.close();
  ({ win } = await profile.launch());
  await openProject(win);
  const reopened = await openAssignment(win);
  await expect(reopened.getByText('No Metaproject assignment for this folder.')).toBeVisible();
  expect(await readFile(profile.yaml, 'utf8')).toBe(`${YAML_ORIGINAL}# external update\r\n`);
});

test('returning from Board retains an unsaved editor buffer at the minimum verification viewport', async ({
  profile,
  originA,
}) => {
  const built = await profile.launch();
  const { app, win } = built;
  await saveInitialLink(win, profile, originA);
  await expect
    .poll(() => win.evaluate(() => [window.innerWidth, window.innerHeight]))
    .toEqual([900, 600]);
  await win.getByRole('button', { name: 'Files', exact: true }).click();
  await win
    .getByTestId('file-entry')
    .filter({ hasText: /^notes\.txt$/ })
    .click();
  await win.getByTestId('file-edit-toggle').click();
  const editor = win.getByTestId('file-editor').getByRole('textbox');
  await expect(editor).toHaveValue('Original on disk\n');
  await editor.fill('Unsaved before opening Board');
  await expect(win.getByTestId('file-save')).toBeEnabled();
  await openBoard(built, originA);
  await expect(editor).toBeHidden();
  const returnButton = win.getByRole('button', { name: 'Return to workspace' });
  await expect(returnButton).toBeFocused();
  await returnButton.press('Enter');
  await expect.poll(() => attachedGuests(app)).toBe(0);
  await expect(editor).toBeVisible();
  await expect(editor).toHaveValue('Unsaved before opening Board');
  await expect(win.getByTestId('file-save')).toBeEnabled();
  expect(await readFile(profile.notes, 'utf8')).toBe('Original on disk\n');
});

test('service rejection during Board open signs out the shared session without replaying the remembered login', async ({
  profile,
  originA,
}) => {
  const built = await profile.launch();
  const { app, win } = built;
  await saveInitialLink(win, profile, originA, true);
  await openBoard(built, originA);
  await win.getByRole('button', { name: 'Return to workspace' }).click();
  const loginRequests = originA.requests.filter((entry) => entry.path === LOGIN).length;
  originA.expire();
  await win.getByRole('button', { name: 'Board', exact: true }).click();
  const board = win.getByRole('region', { name: `Board for ${PROJECT}` });
  await expect(board.getByRole('alert')).toHaveText(
    'Your Metaproject session expired. Sign in again.',
  );
  expect(originA.state.rejected).toBeGreaterThan(0);
  expect(originA.requests).toContainEqual({
    path: `/api/projects/${REMOTE_ID}`,
    method: 'GET',
    authenticated: false,
  });
  await expect.poll(() => attachedGuests(app)).toBe(0);
  await expect.poll(() => originA.state.sockets).toBe(0);
  expect(originA.requests.filter((entry) => entry.path === LOGIN)).toHaveLength(loginRequests);
  expect(await readFile(profile.yaml, 'utf8')).toContain(`metaproject_origin: ${originA.origin}`);
});
