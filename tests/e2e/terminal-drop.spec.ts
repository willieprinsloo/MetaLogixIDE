/**
 * Terminal drag-and-drop, Ghostty-style
 * (docs/specs/2026-10-17-terminal-drag-drop.md AC1, AC3a, AC7, AC8, AC9,
 * AC10, AC11, AC14, AC16, AC19, AC20, AC20a, AC21, AC22). Clipboard paste
 * (AC12, AC12a, AC13) lives in terminal-paste-clipboard.spec.ts, which runs
 * serially because it writes the real OS clipboard (AC13a).
 *
 * Every test launches its own app (helpers/drop.ts `launchDropFixture`): one
 * project, the primary pane switched to a plain `sh` tab, and the split open
 * on a second plain `sh`. Drops are synthetic `DataTransfer`s dispatched on
 * the pane's terminal screen; what reached the PTY is read from a
 * main-process spy on `shells:write`, so bracketed-paste markers are visible
 * byte for byte. A program's bracketed-paste mode is made deterministic by
 * leaving `cat` in the foreground after `printf '\033[?2004h'` (or `l`).
 *
 * Not covered here, by design:
 * - AC6's real-path branch (an OS file whose path `webUtils.getPathForFile`
 *   resolves). A synthetic `File` built in the page never has a path on disk,
 *   and the contextBridge `api` object (`api.pathForFile`) is frozen, so the
 *   branch cannot be stubbed from a test. It is covered by the `planDrop` unit
 *   test with `pathForFile` injected, plus manual check M1.
 * - AC10's "files with paths mixed with files without" for the same reason:
 *   the order test here mixes two pathless files.
 * - AC21's popped-out window: manual check M1. Primary and split are covered.
 * - AC14's clipboard-image half: an over-50 MB clipboard image is not
 *   practical to place on the OS clipboard; unit-tested on the handler.
 * - AC15 (a staging write failing): unit-tested; no test seam reaches the
 *   main-process filesystem without replacing the handler under test.
 */

import { test, expect } from '@playwright/test';
import { readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { APP_FILE_DRAG_TYPE, DROP_COPY, MAX_STAGED_BYTES } from '../../src/shared/terminal-drop-contract';
import { marker, waitForShellOutput } from './helpers/focus';
import {
  BP_END, BP_START, PNG_1X1, PRIMARY, PROJECT, RIGHT,
  channelCalls, detachedDragPrevented, dragEventOn, dropDir, dropOn, expectWrite,
  expectedEscape, holdBracketedPaste, interrupt, launchDropFixture, realDropDir, runInPane, screen, stagedWithPrefix,
  shellTab, shellWrites, unescapePath, writeContaining,
  type DropFixture,
} from './helpers/drop';

async function withFixture(body: (f: DropFixture) => Promise<void>): Promise<void> {
  const f = await launchDropFixture();
  try {
    await body(f);
  } finally {
    await f.app.close();
    f.cleanup();
  }
}

const appFile = (projectId: number, relPath: string) => ({
  type: APP_FILE_DRAG_TYPE,
  payload: JSON.stringify({ projectId, relPath }),
});

/**
 * The staged file an inserted (escaped) path names, checked against the
 * launch's drop directory: a test-mode launch stages into `<userData>/drops`.
 */
function stagedPath(f: DropFixture, escaped: string): string {
  const path = unescapePath(escaped);
  expect(path.startsWith('/'), `inserted staged path is absolute: ${JSON.stringify(escaped)}`).toBe(true);
  expect(realpathSync(dirname(path)), 'staged file sits in the launch\'s <userData>/drops').toBe(realpathSync(dropDir(f)));
  return path;
}

test.describe('terminal drop', () => {
  test('AC1, AC21: a drop is a bracketed paste when the program set 2004, and bare when it did not, in the primary and the split pane', async () => {
    await withFixture(async ({ app, win, left, right }) => {
      for (const [pane, shellIndex] of [[PRIMARY, left], [RIGHT, right]] as const) {
        const onText = marker(`bp-on-${shellIndex}`);
        await holdBracketedPaste(win, pane, true);
        await dropOn(screen(win, pane), { text: onText });
        await expectWrite(app, shellIndex, `${BP_START}${onText}${BP_END}`, `${pane}: drop arrives bracketed with 2004 on`);

        await interrupt(win, pane);
        await holdBracketedPaste(win, pane, false);
        const offText = marker(`bp-off-${shellIndex}`);
        await dropOn(screen(win, pane), { text: offText });
        await expectWrite(app, shellIndex, offText, `${pane}: drop arrives bare with 2004 off`);
        const writes = await shellWrites(app, shellIndex);
        expect(writes.filter((d) => d.includes(offText)), `${pane}: the 2004-off drop is written once, unbracketed`).toEqual([offText]);
        expect(writes.filter((d) => d.includes(onText)), `${pane}: the 2004-on drop is written once`).toHaveLength(1);
      }
    });
  });

  test('AC7: a Files-tree drop inserts the escaped absolute path, whatever the shell\'s working directory', async () => {
    await withFixture(async ({ app, win, left, projectId, projectRoot }) => {
      const relPath = `my file (${marker('ac7')}).txt`;
      writeFileSync(join(projectRoot, relPath), 'fixture\n');
      await runInPane(win, PRIMARY, 'cd /tmp && echo "cwd=$(pwd)"');
      await waitForShellOutput(win, PROJECT, left, 'cwd=/tmp');
      await holdBracketedPaste(win, PRIMARY, false);

      await dropOn(screen(win, PRIMARY), { appFile: appFile(projectId, relPath) });
      const expected = expectedEscape(join(projectRoot, relPath));
      await expectWrite(app, left, expected, 'the Files-tree drop inserts the escaped absolute path');
      expect(expected, 'the expected payload really is escaped (the fixture name has a space and parentheses)').toContain('my\\ file\\ \\(');
    });
  });

  test('AC3a: a Files-tree file whose name contains a newline never puts CR or LF on the PTY with bracketed paste off', async () => {
    test.skip(process.platform === 'win32', 'POSIX only: Windows file names cannot contain LF');
    await withFixture(async ({ app, win, left, projectId, projectRoot }) => {
      const tag = marker('ac3a');
      const relPath = `${tag}\nrm -rf ~.png`;
      writeFileSync(join(projectRoot, relPath), 'fixture\n');
      await holdBracketedPaste(win, PRIMARY, false);

      await dropOn(screen(win, PRIMARY), { appFile: appFile(projectId, relPath) });
      const written = await writeContaining(app, left, tag, 'the newline-named file\'s path reaches the PTY');
      expect(written, 'no LF in the inserted path').not.toContain('\n');
      expect(written, 'no CR in the inserted path').not.toContain('\r');
      expect(written, 'LF became an (escaped) space; the rest of the name is escaped as a path').toBe(
        expectedEscape(join(projectRoot, `${tag} rm -rf ~.png`)),
      );
    });
  });

  test('AC20a: the Files-tree type wins over Files and text/plain in the same drop; the path is inserted once and nothing is staged', async () => {
    await withFixture(async ({ app, win, left, projectId, projectRoot }) => {
      const relPath = `precedence-${marker('ac20a')}.txt`;
      writeFileSync(join(projectRoot, relPath), 'fixture\n');
      await holdBracketedPaste(win, PRIMARY, false);

      await dropOn(screen(win, PRIMARY), {
        appFile: appFile(projectId, relPath),
        files: [{ name: 'decoy.png', type: 'image/png', bytes: [...PNG_1X1] }],
        text: relPath,
      });
      const expected = expectedEscape(join(projectRoot, relPath));
      await expectWrite(app, left, expected, 'the Files-tree path is inserted');
      const mentions = (await shellWrites(app, left)).filter((d) => d.includes(relPath));
      expect(mentions, 'the absolute path is the only write mentioning the file: no second insert of the text/plain relPath').toEqual([expected]);
      expect(await channelCalls(app, 'drops:stage-file'), 'the decoy File was never staged').toEqual([]);
    });
  });

  test('AC8: a text-only drop is inserted verbatim, unquoted and unescaped, with paste line endings', async () => {
    await withFixture(async ({ app, win, left }) => {
      await holdBracketedPaste(win, PRIMARY, false);
      const tag = marker('ac8');
      await dropOn(screen(win, PRIMARY), { text: `echo "a b" ${tag}\nsecond line` });
      await expectWrite(app, left, `echo "a b" ${tag}\rsecond line`, 'text arrives verbatim; LF normalised to CR as a paste does');
    });
  });

  test('AC9, AC10: pathless dropped files are staged with identical bytes, mode 0600, and inserted in drop order', async () => {
    const tag = marker('ac9');
    try {
      await withFixture(async (f) => {
        const { app, win, left } = f;
        await holdBracketedPaste(win, PRIMARY, false);
        const first = `${tag}-a.png`;
        const second = `${tag}-b.png`;
        const secondBytes = [...PNG_1X1, 0x00, 0x01, 0x02];
        await dropOn(screen(win, PRIMARY), {
          files: [
            { name: first, type: 'image/png', bytes: [...PNG_1X1] },
            { name: second, type: 'image/png', bytes: secondBytes },
          ],
        });
        const written = await writeContaining(app, left, tag, 'the staged paths reach the PTY');
        const parts = written.split(/(?<!\\) /);
        expect(parts, `two escaped paths joined by one space: ${JSON.stringify(written)}`).toHaveLength(2);
        const [a, b] = parts.map((part) => stagedPath(f, part)) as [string, string];
        expect(basename(a), 'first dropped file is inserted first').toMatch(new RegExp(`^${tag}-a(-\\d+)?\\.png$`));
        expect(basename(b), 'second dropped file is inserted second').toMatch(new RegExp(`^${tag}-b(-\\d+)?\\.png$`));
        expect([...readFileSync(a)], 'first staged file has the dropped bytes').toEqual([...PNG_1X1]);
        expect([...readFileSync(b)], 'second staged file has the dropped bytes').toEqual(secondBytes);
        if (process.platform !== 'win32') {
          expect(statSync(a).mode & 0o777, 'staged file is owner-only').toBe(0o600);
          expect(statSync(dirname(a)).mode & 0o777, 'drop directory is owner-only').toBe(0o700);
        }
        expect(await channelCalls(app, 'drops:stage-file'), 'one staging call per pathless file').toHaveLength(2);
        // Positive control for the check below: the same directory probe finds both files under <userData>/drops.
        expect(stagedWithPrefix(dropDir(f), tag), 'positive control: both files are staged under <userData>/drops').toHaveLength(2);
        expect(stagedWithPrefix(realDropDir(), tag), `the real ${realDropDir()} is not written by a test-mode run`).toEqual([]);
      });
    } finally {
      // Normally a no-op; if the app regressed into the real directory, never leave tagged files there.
      for (const name of stagedWithPrefix(realDropDir(), tag)) rmSync(join(realDropDir(), name), { force: true });
    }
  });

  test('AC11: a drop with nothing usable inserts nothing, throws nothing and clears the overlay', async () => {
    await withFixture(async ({ app, win, left, pageErrors }) => {
      await holdBracketedPaste(win, PRIMARY, false);
      const before = marker('ac11-before');
      await dropOn(screen(win, PRIMARY), { text: before });
      await expectWrite(app, left, before, 'positive control: a usable drop is written');
      const writesBefore = (await shellWrites(app, left)).length;

      await dropOn(screen(win, PRIMARY), { files: [{ name: 'empty.png', type: 'image/png', bytes: [] }] });
      const after = marker('ac11-after');
      await dropOn(screen(win, PRIMARY), { text: after });
      await expectWrite(app, left, after, 'a later drop is still written');

      expect((await shellWrites(app, left)).slice(writesBefore), 'the empty drop wrote nothing between the two usable drops').toEqual([after]);
      expect(await channelCalls(app, 'drops:stage-file'), 'a zero-byte file is not staged').toEqual([]);
      await expect(win.getByText(DROP_COPY.overlayPath)).toBeHidden();
      await expect(win.getByText(DROP_COPY.overlayText)).toBeHidden();
      expect(pageErrors.map(String), 'no uncaught page error').toEqual([]);
    });
  });

  test('AC14: a pathless file over 50 MB is not staged; an error toast names the limit and nothing is inserted', async () => {
    await withFixture(async ({ app, win, left }) => {
      await holdBracketedPaste(win, PRIMARY, false);
      const writesBefore = (await shellWrites(app, left)).length;
      const name = `${marker('ac14')}.png`;

      await dropOn(screen(win, PRIMARY), { files: [{ name, type: 'image/png', size: MAX_STAGED_BYTES + 1 }] });
      const toast = win.getByTestId('toast').filter({ hasText: DROP_COPY.tooLargeTitle });
      await expect(toast, 'the too-large toast appears').toBeVisible({ timeout: 8000 });
      await expect(toast).toContainText(DROP_COPY.tooLargeDetail(name));

      const after = marker('ac14-after');
      await dropOn(screen(win, PRIMARY), { text: after });
      await expectWrite(app, left, after, 'positive control: a later drop is written');
      expect((await shellWrites(app, left)).slice(writesBefore), 'the oversized drop wrote nothing').toEqual([after]);
      expect(await channelCalls(app, 'drops:stage-file'), 'the oversized bytes never reached staging').toEqual([]);
    });
  });

  test('AC16: dropping onto a terminal whose shell has exited inserts nothing and raises no error', async () => {
    await withFixture(async ({ app, win, left, right, pageErrors }) => {
      const alive = marker('ac16-alive');
      await dropOn(screen(win, RIGHT), { text: alive });
      await expectWrite(app, right, alive, 'positive control: the live shell receives a drop');

      await interrupt(win, RIGHT);
      await runInPane(win, RIGHT, 'exit');
      await expect(win.locator(`${RIGHT} [data-testid="shell-relaunch"]`), 'the shell has exited').toBeVisible({ timeout: 8000 });

      const dead = marker('ac16-dead');
      await dropOn(screen(win, RIGHT), { text: dead });
      const sentinel = marker('ac16-sentinel');
      await dropOn(screen(win, PRIMARY), { text: sentinel });
      await expectWrite(app, left, sentinel, 'a later drop on the live primary pane is written');

      expect((await shellWrites(app, right)).filter((d) => d.includes(dead)), 'nothing was written to the exited shell').toEqual([]);
      expect(pageErrors.map(String), 'no uncaught page error').toEqual([]);
    });
  });

  test('AC19, AC20: the overlay stays up while the drag crosses the terminal\'s children, hides when it leaves, and its wording matches the drag', async () => {
    await withFixture(async ({ win }) => {
      const container = shellTab(win, PRIMARY);
      const inner = screen(win, PRIMARY);
      const pathDrag = { files: [{ name: 'a.png', type: 'image/png', bytes: [1] }] };
      const pathOverlay = win.getByText(DROP_COPY.overlayPath, { exact: true });
      const textOverlay = win.getByText(DROP_COPY.overlayText, { exact: true });

      // Count every time the overlay node is removed while the drag is in progress.
      await container.evaluate((el, label) => {
        const w = window as unknown as { __e2eOverlayRemovals: number };
        w.__e2eOverlayRemovals = 0;
        new MutationObserver((records) => {
          for (const r of records) for (const n of r.removedNodes) if (n.textContent?.includes(label)) w.__e2eOverlayRemovals += 1;
        }).observe(el, { childList: true, subtree: true });
      }, DROP_COPY.overlayPath);

      await dragEventOn(container, 'dragenter', pathDrag);
      await dragEventOn(container, 'dragover', pathDrag);
      await expect(pathOverlay, 'a Files drag shows the path wording').toBeVisible();
      await dragEventOn(inner, 'dragenter', pathDrag);
      await dragEventOn(inner, 'dragover', pathDrag);
      await dragEventOn(container, 'dragleave', pathDrag);
      await expect(pathOverlay, 'crossing into a child keeps the overlay up').toBeVisible();
      expect(await win.evaluate(() => (window as unknown as { __e2eOverlayRemovals: number }).__e2eOverlayRemovals),
        'the overlay never toggled off while the drag stayed over the terminal').toBe(0);
      await dragEventOn(inner, 'dragleave', pathDrag);
      await expect(pathOverlay, 'leaving the terminal hides the overlay').toBeHidden();

      const textDrag = { text: 'echo hi' };
      await dragEventOn(container, 'dragenter', textDrag);
      await dragEventOn(container, 'dragover', textDrag);
      await expect(textOverlay, 'a text-only drag shows the text wording').toBeVisible();
      await expect(pathOverlay).toBeHidden();
      await dragEventOn(container, 'dragleave', textDrag);
      await expect(textOverlay).toBeHidden();
    });
  });

  test('AC22: the guard cancels dragover and drop for file, URL and text drags over the sidebar', async () => {
    await withFixture(async ({ win }) => {
      const sidebar = win.getByTestId('section-all');
      await expect(sidebar).toBeVisible();
      const drags = {
        file: { files: [{ name: 'a.png', type: 'image/png', bytes: [1] }] },
        url: { uriList: 'https://example.com/' },
        text: { text: 'some text' },
      };
      for (const [kind, spec] of Object.entries(drags)) {
        expect(await detachedDragPrevented(win, spec), `positive control (${kind}): an event no app listener sees is not cancelled`)
          .toEqual({ dragoverPrevented: false, dropPrevented: false });
        expect(await dropOn(sidebar, spec), `${kind} drag over the sidebar is cancelled`)
          .toEqual({ dragoverPrevented: true, dropPrevented: true });
      }
    });
  });

  test('AC22: a drag that started in this window keeps its default over the sidebar; an external one is still cancelled', async () => {
    await withFixture(async ({ win }) => {
      const sidebar = win.getByTestId('section-all');
      const source = win.locator('[data-testid="project-row"]').first();
      await expect(sidebar).toBeVisible();
      const spec = { text: 'alpha' };

      expect(await dropOn(sidebar, spec), 'positive control: an external text drag over the sidebar is cancelled')
        .toEqual({ dragoverPrevented: true, dropPrevented: true });

      await dragEventOn(source, 'dragstart', spec);
      expect(await dropOn(sidebar, spec), 'a drag that started in the window is not cancelled by the guard')
        .toEqual({ dragoverPrevented: false, dropPrevented: false });

      expect(await dropOn(sidebar, spec), 'after the in-app drag dropped, the next (external) drag is cancelled again')
        .toEqual({ dragoverPrevented: true, dropPrevented: true });

      await dragEventOn(source, 'dragstart', spec);
      await dragEventOn(source, 'dragend', spec);
      expect(await dropOn(sidebar, spec), 'after an in-app drag ended without a drop, an external drag is cancelled')
        .toEqual({ dragoverPrevented: true, dropPrevented: true });
    });
  });
});
