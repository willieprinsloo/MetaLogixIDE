// @vitest-environment jsdom

/** Exercises find geometry and the trusted Option-drag contract without a terminal session. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGhosttyFindPaint } from '@renderer/terminal/ghostty-find-paint';
import { enableGhosttyOptionSelection } from '@renderer/terminal/ghostty-option-selection';

afterEach(() => { vi.restoreAllMocks(); });

function setupPaint() {
  const host = document.createElement('div');
  const content = host.appendChild(document.createElement('canvas'));
  const grid = { cols: 10, rows: 3, viewportY: 5, cellWidthPx: 16, cellHeightPx: 28, devicePixelRatio: 2 };
  const viewport = vi.fn(() => grid);
  const scroll = vi.fn<(row: number) => void>();
  const paint = createGhosttyFindPaint(host, viewport, scroll);
  return { host, content, grid, viewport, scroll, paint };
}

function markBounds(host: HTMLElement) {
  return Array.from(host.querySelectorAll<HTMLElement>('[data-terminal-find] span'), ({ style }) =>
    [style.left, style.top, style.width, style.height]);
}

describe('Ghostty find paint', () => {
  it('paints inclusive cell ranges, including intermediate rows, in CSS pixels without scrolling a visible result', () => {
    const { host, scroll, paint } = setupPaint();
    paint.show({ start: { row: 5, col: 3 }, end: { row: 7, col: 1 } });
    expect(scroll).not.toHaveBeenCalled();
    expect(host.querySelector('[data-terminal-find]')?.getAttribute('aria-hidden')).toBe('true');
    expect(markBounds(host)).toEqual([
      ['24px', '0px', '56px', '14px'],
      ['0px', '14px', '80px', '14px'],
      ['0px', '28px', '16px', '14px'],
    ]);
  });

  it('scrolls to the match start and clips until the viewport catches up', () => {
    const { host, grid, scroll, paint } = setupPaint();
    paint.show({ start: { row: 4, col: 9 }, end: { row: 5, col: 0 } });
    expect(scroll.mock.calls).toEqual([[4]]);
    expect(markBounds(host)).toEqual([['0px', '0px', '8px', '14px']]);

    grid.viewportY = 4;
    paint.refresh();
    expect(markBounds(host)).toEqual([['72px', '0px', '8px', '14px'], ['0px', '14px', '8px', '14px']]);

    paint.show({ start: { row: 6, col: 8 }, end: { row: 7, col: 2 } });
    expect(scroll.mock.calls).toEqual([[4], [6]]);
    expect(markBounds(host)).toEqual([['64px', '28px', '16px', '14px']]);

    grid.viewportY = 8;
    paint.refresh();
    expect(markBounds(host)).toEqual([]);
  });

  it('keeps marks stable on redundant refresh, repaints a new hit or grid and removes only its own overlay', () => {
    const { host, content, grid, viewport, paint } = setupPaint();
    paint.refresh();
    expect(viewport).not.toHaveBeenCalled();
    paint.show({ start: { row: 6, col: 1 }, end: { row: 6, col: 2 } });
    const layer = host.querySelector('[data-terminal-find]');
    const mark = layer?.firstElementChild;
    expect(markBounds(host)).toEqual([['8px', '14px', '16px', '14px']]);

    paint.refresh();
    expect(layer?.firstElementChild).toBe(mark);
    paint.show({ start: { row: 6, col: 3 }, end: { row: 6, col: 3 } });
    expect(host.querySelectorAll('[data-terminal-find]')).toHaveLength(1);
    expect(markBounds(host)).toEqual([['24px', '14px', '8px', '14px']]);

    grid.cellHeightPx = 32;
    grid.devicePixelRatio = 1;
    paint.refresh();
    expect(markBounds(host)).toEqual([['48px', '32px', '16px', '32px']]);

    paint.clear();
    paint.clear();
    paint.refresh();
    expect([...host.children]).toEqual([content]);
  });
});

function pointer(type: string, changes: Partial<PointerEvent> = {}) {
  return {
    type, isTrusted: true, isPrimary: true, pointerId: 7, pointerType: 'mouse', button: 0,
    buttons: 1, altKey: true, clientX: 15, clientY: 24, timeStamp: 100,
    preventDefault: vi.fn(), stopImmediatePropagation: vi.fn(), ...changes,
  };
}

function selectionFixture() {
  const element = document.createElement('div');
  const elementListeners = vi.spyOn(element, 'addEventListener');
  const documentListeners = vi.spyOn(document, 'addEventListener');
  const captures = new Set<number>();
  const capture = vi.fn((id: number) => { captures.add(id); });
  const release = vi.fn((id: number) => { captures.delete(id); });
  Object.assign(element, {
    setPointerCapture: capture, releasePointerCapture: release,
    hasPointerCapture: (id: number) => captures.has(id),
  });
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 20, 40, 30));
  vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(2);
  const sendPointer = vi.fn<Parameters<typeof enableGhosttyOptionSelection>[0]['sendPointer']>();
  const focus = vi.fn();
  const fault = vi.fn();
  const disposal = enableGhosttyOptionSelection({ element, geometry: { widthPx: 80, heightPx: 60 }, focus, sendPointer }, fault);

  function route(event: ReturnType<typeof pointer>): void {
    const records = event.type === 'pointerdown' || event.type === 'lostpointercapture' ? elementListeners : documentListeners;
    for (const [type, listener, options] of records.mock.calls) {
      if (type === event.type && typeof listener === 'function' && typeof options === 'object' &&
          options.capture && options.signal && !options.signal.aborted) {
        Reflect.apply(listener, undefined, [event]);
      }
    }
  }

  return { route, captures, capture, release, focus, sendPointer, fault, disposal };
}

describe('Ghostty Option selection', () => {
  it.each([
    ['synthetic', { isTrusted: false }], ['secondary contact', { isPrimary: false }],
    ['touch', { pointerType: 'touch' }], ['right button', { button: 2 }], ['no Option modifier', { altKey: false }],
  ] satisfies [string, Partial<PointerEvent>][])('leaves %s presses to the ordinary event path', (_description, changes) => {
    const { route, focus, capture, sendPointer, disposal } = selectionFixture();
    const down = pointer('pointerdown', changes);
    route(down);
    expect(down.preventDefault).not.toHaveBeenCalled();
    expect(down.stopImmediatePropagation).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
    expect(sendPointer).not.toHaveBeenCalled();
    disposal.dispose();
  });

  it('focuses and captures the mouse, clamps physical coordinates and releases after Option is lifted', () => {
    const { route, focus, capture, release, sendPointer, disposal } = selectionFixture();
    const down = pointer('pointerdown');
    const foreignMove = pointer('pointermove', { pointerId: 42 });
    const syntheticMove = pointer('pointermove', { isTrusted: false });
    const move = pointer('pointermove', { altKey: false, clientX: -100, clientY: 200, timeStamp: 120 });
    const up = pointer('pointerup', { altKey: false, buttons: 0, clientX: 51, clientY: 18, timeStamp: 130 });
    for (const event of [down, foreignMove, syntheticMove, move, up]) route(event);

    expect(focus).toHaveBeenCalledOnce();
    expect(capture.mock.calls).toEqual([[7]]);
    expect(release.mock.calls).toEqual([[7]]);
    for (const event of [down, move, up]) {
      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(event.stopImmediatePropagation).toHaveBeenCalledOnce();
    }
    expect(foreignMove.preventDefault).not.toHaveBeenCalled();
    expect(syntheticMove.preventDefault).not.toHaveBeenCalled();
    expect(sendPointer.mock.calls).toEqual([
      [{ action: 'press', button: 'left', forceSelection: true, anyButtonPressed: true, x: 10, y: 8, timeMs: 100 }],
      [{ action: 'motion', button: 'left', forceSelection: true, anyButtonPressed: true, x: 0, y: 59, timeMs: 120 }],
      [{ action: 'release', button: 'left', forceSelection: true, anyButtonPressed: false, x: 79, y: 0, timeMs: 130 }],
    ]);
    const late = pointer('pointermove');
    route(late);
    expect(late.preventDefault).not.toHaveBeenCalled();
    disposal.dispose();
  });

  it.each(['pointercancel', 'lostpointercapture'])('releases at the last position on %s without sending an unmatched release', (type) => {
    const { route, captures, release, sendPointer, disposal } = selectionFixture();
    route(pointer('pointerdown'));
    route(pointer('pointermove', { clientX: 20, clientY: 27, timeStamp: 125 }));
    if (type === 'lostpointercapture') captures.delete(7);
    route(pointer(type, { clientX: 0, clientY: 0, timeStamp: 150 }));

    expect(sendPointer).toHaveBeenLastCalledWith({
      action: 'release', button: 'left', forceSelection: true, anyButtonPressed: false, x: 20, y: 14, timeMs: 125,
    });
    const move = pointer('pointermove');
    const up = pointer('pointerup', { buttons: 0 });
    route(move);
    route(up);
    expect(move.preventDefault).toHaveBeenCalledTimes(type === 'lostpointercapture' ? 1 : 0);
    expect(up.preventDefault).toHaveBeenCalledTimes(type === 'lostpointercapture' ? 1 : 0);
    expect(sendPointer).toHaveBeenCalledTimes(3);
    expect(release).toHaveBeenCalledTimes(type === 'pointercancel' ? 1 : 0);
    disposal.dispose();
  });

  it('returns to hover after capture loss with no button held', () => {
    const { route, captures, sendPointer, disposal } = selectionFixture();
    route(pointer('pointerdown'));
    captures.delete(7);
    route(pointer('lostpointercapture'));
    const hover = pointer('pointermove', { buttons: 0 });
    route(hover);
    const later = pointer('pointermove');
    route(later);
    expect(hover.preventDefault).not.toHaveBeenCalled();
    expect(later.preventDefault).not.toHaveBeenCalled();
    expect(sendPointer).toHaveBeenCalledTimes(2);
    disposal.dispose();
  });

  it('reports a failed vendor send and detaches a live gesture when replaced or disposed', () => {
    const { route, release, capture, sendPointer, fault, disposal } = selectionFixture();
    sendPointer.mockImplementationOnce(() => { throw new Error('pointer send failed'); });
    route(pointer('pointerdown'));
    expect(fault).toHaveBeenCalledOnce();
    const regularPress = pointer('pointerdown', { pointerId: 8, altKey: false });
    route(regularPress);
    expect(regularPress.preventDefault).not.toHaveBeenCalled();
    expect(release.mock.calls).toEqual([[7]]);

    route(pointer('pointerdown', { pointerId: 8 }));
    expect(capture.mock.calls).toEqual([[7], [8]]);
    disposal.dispose();
    expect(release.mock.calls).toEqual([[7], [8]]);
    route(pointer('pointerdown', { pointerId: 9 }));
    route(pointer('pointermove', { pointerId: 8 }));
    expect(sendPointer).toHaveBeenCalledTimes(2);
  });
});
