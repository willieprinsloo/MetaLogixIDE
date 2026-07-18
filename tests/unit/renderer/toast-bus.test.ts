import { describe, it, expect, beforeEach, vi } from 'vitest';

// Import the module in isolation so state doesn't leak between tests.
async function freshBus() {
  vi.resetModules();
  const mod = await import('@renderer/hooks/useToasts');
  return { toast: mod.toast, bus: mod.toastBus };
}

describe('toastBus', () => {
  beforeEach(() => {
    // The bus lives in a module — window is available in vitest jsdom env.
    vi.useFakeTimers();
  });

  it('pushes and delivers to subscribers', async () => {
    const { toast, bus } = await freshBus();
    const seen: Array<{ len: number }> = [];
    const off = bus.subscribe((ts) => seen.push({ len: ts.length }));
    toast('hello', { timeoutMs: 0 });
    expect(seen.at(-1)?.len).toBe(1);
    off();
  });

  it('drops timed-out toasts on its own schedule', async () => {
    const { toast, bus } = await freshBus();
    const seen: number[] = [];
    const off = bus.subscribe((ts) => seen.push(ts.length));
    toast('bye', { timeoutMs: 100 });
    expect(seen.at(-1)).toBe(1);
    vi.advanceTimersByTime(100);
    expect(seen.at(-1)).toBe(0);
    off();
  });

  it('caps the queue at 6 items (newest first)', async () => {
    const { toast, bus } = await freshBus();
    let last: number = 0;
    const off = bus.subscribe((ts) => { last = ts.length; });
    for (let i = 0; i < 10; i++) toast(`t${i}`, { timeoutMs: 0 });
    expect(last).toBe(6);
    off();
  });

  it('dismiss removes a specific toast', async () => {
    const { toast, bus } = await freshBus();
    const id = toast('to-remove', { timeoutMs: 0 });
    let count = -1;
    const off = bus.subscribe((ts) => { count = ts.length; });
    expect(count).toBeGreaterThan(0);
    bus.dismiss(id);
    expect(count).toBe(0);
    off();
  });
});
