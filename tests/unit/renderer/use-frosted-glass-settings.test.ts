/**
 * `useFrostedGlassSettings` loads the four frosted-glass settings on mount and saves each
 * through its dedicated validated channel, reverting the optimistic update and logging when a
 * save is refused or the IPC call rejects (AC28). Runs under a minimal in-test React runtime
 * (vitest runs in node, without a DOM renderer), mirroring
 * `tests/unit/renderer/settings/frost-terminal-row.test.tsx` and
 * `tests/unit/renderer/use-frosted-glass-attributes.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FROSTED_GLASS_KEYS } from '@shared/frosted-glass';

const rt = vi.hoisted(() => {
  type Effect = { deps?: unknown[]; cleanup?: () => void; run?: () => unknown };
  const effects: Effect[] = [];
  const slots: unknown[] = [];
  let effectCursor = 0;
  let stateCursor = 0;
  const changed = (a: unknown[] | undefined, b: unknown[] | undefined) =>
    !a || !b || a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]));
  return {
    reset() { effects.length = 0; slots.length = 0; },
    render<T>(fn: () => T): T {
      effectCursor = 0;
      stateCursor = 0;
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
    useState<S>(init: S | (() => S)) {
      const i = stateCursor++;
      if (!(i in slots)) slots[i] = typeof init === 'function' ? (init as () => S)() : init;
      const set = (v: S | ((p: S) => S)) => { slots[i] = typeof v === 'function' ? (v as (p: S) => S)(slots[i] as S) : v; };
      return [slots[i] as S, set] as const;
    },
  };
});

vi.mock('react', async (orig) => {
  const real = await orig<typeof import('react')>();
  return {
    ...real,
    useEffect: rt.useEffect,
    useState: (<S>(init: S | (() => S)) => rt.useState(init)) as typeof real.useState,
  };
});

const invoke = vi.fn<(channel: string, req: unknown) => Promise<unknown>>();
vi.mock('@renderer/api', () => ({ api: { invoke: (...args: [string, unknown]) => invoke(...args) } }));

const { useFrostedGlassSettings } = await import('@renderer/hooks/useFrostedGlassSettings');

const flush = () => new Promise((r) => setTimeout(r, 0));

function mockLoad(frostChrome: unknown, chromeLevel: unknown, terminalLevel: unknown, material: unknown): void {
  invoke.mockImplementation(async (channel: string, req: unknown) => {
    if (channel !== 'settings:get') return { ok: true };
    const key = (req as { key?: string }).key;
    if (key === FROSTED_GLASS_KEYS.frostChrome) return { value: frostChrome };
    if (key === FROSTED_GLASS_KEYS.chromeFrostLevel) return { value: chromeLevel };
    if (key === FROSTED_GLASS_KEYS.terminalFrostLevel) return { value: terminalLevel };
    if (key === FROSTED_GLASS_KEYS.vibrancyMaterial) return { value: material };
    return { value: null };
  });
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  rt.reset();
  invoke.mockReset();
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  rt.unmount();
  errorSpy.mockRestore();
});

describe('useFrostedGlassSettings — load on mount', () => {
  it('reads the four keys and applies the stored values', async () => {
    mockLoad(true, 'strong', 'medium', 'hud');
    const api = rt.render(() => useFrostedGlassSettings());
    await flush();
    const after = rt.render(() => useFrostedGlassSettings());
    expect(after.values).toEqual({
      frostChrome: true,
      chromeFrostLevel: 'strong',
      terminalFrostLevel: 'medium',
      vibrancyMaterial: 'hud',
    });
    void api;
  });

  it('AC18: an unknown stored material falls back to sidebar', async () => {
    mockLoad(false, 'subtle', 'off', 'not-a-real-material');
    rt.render(() => useFrostedGlassSettings());
    await flush();
    const after = rt.render(() => useFrostedGlassSettings());
    expect(after.values.vibrancyMaterial).toBe('sidebar');
  });

  it('AC34: never reads the legacy frost_terminal key', async () => {
    mockLoad(false, 'subtle', 'off', 'sidebar');
    rt.render(() => useFrostedGlassSettings());
    await flush();
    expect(invoke).not.toHaveBeenCalledWith('settings:get', { key: 'frost_terminal' });
  });
});

describe('useFrostedGlassSettings — setFrostChrome', () => {
  async function run(reply: () => Promise<unknown>) {
    mockLoad(false, 'subtle', 'off', 'sidebar');
    let api = rt.render(() => useFrostedGlassSettings());
    await flush();
    api = rt.render(() => useFrostedGlassSettings());
    invoke.mockReset();
    invoke.mockImplementation(reply as never);
    const pending = api.setFrostChrome(true);
    expect(rt.render(() => useFrostedGlassSettings()).values.frostChrome).toBe(true);
    await pending;
    expect(invoke).toHaveBeenCalledWith('settings:set-frost-chrome', { enabled: true });
    return rt.render(() => useFrostedGlassSettings()).values.frostChrome;
  }

  it('keeps the optimistic value when the save succeeds', async () => {
    expect(await run(async () => ({ ok: true }))).toBe(true);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('reverts and logs when the save is refused', async () => {
    expect(await run(async () => ({ ok: false, error: 'invalid' }))).toBe(false);
    expect(errorSpy).toHaveBeenCalled();
  });

  it('reverts and logs when the IPC call rejects', async () => {
    expect(await run(() => Promise.reject(new Error('ipc down')))).toBe(false);
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe('useFrostedGlassSettings — setChromeFrostLevel', () => {
  it('persists through settings:set-chrome-frost-level and reverts on refusal', async () => {
    mockLoad(true, 'subtle', 'off', 'sidebar');
    let api = rt.render(() => useFrostedGlassSettings());
    await flush();
    api = rt.render(() => useFrostedGlassSettings());
    invoke.mockReset();
    invoke.mockResolvedValue({ ok: false, error: 'invalid' });
    const pending = api.setChromeFrostLevel('strong');
    expect(rt.render(() => useFrostedGlassSettings()).values.chromeFrostLevel).toBe('strong');
    await pending;
    expect(invoke).toHaveBeenCalledWith('settings:set-chrome-frost-level', { level: 'strong' });
    expect(rt.render(() => useFrostedGlassSettings()).values.chromeFrostLevel).toBe('subtle');
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe('useFrostedGlassSettings — setTerminalFrostLevel', () => {
  it('persists through settings:set-terminal-frost-level and reverts on a rejected call', async () => {
    mockLoad(true, 'subtle', 'off', 'sidebar');
    let api = rt.render(() => useFrostedGlassSettings());
    await flush();
    api = rt.render(() => useFrostedGlassSettings());
    invoke.mockReset();
    invoke.mockImplementation(() => Promise.reject(new Error('ipc down')));
    const pending = api.setTerminalFrostLevel('medium');
    expect(rt.render(() => useFrostedGlassSettings()).values.terminalFrostLevel).toBe('medium');
    await pending;
    expect(invoke).toHaveBeenCalledWith('settings:set-terminal-frost-level', { level: 'medium' });
    expect(rt.render(() => useFrostedGlassSettings()).values.terminalFrostLevel).toBe('off');
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe('useFrostedGlassSettings — setVibrancyMaterial', () => {
  it('persists through settings:set-vibrancy-material and keeps the value on success', async () => {
    mockLoad(true, 'subtle', 'off', 'sidebar');
    let api = rt.render(() => useFrostedGlassSettings());
    await flush();
    api = rt.render(() => useFrostedGlassSettings());
    invoke.mockReset();
    invoke.mockResolvedValue({ ok: true });
    await api.setVibrancyMaterial('popover');
    expect(invoke).toHaveBeenCalledWith('settings:set-vibrancy-material', { material: 'popover' });
    expect(rt.render(() => useFrostedGlassSettings()).values.vibrancyMaterial).toBe('popover');
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe('useFrostedGlassSettings — overlapping saves', () => {
  async function loaded() {
    mockLoad(true, 'subtle', 'off', 'sidebar');
    rt.render(() => useFrostedGlassSettings());
    await flush();
    invoke.mockReset();
    return rt.render(() => useFrostedGlassSettings());
  }

  it('a slow refusal after a later successful save keeps the later value', async () => {
    let refuseA!: (r: unknown) => void;
    const api = await loaded();
    invoke.mockImplementationOnce(() => new Promise((r) => { refuseA = r; }));
    const slow = api.setChromeFrostLevel('medium');
    const next = rt.render(() => useFrostedGlassSettings());
    invoke.mockResolvedValueOnce({ ok: true });
    await next.setChromeFrostLevel('strong');
    refuseA({ ok: false, error: 'invalid' });
    await slow;
    expect(rt.render(() => useFrostedGlassSettings()).values.chromeFrostLevel).toBe('strong');
    expect(errorSpy).toHaveBeenCalled();
  });

  it('a slow rejection still reverts when no later save replaced its value', async () => {
    let rejectA!: (e: unknown) => void;
    const api = await loaded();
    invoke.mockImplementationOnce(() => new Promise((_, j) => { rejectA = j; }));
    const slow = api.setVibrancyMaterial('hud');
    rt.render(() => useFrostedGlassSettings());
    rejectA(new Error('ipc down'));
    await slow;
    expect(rt.render(() => useFrostedGlassSettings()).values.vibrancyMaterial).toBe('sidebar');
  });
});
