import { describe, it, expect, vi, afterEach } from 'vitest';
import { Terminal } from '@xterm/headless';
import { PtyManager } from '@main/pty/manager';
import { ScreenMirror } from '@main/pty/screen-mirror';

const COLS = 80;
const ROWS = 24;

function nodeLaunch(script: string) {
  return { argv: ['node', '-e', script], env: {}, cwd: process.cwd(), variant: 'first' as const };
}

/** Collects every data event for one project and resolves once `match` has been seen. */
function collect(
  mgr: PtyManager,
  projectId: number,
): { all: () => string; until: (match: string, timeoutMs?: number) => Promise<void> } {
  let buf = '';
  const waiters: Array<{ match: string; done: () => void }> = [];
  mgr.on('data', ({ projectId: pid, data }: { projectId: number; data: string }) => {
    if (pid !== projectId) return;
    buf += data;
    for (const w of waiters.filter((x) => buf.includes(x.match))) w.done();
  });
  return {
    all: () => buf,
    until: (match, timeoutMs = 10_000) =>
      new Promise<void>((res, rej) => {
        if (buf.includes(match)) {
          res();
          return;
        }
        const timer = setTimeout(
          () =>
            rej(new Error(`timeout waiting for ${JSON.stringify(match)}; got ${buf.length} bytes`)),
          timeoutMs,
        );
        waiters.push({
          match,
          done: () => {
            clearTimeout(timer);
            res();
          },
        });
      }),
  };
}

/** Resolves on the first exit event for `projectId`, ignoring late exits of other tests' shells. */
function exitOf(mgr: PtyManager, projectId: number): Promise<void> {
  return new Promise<void>((res) => {
    const onExit = ({ projectId: pid }: { projectId: number }) => {
      if (pid !== projectId) return;
      mgr.off('exit', onExit);
      res();
    };
    mgr.on('exit', onExit);
  });
}

/** The mirror instance whose `write` spy saw `marker`, so assertions ignore other tests' mirrors. */
function mirrorThatReceived(
  writes: { mock: { calls: unknown[][]; contexts: unknown[] } },
  marker: string,
): unknown {
  const i = writes.mock.calls.findIndex(([data]) => String(data).includes(marker));
  expect(i).toBeGreaterThanOrEqual(0);
  return writes.mock.contexts[i];
}

/** Feeds `chunks` in order into a fresh headless terminal, resizing between chunks where asked. */
async function render(
  cols: number,
  rows: number,
  ...steps: Array<string | { cols: number; rows: number }>
): Promise<Terminal> {
  const term = new Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true });
  for (const step of steps) {
    if (typeof step === 'string') await new Promise<void>((r) => term.write(step, r));
    else term.resize(step.cols, step.rows);
  }
  return term;
}

function screenLines(term: Terminal): string[] {
  const buf = term.buffer.active;
  const out: string[] = [];
  for (let y = 0; y < term.rows; y++)
    out.push(buf.getLine(buf.baseY + y)?.translateToString(true) ?? '');
  return out;
}

/** Every line of the active buffer (scrollback + screen) with each cell's char and SGR state, plus cursor. */
function fullSignature(term: Terminal): string[] {
  const buf = term.buffer.active;
  const out: string[] = [];
  const cell = buf.getNullCell();
  for (let y = 0; y < buf.length; y++) {
    const line = buf.getLine(y);
    if (!line) continue;
    let sig = '';
    for (let x = 0; x < term.cols; x++) {
      line.getCell(x, cell);
      sig += `${cell.getChars() || ' '}${cell.getFgColorMode()}:${cell.getFgColor()}/${cell.getBgColorMode()}:${cell.getBgColor()}${cell.isBold()}${cell.isUnderline()}|`;
    }
    out.push(sig);
  }
  out.push(`cursor=${buf.cursorX},${buf.cursorY} base=${buf.baseY}`);
  return out;
}

const HEADLINE_SCRIPT = `
const R = ${ROWS};
let s = '\\x1b[2J\\x1b[H';
s += '\\x1b[' + (R - 3) + ';1H+' + '-'.repeat(20) + '+ BOX-TOP';
s += '\\x1b[' + (R - 2) + ';1H| > PROMPT-INPUT       |';
s += '\\x1b[' + (R - 1) + ';1H+' + '-'.repeat(20) + '+ BOX-BOTTOM';
s += '\\x1b[' + R + ';1HSTATUS-LINE model=opus';
s += '\\x1b[1;' + (R - 4) + 'r\\x1b[' + (R - 4) + ';1H';
process.stdout.write(s);
const line = 'scroll-region-output-'.padEnd(70, 'x');
let bulk = '';
for (let i = 0; i < 4500; i++) bulk += '\\n' + String(i).padStart(5, '0') + line;
process.stdout.write(bulk + '\\nHEADLINE-DONE', () => setTimeout(() => {}, 20000));
`;

const COLOUR_SCRIPT = `
let s = '';
for (let i = 0; i < 40; i++) s += '\\x1b[31mRED' + i + '\\x1b[0m plain \\x1b[1;32mBOLDGREEN\\x1b[0m \\x1b[48;5;208mBG208\\x1b[0m \\x1b[4mUNDER\\x1b[0m\\n';
process.stdout.write(s + '\\x1b[38;2;10;20;30mTRUECOLOUR\\x1b[0m COLOUR-DONE', () => setTimeout(() => {}, 20000));
`;

const RESIZE_SCRIPT = `
process.stdout.write('before-resize ' + process.stdout.columns + 'x' + process.stdout.rows + '\\nPRE-DONE');
process.stdout.on('resize', () => {
  const c = process.stdout.columns, r = process.stdout.rows;
  process.stdout.write('\\n' + 'W'.repeat(110) + '\\x1b[' + r + ';1HRESIZED-STATUS ' + c + 'x' + r + '\\x1b[5;7HPOST-DONE');
});
setTimeout(() => {}, 20000);
`;

describe('PtyManager.getSnapshot', () => {
  const mgr = new PtyManager();

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const s of mgr.list()) await mgr.kill(s.projectId, s.shellIndex);
  });

  it('keeps a once-drawn status line and box after >256 KiB of scroll-region output', async () => {
    const out = collect(mgr, 101);
    mgr.resize(101, 0, COLS, ROWS);
    await mgr.spawn(101, 0, nodeLaunch(HEADLINE_SCRIPT));
    await out.until('HEADLINE-DONE', 20_000);
    expect(out.all().length).toBeGreaterThan(256 * 1024);

    const replay = await render(COLS, ROWS, await mgr.getSnapshot(101, 0));
    const lines = screenLines(replay);

    expect(lines[ROWS - 1]).toContain('STATUS-LINE model=opus');
    expect(lines[ROWS - 4]).toContain('BOX-TOP');
    expect(lines[ROWS - 3]).toContain('| > PROMPT-INPUT       |');
    expect(lines[ROWS - 2]).toContain('BOX-BOTTOM');
    expect(lines[ROWS - 5]).toContain('HEADLINE-DONE');
    expect(lines[ROWS - 6]).toContain('04499scroll-region-output-');
  }, 30_000);

  it('round-trips plain coloured shell output cell for cell, including cursor', async () => {
    const out = collect(mgr, 102);
    mgr.resize(102, 0, COLS, ROWS);
    await mgr.spawn(102, 0, nodeLaunch(COLOUR_SCRIPT));
    await out.until('COLOUR-DONE');

    const snapshot = await mgr.getSnapshot(102, 0);
    const reference = await render(COLS, ROWS, out.all());
    const replay = await render(COLS, ROWS, snapshot);

    expect(fullSignature(replay)).toEqual(fullSignature(reference));
    const cell = replay.buffer.active.getLine(replay.buffer.active.length - 1)?.getCell(0);
    expect(cell?.getChars()).toBe('T');
    expect(cell?.isFgRGB()).toBe(true);
    expect(cell?.getFgColor()).toBe((10 << 16) | (20 << 8) | 30);
  });

  it('follows resize so a snapshot taken after it replays correctly at the new size', async () => {
    const out = collect(mgr, 103);
    mgr.resize(103, 0, COLS, ROWS);
    await mgr.spawn(103, 0, nodeLaunch(RESIZE_SCRIPT));
    await out.until('PRE-DONE');
    const pre = out.all();
    mgr.resize(103, 0, 120, 30);
    await out.until('POST-DONE');
    const post = out.all().slice(pre.length);

    const reference = await render(COLS, ROWS, pre, { cols: 120, rows: 30 }, post);
    const replay = await render(120, 30, await mgr.getSnapshot(103, 0));
    const lines = screenLines(replay);

    expect(lines[29]).toContain('RESIZED-STATUS 120x30');
    expect(lines.some((l) => l === 'W'.repeat(110))).toBe(true);
    expect(fullSignature(replay)).toEqual(fullSignature(reference));
  });

  it('returns an empty string for an unknown shell', async () => {
    await expect(mgr.getSnapshot(999, 7)).resolves.toBe('');
  });

  it('returns an empty string once the shell has exited', async () => {
    const exited = exitOf(mgr, 104);
    await mgr.spawn(104, 0, nodeLaunch('process.stdout.write("bye")'));
    await exited;
    await expect(mgr.getSnapshot(104, 0)).resolves.toBe('');
  });

  it('disposes the headless terminal on kill', async () => {
    const dispose = vi.spyOn(ScreenMirror.prototype, 'dispose');
    const writes = vi.spyOn(ScreenMirror.prototype, 'write');
    const out = collect(mgr, 105);
    await mgr.spawn(
      105,
      0,
      nodeLaunch('process.stdout.write("KILL-ME"); setTimeout(() => {}, 20000)'),
    );
    await out.until('KILL-ME');
    await mgr.kill(105, 0);
    expect(dispose.mock.contexts).toContain(mirrorThatReceived(writes, 'KILL-ME'));
    await expect(mgr.getSnapshot(105, 0)).resolves.toBe('');
  });

  it('disposes the headless terminal when the shell exits on its own', async () => {
    const dispose = vi.spyOn(ScreenMirror.prototype, 'dispose');
    const writes = vi.spyOn(ScreenMirror.prototype, 'write');
    const exited = exitOf(mgr, 106);
    await mgr.spawn(106, 0, nodeLaunch('process.stdout.write("EXIT-ALONE")'));
    await exited;
    expect(dispose.mock.contexts).toContain(mirrorThatReceived(writes, 'EXIT-ALONE'));
  });

  it('emits data before the headless terminal parses it', async () => {
    const order: string[] = [];
    vi.spyOn(ScreenMirror.prototype, 'write').mockImplementation((data: string) => {
      if (data.includes('ORDER')) order.push('mirror');
    });
    const out = collect(mgr, 107);
    mgr.on('data', ({ projectId }: { projectId: number }) => {
      if (projectId === 107) order.push('emit');
    });
    await mgr.spawn(
      107,
      0,
      nodeLaunch('process.stdout.write("ORDER"); setTimeout(() => {}, 20000)'),
    );
    await out.until('ORDER');
    expect(order.slice(0, 2)).toEqual(['emit', 'mirror']);
  });

  it('keeps a respawned shell and its terminal when the killed predecessor exits late', async () => {
    const oldExit = exitOf(mgr, 109);
    const first = collect(mgr, 109);
    await mgr.spawn(
      109,
      0,
      nodeLaunch(
        'process.on("SIGHUP", () => setTimeout(() => process.exit(0), 400)); process.stdout.write("FIRST-LIFE"); setTimeout(() => {}, 20000)',
      ),
    );
    await first.until('FIRST-LIFE');
    await mgr.kill(109, 0);
    const out = collect(mgr, 109);
    await mgr.spawn(
      109,
      0,
      nodeLaunch('process.stdout.write("SECOND-LIFE"); setTimeout(() => {}, 20000)'),
    );
    await oldExit;
    await out.until('SECOND-LIFE');
    expect(mgr.isAlive(109, 0)).toBe(true);
    expect(await mgr.getSnapshot(109, 0)).toContain('SECOND-LIFE');
  });

  it('keeps the raw rolling scrollback intact alongside the snapshot', async () => {
    const out = collect(mgr, 108);
    await mgr.spawn(
      108,
      0,
      nodeLaunch('process.stdout.write("\\x1b[31mRAW-TAIL\\x1b[0m"); setTimeout(() => {}, 20000)'),
    );
    await out.until('RAW-TAIL');
    expect(mgr.getScrollback(108, 0)).toBe(out.all());
  });
});

describe('ScreenMirror', () => {
  it('serializes pending writes, not just what was parsed so far', async () => {
    const m = new ScreenMirror(20, 5);
    m.write('\x1b[33mhello\x1b[0m');
    const replay = await render(20, 5, await m.snapshot());
    expect(screenLines(replay)[0]).toBe('hello');
    m.dispose();
  });

  it('resolves pending snapshots with an empty string when disposed, and later ones too', async () => {
    const m = new ScreenMirror(20, 5);
    m.write('x'.repeat(10_000));
    const pending = m.snapshot();
    m.dispose();
    await expect(pending).resolves.toBe('');
    await expect(m.snapshot()).resolves.toBe('');
    expect(() => m.write('ignored')).not.toThrow();
    expect(() => m.resize(30, 6)).not.toThrow();
    expect(() => m.dispose()).not.toThrow();
  });

  it('keeps at most 5000 lines of scrollback', async () => {
    const m = new ScreenMirror(20, 5);
    m.write(Array.from({ length: 6000 }, (_, i) => `L${i}`).join('\r\n'));
    const replay = await render(20, 5, await m.snapshot());
    const buf = replay.buffer.active;
    expect(buf.length).toBe(5005);
    expect(buf.getLine(0)?.translateToString(true)).toBe('L995');
    m.dispose();
  });
});
