import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  KEEP_AWAKE_COPY,
  KEEP_AWAKE_DARKEN_DELAY_MS,
  KEEP_AWAKE_MAX_MS,
} from '@shared/keep-awake-contract';
import type { DarkenResult } from '@main/keep-awake/darken';
import { createKeepAwakeService } from '@main/keep-awake/service';

const T0 = 1_000_000;

function setup(darkenResult: DarkenResult = { ok: true }) {
  let clock = T0;
  const assertion = { hold: vi.fn(), release: vi.fn() };
  const darken = vi.fn(async () => darkenResult);
  const notify = vi.fn();
  const onChange = vi.fn();
  const onDarkenFailed = vi.fn();
  const svc = createKeepAwakeService({
    assertion,
    darken,
    notify,
    now: () => clock,
    timers: {
      setInterval: (f, ms) => setInterval(f, ms),
      clearInterval: (h) => clearInterval(h as NodeJS.Timeout),
      setTimeout: (f, ms) => setTimeout(f, ms),
      clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
    },
    onChange,
    onDarkenFailed,
  });
  return { svc, assertion, darken, notify, onChange, onDarkenFailed, setClock: (n: number) => (clock = n) };
}

describe('keep-awake service', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('starts: holds assertion, goes active, notifies change', () => {
    const t = setup();
    const r = t.svc.start(T0 + 60_000);
    expect(r).toEqual({ ok: true, state: { active: true, endsAt: T0 + 60_000 } });
    expect(t.svc.get()).toEqual({ active: true, endsAt: T0 + 60_000 });
    expect(t.assertion.hold).toHaveBeenCalledTimes(1);
    expect(t.onChange).toHaveBeenCalledWith({ active: true, endsAt: T0 + 60_000 });
  });

  it.each([
    ['equal to now', T0],
    ['in the past', T0 - 1],
    ['beyond 24 h', T0 + KEEP_AWAKE_MAX_MS + 1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('rejects endsAt %s without side effects', (_n, endsAt) => {
    const t = setup();
    expect(t.svc.start(endsAt)).toEqual({ ok: false, error: 'invalid' });
    expect(t.assertion.hold).not.toHaveBeenCalled();
    expect(t.onChange).not.toHaveBeenCalled();
    expect(t.svc.get()).toEqual({ active: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('accepts exactly now + 24 h', () => {
    const t = setup();
    expect(t.svc.start(T0 + KEEP_AWAKE_MAX_MS).ok).toBe(true);
  });

  it('invalid re-start keeps the running deadline', () => {
    const t = setup();
    t.svc.start(T0 + 60_000);
    t.svc.start(T0 - 5);
    expect(t.svc.get()).toEqual({ active: true, endsAt: T0 + 60_000 });
  });

  it('re-start moves the deadline without releasing or a second hold', () => {
    const t = setup();
    t.svc.start(T0 + 60_000);
    t.svc.start(T0 + 120_000);
    expect(t.svc.get()).toEqual({ active: true, endsAt: T0 + 120_000 });
    expect(t.assertion.hold).toHaveBeenCalledTimes(2);
    expect(t.assertion.release).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(2);
  });

  it('darkens once at the delay, not before', () => {
    const t = setup();
    t.svc.start(T0 + 60_000);
    vi.advanceTimersByTime(KEEP_AWAKE_DARKEN_DELAY_MS - 1);
    expect(t.darken).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(t.darken).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10_000);
    expect(t.darken).toHaveBeenCalledTimes(1);
  });

  it('re-start reschedules the darken', () => {
    const t = setup();
    t.svc.start(T0 + 60_000);
    vi.advanceTimersByTime(1000);
    t.svc.start(T0 + 90_000);
    vi.advanceTimersByTime(KEEP_AWAKE_DARKEN_DELAY_MS - 1);
    expect(t.darken).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(t.darken).toHaveBeenCalledTimes(1);
  });

  it('stop cancels a pending darken, releases synchronously, no notification', () => {
    const t = setup();
    t.svc.start(T0 + 60_000);
    expect(t.svc.stop()).toEqual({ active: false });
    expect(t.assertion.release).toHaveBeenCalledTimes(1);
    expect(t.onChange).toHaveBeenLastCalledWith({ active: false });
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5000);
    expect(t.darken).not.toHaveBeenCalled();
    expect(t.notify).not.toHaveBeenCalled();
  });

  it('stop while inactive is a quiet no-op', () => {
    const t = setup();
    expect(t.svc.stop()).toEqual({ active: false });
    expect(t.onChange).not.toHaveBeenCalled();
    expect(t.assertion.release).not.toHaveBeenCalled();
  });

  it('expires on the first tick after the wall clock passes endsAt, notifying once', () => {
    const t = setup();
    t.svc.start(T0 + 60_000);
    t.setClock(T0 + 59_999);
    vi.advanceTimersByTime(1000);
    expect(t.assertion.release).not.toHaveBeenCalled();
    t.setClock(T0 + 60_000);
    vi.advanceTimersByTime(1000);
    expect(t.assertion.release).toHaveBeenCalledTimes(1);
    expect(t.svc.get()).toEqual({ active: false });
    expect(t.onChange).toHaveBeenLastCalledWith({ active: false });
    expect(t.notify).toHaveBeenCalledTimes(1);
    expect(t.notify).toHaveBeenCalledWith(KEEP_AWAKE_COPY.notification.title, KEEP_AWAKE_COPY.notification.body);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5000);
    expect(t.notify).toHaveBeenCalledTimes(1);
  });

  it('expires after a wall-clock jump even though few timer ticks elapsed', () => {
    const t = setup();
    t.svc.start(T0 + 3_600_000);
    t.setClock(T0 + 7_200_000);
    vi.advanceTimersByTime(1000);
    expect(t.assertion.release).toHaveBeenCalledTimes(1);
  });

  it('expiry cancels a pending darken', () => {
    const t = setup();
    t.svc.start(T0 + 1000);
    t.setClock(T0 + 1000);
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(5000);
    expect(t.darken).not.toHaveBeenCalled();
  });

  it('darken failure signals onDarkenFailed and keeps keep-awake on', async () => {
    const t = setup({ ok: false, cause: new Error('x') });
    t.svc.start(T0 + 60_000);
    await vi.advanceTimersByTimeAsync(KEEP_AWAKE_DARKEN_DELAY_MS);
    expect(t.onDarkenFailed).toHaveBeenCalledTimes(1);
    expect(t.svc.get().active).toBe(true);
    expect(t.assertion.release).not.toHaveBeenCalled();
  });

  it('darken success does not signal failure', async () => {
    const t = setup();
    t.svc.start(T0 + 60_000);
    await vi.advanceTimersByTimeAsync(KEEP_AWAKE_DARKEN_DELAY_MS);
    expect(t.onDarkenFailed).not.toHaveBeenCalled();
  });

  it('darkenNow darkens immediately while active, reports inactive otherwise', () => {
    const t = setup();
    expect(t.svc.darkenNow()).toEqual({ ok: false, error: 'inactive' });
    expect(t.darken).not.toHaveBeenCalled();
    t.svc.start(T0 + 60_000);
    expect(t.svc.darkenNow()).toEqual({ ok: true });
    expect(t.darken).toHaveBeenCalledTimes(1);
  });

  it('darkenNow cancels the pending scheduled darken so it darkens once', async () => {
    const t = setup();
    t.svc.start(T0 + 60_000);
    await vi.advanceTimersByTimeAsync(500);
    t.svc.darkenNow();
    await vi.advanceTimersByTimeAsync(KEEP_AWAKE_DARKEN_DELAY_MS);
    expect(t.darken).toHaveBeenCalledTimes(1);
  });

  it('a failing darken settling after stop does not signal failure', async () => {
    const t = setup();
    let settle: (r: DarkenResult) => void = () => undefined;
    t.darken.mockImplementationOnce(() => new Promise<DarkenResult>((res) => (settle = res)));
    t.svc.start(T0 + 60_000);
    await vi.advanceTimersByTimeAsync(KEEP_AWAKE_DARKEN_DELAY_MS);
    t.svc.stop();
    settle({ ok: false, cause: new Error('late') });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.onDarkenFailed).not.toHaveBeenCalled();
  });

  it('a failing darken settling while active signals failure once', async () => {
    const t = setup();
    let settle: (r: DarkenResult) => void = () => undefined;
    t.darken.mockImplementationOnce(() => new Promise<DarkenResult>((res) => (settle = res)));
    t.svc.start(T0 + 60_000);
    await vi.advanceTimersByTimeAsync(KEEP_AWAKE_DARKEN_DELAY_MS);
    settle({ ok: false, cause: new Error('late') });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.onDarkenFailed).toHaveBeenCalledTimes(1);
  });

  it('dispose releases, clears all timers and posts nothing', () => {
    const t = setup();
    t.svc.start(T0 + 60_000);
    t.svc.dispose();
    expect(t.assertion.release).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(t.notify).not.toHaveBeenCalled();
    expect(t.svc.get()).toEqual({ active: false });
  });

  it('has no timers while inactive', () => {
    const t = setup();
    expect(vi.getTimerCount()).toBe(0);
    t.svc.start(T0 + 60_000);
    t.svc.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
