import { describe, expect, it, vi } from 'vitest';
import { REDUCE_TRANSPARENCY_QUERY, reducedTransparencyStore } from '@renderer/hooks/usePrefersReducedTransparency';

function fakeMedia(initial: boolean) {
  const listeners = new Set<() => void>();
  const list = {
    matches: initial,
    addEventListener: (_: 'change', cb: () => void) => { listeners.add(cb); },
    removeEventListener: (_: 'change', cb: () => void) => { listeners.delete(cb); },
  };
  const matchMedia = vi.fn<(query: string) => typeof list>(() => list);
  const flip = (next: boolean) => { list.matches = next; for (const cb of [...listeners]) cb(); };
  return { matchMedia, flip, listeners };
}

describe('reducedTransparencyStore', () => {
  it('queries prefers-reduced-transparency: reduce', () => {
    const m = fakeMedia(false);
    reducedTransparencyStore(m.matchMedia).getSnapshot();
    expect(REDUCE_TRANSPARENCY_QUERY).toBe('(prefers-reduced-transparency: reduce)');
    expect(m.matchMedia).toHaveBeenCalledWith(REDUCE_TRANSPARENCY_QUERY);
  });

  it('reads the current preference, not the one at creation', () => {
    const m = fakeMedia(false);
    const store = reducedTransparencyStore(m.matchMedia);
    expect(store.getSnapshot()).toBe(false);
    m.flip(true);
    expect(store.getSnapshot()).toBe(true);
  });

  it('notifies subscribers when the preference changes', () => {
    const m = fakeMedia(false);
    const store = reducedTransparencyStore(m.matchMedia);
    const cb = vi.fn();
    store.subscribe(cb);
    m.flip(true);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('stops notifying after unsubscribe', () => {
    const m = fakeMedia(false);
    const store = reducedTransparencyStore(m.matchMedia);
    const cb = vi.fn();
    store.subscribe(cb)();
    m.flip(true);
    expect(cb).not.toHaveBeenCalled();
    expect(m.listeners.size).toBe(0);
  });
});
