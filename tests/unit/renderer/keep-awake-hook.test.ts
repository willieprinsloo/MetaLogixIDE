import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IpcEvents } from '@shared/ipc-contract';
import { KEEP_AWAKE_COPY, type KeepAwakeState } from '@shared/keep-awake-contract';

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

const toast = vi.hoisted(() => vi.fn());
vi.mock('@renderer/hooks/useToasts', () => ({ toast }));

type Listener = (payload: unknown) => void;
const listeners = new Map<string, Set<Listener>>();
const invoke = vi.fn();
const fakeApi = {
  platform: 'darwin',
  invoke,
  on: vi.fn((channel: string, cb: Listener) => {
    const set = listeners.get(channel) ?? new Set<Listener>();
    set.add(cb);
    listeners.set(channel, set);
    return () => { set.delete(cb); };
  }),
};
vi.mock('@renderer/api', () => ({ api: fakeApi }));

const { useKeepAwake } = await import('@renderer/hooks/useKeepAwake');

const NOW = new Date(2026, 9, 19, 10, 0, 0).getTime();
const emit = <E extends keyof IpcEvents>(channel: E, payload: IpcEvents[E]) => {
  for (const l of listeners.get(channel) ?? []) l(payload);
};
const flush = () => new Promise((r) => setTimeout(r, 0));
const mount = () => {
  const read = () => rt.render(() => useKeepAwake());
  read();
  return read;
};
const on: KeepAwakeState = { active: true, endsAt: NOW + 3_600_000 };

beforeEach(() => {
  rt.reset();
  listeners.clear();
  invoke.mockReset();
  toast.mockReset();
  fakeApi.on.mockClear();
  fakeApi.platform = 'darwin';
  invoke.mockImplementation(async (channel: string) => (channel === 'keep-awake:get' ? { active: false } : { active: false }));
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  rt.unmount();
  vi.useRealTimers();
});

describe('useKeepAwake off macOS', () => {
  it('returns null and never touches IPC (AC16)', async () => {
    fakeApi.platform = 'linux';
    const read = mount();
    await flush();
    expect(read()).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
    expect(fakeApi.on).not.toHaveBeenCalled();
  });
});

describe('useKeepAwake on macOS', () => {
  it('starts inactive and reads the main-process state once at mount', async () => {
    invoke.mockResolvedValueOnce(on);
    const read = mount();
    expect(read()?.state).toEqual({ active: false });
    await flush();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('keep-awake:get', undefined);
    expect(read()?.state).toEqual(on);
  });

  it('follows keep-awake:changed', async () => {
    const read = mount();
    await flush();
    emit('keep-awake:changed', on);
    expect(read()?.state).toEqual(on);
    emit('keep-awake:changed', { active: false });
    expect(read()?.state).toEqual({ active: false });
  });

  it('does not let a late get response overwrite a newer changed event', async () => {
    let resolveGet: (s: KeepAwakeState) => void = () => {};
    invoke.mockImplementationOnce(() => new Promise((r) => { resolveGet = r; }));
    const read = mount();
    emit('keep-awake:changed', on);
    resolveGet({ active: false });
    await flush();
    expect(read()?.state).toEqual(on);
  });

  it('unsubscribes on unmount', async () => {
    mount();
    await flush();
    rt.unmount();
    expect([...listeners.values()].every((s) => s.size === 0)).toBe(true);
  });

  it('shows one warning toast with the contract copy on keep-awake:darken-failed (AC8)', async () => {
    mount();
    await flush();
    emit('keep-awake:darken-failed', {});
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(KEEP_AWAKE_COPY.toast.darkenFailed, {
      kind: 'warning',
      detail: KEEP_AWAKE_COPY.toast.darkenFailedDetail,
    });
  });

  it('startUntil sends the given endsAt and adopts the returned state', async () => {
    const read = mount();
    await flush();
    invoke.mockResolvedValueOnce({ ok: true, state: on });
    await read()?.startUntil(on.endsAt);
    expect(invoke).toHaveBeenLastCalledWith('keep-awake:start', { endsAt: on.endsAt });
    expect(read()?.state).toEqual(on);
    expect(toast).not.toHaveBeenCalled();
  });

  it('start(ms) sends now + ms', async () => {
    const read = mount();
    await flush();
    invoke.mockResolvedValueOnce({ ok: true, state: on });
    await read()?.start(30 * 60_000);
    expect(invoke).toHaveBeenLastCalledWith('keep-awake:start', { endsAt: NOW + 30 * 60_000 });
  });

  it('toasts an error and keeps the state when start answers ok:false', async () => {
    const read = mount();
    await flush();
    invoke.mockResolvedValueOnce({ ok: false, error: 'invalid' });
    await read()?.startUntil(NOW - 1);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(KEEP_AWAKE_COPY.toast.startFailed, { kind: 'error' });
    expect(read()?.state).toEqual({ active: false });
  });

  it('toasts an error when the start call rejects', async () => {
    const read = mount();
    await flush();
    invoke.mockRejectedValueOnce(new Error('ipc down'));
    await read()?.startUntil(NOW + 1000);
    expect(toast).toHaveBeenCalledWith(KEEP_AWAKE_COPY.toast.startFailed, { kind: 'error' });
  });

  it('stop invokes keep-awake:stop and adopts the returned state', async () => {
    const read = mount();
    await flush();
    emit('keep-awake:changed', on);
    invoke.mockResolvedValueOnce({ active: false });
    await read()?.stop();
    expect(invoke).toHaveBeenLastCalledWith('keep-awake:stop', undefined);
    expect(read()?.state).toEqual({ active: false });
  });

  it('darkenNow invokes keep-awake:darken', async () => {
    const read = mount();
    await flush();
    invoke.mockResolvedValueOnce({ ok: true });
    await read()?.darkenNow();
    expect(invoke).toHaveBeenLastCalledWith('keep-awake:darken', undefined);
  });
});
