import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRevealTimers, REVEAL_TIMEOUT_MS, rowRevealKey } from '@renderer/env-reveal';

describe('env reveal timers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('REVEAL_TIMEOUT_MS is 39 seconds (D1)', () => {
    expect(REVEAL_TIMEOUT_MS).toBe(39_000);
  });

  it('toggling a key reveals only that key', () => {
    const onChange = vi.fn();
    const t = createRevealTimers({ onChange });
    t.toggle('row:0');
    expect(t.isRevealed('row:0')).toBe(true);
    expect(t.isRevealed('row:1')).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('stays revealed just before the timeout and masks at the timeout', () => {
    const t = createRevealTimers({ onChange: vi.fn() });
    t.toggle('row:0');
    vi.advanceTimersByTime(REVEAL_TIMEOUT_MS - 100);
    expect(t.isRevealed('row:0')).toBe(true);
    vi.advanceTimersByTime(100);
    expect(t.isRevealed('row:0')).toBe(false);
  });

  it('each key has its own independent timer (AC23)', () => {
    const t = createRevealTimers({ onChange: vi.fn() });
    t.toggle('row:0');
    vi.advanceTimersByTime(20_000);
    t.toggle('row:1');
    vi.advanceTimersByTime(19_000); // t=39s: row:0 masks
    expect(t.isRevealed('row:0')).toBe(false);
    expect(t.isRevealed('row:1')).toBe(true);
    vi.advanceTimersByTime(20_000); // t=59s: row:1 masks
    expect(t.isRevealed('row:1')).toBe(false);
  });

  it('toggling a revealed key masks it immediately and cancels its timer', () => {
    const onChange = vi.fn();
    const t = createRevealTimers({ onChange });
    t.toggle('row:0');
    onChange.mockClear();
    t.toggle('row:0');
    expect(t.isRevealed('row:0')).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(1);
    // the cancelled timer must not fire and flip state again
    vi.advanceTimersByTime(REVEAL_TIMEOUT_MS);
    expect(t.isRevealed('row:0')).toBe(false);
  });

  it('revealing again after a manual hide starts a fresh full timeout (AC24)', () => {
    const t = createRevealTimers({ onChange: vi.fn() });
    t.toggle('row:0');
    vi.advanceTimersByTime(30_000);
    t.toggle('row:0'); // hide at t=30s
    t.toggle('row:0'); // reveal again at t=30s
    vi.advanceTimersByTime(REVEAL_TIMEOUT_MS - 100);
    expect(t.isRevealed('row:0')).toBe(true);
    vi.advanceTimersByTime(100);
    expect(t.isRevealed('row:0')).toBe(false);
  });

  it('clearAll hides everything and leaves no pending timers (AC25)', () => {
    const t = createRevealTimers({ onChange: vi.fn() });
    t.toggle('row:0');
    t.toggle('row:1');
    t.clearAll();
    expect(t.isRevealed('row:0')).toBe(false);
    expect(t.isRevealed('row:1')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('hide masks one key at once, cancels its timer and leaves the others revealed', () => {
    const onChange = vi.fn();
    const t = createRevealTimers({ onChange });
    t.toggle('row:0');
    t.toggle('row:1');
    onChange.mockClear();
    t.hide('row:0');
    expect(t.isRevealed('row:0')).toBe(false);
    expect(t.isRevealed('row:1')).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('hide of a masked key changes nothing and does not notify', () => {
    const onChange = vi.fn();
    const t = createRevealTimers({ onChange });
    t.hide('row:0');
    expect(t.isRevealed('row:0')).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('a key revealed again after hide gets a fresh full timeout', () => {
    const t = createRevealTimers({ onChange: vi.fn() });
    t.toggle('row:0');
    vi.advanceTimersByTime(30_000);
    t.hide('row:0');
    t.toggle('row:0');
    vi.advanceTimersByTime(REVEAL_TIMEOUT_MS - 100);
    expect(t.isRevealed('row:0')).toBe(true);
  });

  it('rowRevealKey namespaces an editable row key as row:<key>', () => {
    expect(rowRevealKey(3)).toBe('row:3');
  });

  it('respects a custom timeoutMs', () => {
    const t = createRevealTimers({ onChange: vi.fn(), timeoutMs: 1000 });
    t.toggle('row:0');
    vi.advanceTimersByTime(999);
    expect(t.isRevealed('row:0')).toBe(true);
    vi.advanceTimersByTime(1);
    expect(t.isRevealed('row:0')).toBe(false);
  });
});
