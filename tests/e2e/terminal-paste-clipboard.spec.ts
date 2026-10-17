/**
 * Terminal clipboard paste (docs/specs/2026-10-17-terminal-drag-drop.md
 * AC12, AC12a, AC13, AC13a).
 *
 * AC13a: this file writes the real OS clipboard from the main process
 * (`clipboard.writeText` / `writeImage` / `clear`), so its tests run
 * serially against one app and never in parallel with each other.
 *
 * Routes:
 * - Context-menu Paste: right-click the terminal, click "Paste".
 * - Edit > Paste and the macOS Cmd+V shortcut: `webContents.paste()` from the
 *   main process. Cmd+V is the Edit > Paste accelerator on macOS, and both end
 *   in the same DOM `paste` event; a synthetic Playwright Cmd+V does not
 *   reliably trigger a menu accelerator.
 * - Ctrl+Shift+V (non-macOS) is covered by the terminal-keys and
 *   clipboard-paste unit tests; it is driven here only on Linux.
 *
 * Bracketed paste is held on in the right (split) pane by `cat` after
 * `printf '\033[?2004h'`, so each payload's framing is visible byte for byte
 * in the main-process `shells:write` spy.
 */

import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { readFileSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { DROP_COPY } from '../../src/shared/terminal-drop-contract';
import { marker } from './helpers/focus';
import {
  BP_END, BP_START, PNG_1X1, PNG_SIGNATURE, RIGHT,
  channelCalls, dropDir, expectWrite, holdBracketedPaste, launchDropFixture, recordChannel, screen,
  shellWrites, unescapePath, writeContaining,
  type DropFixture,
} from './helpers/drop';

test.describe.configure({ mode: 'serial' });

let f: DropFixture;
const stagedFiles: string[] = [];

test.beforeAll(async () => {
  f = await launchDropFixture();
  await recordChannel(f.app, 'drops:stage-clipboard-image');
  await holdBracketedPaste(f.win, RIGHT, true);
});

test.afterAll(async () => {
  await f?.app.close();
  f?.cleanup();
  for (const path of stagedFiles) rmSync(path, { force: true });
});

async function setClipboardText(app: ElectronApplication, text: string): Promise<void> {
  await app.evaluate(({ clipboard }, t) => { clipboard.clear(); clipboard.writeText(t); }, text);
}

async function setClipboardImage(app: ElectronApplication, png: number[]): Promise<void> {
  await app.evaluate(({ clipboard, nativeImage }, bytes) => {
    clipboard.clear();
    clipboard.writeImage(nativeImage.createFromBuffer(Buffer.from(bytes)));
  }, png);
}

async function clearClipboard(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ clipboard }) => { clipboard.clear(); });
}

/** Edit > Paste / macOS Cmd+V: focus the pane's terminal, then paste from the main process. */
async function pasteViaEditMenu(app: ElectronApplication, win: Page): Promise<void> {
  await screen(win, RIGHT).click();
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]!;
    w.focus();
    w.webContents.paste();
  });
}

/** Context-menu Paste on the pane's terminal. */
async function pasteViaContextMenu(app: ElectronApplication, win: Page): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.focus(); });
  await screen(win, RIGHT).click({ button: 'right' });
  await win.getByRole('menuitem', { name: 'Paste', exact: true }).click();
}

type Route = { name: string; paste: (app: ElectronApplication, win: Page) => Promise<void> };
const ROUTES: Route[] = [
  { name: 'Edit > Paste (Cmd+V)', paste: pasteViaEditMenu },
  { name: 'context-menu Paste', paste: pasteViaContextMenu },
];

/** Asserts a pasted payload is a bracketed escaped path to a fresh staged PNG of the clipboard image. */
async function expectStagedPng(app: ElectronApplication, written: string, route: string): Promise<void> {
  expect(written.startsWith(BP_START) && written.endsWith(BP_END), `${route}: the image path arrives bracketed`).toBe(true);
  const path = unescapePath(written.slice(BP_START.length, -BP_END.length));
  stagedFiles.push(path);
  expect(realpathSync(dirname(path)), `${route}: staged in the launch's <userData>/drops`).toBe(realpathSync(dropDir(f)));
  expect(basename(path), `${route}: staged as pasted-<timestamp>.png`).toMatch(/^pasted-.+\.png$/);
  expect([...readFileSync(path).subarray(0, 8)], `${route}: the staged file is a PNG`).toEqual(PNG_SIGNATURE);
  const size = await app.evaluate(({ nativeImage }, p) => nativeImage.createFromPath(p).getSize(), path);
  expect(size, `${route}: the staged PNG decodes to the clipboard image`).toEqual({ width: 1, height: 1 });
}

test('AC12a: context-menu Paste goes through bracketed paste and the sanitiser', async () => {
  const { app, win, right } = f;
  const tag = marker('ac12a');
  await setClipboardText(app, `${tag}x\x1b[201~y`);
  await pasteViaContextMenu(app, win);
  await expectWrite(app, right, `${BP_START}${tag}x [201~y${BP_END}`,
    'clipboard text arrives bracketed, its embedded ESC replaced by a space so it cannot end the paste early');
});

test('AC12: Edit > Paste (the macOS Cmd+V accelerator) inserts clipboard text through bracketed paste, sanitised', async () => {
  const { app, win, right } = f;
  const tag = marker('ac12-text');
  await setClipboardText(app, `${tag}\x07bell`);
  await pasteViaEditMenu(app, win);
  await expectWrite(app, right, `${BP_START}${tag} bell${BP_END}`, 'clipboard text arrives bracketed with BEL replaced by a space');
});

test('AC12: an image-only clipboard is staged as a PNG and its escaped path pasted, by every route', async () => {
  const { app, win, right } = f;
  for (const route of ROUTES) {
    const callsBefore = (await channelCalls(app, 'drops:stage-clipboard-image')).length;
    const writesBefore = (await shellWrites(app, right)).length;
    await setClipboardImage(app, [...PNG_1X1]);
    await route.paste(app, win);
    await expect.poll(async () => (await shellWrites(app, right)).slice(writesBefore).some((d) => d.includes('pasted-')),
      { timeout: 8000, message: `${route.name}: a staged image path is pasted` }).toBe(true);
    const written = (await shellWrites(app, right)).slice(writesBefore).find((d) => d.includes('pasted-'))!;
    await expectStagedPng(app, written, route.name);
    expect((await channelCalls(app, 'drops:stage-clipboard-image')).length - callsBefore,
      `${route.name}: exactly one clipboard-image staging call`).toBe(1);
  }
});

test('AC13: an empty clipboard pastes nothing and shows no error, by every route', async () => {
  const { app, win, right } = f;
  for (const route of ROUTES) {
    const writesBefore = (await shellWrites(app, right)).length;
    await clearClipboard(app);
    await route.paste(app, win);

    // Positive control: the same route still pastes once the clipboard has text.
    const sentinel = marker('ac13-sentinel');
    await setClipboardText(app, sentinel);
    await route.paste(app, win);
    await writeContaining(app, right, sentinel, `${route.name}: a later paste with text is written`);

    expect((await shellWrites(app, right)).slice(writesBefore), `${route.name}: the empty-clipboard paste wrote nothing`)
      .toEqual([`${BP_START}${sentinel}${BP_END}`]);
  }
  await expect(win.getByTestId('toast').filter({ hasText: DROP_COPY.clipboardImageFailedTitle }), 'no clipboard-image error toast').toHaveCount(0);
  await expect(win.getByTestId('toast').filter({ hasText: 'Paste failed' }), 'no paste error toast').toHaveCount(0);
});

test('AC12: Ctrl+Shift+V pastes clipboard text through bracketed paste (Linux only)', async () => {
  test.skip(process.platform !== 'linux', 'non-macOS shortcut; covered by unit tests off Linux (Windows runs no E2E)');
  const { app, win, right } = f;
  const tag = marker('ac12-ctrlshiftv');
  await setClipboardText(app, tag);
  await screen(win, RIGHT).click();
  await win.keyboard.press('Control+Shift+V');
  await expectWrite(app, right, `${BP_START}${tag}${BP_END}`, 'Ctrl+Shift+V paste arrives bracketed');
});
