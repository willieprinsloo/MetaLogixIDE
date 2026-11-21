/**
 * OSC 52 clipboard write from a LOCAL shell (docs/specs/remote-clipboard.md
 * AC-T6, AC-T7). The handler is source-independent, so a local shell proves it
 * end to end; remote paths are covered by component tests.
 *
 * Writes the real OS clipboard from the main process, so tests run serially
 * against one app (as terminal-paste-clipboard.spec.ts, AC13a).
 *
 * Home: this reuses launchDropFixture (real app, real local PTYs, real
 * Electron clipboard) so every assertion can fail on a regression; nothing
 * here is stubbed except the passive `shells:write` spy.
 */

import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { marker, shellOutput } from './helpers/focus';
import {
  PROJECT, RIGHT, interrupt, launchDropFixture, recordShellWrites, runInPane, screen, shellWrites,
  type DropFixture,
} from './helpers/drop';

test.describe.configure({ mode: 'serial' });

let f: DropFixture;

test.beforeAll(async () => {
  f = await launchDropFixture();
  await recordShellWrites(f.app);
});

test.afterAll(async () => {
  await f?.app.close();
  f?.cleanup();
});

const readClipboard = (app: ElectronApplication): Promise<string> =>
  app.evaluate(({ clipboard }) => clipboard.readText());

async function setClipboardText(app: ElectronApplication, text: string): Promise<void> {
  await app.evaluate(({ clipboard }, t) => { clipboard.clear(); clipboard.writeText(t); }, text);
}

/** Types a printf of one OSC 52 sequence (BEL or ST terminated) into the right pane. */
async function emitOsc52(win: Page, pm: string, terminator: 'bel' | 'st'): Promise<void> {
  const end = terminator === 'bel' ? '\\a' : '\\033\\\\';
  await runInPane(win, RIGHT, `printf '\\033]52;c;${pm}${end}'`);
}

/** Runs `done-<tag>` echo so the test knows the shell consumed the prior command. */
async function sync(win: Page, app: ElectronApplication, label: string): Promise<void> {
  const tag = marker(label);
  await runInPane(win, RIGHT, `echo ${tag.slice(0, 4)}$((40+2))${tag.slice(4)}`);
  await expect.poll(() => shellOutput(win, PROJECT, f.right),
    { timeout: 8000 }).toContain(`${tag.slice(0, 4)}42${tag.slice(4)}`);
}

/** xterm `modes.mouseTrackingMode` of the right pane, read through React's fiber (as helpers/drop.ts bracketedPasteMode). */
async function mouseTrackingMode(win: Page, probe: 'mode' | 'selection' = 'mode'): Promise<string | null> {
  return win.evaluate(([sel, what]: [string, string]) => {
    type Term = { modes: { mouseTrackingMode: string }; buffer: { active: unknown }; hasSelection(): boolean };
    type Hook = { memoizedState: unknown; next: Hook | null };
    type Fiber = { tag: number; memoizedState: unknown; return: Fiber | null };
    const isTerm = (v: unknown): v is Term => !!v && typeof v === 'object' && 'modes' in v && 'buffer' in v;
    const host = [...document.querySelectorAll<HTMLElement>(`${sel} [data-testid="shell-tab"] .xterm`)].find((n) => n.offsetParent !== null);
    if (!host) return null;
    let el: HTMLElement | null = host;
    let fiber: Fiber | null = null;
    while (el && !fiber) {
      const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
      if (key) fiber = (el as unknown as Record<string, Fiber>)[key] ?? null;
      el = el.parentElement;
    }
    for (let f = fiber; f; f = f.return) {
      if (f.tag !== 0) continue;
      for (let h = f.memoizedState as Hook | null; h; h = h.next) {
        const ref = h.memoizedState as { current?: unknown } | null;
        if (ref && typeof ref === 'object' && 'current' in ref && isTerm(ref.current)) return what === 'selection' ? String(ref.current.hasSelection()) : ref.current.modes.mouseTrackingMode;
      }
    }
    return null;
  }, [RIGHT, probe] as [string, string]);
}

test('AC-T6: OSC 52 write (BEL) from a local shell lands on the system clipboard, UTF-8 intact', async () => {
  const { app, win } = f;
  await setClipboardText(app, 'before-osc52');
  const text = 'héllo 🎉';
  await emitOsc52(win, Buffer.from(text, 'utf8').toString('base64'), 'bel');
  await expect.poll(() => readClipboard(app), { timeout: 8000, message: 'clipboard receives the decoded OSC 52 text' }).toBe(text);
});

test('AC-T6: OSC 52 write terminated with ST also lands on the clipboard', async () => {
  const { app, win } = f;
  const text = `st-${marker('osc52')}`;
  await setClipboardText(app, 'before-st');
  await emitOsc52(win, Buffer.from(text, 'utf8').toString('base64'), 'st');
  await expect.poll(() => readClipboard(app), { timeout: 8000 }).toBe(text);
});

test('AC-T6: invalid base64 is ignored without error and leaves the clipboard alone', async () => {
  const { app, win } = f;
  const errors: Error[] = [];
  win.on('pageerror', (e) => errors.push(e));
  await setClipboardText(app, 'keep-me');
  await emitOsc52(win, '!!!not*base64@@', 'bel');
  await sync(win, app, 'badb64');
  expect(await readClipboard(app), 'invalid base64 wrote nothing').toBe('keep-me');
  expect(errors, 'no page error').toEqual([]);

  // Positive control: a valid write right after still lands.
  await emitOsc52(win, Buffer.from('after-bad', 'utf8').toString('base64'), 'bel');
  await expect.poll(() => readClipboard(app), { timeout: 8000 }).toBe('after-bad');
});

test('AC-T6: a payload over 1 MiB of text is ignored', async () => {
  const { app, win } = f;
  await setClipboardText(app, 'keep-big');
  // 1 MiB + 1 decoded bytes, generated by the shell so the typed command stays short.
  await runInPane(win, RIGHT,
    `printf '\\033]52;c;%s\\a' "$(head -c 1048577 /dev/zero | tr '\\0' 'a' | base64 | tr -d '\\n')"`);
  await sync(win, app, 'bigpayload');
  expect(await readClipboard(app), 'oversize payload wrote nothing').toBe('keep-big');

  // Positive control: a small write after it still lands.
  await emitOsc52(win, Buffer.from('after-big', 'utf8').toString('base64'), 'bel');
  await expect.poll(() => readClipboard(app), { timeout: 8000 }).toBe('after-big');
});

test('AC-T6: an OSC 52 "?" query writes nothing to the clipboard and echoes no reply into the shell', async () => {
  const { app, win } = f;
  await setClipboardText(app, 'secret-viewer-clipboard');
  const writesBefore = (await shellWrites(app, f.right).catch(() => [])).length;
  await emitOsc52(win, '?', 'bel');
  await sync(win, app, 'query');

  expect(await readClipboard(app), 'query did not touch the clipboard').toBe('secret-viewer-clipboard');
  const replies = (await shellWrites(app, f.right)).slice(writesBefore).filter((d) => d.includes('\x1b]52'));
  expect(replies, 'no OSC 52 reply was sent to the pty').toEqual([]);
  const text = await shellOutput(win, PROJECT, f.right);
  expect(text, 'clipboard contents never echoed into the shell').not.toContain('secret-viewer-clipboard');
  expect(text, 'base64 reply not echoed').not.toContain(Buffer.from('secret-viewer-clipboard').toString('base64'));
});

test('AC-T7: Option+drag with mouse tracking on selects text that context-menu Copy puts on the clipboard (macOS)', async () => {
  test.skip(process.platform !== 'darwin', 'Option+drag is the macOS override; Shift+drag elsewhere is existing behaviour');
  const { app, win } = f;
  const tag = marker('ac-t7');
  await runInPane(win, RIGHT, `printf '\\033[2J\\033[H${tag}\\n\\033[?1000h'; cat`);
  await expect.poll(() => shellOutput(win, PROJECT, f.right),
    { timeout: 8000 }).toContain(tag);
  await expect.poll(() => mouseTrackingMode(win), { timeout: 8000, message: 'mouse tracking is on' }).not.toBe('none');
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.focus(); });

  const box = (await screen(win, RIGHT).boundingBox())!;
  const y = box.y + 6; // first terminal row
  const x0 = box.x + 2;
  const x1 = box.x + Math.min(box.width - 4, 200);

  // Control: a plain drag is reported to the app (mouse tracking), so no selection to copy.
  await setClipboardText(app, '');
  await win.mouse.move(x0, y);
  await win.mouse.down();
  await win.mouse.move(x1, y, { steps: 8 });
  await win.mouse.up();
  expect(await mouseTrackingMode(win, 'selection'), 'plain drag under mouse tracking makes no terminal selection').toBe('false');

  // Option+drag forces a terminal selection.
  await win.keyboard.down('Alt');
  await win.mouse.move(x0, y);
  await win.mouse.down();
  await win.mouse.move(x1, y, { steps: 8 });
  await win.mouse.up();
  await win.keyboard.up('Alt');
  expect(await mouseTrackingMode(win, 'selection'), 'Option+drag made a terminal selection').toBe('true');
  // Right-click inside the selection with Option held, so xterm does not report it to the app and clear the selection.
  await screen(win, RIGHT).click({ button: 'right', modifiers: ['Alt'], position: { x: x1 - box.x - 10, y: 6 } });
  await win.getByRole('menuitem', { name: 'Copy', exact: true }).click();
  await expect.poll(async () => (await readClipboard(app)).length, { timeout: 8000, message: 'Option+drag selection was copied' }).toBeGreaterThan(0);
  expect(await readClipboard(app)).toContain(tag.slice(0, 4));
  await interrupt(win, RIGHT);
});
