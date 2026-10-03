import { describe, it, expect, beforeEach } from 'vitest';
import {
  classifyActiveElement,
  shouldTakeFocus,
  shouldHonourRequest,
  createTerminalFocusCoordinator,
  FOCUS_REQUEST_TTL_MS,
  XTERM_TEXTAREA_CLASS,
  type ActiveElementKind,
  type ElementLike,
  type ShellKey,
  type TerminalFocusCoordinator,
  type TerminalRegistration,
} from '@renderer/terminal-focus';

const el = (tagName: string, opts: { classes?: string[]; editable?: boolean } = {}): ElementLike => ({
  tagName,
  isContentEditable: opts.editable ?? false,
  classList: { contains: (token: string) => (opts.classes ?? []).includes(token) },
});

describe('classifyActiveElement', () => {
  it.each([
    ['null', null],
    ['BODY', el('BODY')],
    ['HTML', el('HTML')],
  ])('treats %s as none', (_label, input) => {
    expect(classifyActiveElement(input)).toBe('none');
  });

  it('treats the xterm helper textarea as terminal', () => {
    expect(classifyActiveElement(el('TEXTAREA', { classes: [XTERM_TEXTAREA_CLASS] }))).toBe('terminal');
  });

  it.each([
    ['INPUT', el('INPUT')],
    ['plain TEXTAREA', el('TEXTAREA', { classes: ['editor'] })],
    ['SELECT', el('SELECT')],
    ['contenteditable DIV', el('DIV', { editable: true })],
  ])('treats %s as text-entry', (_label, input) => {
    expect(classifyActiveElement(input)).toBe('text-entry');
  });

  it.each([
    ['BUTTON', el('BUTTON')],
    ['A', el('A')],
    ['DIV', el('DIV')],
    ['xterm class on a non-textarea', el('DIV', { classes: [XTERM_TEXTAREA_CLASS] })],
  ])('treats %s as control', (_label, input) => {
    expect(classifyActiveElement(input)).toBe('control');
  });
});

const KINDS: ActiveElementKind[] = ['none', 'terminal', 'text-entry', 'control'];

describe('shouldTakeFocus', () => {
  it.each([
    ['none', true],
    ['control', true],
    ['terminal', false],
    ['text-entry', false],
  ] as const)('without an overlay, %s → %s', (active, expected) => {
    expect(shouldTakeFocus({ overlayOpen: false, active })).toBe(expected);
  });

  it.each(KINDS)('never takes focus with an overlay open (%s)', (active) => {
    expect(shouldTakeFocus({ overlayOpen: true, active })).toBe(false);
  });
});

describe('shouldHonourRequest', () => {
  it.each([
    ['none', true],
    ['control', true],
    ['terminal', true],
    ['text-entry', false],
  ] as const)('without an overlay, %s → %s', (active, expected) => {
    expect(shouldHonourRequest({ overlayOpen: false, active })).toBe(expected);
  });

  it.each(KINDS)('never honours a request with an overlay open (%s)', (active) => {
    expect(shouldHonourRequest({ overlayOpen: true, active })).toBe(false);
  });
});

interface FakeTerminal {
  key: ShellKey;
  primary: boolean;
  open: boolean;
  focusCalls: number;
  reg: TerminalRegistration;
}

describe('createTerminalFocusCoordinator', () => {
  let active: ActiveElementKind;
  let clock: number;
  let coord: TerminalFocusCoordinator;

  const add = (key: ShellKey, opts: { primary?: boolean; open?: boolean } = {}): FakeTerminal => {
    const t = { key, primary: opts.primary ?? false, open: opts.open ?? false, focusCalls: 0 } as FakeTerminal;
    t.reg = coord.register({
      key,
      primary: t.primary,
      isOpen: () => t.open,
      focus: () => { t.focusCalls += 1; },
    });
    if (t.open) t.reg.opened();
    return t;
  };
  const open = (t: FakeTerminal) => { t.open = true; t.reg.opened(); };

  beforeEach(() => {
    active = 'none';
    clock = 1000;
    coord = createTerminalFocusCoordinator({ activeElementKind: () => active, now: () => clock });
  });

  describe('window focus', () => {
    it.each(['none', 'control'] as const)('focuses a single open terminal once when active is %s', (kind) => {
      const t = add({ projectId: 1, shellIndex: 0 }, { primary: true, open: true });
      active = kind;
      coord.onWindowFocus();
      expect(t.focusCalls).toBe(1);
    });

    it.each(['text-entry', 'terminal'] as const)('leaves focus alone when active is %s', (kind) => {
      const t = add({ projectId: 1, shellIndex: 0 }, { primary: true, open: true });
      active = kind;
      coord.onWindowFocus();
      expect(t.focusCalls).toBe(0);
    });

    it('does nothing while an overlay is open', () => {
      const t = add({ projectId: 1, shellIndex: 0 }, { primary: true, open: true });
      coord.setOverlayOpen(true);
      coord.onWindowFocus();
      expect(t.focusCalls).toBe(0);
    });

    it('resumes once the overlay closes', () => {
      const t = add({ projectId: 1, shellIndex: 0 }, { primary: true, open: true });
      coord.setOverlayOpen(true);
      coord.setOverlayOpen(false);
      coord.onWindowFocus();
      expect(t.focusCalls).toBe(1);
    });

    it('focuses the last-used right terminal and not the left', () => {
      const left = add({ projectId: 1, shellIndex: 0 }, { primary: true, open: true });
      const right = add({ projectId: 1, shellIndex: 1 }, { open: true });
      right.reg.used();
      coord.onWindowFocus();
      expect(right.focusCalls).toBe(1);
      expect(left.focusCalls).toBe(0);
    });

    it('focuses the last-used left terminal and not the right', () => {
      const left = add({ projectId: 1, shellIndex: 0 }, { primary: true, open: true });
      const right = add({ projectId: 1, shellIndex: 1 }, { open: true });
      right.reg.used();
      left.reg.used();
      coord.onWindowFocus();
      expect(left.focusCalls).toBe(1);
      expect(right.focusCalls).toBe(0);
    });

    it('falls back to the primary terminal even when it registered second', () => {
      const right = add({ projectId: 1, shellIndex: 1 }, { open: true });
      const left = add({ projectId: 1, shellIndex: 0 }, { primary: true, open: true });
      coord.onWindowFocus();
      expect(left.focusCalls).toBe(1);
      expect(right.focusCalls).toBe(0);
    });

    it('falls back to the first registered terminal when none is primary', () => {
      const first = add({ projectId: 1, shellIndex: 0 }, { open: true });
      const second = add({ projectId: 1, shellIndex: 1 }, { open: true });
      coord.onWindowFocus();
      expect(first.focusCalls).toBe(1);
      expect(second.focusCalls).toBe(0);
    });

    it('falls back to primary after the last-used terminal unregisters', () => {
      const left = add({ projectId: 1, shellIndex: 0 }, { primary: true, open: true });
      const right = add({ projectId: 1, shellIndex: 1 }, { open: true });
      right.reg.used();
      right.reg.unregister();
      coord.onWindowFocus();
      expect(left.focusCalls).toBe(1);
      expect(right.focusCalls).toBe(0);
    });

    it('ignores a used() that arrives after unregister', () => {
      const left = add({ projectId: 1, shellIndex: 0 }, { primary: true, open: true });
      const right = add({ projectId: 1, shellIndex: 1 }, { open: true });
      right.reg.unregister();
      right.reg.used();
      coord.onWindowFocus();
      expect(left.focusCalls).toBe(1);
      expect(right.focusCalls).toBe(0);
    });

    it('leaves nothing pending when no terminal is registered', () => {
      coord.onWindowFocus();
      const t = add({ projectId: 1, shellIndex: 0 }, { primary: true });
      open(t);
      expect(t.focusCalls).toBe(0);
    });
  });

  describe('pending window target', () => {
    it('focuses the target once when it opens after the window focus', () => {
      const t = add({ projectId: 1, shellIndex: 0 }, { primary: true });
      coord.onWindowFocus();
      expect(t.focusCalls).toBe(0);
      open(t);
      expect(t.focusCalls).toBe(1);
      t.reg.opened();
      expect(t.focusCalls).toBe(1);
    });

    it('does not steal when focus moved to a text field before open', () => {
      const t = add({ projectId: 1, shellIndex: 0 }, { primary: true });
      coord.onWindowFocus();
      active = 'text-entry';
      open(t);
      expect(t.focusCalls).toBe(0);
    });

    it('does not steal when an overlay opened before open', () => {
      const t = add({ projectId: 1, shellIndex: 0 }, { primary: true });
      coord.onWindowFocus();
      coord.setOverlayOpen(true);
      open(t);
      expect(t.focusCalls).toBe(0);
    });

    it('is cleared by a window blur', () => {
      const t = add({ projectId: 1, shellIndex: 0 }, { primary: true });
      coord.onWindowFocus();
      coord.onWindowBlur();
      open(t);
      expect(t.focusCalls).toBe(0);
    });

    it('survives another terminal opening first', () => {
      const left = add({ projectId: 1, shellIndex: 0 }, { primary: true });
      const right = add({ projectId: 1, shellIndex: 1 });
      coord.onWindowFocus();
      open(right);
      expect(right.focusCalls).toBe(0);
      open(left);
      expect(left.focusCalls).toBe(1);
    });

    it('is dropped when the pending terminal unregisters', () => {
      const t = add({ projectId: 1, shellIndex: 0 }, { primary: true });
      coord.onWindowFocus();
      t.reg.unregister();
      open(t);
      expect(t.focusCalls).toBe(0);
    });
  });

  describe('focus requests', () => {
    const B: ShellKey = { projectId: 2, shellIndex: 0 };

    it('focuses the requested terminal when it registers and opens', () => {
      coord.requestFocus(B);
      const t = add(B, { primary: true });
      open(t);
      expect(t.focusCalls).toBe(1);
    });

    it('ignores a terminal with another key and keeps the request', () => {
      coord.requestFocus(B);
      const intermediate = add({ projectId: 2, shellIndex: 1 }, { primary: true });
      open(intermediate);
      expect(intermediate.focusCalls).toBe(0);
      intermediate.reg.unregister();
      const t = add(B, { primary: true });
      open(t);
      expect(t.focusCalls).toBe(1);
    });

    it('matches on both projectId and shellIndex', () => {
      coord.requestFocus(B);
      const sameIndex = add({ projectId: 3, shellIndex: 0 }, { primary: true });
      open(sameIndex);
      expect(sameIndex.focusCalls).toBe(0);
    });

    it('ignores a request older than the TTL', () => {
      coord.requestFocus(B);
      clock += FOCUS_REQUEST_TTL_MS + 1;
      const t = add(B, { primary: true });
      open(t);
      expect(t.focusCalls).toBe(0);
    });

    it('honours a request right at the TTL boundary', () => {
      coord.requestFocus(B);
      clock += FOCUS_REQUEST_TTL_MS;
      const t = add(B, { primary: true });
      open(t);
      expect(t.focusCalls).toBe(1);
    });

    it('focuses an already-open terminal immediately and only once', () => {
      const t = add(B, { primary: true, open: true });
      coord.requestFocus(B);
      expect(t.focusCalls).toBe(1);
      t.reg.opened();
      expect(t.focusCalls).toBe(1);
    });

    it('does not focus with an overlay open, and does not steal later', () => {
      coord.setOverlayOpen(true);
      coord.requestFocus(B);
      const t = add(B, { primary: true });
      open(t);
      expect(t.focusCalls).toBe(0);
      coord.setOverlayOpen(false);
      t.reg.opened();
      expect(t.focusCalls).toBe(0);
    });

    it('does not focus an already-open terminal while a text field holds focus', () => {
      const t = add(B, { primary: true, open: true });
      active = 'text-entry';
      coord.requestFocus(B);
      expect(t.focusCalls).toBe(0);
    });

    it('does not focus on open while a text field holds focus', () => {
      active = 'text-entry';
      coord.requestFocus(B);
      const t = add(B, { primary: true });
      open(t);
      expect(t.focusCalls).toBe(0);
    });

    it('focuses when a terminal (not a text field) holds focus', () => {
      const other = add({ projectId: 1, shellIndex: 0 }, { primary: true, open: true });
      active = 'terminal';
      coord.requestFocus(B);
      other.reg.unregister();
      const t = add(B, { primary: true });
      open(t);
      expect(t.focusCalls).toBe(1);
    });

    it('works for a request made before any registration (popout mount)', () => {
      coord.requestFocus(B);
      coord.onWindowFocus();
      clock += FOCUS_REQUEST_TTL_MS - 1;
      const t = add(B, { primary: true });
      open(t);
      expect(t.focusCalls).toBe(1);
    });

    it('is cleared by a window blur', () => {
      coord.requestFocus(B);
      coord.onWindowBlur();
      const t = add(B, { primary: true });
      open(t);
      expect(t.focusCalls).toBe(0);
    });

    it('focuses once when it also is the pending window target', () => {
      coord.requestFocus(B);
      const t = add(B, { primary: true });
      coord.onWindowFocus();
      open(t);
      expect(t.focusCalls).toBe(1);
    });
  });

  describe('project requests', () => {
    const P = 2;
    const primaryOf = (projectId: number, shellIndex = 0): FakeTerminal =>
      add({ projectId, shellIndex }, { primary: true });

    it('focuses the project primary terminal when it registers and opens later', () => {
      coord.requestProjectFocus(P);
      const t = primaryOf(P, 3);
      expect(t.focusCalls).toBe(0);
      open(t);
      expect(t.focusCalls).toBe(1);
    });

    it('ignores a non-primary terminal of the same project and keeps the request', () => {
      coord.requestProjectFocus(P);
      const right = add({ projectId: P, shellIndex: 1 });
      open(right);
      expect(right.focusCalls).toBe(0);
      const left = primaryOf(P);
      open(left);
      expect(left.focusCalls).toBe(1);
      expect(right.focusCalls).toBe(0);
    });

    it('focuses the left pane, not an already-open right pane, of a restored split', () => {
      const right = add({ projectId: P, shellIndex: 1 }, { open: true });
      coord.requestProjectFocus(P);
      expect(right.focusCalls).toBe(0);
      const left = primaryOf(P);
      open(left);
      expect(left.focusCalls).toBe(1);
      expect(right.focusCalls).toBe(0);
    });

    it('ignores the primary terminal of another project and keeps the request', () => {
      const old = add({ projectId: 1, shellIndex: 0 }, { primary: true, open: true });
      coord.requestProjectFocus(P);
      expect(old.focusCalls).toBe(0);
      const other = primaryOf(3);
      open(other);
      expect(other.focusCalls).toBe(0);
      old.reg.opened();
      expect(old.focusCalls).toBe(0);
      const t = primaryOf(P);
      open(t);
      expect(t.focusCalls).toBe(1);
    });

    it('focuses an already-open primary terminal immediately and only once', () => {
      const t = add({ projectId: P, shellIndex: 0 }, { primary: true, open: true });
      coord.requestProjectFocus(P);
      expect(t.focusCalls).toBe(1);
      t.reg.opened();
      expect(t.focusCalls).toBe(1);
    });

    it('focuses the open target immediately when another open terminal registered first', () => {
      const old = add({ projectId: 1, shellIndex: 0 }, { primary: true, open: true });
      const right = add({ projectId: P, shellIndex: 1 }, { open: true });
      const t = add({ projectId: P, shellIndex: 0 }, { primary: true, open: true });
      coord.requestProjectFocus(P);
      expect(t.focusCalls).toBe(1);
      expect(old.focusCalls).toBe(0);
      expect(right.focusCalls).toBe(0);
    });

    it('does not focus an already-open primary terminal while a text field holds focus', () => {
      const t = add({ projectId: P, shellIndex: 0 }, { primary: true, open: true });
      active = 'text-entry';
      coord.requestProjectFocus(P);
      expect(t.focusCalls).toBe(0);
    });

    it('does not focus when a text field holds focus at open, and does not steal later', () => {
      coord.requestProjectFocus(P);
      const t = primaryOf(P);
      active = 'text-entry';
      open(t);
      expect(t.focusCalls).toBe(0);
      active = 'none';
      t.reg.opened();
      expect(t.focusCalls).toBe(0);
    });

    it('does not focus when an overlay is open at open, and does not steal later', () => {
      coord.requestProjectFocus(P);
      const t = primaryOf(P);
      coord.setOverlayOpen(true);
      open(t);
      expect(t.focusCalls).toBe(0);
      coord.setOverlayOpen(false);
      t.reg.opened();
      expect(t.focusCalls).toBe(0);
    });

    it('focuses when an overlay was opened and closed again before open', () => {
      coord.requestProjectFocus(P);
      const t = primaryOf(P);
      coord.setOverlayOpen(true);
      coord.setOverlayOpen(false);
      open(t);
      expect(t.focusCalls).toBe(1);
    });

    it('focuses when a text field was focused and left again before open', () => {
      coord.requestProjectFocus(P);
      const t = primaryOf(P);
      active = 'text-entry';
      active = 'control';
      open(t);
      expect(t.focusCalls).toBe(1);
    });

    it('focuses when requested while an overlay is open that closes before open', () => {
      coord.setOverlayOpen(true);
      coord.requestProjectFocus(P);
      coord.setOverlayOpen(false);
      const t = primaryOf(P);
      open(t);
      expect(t.focusCalls).toBe(1);
    });

    it('ignores an open after the TTL', () => {
      coord.requestProjectFocus(P);
      clock += FOCUS_REQUEST_TTL_MS + 1;
      const t = primaryOf(P);
      open(t);
      expect(t.focusCalls).toBe(0);
    });

    it('honours an open right at the TTL boundary', () => {
      coord.requestProjectFocus(P);
      clock += FOCUS_REQUEST_TTL_MS;
      const t = primaryOf(P);
      open(t);
      expect(t.focusCalls).toBe(1);
    });

    it.each([
      ['B opens before C', ['B', 'C']],
      ['C opens before B', ['C', 'B']],
    ] as const)('B then C requested, %s → only C is focused', (_label, order) => {
      const terms = { B: primaryOf(2), C: primaryOf(3) };
      coord.requestProjectFocus(2);
      coord.requestProjectFocus(3);
      for (const name of order) open(terms[name]);
      expect(terms.C.focusCalls).toBe(1);
      expect(terms.B.focusCalls).toBe(0);
    });

    it('is dropped by cancelRequest', () => {
      coord.requestProjectFocus(P);
      coord.cancelRequest();
      const t = primaryOf(P);
      open(t);
      expect(t.focusCalls).toBe(0);
    });

    it('cancelRequest also drops a pending key request', () => {
      const key = { projectId: P, shellIndex: 1 };
      coord.requestFocus(key);
      coord.cancelRequest();
      const t = add(key, { primary: true });
      open(t);
      expect(t.focusCalls).toBe(0);
    });

    it('a request made after cancelRequest still fires', () => {
      coord.requestProjectFocus(3);
      coord.cancelRequest();
      coord.requestProjectFocus(P);
      const t = primaryOf(P);
      open(t);
      expect(t.focusCalls).toBe(1);
    });

    it('focuses nothing when no matching terminal ever registers, and expires', () => {
      const old = add({ projectId: 1, shellIndex: 0 }, { primary: true, open: true });
      coord.requestProjectFocus(P);
      clock += FOCUS_REQUEST_TTL_MS + 1;
      const t = primaryOf(P);
      open(t);
      expect(t.focusCalls).toBe(0);
      expect(old.focusCalls).toBe(0);
    });

    it('is cleared by a window blur', () => {
      coord.requestProjectFocus(P);
      coord.onWindowBlur();
      const t = primaryOf(P);
      open(t);
      expect(t.focusCalls).toBe(0);
    });

    it('focuses once when the target is also the pending window target', () => {
      coord.requestProjectFocus(P);
      const t = primaryOf(P);
      coord.onWindowFocus();
      open(t);
      expect(t.focusCalls).toBe(1);
    });

    it('replaces a pending key request', () => {
      const key = { projectId: 3, shellIndex: 0 };
      coord.requestFocus(key);
      coord.requestProjectFocus(P);
      const keyed = add(key, { primary: true });
      open(keyed);
      expect(keyed.focusCalls).toBe(0);
      const t = primaryOf(P);
      open(t);
      expect(t.focusCalls).toBe(1);
    });
  });
});
