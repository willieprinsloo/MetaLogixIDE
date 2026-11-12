import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const rt = await vi.hoisted(async () => {
  const { createHookRuntime } = await import('./helpers/hook-runtime');
  return createHookRuntime();
});

vi.mock('react', async (orig) => ({
  ...(await orig<typeof import('react')>()),
  useState: rt.useState,
  useRef: rt.useRef,
  useCallback: rt.useCallback,
  useEffect: rt.useEffect,
}));
vi.mock('@renderer/api', () => ({ api: {} }));

const { useNow, useChipPopover, NOW_TICK_MS } = await import('@renderer/components/KeepAwakeChip');

type Handler = (e: unknown) => void;
const handlers = new Map<string, Set<Handler>>();
const fakeDocument = {
  addEventListener: (type: string, h: Handler) => { (handlers.get(type) ?? handlers.set(type, new Set()).get(type))?.add(h); },
  removeEventListener: (type: string, h: Handler) => { handlers.get(type)?.delete(h); },
};
const fire = (type: string, e: unknown) => { for (const h of [...(handlers.get(type) ?? [])]) h(e); };
const listenerCount = () => [...handlers.values()].reduce((n, s) => n + s.size, 0);

const T0 = new Date(2026, 9, 19, 10, 0, 0).getTime();

beforeEach(() => {
  rt.reset();
  handlers.clear();
  vi.stubGlobal('document', fakeDocument);
  vi.stubGlobal('window', globalThis);
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(T0);
});
afterEach(() => {
  rt.unmount();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useNow', () => {
  const mount = (active: boolean) => {
    let a = active;
    const read = () => rt.render(() => useNow(a));
    read();
    return { read, set: (v: boolean) => { a = v; read(); } };
  };

  it('ticks at most once a minute (AC10 needs one refresh per minute)', () => {
    expect(NOW_TICK_MS).toBeLessThanOrEqual(60_000);
  });

  it('re-reads the clock every tick while active', () => {
    const h = mount(true);
    vi.advanceTimersByTime(NOW_TICK_MS);
    expect(h.read()).toBe(T0 + NOW_TICK_MS);
  });

  it('keeps no timer while inactive', () => {
    const h = mount(false);
    expect(vi.getTimerCount()).toBe(0);
    h.set(true);
    expect(vi.getTimerCount()).toBe(1);
    h.set(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the timer on unmount', () => {
    mount(true);
    rt.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('useChipPopover', () => {
  const inside = {};
  const outside = {};
  const mount = (active = true) => {
    let a = active;
    const read = () => rt.render(() => useChipPopover(a));
    const first = read();
    (first.anchorRef as { current: unknown }).current = { contains: (t: unknown) => t === inside };
    const focus = vi.fn();
    (first.chipRef as { current: unknown }).current = { focus };
    return { read, focus, setActive: (v: boolean) => { a = v; return read(); } };
  };

  it('starts closed and toggles', () => {
    const h = mount();
    expect(h.read().open).toBe(false);
    h.read().toggle();
    expect(h.read().open).toBe(true);
    h.read().toggle();
    expect(h.read().open).toBe(false);
  });

  it('listens for dismissal only while open', () => {
    const h = mount();
    expect(listenerCount()).toBe(0);
    h.read().toggle();
    h.read();
    expect(listenerCount()).toBeGreaterThan(0);
    h.read().close();
    h.read();
    expect(listenerCount()).toBe(0);
  });

  it('closes on Escape and returns focus to the chip', () => {
    const h = mount();
    h.read().toggle();
    h.read();
    fire('keydown', { key: 'Escape' });
    expect(h.read().open).toBe(false);
    expect(h.focus).toHaveBeenCalledTimes(1);
  });

  it('ignores other keys', () => {
    const h = mount();
    h.read().toggle();
    h.read();
    fire('keydown', { key: 'a' });
    expect(h.read().open).toBe(true);
    expect(h.focus).not.toHaveBeenCalled();
  });

  it('closes on an outside mousedown and returns focus to the chip', () => {
    const h = mount();
    h.read().toggle();
    h.read();
    fire('mousedown', { target: outside });
    expect(h.read().open).toBe(false);
    expect(h.focus).toHaveBeenCalledTimes(1);
  });

  it('stays open for a mousedown inside the chip or popover', () => {
    const h = mount();
    h.read().toggle();
    h.read();
    fire('mousedown', { target: inside });
    expect(h.read().open).toBe(true);
    expect(h.focus).not.toHaveBeenCalled();
  });

  it('closes when keep-awake turns inactive, so it does not reopen on the next start', () => {
    const h = mount();
    h.read().toggle();
    h.read();
    expect(h.setActive(false).open).toBe(false);
    expect(h.setActive(true).open).toBe(false);
  });

  it('removes its listeners on unmount', () => {
    const h = mount();
    h.read().toggle();
    h.read();
    rt.unmount();
    expect(listenerCount()).toBe(0);
  });
});
