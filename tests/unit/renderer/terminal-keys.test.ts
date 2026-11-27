import { describe, it, expect, vi } from 'vitest';
import {
  createTerminalKeyHandler,
  routeTerminalKey,
  terminalTabAction,
} from '@renderer/terminal-keys';
import { sanitizeTerminalCopy } from '@shared/sanitize-terminal-copy';
import type {
  ShortcutKeyLike,
  ShortcutPlatform,
  TerminalKeyEvent,
  TerminalKeyHandlerDeps,
} from '@renderer/shortcut-contract';

type Mods = Partial<Omit<ShortcutKeyLike, 'key'>>;

const key = (k: string, mods: Mods = {}): ShortcutKeyLike => ({
  key: k,
  type: 'keydown',
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});

const ctrl = (k: string, mods: Mods = {}): ShortcutKeyLike => key(k, { ctrlKey: true, ...mods });
const ctrlShift = (k: string): ShortcutKeyLike => ctrl(k, { shiftKey: true });

describe('routeTerminalKey on other platforms', () => {
  it.each(['r', 'p', 'b', 't', 'c', '\\', 'a', 'd', 'l', 'u', 'w', 'z'])(
    'sends unshifted Ctrl+%s to the shell (AC10)',
    (k) => {
      expect(routeTerminalKey(ctrl(k), 'linux')).toBe('shell');
    },
  );

  it.each(['k', 'K'])(
    'routes unshifted Ctrl+%s to the app so the palette opens from a terminal',
    (k) => {
      expect(routeTerminalKey(ctrl(k), 'linux')).toBe('app');
    },
  );

  it('sends upper-case-reported unshifted Ctrl letters to the shell', () => {
    expect(routeTerminalKey(ctrl('R'), 'linux')).toBe('shell');
  });

  it.each(['P', 'K', 'O', 'N', 'T', 'F', 'A', 'p', 'k', 'o', 'n', 't', 'f', 'a'])(
    'routes Ctrl+Shift+%s to the app (AC11)',
    (k) => {
      expect(routeTerminalKey(ctrlShift(k), 'linux')).toBe('app');
    },
  );

  it.each([',', '/', '=', '-', '0'])('routes Ctrl+%s to the app (AC11)', (k) => {
    expect(routeTerminalKey(ctrl(k), 'linux')).toBe('app');
  });

  it('routes Ctrl++ (reported shifted or not) to the app', () => {
    expect(routeTerminalKey(ctrl('+'), 'linux')).toBe('app');
    expect(routeTerminalKey(ctrl('+', { shiftKey: true }), 'linux')).toBe('app');
  });

  it('takes unshifted Ctrl+F for terminal find (AC11/AC12)', () => {
    expect(routeTerminalKey(ctrl('f'), 'linux')).toBe('app');
    expect(routeTerminalKey(ctrl('F'), 'linux')).toBe('app');
  });

  it('routes Ctrl+Shift+C to copy and Ctrl+Shift+V to paste', () => {
    expect(routeTerminalKey(ctrlShift('C'), 'linux')).toBe('copy');
    expect(routeTerminalKey(ctrlShift('c'), 'linux')).toBe('copy');
    expect(routeTerminalKey(ctrlShift('V'), 'linux')).toBe('paste');
  });

  it('leaves keys xterm still maps, and other shifted chords, to default', () => {
    expect(routeTerminalKey(ctrl('['), 'linux')).toBe('default');
    expect(routeTerminalKey(ctrl('3'), 'linux')).toBe('default');
    expect(routeTerminalKey(ctrl('_', { shiftKey: true }), 'linux')).toBe('default');
    expect(routeTerminalKey(ctrlShift('R'), 'linux')).toBe('default');
  });

  it('leaves plain, shifted and Alt keys to default', () => {
    expect(routeTerminalKey(key('k'), 'linux')).toBe('default');
    expect(routeTerminalKey(key('K', { shiftKey: true }), 'linux')).toBe('default');
    expect(routeTerminalKey(key('Enter'), 'linux')).toBe('default');
    expect(routeTerminalKey(key('b', { altKey: true }), 'linux')).toBe('default');
    expect(routeTerminalKey(ctrl('b', { altKey: true }), 'linux')).toBe('default');
    expect(routeTerminalKey(ctrl('f', { altKey: true }), 'linux')).toBe('default');
  });

  it('does not treat Super as a modifier', () => {
    expect(routeTerminalKey(key('k', { metaKey: true }), 'linux')).toBe('default');
    expect(routeTerminalKey(key('f', { metaKey: true }), 'linux')).toBe('default');
    expect(routeTerminalKey(key('C', { metaKey: true, shiftKey: true }), 'linux')).toBe('default');
    expect(routeTerminalKey(ctrl('k', { metaKey: true }), 'linux')).toBe('default');
  });
});

describe('routeTerminalKey on mac (AC14)', () => {
  it('routes ⌘F to the app', () => {
    expect(routeTerminalKey(key('f', { metaKey: true }), 'mac')).toBe('app');
  });

  it.each(['k', 'r', 'c', 'f', 'b', '\\'])('leaves Ctrl+%s to xterm (default)', (k) => {
    expect(routeTerminalKey(ctrl(k), 'mac')).toBe('default');
  });

  it('leaves every other chord, including the Linux copy/paste chords, to default', () => {
    expect(routeTerminalKey(key('k', { metaKey: true }), 'mac')).toBe('default');
    expect(routeTerminalKey(key('F', { metaKey: true, shiftKey: true }), 'mac')).toBe('default');
    expect(routeTerminalKey(ctrlShift('C'), 'mac')).toBe('default');
    expect(routeTerminalKey(ctrlShift('V'), 'mac')).toBe('default');
    expect(routeTerminalKey(ctrlShift('P'), 'mac')).toBe('default');
    expect(routeTerminalKey(key('f', { metaKey: true, ctrlKey: true }), 'mac')).toBe('default');
  });
});

interface Harness {
  readonly deps: TerminalKeyHandlerDeps;
  readonly writeClipboard: ReturnType<typeof vi.fn>;
  readonly readClipboard: ReturnType<typeof vi.fn>;
  readonly paste: ReturnType<typeof vi.fn>;
  readonly onClipboardError: ReturnType<typeof vi.fn>;
}

function harness(
  opts: {
    platform?: ShortcutPlatform;
    selection?: string;
    writeError?: Error;
    clipboard?: string;
    readError?: Error;
  } = {},
): Harness {
  const selection = opts.selection ?? '';
  const writeClipboard = vi.fn(() =>
    opts.writeError ? Promise.reject(opts.writeError) : Promise.resolve(),
  );
  const readClipboard = vi.fn(() =>
    opts.readError ? Promise.reject(opts.readError) : Promise.resolve(opts.clipboard ?? ''),
  );
  const paste = vi.fn();
  const onClipboardError = vi.fn();
  const deps: TerminalKeyHandlerDeps = {
    platform: opts.platform ?? 'linux',
    hasSelection: () => selection.length > 0,
    getSelection: () => selection,
    writeClipboard,
    readClipboard,
    paste,
    onClipboardError,
  };
  return { deps, writeClipboard, readClipboard, paste, onClipboardError };
}

const event = (
  base: ShortcutKeyLike,
  type = 'keydown',
): TerminalKeyEvent & { preventDefault: ReturnType<typeof vi.fn<() => void>> } => ({
  ...base,
  type,
  preventDefault: vi.fn<() => void>(),
});

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('createTerminalKeyHandler', () => {
  it('lets xterm process shell and default keys (returns true) without preventDefault', () => {
    const h = harness();
    const handler = createTerminalKeyHandler(h.deps);
    for (const e of [event(ctrl('r')), event(ctrl('\\')), event(key('a')), event(ctrl('['))]) {
      expect(handler(e)).toBe(true);
      expect(e.preventDefault).not.toHaveBeenCalled();
    }
  });

  it('skips app keys (returns false) so no ^F reaches the PTY, and leaves the event to bubble (AC12)', () => {
    const h = harness();
    const handler = createTerminalKeyHandler(h.deps);
    for (const e of [
      event(ctrl('f')),
      event(ctrl('k')),
      event(ctrlShift('F')),
      event(ctrlShift('P')),
      event(ctrl('=')),
    ]) {
      expect(handler(e)).toBe(false);
      expect(e.preventDefault).not.toHaveBeenCalled();
    }
    expect(h.writeClipboard).not.toHaveBeenCalled();
    expect(h.paste).not.toHaveBeenCalled();
  });

  it('copies exactly the sanitised selection on Ctrl+Shift+C, sending nothing to the PTY (AC15)', async () => {
    const raw = 'ls -la  ​  \r\nnext line   ';
    const h = harness({ selection: raw });
    const e = event(ctrlShift('C'));
    expect(createTerminalKeyHandler(h.deps)(e)).toBe(false);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(h.writeClipboard).toHaveBeenCalledTimes(1);
    expect(h.writeClipboard).toHaveBeenCalledWith(sanitizeTerminalCopy(raw));
    await flush();
    expect(h.paste).not.toHaveBeenCalled();
    expect(h.onClipboardError).not.toHaveBeenCalled();
  });

  it('reports a failed clipboard write once as a copy error (AC15)', async () => {
    const err = new Error('denied');
    const h = harness({ selection: 'text', writeError: err });
    createTerminalKeyHandler(h.deps)(event(ctrlShift('C')));
    await flush();
    expect(h.onClipboardError).toHaveBeenCalledTimes(1);
    expect(h.onClipboardError).toHaveBeenCalledWith('copy', err);
  });

  it('does nothing on Ctrl+Shift+C with no selection, but still keeps the key from the PTY (AC16)', async () => {
    const h = harness({ selection: '' });
    const e = event(ctrlShift('C'));
    expect(createTerminalKeyHandler(h.deps)(e)).toBe(false);
    await flush();
    expect(h.writeClipboard).not.toHaveBeenCalled();
    expect(h.paste).not.toHaveBeenCalled();
    expect(h.onClipboardError).not.toHaveBeenCalled();
  });

  it('pastes the clipboard exactly once through deps.paste and prevents the native paste (AC17)', async () => {
    const h = harness({ clipboard: 'echo hi\n' });
    const e = event(ctrlShift('V'));
    expect(createTerminalKeyHandler(h.deps)(e)).toBe(false);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    await flush();
    expect(h.readClipboard).toHaveBeenCalledTimes(1);
    expect(h.paste).toHaveBeenCalledTimes(1);
    expect(h.paste).toHaveBeenCalledWith('echo hi\n');
    expect(h.writeClipboard).not.toHaveBeenCalled();
    expect(h.onClipboardError).not.toHaveBeenCalled();
  });

  it('reports a failed clipboard read once as a paste error and pastes nothing (AC17)', async () => {
    const err = new Error('no permission');
    const h = harness({ readError: err });
    createTerminalKeyHandler(h.deps)(event(ctrlShift('V')));
    await flush();
    expect(h.paste).not.toHaveBeenCalled();
    expect(h.onClipboardError).toHaveBeenCalledTimes(1);
    expect(h.onClipboardError).toHaveBeenCalledWith('paste', err);
  });

  it('keeps Ctrl+C as SIGINT with a selection: xterm processes it and nothing is copied (AC18)', async () => {
    const h = harness({ selection: 'selected' });
    const e = event(ctrl('c'));
    expect(createTerminalKeyHandler(h.deps)(e)).toBe(true);
    expect(e.preventDefault).not.toHaveBeenCalled();
    await flush();
    expect(h.writeClipboard).not.toHaveBeenCalled();
  });

  it.each(['keyup', 'keypress'])('skips copy/paste on %s without acting', async (type) => {
    const h = harness({ selection: 'x', clipboard: 'y' });
    const handler = createTerminalKeyHandler(h.deps);
    expect(handler(event(ctrlShift('C'), type))).toBe(false);
    expect(handler(event(ctrlShift('V'), type))).toBe(false);
    await flush();
    expect(h.writeClipboard).not.toHaveBeenCalled();
    expect(h.readClipboard).not.toHaveBeenCalled();
    expect(h.paste).not.toHaveBeenCalled();
  });

  it('treats an event without a type as a keydown', async () => {
    const h = harness({ clipboard: 'z' });
    const e = { ...ctrlShift('V'), type: undefined, preventDefault: vi.fn() };
    expect(createTerminalKeyHandler(h.deps)(e)).toBe(false);
    await flush();
    expect(h.paste).toHaveBeenCalledTimes(1);
  });

  it('returns the keydown verdict on keyup for shell and app keys', () => {
    const handler = createTerminalKeyHandler(harness().deps);
    expect(handler(event(ctrl('r'), 'keyup'))).toBe(true);
    expect(handler(event(ctrl('f'), 'keyup'))).toBe(false);
  });

  it('on mac leaves Ctrl+Shift+C/V to xterm and skips ⌘F', async () => {
    const h = harness({ platform: 'mac', selection: 'x', clipboard: 'y' });
    const handler = createTerminalKeyHandler(h.deps);
    expect(handler(event(ctrlShift('C')))).toBe(true);
    expect(handler(event(ctrlShift('V')))).toBe(true);
    expect(handler(event(key('f', { metaKey: true })))).toBe(false);
    await flush();
    expect(h.writeClipboard).not.toHaveBeenCalled();
    expect(h.paste).not.toHaveBeenCalled();
  });
});

describe.each([
  { platform: 'linux' as const, mod: { ctrlKey: true }, wrong: { metaKey: true } },
  { platform: 'mac' as const, mod: { metaKey: true }, wrong: { ctrlKey: true } },
])('terminalTabAction on $platform', ({ platform, mod, wrong }) => {
  it.each([
    ['f', false, 'find'],
    ['=', false, 'zoom-in'],
    ['+', false, 'zoom-in'],
    ['+', true, 'zoom-in'],
    ['-', false, 'zoom-out'],
    ['0', false, 'zoom-reset'],
  ] as const)('maps mod+%s (shift=%s) to %s', (k, shiftKey, action) => {
    expect(terminalTabAction(key(k, { ...mod, shiftKey }), platform)).toBe(action);
  });

  it.each(['f', '=', '+', '-', '0'])(
    'ignores %s with only the other modifier, or with none',
    (k) => {
      expect(terminalTabAction(key(k, wrong), platform)).toBeNull();
      expect(terminalTabAction(key(k), platform)).toBeNull();
    },
  );

  it('leaves mod+Shift+F to Find in project and Alt chords alone (AC12)', () => {
    expect(terminalTabAction(key('F', { ...mod, shiftKey: true }), platform)).toBeNull();
    expect(terminalTabAction(key('f', { ...mod, altKey: true }), platform)).toBeNull();
    expect(terminalTabAction(key('k', mod), platform)).toBeNull();
  });
});

describe('routeTerminalKey on Windows (METAI-7)', () => {
  it('routes plain Ctrl+V to paste — Windows Terminal convention', () => {
    expect(routeTerminalKey(ctrl('v'), 'win')).toBe('paste');
  });

  it('still routes Ctrl+Shift+V to paste so Linux muscle memory keeps working', () => {
    expect(routeTerminalKey(ctrlShift('v'), 'win')).toBe('paste');
  });

  it('routes plain Ctrl+C to copy-or-shell — the handler picks copy vs ^C by selection', () => {
    expect(routeTerminalKey(ctrl('c'), 'win')).toBe('copy-or-shell');
  });

  it('still routes Ctrl+Shift+C to copy outright', () => {
    expect(routeTerminalKey(ctrlShift('c'), 'win')).toBe('copy');
  });

  it('every other Ctrl+letter stays with the shell, same as Linux', () => {
    for (const k of ['a', 'd', 'l', 'u', 'w']) {
      expect(routeTerminalKey(ctrl(k), 'win')).toBe('shell');
    }
  });

  it('app chords (Ctrl+F find, Ctrl+K palette, Ctrl+J) still escape to the app', () => {
    expect(routeTerminalKey(ctrl('f'), 'win')).toBe('app');
    expect(routeTerminalKey(ctrl('k'), 'win')).toBe('app');
    expect(routeTerminalKey(ctrl('j'), 'win')).toBe('app');
  });

  it('Ctrl without a chord goes to default so plain modifier taps do nothing weird', () => {
    expect(routeTerminalKey(key('Control', { ctrlKey: true }), 'win')).toBe('default');
  });
});

describe('createTerminalKeyHandler on Windows (METAI-7)', () => {
  it('plain Ctrl+C with a selection copies the selection and prevents default', () => {
    const h = harness({ platform: 'win', selection: 'hello' });
    const handler = createTerminalKeyHandler(h.deps);
    const e = event(ctrl('c'));
    const result = handler(e);
    expect(result).toBe(false);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(h.writeClipboard).toHaveBeenCalledWith(sanitizeTerminalCopy('hello'));
  });

  it('plain Ctrl+C with no selection returns true so xterm sends ^C to the shell', () => {
    const h = harness({ platform: 'win', selection: '' });
    const handler = createTerminalKeyHandler(h.deps);
    const e = event(ctrl('c'));
    const result = handler(e);
    expect(result).toBe(true);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(h.writeClipboard).not.toHaveBeenCalled();
  });

  it('plain Ctrl+V pastes the clipboard and prevents default', async () => {
    const h = harness({ platform: 'win', clipboard: 'pasted text' });
    const handler = createTerminalKeyHandler(h.deps);
    const e = event(ctrl('v'));
    handler(e);
    await flush();
    expect(e.preventDefault).toHaveBeenCalled();
    expect(h.paste).toHaveBeenCalledWith('pasted text');
  });
});
