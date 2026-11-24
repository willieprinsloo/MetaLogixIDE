/**
 * `useFrostedGlassAttributes` keeps the root's frosted-glass attributes in sync with the three
 * stored keys (`frost_chrome`, `chrome_frost_level`, `terminal_frost_level`): it re-reads all
 * three on mount and again on every `settings:changed` for any of them, and ignores changes to
 * other keys. On Linux the same live path sets and removes `data-platform="linux"` (AC8, unit half),
 * while the transparent-window marker stays (AC7). The hook runs under a minimal in-test effect runtime (vitest runs in node, without a
 * DOM renderer), mirroring `tests/unit/renderer/use-git-status.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FROST_ATTR, MAC_PLATFORM } from '@renderer/frosted-chrome-contract';
import { FROSTED_GLASS_KEYS } from '@shared/frosted-glass';
import type { RootFlagTarget } from '@renderer/root-flags';

const rt = vi.hoisted(() => {
  type Effect = { deps?: unknown[]; cleanup?: () => void; run?: () => unknown };
  const effects: Effect[] = [];
  let effectCursor = 0;
  const changed = (a: unknown[] | undefined, b: unknown[] | undefined) =>
    !a || !b || a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]));
  return {
    reset() { effects.length = 0; },
    render<T>(fn: () => T): T {
      effectCursor = 0;
      const out = fn();
      const due = effects.filter((e) => e.run);
      for (const e of due) e.cleanup?.();
      for (const e of due) {
        const c = e.run?.();
        e.run = undefined;
        e.cleanup = typeof c === 'function' ? (c as () => void) : undefined;
      }
      return out;
    },
    unmount() { for (const e of effects) e.cleanup?.(); },
    useEffect(run: () => unknown, deps?: unknown[]) {
      const i = effectCursor++;
      const prev = effects[i];
      if (prev && !changed(prev.deps, deps)) return;
      effects[i] = { deps, cleanup: prev?.cleanup, run };
    },
  };
});

vi.mock('react', async (orig) => ({
  ...(await orig<typeof import('react')>()),
  useEffect: rt.useEffect,
}));

type ChangedHandler = (payload: { key: string }) => void;
const invoke = vi.fn<(channel: string, req: unknown) => Promise<unknown>>();
const listeners: ChangedHandler[] = [];
const offs: ReturnType<typeof vi.fn>[] = [];

vi.mock('@renderer/api', () => ({
  api: {
    platform: 'darwin',
    invoke: (...args: [string, unknown]) => invoke(...args),
    on: vi.fn((_channel: string, cb: ChangedHandler) => {
      listeners.push(cb);
      const off = vi.fn();
      offs.push(off);
      return off;
    }),
  },
}));

const { useFrostedGlassAttributes } = await import('@renderer/hooks/useFrostedGlassAttributes');
const { api } = await import('@renderer/api');

function fakeTarget(): RootFlagTarget & { set: Record<string, string>; removed: string[] } {
  const set: Record<string, string> = {};
  const removed: string[] = [];
  return {
    set,
    removed,
    setAttribute(name: string, value: string): void { set[name] = value; },
    removeAttribute(name: string): void { removed.push(name); Reflect.deleteProperty(set, name); },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function mockValues(frostChrome: unknown, chromeFrost: unknown, terminalFrost: unknown): void {
  invoke.mockImplementation(async (_channel: string, req: unknown) => {
    const key = (req as { key?: string }).key;
    if (key === FROSTED_GLASS_KEYS.frostChrome) return { value: frostChrome };
    if (key === FROSTED_GLASS_KEYS.chromeFrostLevel) return { value: chromeFrost };
    if (key === FROSTED_GLASS_KEYS.terminalFrostLevel) return { value: terminalFrost };
    return { value: null };
  });
}

beforeEach(() => {
  rt.reset();
  listeners.length = 0;
  offs.length = 0;
  invoke.mockReset();
  vi.mocked(api.on).mockClear();
});

afterEach(() => {
  rt.unmount();
  Object.assign(api, { platform: 'darwin' });
});

describe('useFrostedGlassAttributes', () => {
  it('reads the three keys on mount and applies them to the target', async () => {
    mockValues(true, 'strong', 'medium');
    const target = fakeTarget();
    rt.render(() => useFrostedGlassAttributes(target));
    await flush();
    expect(invoke).toHaveBeenCalledWith('settings:get', { key: FROSTED_GLASS_KEYS.frostChrome });
    expect(invoke).toHaveBeenCalledWith('settings:get', { key: FROSTED_GLASS_KEYS.chromeFrostLevel });
    expect(invoke).toHaveBeenCalledWith('settings:get', { key: FROSTED_GLASS_KEYS.terminalFrostLevel });
    expect(target.set[FROST_ATTR.platform]).toBe(MAC_PLATFORM);
    expect(target.set[FROST_ATTR.chromeFrost]).toBe('strong');
    expect(target.set[FROST_ATTR.terminalFrost]).toBe('medium');
  });

  it.each([
    ['frost_chrome', FROSTED_GLASS_KEYS.frostChrome],
    ['chrome_frost_level', FROSTED_GLASS_KEYS.chromeFrostLevel],
    ['terminal_frost_level', FROSTED_GLASS_KEYS.terminalFrostLevel],
  ])('re-reads and re-applies on settings:changed for %s', async (_label, key) => {
    mockValues(false, 'subtle', 'off');
    const target = fakeTarget();
    rt.render(() => useFrostedGlassAttributes(target));
    await flush();
    expect(target.removed).toContain(FROST_ATTR.platform);

    mockValues(true, 'strong', 'strong');
    listeners[0]?.({ key });
    await flush();
    expect(target.set[FROST_ATTR.platform]).toBe(MAC_PLATFORM);
    expect(target.set[FROST_ATTR.chromeFrost]).toBe('strong');
    expect(target.set[FROST_ATTR.terminalFrost]).toBe('strong');
  });

  it('ignores settings:changed for an unrelated key', async () => {
    mockValues(false, 'subtle', 'off');
    const target = fakeTarget();
    rt.render(() => useFrostedGlassAttributes(target));
    await flush();
    invoke.mockClear();

    listeners[0]?.({ key: 'window_opacity' });
    await flush();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('cleans up its settings:changed subscription on unmount', async () => {
    mockValues(false, 'subtle', 'off');
    const target = fakeTarget();
    rt.render(() => useFrostedGlassAttributes(target));
    await flush();
    rt.unmount();
    expect(offs[0]).toHaveBeenCalled();
  });

  it('on linux, applies data-platform="linux" live when Frosted chrome turns on, then removes every frost attribute when it turns off', async () => {
    Object.assign(api, { platform: 'linux' });
    mockValues(false, 'medium', 'medium');
    const target = fakeTarget();
    rt.render(() => useFrostedGlassAttributes(target));
    await flush();
    expect(target.set).toEqual({ [FROST_ATTR.transparentWindow]: '' });

    mockValues(true, 'medium', 'medium');
    listeners[0]?.({ key: FROSTED_GLASS_KEYS.frostChrome });
    await flush();
    expect(target.set).toEqual({
      [FROST_ATTR.platform]: 'linux',
      [FROST_ATTR.chromeFrost]: 'medium',
      [FROST_ATTR.terminalFrost]: 'medium',
      [FROST_ATTR.transparentWindow]: '',
    });

    mockValues(false, 'medium', 'medium');
    listeners[0]?.({ key: FROSTED_GLASS_KEYS.frostChrome });
    await flush();
    expect(target.set).toEqual({ [FROST_ATTR.transparentWindow]: '' });
  });
});
