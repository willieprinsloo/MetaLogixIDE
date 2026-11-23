import { Terminal } from '@xterm/headless';
import { expect, it, vi } from 'vitest';
import { terminalBackdrop, watchTerminalBackdrop } from '@renderer/terminal/terminal-backdrop';

it('uses an alternate screen’s uniform truecolor edges, regardless of the center', async () => {
  using terminal = makeTerminal();
  await terminal.write('\x1b[?1049h\x1b[48;2;0;0;0m\x1b[2J\x1b[3;3H\x1b[48;2;102;51;153mX');
  expect(terminalBackdrop(terminal.emulator)).toEqual({ kind: 'rgb', value: 0 });
  await terminal.write('\x1b[48;2;19;57;91m\x1b[2J');
  expect(terminalBackdrop(terminal.emulator)).toEqual({ kind: 'rgb', value: 0x13395b });
});

it('does not guess when an edge differs, and clears on return to the normal screen', async () => {
  using terminal = makeTerminal();
  await terminal.write('\x1b[?1049h');
  expect(terminalBackdrop(terminal.emulator)).toBeUndefined();
  await terminal.write('\x1b[48;2;19;57;91m\x1b[2J\x1b[1;3H\x1b[49mX');
  expect(terminalBackdrop(terminal.emulator)).toBeUndefined();
  await terminal.write('\x1b[?1049l\x1b[48;2;19;57;91m\x1b[2J');
  expect(terminalBackdrop(terminal.emulator)).toBeUndefined();
});

it('detects an extended palette index without treating a palette index as truecolor', async () => {
  using terminal = makeTerminal();
  await terminal.write('\x1b[?1049h\x1b[48;5;232m\x1b[2J');
  expect(terminalBackdrop(terminal.emulator)).toEqual({ kind: 'palette', value: 232 });
  await terminal.write('\x1b[41m\x1b[2J');
  expect(terminalBackdrop(terminal.emulator)).toBeUndefined();
});

it('paints only changes and clears the backdrop when the active renderer is disposed', async () => {
  using terminal = makeTerminal();
  const paint = vi.fn();
  const watcher = watchTerminalBackdrop(terminal.observed, paint);
  expect(paint).not.toHaveBeenCalled();
  await terminal.write('\x1b[?1049h\x1b[48;5;232m\x1b[2J');
  terminal.render();
  terminal.render();
  await Promise.resolve();
  expect(paint.mock.calls).toEqual([['#080808']]);
  await terminal.write('\x1b[?1049l');
  expect(paint.mock.calls).toEqual([['#080808'], [undefined]]);

  await terminal.write('\x1b[?1049h\x1b[48;5;232m\x1b[2J');
  terminal.render();
  await Promise.resolve();
  watcher.dispose();
  expect(terminal.stopRender).toHaveBeenCalledOnce();
  expect(paint.mock.calls).toEqual([['#080808'], [undefined], ['#080808'], [undefined]]);
});

it('does not paint an indexed color that resolves after the alternate screen was left', async () => {
  using terminal = makeTerminal();
  const paint = vi.fn();
  const palette = Promise.withResolvers<number>();
  const readPalette = vi.fn(() => palette.promise);
  const watcher = watchTerminalBackdrop(terminal.observed, paint, { resolvePalette: readPalette });
  await terminal.write('\x1b[?1049h\x1b[48;5;232m\x1b[2J');
  terminal.render();
  expect(readPalette.mock.calls).toEqual([[232]]);
  await terminal.write('\x1b[?1049l');
  palette.resolve(0x123456);
  await palette.promise;
  expect(paint.mock.calls).toEqual([[undefined]]);
  watcher.dispose();
});

function makeTerminal() {
  const emulator = new Terminal({ cols: 5, rows: 5, allowProposedApi: true });
  const stopRender = vi.fn();
  let render: ((range: { start: number; end: number }) => void) | undefined;
  const observed = Object.assign(emulator, {
    onRender(listener: (range: { start: number; end: number }) => void) {
      render = listener;
      return { dispose: stopRender };
    },
  });
  return {
    emulator, observed, stopRender,
    render: () => render?.({ start: 0, end: 4 }),
    write: (data: string) => new Promise<void>(resolve => emulator.write(data, resolve)),
    [Symbol.dispose]: () => emulator.dispose(),
  };
}
