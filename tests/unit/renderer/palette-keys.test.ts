import { describe, it, expect } from 'vitest';
import { paletteKeyAction } from '@renderer/palette-keys';
import type { PaletteKeyEvent } from '@renderer/command-palette-contract';

const key = (k: string, mods: Partial<Omit<PaletteKeyEvent, 'key'>> = {}): PaletteKeyEvent => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});

describe('paletteKeyAction', () => {
  it.each([false, true])('toggles on Cmd+K (open=%s)', (isOpen) => {
    expect(paletteKeyAction(key('k', { metaKey: true }), isOpen)).toEqual({ kind: 'toggle' });
  });

  it.each([false, true])(
    'opens with ">" on Cmd+Shift+P whatever case the key reports (open=%s)',
    (isOpen) => {
      expect(paletteKeyAction(key('P', { metaKey: true, shiftKey: true }), isOpen)).toEqual({
        kind: 'open',
        seed: '>',
      });
      expect(paletteKeyAction(key('p', { metaKey: true, shiftKey: true }), isOpen)).toEqual({
        kind: 'open',
        seed: '>',
      });
    },
  );

  it.each([false, true])('opens with "@" on Cmd+P (open=%s)', (isOpen) => {
    expect(paletteKeyAction(key('p', { metaKey: true }), isOpen)).toEqual({
      kind: 'open',
      seed: '@',
    });
  });

  it('treats Option chords as non-palette keys: Cmd+Option+K / Cmd+Option+P pass while closed, are swallowed while open', () => {
    for (const k of ['k', 'p', 'P']) {
      const e = key(k, { metaKey: true, altKey: true, shiftKey: k === 'P' });
      expect(paletteKeyAction(e, false), k).toEqual({ kind: 'pass' });
      expect(paletteKeyAction(e, true), k).toEqual({ kind: 'swallow' });
    }
  });

  it('leaves Cmd+Shift+K to the prompt library', () => {
    expect(paletteKeyAction(key('k', { metaKey: true, shiftKey: true }), false)).toEqual({
      kind: 'pass',
    });
    expect(paletteKeyAction(key('K', { metaKey: true, shiftKey: true }), false)).toEqual({
      kind: 'pass',
    });
  });

  it.each([',', 'n', 'N', 'f', 'F', 'O', '/', 'b', 't', 'T', '\\'])(
    'swallows the other mod-chord Cmd+%s while open',
    (k) => {
      expect(
        paletteKeyAction(key(k, { metaKey: true, shiftKey: k !== k.toLowerCase() }), true),
      ).toEqual({ kind: 'swallow' });
    },
  );

  it('swallows Cmd+Shift+K while open so the prompt library cannot stack on the palette', () => {
    expect(paletteKeyAction(key('K', { metaKey: true, shiftKey: true }), true)).toEqual({
      kind: 'swallow',
    });
  });

  it.each([',', 'n', 'f', '/', 'b', 't'])('passes Cmd+%s while closed', (k) => {
    expect(paletteKeyAction(key(k, { metaKey: true }), false)).toEqual({ kind: 'pass' });
  });

  it.each([false, true])('passes plain keys (open=%s)', (isOpen) => {
    for (const k of ['k', 'p', 'P', 'Escape', 'Enter', 'ArrowDown', 'a']) {
      expect(paletteKeyAction(key(k), isOpen)).toEqual({ kind: 'pass' });
    }
    expect(paletteKeyAction(key('P', { shiftKey: true }), isOpen)).toEqual({ kind: 'pass' });
    expect(paletteKeyAction(key('k', { altKey: true }), isOpen)).toEqual({ kind: 'pass' });
  });
});

describe('paletteKeyAction defaults to the runtime platform (mac under node)', () => {
  it('matches an explicit mac call', () => {
    expect(paletteKeyAction(key('k', { metaKey: true }), false)).toEqual(
      paletteKeyAction(key('k', { metaKey: true }), false, 'mac'),
    );
    expect(paletteKeyAction(key('k', { ctrlKey: true }), false)).toEqual({ kind: 'pass' });
  });
});

describe('paletteKeyAction on mac ignores Ctrl (AC2)', () => {
  it.each([false, true])(
    'passes Ctrl+K, Ctrl+P, Ctrl+Shift+P and other Ctrl chords (open=%s)',
    (isOpen) => {
      for (const e of [
        key('k', { ctrlKey: true }),
        key('p', { ctrlKey: true }),
        key('P', { ctrlKey: true, shiftKey: true }),
        key('b', { ctrlKey: true }),
        key('k', { ctrlKey: true, metaKey: true }),
      ]) {
        expect(paletteKeyAction(e, isOpen, 'mac'), e.key).toEqual({ kind: 'pass' });
      }
    },
  );
});

describe('paletteKeyAction on other platforms (AC1/AC3)', () => {
  it.each([false, true])('toggles on Ctrl+K (open=%s)', (isOpen) => {
    expect(paletteKeyAction(key('k', { ctrlKey: true }), isOpen, 'linux')).toEqual({
      kind: 'toggle',
    });
  });

  it.each([false, true])('opens with "@" on Ctrl+P (open=%s)', (isOpen) => {
    expect(paletteKeyAction(key('p', { ctrlKey: true }), isOpen, 'linux')).toEqual({
      kind: 'open',
      seed: '@',
    });
  });

  it.each([false, true])(
    'opens with ">" on Ctrl+Shift+P whatever case the key reports (open=%s)',
    (isOpen) => {
      expect(
        paletteKeyAction(key('P', { ctrlKey: true, shiftKey: true }), isOpen, 'linux'),
      ).toEqual({ kind: 'open', seed: '>' });
      expect(
        paletteKeyAction(key('p', { ctrlKey: true, shiftKey: true }), isOpen, 'linux'),
      ).toEqual({ kind: 'open', seed: '>' });
    },
  );

  it.each([',', 'n', 'N', 'f', 'F', 'O', 'K', '/', 'b', 't', 'T', '\\'])(
    'swallows Ctrl+%s while open and passes it while closed',
    (k) => {
      const e = key(k, { ctrlKey: true, shiftKey: k !== k.toLowerCase() });
      expect(paletteKeyAction(e, true, 'linux')).toEqual({ kind: 'swallow' });
      expect(paletteKeyAction(e, false, 'linux')).toEqual({ kind: 'pass' });
    },
  );

  it.each([false, true])('passes Super (Meta) chords, alone or with Ctrl (open=%s)', (isOpen) => {
    for (const e of [
      key('k', { metaKey: true }),
      key('p', { metaKey: true }),
      key('P', { metaKey: true, shiftKey: true }),
      key('b', { metaKey: true }),
      key('k', { metaKey: true, ctrlKey: true }),
    ]) {
      expect(paletteKeyAction(e, isOpen, 'linux'), e.key).toEqual({ kind: 'pass' });
    }
  });
});
