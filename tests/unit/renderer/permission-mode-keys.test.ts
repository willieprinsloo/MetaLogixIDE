import { describe, it, expect } from 'vitest';
import { classifyDialogKey, nextFocusIndex } from '@renderer/components/permission-mode-keys';

const key = (k: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});

describe('classifyDialogKey', () => {
  it('traps Tab and Shift+Tab', () => {
    expect(classifyDialogKey(key('Tab'))).toBe('cycle-focus');
    expect(classifyDialogKey(key('Tab', { shiftKey: true }))).toBe('cycle-focus');
  });

  it('confirms on plain Enter', () => {
    expect(classifyDialogKey(key('Enter'))).toBe('confirm');
  });

  it('swallows Escape so no overlay closes or opens', () => {
    expect(classifyDialogKey(key('Escape'))).toBe('swallow');
  });

  it.each([',', 'k', 'p', 'K', 'P', 'O', '/', '\\', 'b', 't', 'n', 'f'])(
    'isolates app shortcut Cmd+%s from app listeners',
    (k) => {
      expect(classifyDialogKey(key(k, { metaKey: true }))).toBe('isolate');
      expect(classifyDialogKey(key(k, { ctrlKey: true, shiftKey: true }))).toBe('isolate');
    },
  );

  it('isolates Cmd+Enter rather than confirming', () => {
    expect(classifyDialogKey(key('Enter', { metaKey: true }))).toBe('isolate');
  });

  it('passes through keys the radio group and button need', () => {
    for (const k of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' ', 'a']) {
      expect(classifyDialogKey(key(k))).toBe('pass');
    }
  });
});

describe('nextFocusIndex', () => {
  it('moves forward and wraps from last to first', () => {
    expect(nextFocusIndex(0, 3, false)).toBe(1);
    expect(nextFocusIndex(2, 3, false)).toBe(0);
  });

  it('moves backward and wraps from first to last', () => {
    expect(nextFocusIndex(1, 3, true)).toBe(0);
    expect(nextFocusIndex(0, 3, true)).toBe(2);
  });

  it('enters at the first element going forward when focus is outside', () => {
    expect(nextFocusIndex(-1, 3, false)).toBe(0);
  });

  it('enters at the last element going backward when focus is outside', () => {
    expect(nextFocusIndex(-1, 3, true)).toBe(2);
  });

  it('returns -1 when there is nothing to focus', () => {
    expect(nextFocusIndex(-1, 0, false)).toBe(-1);
    expect(nextFocusIndex(0, 0, true)).toBe(-1);
  });
});
