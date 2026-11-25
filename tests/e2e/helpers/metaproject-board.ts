import {
  _electron,
  expect,
  type ElectronApplication,
  type Locator,
  type Page,
} from '@playwright/test';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { BOARD_PATH, HOST, REMOTE_ID, type MetaprojectFixture } from './metaproject-fixture';

export const PROJECT = 'board-fixture-project';
export const YAML_ORIGINAL =
  '# preserve this note\r\nboard_url: https://unused.example.invalid/board\r\nname: Fixture repository\r\n';
type BuiltApp = { app: ElectronApplication; win: Page };
type GuestAction = 'inspect' | 'draft' | 'logout';
interface GuestSnapshot {
  url: string;
  topLevel: boolean;
  sandbox: boolean;
  contextIsolation: boolean;
  webSecurity: boolean;
  preload: boolean;
  node: boolean;
  ideBridge: boolean;
  title: string;
  draft: string;
  cardOpened: boolean;
}

export interface BoardProfile {
  yaml: string;
  notes: string;
  userData: string;
  launch(): Promise<BuiltApp>;
  close(): Promise<void>;
  cleanup(): Promise<void>;
}

/** Fresh filesystem, HOME and Chromium profile; kept only for true quit/relaunch in the same test. */
export async function createBoardProfile(): Promise<BoardProfile> {
  const reportDir = resolve('.claude/reports');
  await mkdir(reportDir, { recursive: true });
  const home = await realpath(await mkdtemp(join(reportDir, '.board-e2e-profile-')));
  const userData = join(home, 'userData');
  const root = join(home, 'workspaces');
  const project = join(root, PROJECT);
  const yaml = join(project, '.metaproject.yaml');
  const notes = join(project, 'notes.txt');
  await mkdir(join(project, '.git'), { recursive: true });
  await mkdir(userData);
  await writeFile(yaml, YAML_ORIGINAL);
  await writeFile(notes, 'Original on disk\n');
  let app: ElectronApplication | undefined;
  let seeded = false;

  async function close(): Promise<void> {
    if (!app) return;
    const current = app;
    await current.close();
    app = undefined;
  }

  return {
    yaml,
    notes,
    userData,
    async launch() {
      if (app) throw new Error('Quit the previous application before relaunch');
      const require = createRequire(import.meta.url);
      const executable: unknown = require('electron');
      if (typeof executable !== 'string')
        throw new Error('Pinned Electron executable is unavailable');
      app = await _electron.launch({
        executablePath: executable,
        cwd: process.cwd(),
        timeout: 15_000,
        args: [
          '.',
          `--user-data-dir=${userData}`,
          '--disable-background-networking',
          '--no-proxy-server',
          '--use-mock-keychain',
          '--password-store=basic',
          `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE ${HOST}`,
        ],
        env: {
          HOME: home,
          SHELL: '/bin/sh',
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          ...(process.env.DISPLAY ? { DISPLAY: process.env.DISPLAY } : {}),
          METAIDE_TEST_MODE: '1',
          METAIDE_METAPROJECT_FIXTURE: '1',
          METAIDE_CLAUDE_PERMISSION_MODE: 'bypass',
          METAIDE_DEFAULT_LAUNCH_FIRST: JSON.stringify({ argv: ['/bin/sh'], env: {} }),
          METAIDE_DEFAULT_LAUNCH_SUBSEQUENT: JSON.stringify({ argv: ['/bin/sh'], env: {} }),
        },
      });
      const paths = await app.evaluate(({ app }) => ({
        profile: app.getPath('userData'),
        switchProfile: app.commandLine.getSwitchValue('user-data-dir'),
        packaged: app.isPackaged,
        testMode: process.env.METAIDE_TEST_MODE,
        fixture: process.env.METAIDE_METAPROJECT_FIXTURE,
        electron: process.versions.electron,
      }));
      expect(paths, 'all prerequisites for the local fixture keyring').toEqual({
        profile: userData,
        switchProfile: userData,
        packaged: false,
        testMode: '1',
        fixture: '1',
        electron: '32.3.3',
      });
      const win = await app.firstWindow({ timeout: 15_000 });
      await win.waitForLoadState('domcontentloaded');
      win.setDefaultTimeout(7_500);
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setContentSize(900, 600);
      });
      if (!seeded) {
        await win.evaluate(async (path) => {
          const bridge: unknown = Reflect.get(window, 'api');
          if (
            typeof bridge !== 'object' ||
            bridge === null ||
            !('invoke' in bridge) ||
            typeof bridge.invoke !== 'function'
          ) {
            throw new Error(
              'Trusted IDE preload bridge unavailable during fixture root registration',
            );
          }
          await bridge.invoke('roots:add', { path });
        }, root);
        seeded = true;
      }
      await expect(projectRow(win)).toBeVisible();
      return { app, win };
    },
    close,
    async cleanup() {
      try {
        await close();
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    },
  };
}

export async function openProject(win: Page): Promise<void> {
  await projectRow(win).click();
  await expect(win).toHaveTitle(`${PROJECT} — MetaLogix IDE`);
}

function projectRow(win: Page): Locator {
  return win
    .getByTestId('section-all')
    .getByTestId('project-row')
    .filter({ has: win.getByText(PROJECT, { exact: true }) });
}

export async function showServiceSettings(win: Page): Promise<Locator> {
  await win.getByRole('button', { name: /^Settings \(/ }).click();
  const settings = win.getByTestId('settings-modal');
  await settings.getByRole('button', { name: 'Metaproject', exact: true }).click();
  return settings;
}

export async function switchOrigin(settings: Locator, fixture: MetaprojectFixture): Promise<void> {
  const url = new URL(fixture.origin);
  expect(url.hostname, 'fixture is the only permitted service').toBe(HOST);
  await settings.getByRole('textbox', { name: 'Service origin' }).fill(fixture.origin);
  await settings.getByRole('button', { name: 'Save service origin' }).click();
  await settings.getByRole('button', { name: 'Switch origin' }).click();
  await expect(settings.getByRole('status')).toContainText('Signed out of Metaproject.');
  await expect(settings.getByRole('textbox', { name: 'Service origin' })).toHaveValue(
    fixture.origin,
  );
  await expect(settings.getByRole('button', { name: 'Switch origin' })).toHaveCount(0);
}

export async function signIn(
  win: Page,
  fixture: MetaprojectFixture,
  remember = false,
): Promise<void> {
  const prompt = win.getByRole('dialog', { name: 'Sign in to Metaproject' });
  await expect(prompt).toBeVisible();
  await prompt
    .getByRole('textbox', { name: 'Username or email' })
    .fill(fixture.credentials.username);
  await prompt.getByLabel('Password', { exact: true }).fill(fixture.credentials.password);
  await prompt.getByRole('checkbox', { name: 'Remember me on this device' }).setChecked(remember);
  await prompt.getByRole('button', { name: 'Sign in', exact: true }).click();
}

export async function openAssignment(win: Page): Promise<Locator> {
  await win.getByRole('button', { name: 'Board', exact: true }).click();
  const board = win.getByRole('region', { name: `Board for ${PROJECT}` });
  const direct = win.getByRole('region', { name: 'Metaproject assignment' });
  const settings = board.getByRole('button', { name: 'Open Project Settings' });
  await expect(direct.or(settings)).toBeVisible();
  if (await settings.isVisible()) await settings.click();
  return direct;
}

export async function chooseProject(assignment: Locator, label = 'Link existing'): Promise<void> {
  await assignment.getByRole('button', { name: label, exact: true }).click();
  await expect(assignment.getByRole('option', { name: /Fixture [AB]/ })).toBeAttached();
  await assignment.getByTestId('mp-link-select').selectOption(String(REMOTE_ID));
}

export async function assertAssignment(
  assignment: Locator,
  profile: BoardProfile,
  fixture: MetaprojectFixture,
): Promise<void> {
  await expect(
    assignment.getByText(`Assigned to project #${REMOTE_ID} at ${fixture.origin}.`),
  ).toBeVisible();
  const yaml = await readFile(profile.yaml, 'utf8');
  expect(yaml).toContain(YAML_ORIGINAL);
  expect(yaml).toMatch(/^project_id: 11\r?$/m);
  expect(yaml).toContain(`metaproject_origin: ${fixture.origin}`);
}

/** Read and operate only the known fixture DOM in the attached native view, never replace its network. */
export async function guest(
  app: ElectronApplication,
  fixture: MetaprojectFixture,
  action: GuestAction = 'inspect',
): Promise<GuestSnapshot | null> {
  return app.evaluate(
    async ({ BrowserWindow, WebContentsView }, data): Promise<GuestSnapshot | null> => {
      const window = BrowserWindow.getAllWindows().find((candidate) =>
        candidate.webContents.getURL().startsWith('file:'),
      );
      const view = window?.contentView.children.find(
        (child) => child instanceof WebContentsView && child.webContents.getURL() === data.url,
      );
      if (!(view instanceof WebContentsView) || view.webContents.isDestroyed()) return null;
      const wc = view.webContents;
      // getLastWebPreferences is present in the pinned Electron runtime but not in its declarations.
      const preferences = Reflect.get(wc, 'getLastWebPreferences');
      if (typeof preferences !== 'function')
        throw new Error('Electron WebContents preferences unavailable');
      const info: unknown = Reflect.apply(preferences, wc, []);
      if (typeof info !== 'object' || info === null)
        throw new Error('Missing live guest preferences');
      if (data.action === 'logout') {
        await wc.executeJavaScript(
          `setTimeout(() => document.querySelector('#logout').click(), 0); void 0`,
        );
        return null;
      }
      if (data.action === 'draft')
        await wc.executeJavaScript(
          `document.querySelector('#card summary').click(); document.querySelector('#draft').click(); void 0`,
        );
      // The fixture contains no user-entered data. Return only visible labels and presence flags.
      const dom: unknown = await wc.executeJavaScript(`({
      topLevel: top === self,
      ideBridge: typeof window.api !== 'undefined' || typeof window.logger !== 'undefined',
      node: typeof process !== 'undefined' || typeof require !== 'undefined',
      title: document.querySelector('h1').textContent,
      draft: document.querySelector('#draft-state').textContent,
      cardOpened: document.querySelector('#card').open
    })`);
      if (
        typeof dom !== 'object' ||
        dom === null ||
        !('title' in dom) ||
        typeof dom.title !== 'string' ||
        !('draft' in dom) ||
        typeof dom.draft !== 'string' ||
        !('cardOpened' in dom) ||
        typeof dom.cardOpened !== 'boolean' ||
        !('topLevel' in dom) ||
        typeof dom.topLevel !== 'boolean' ||
        !('ideBridge' in dom) ||
        typeof dom.ideBridge !== 'boolean' ||
        !('node' in dom) ||
        typeof dom.node !== 'boolean'
      )
        throw new Error('Expected inspectable fixture Board DOM');
      return {
        url: wc.getURL(),
        title: dom.title,
        draft: dom.draft,
        cardOpened: dom.cardOpened,
        topLevel: dom.topLevel,
        ideBridge: dom.ideBridge,
        node: dom.node,
        sandbox: Reflect.get(info, 'sandbox') === true,
        contextIsolation: Reflect.get(info, 'contextIsolation') === true,
        webSecurity: Reflect.get(info, 'webSecurity') === true,
        preload: Boolean(Reflect.get(info, 'preload')),
      };
    },
    { action, url: `${fixture.origin}${BOARD_PATH}` },
  );
}

export async function openBoard(built: BuiltApp, fixture: MetaprojectFixture): Promise<void> {
  await built.win.getByRole('button', { name: 'Board', exact: true }).click();
  await expect(built.win.getByRole('button', { name: 'Focus Board' })).toBeEnabled();
  await expect
    .poll(() => guest(built.app, fixture))
    .toMatchObject({
      url: `${fixture.origin}${BOARD_PATH}`,
      title: `${fixture.name} Board`,
      topLevel: true,
      sandbox: true,
      contextIsolation: true,
      webSecurity: true,
      preload: false,
      node: false,
      ideBridge: false,
    });
}

/** Native attachment observation stays synchronous even when the guest is closing mid-navigation. */
export async function attachedGuests(app: ElectronApplication): Promise<number> {
  return app.evaluate(
    ({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((candidate) => candidate.webContents.getURL().startsWith('file:'))
        ?.contentView.children.filter((child) => 'webContents' in child).length ?? 0,
  );
}
