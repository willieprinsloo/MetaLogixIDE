/**
 * The launch coalescer must return the same promise to concurrent callers
 * for the same (projectId, shellIndex) so the underlying `spawn` runs once.
 * Different keys stay independent, and a rejected task clears its slot so
 * the next caller starts fresh.
 */
import { describe, it, expect, vi } from 'vitest';
import { LaunchCoalescer, launchKey } from '@main/ipc/shells-launch-coalesce';

function pending<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((r, j) => { resolve = r; reject = j; });
  return { promise, resolve, reject };
}

describe('LaunchCoalescer', () => {
  it('runs the task once for two concurrent calls on the same key, both callers get the same result', async () => {
    const c = new LaunchCoalescer<{ shellIndex: number }>();
    const gate = pending<{ shellIndex: number }>();
    const task = vi.fn().mockReturnValue(gate.promise);

    const key = launchKey(1, 0);
    const a = c.run(key, task);
    const b = c.run(key, task);
    expect(task).toHaveBeenCalledTimes(1);

    gate.resolve({ shellIndex: 0 });
    await expect(a).resolves.toEqual({ shellIndex: 0 });
    await expect(b).resolves.toEqual({ shellIndex: 0 });
  });

  it('clears the slot once the task settles — a later call runs the task again', async () => {
    const c = new LaunchCoalescer<number>();
    const first = pending<number>();
    const taskA = vi.fn().mockReturnValue(first.promise);
    const key = launchKey(2, 0);
    const a = c.run(key, taskA);
    first.resolve(1);
    await expect(a).resolves.toBe(1);
    expect(c.has(key)).toBe(false);

    const second = pending<number>();
    const taskB = vi.fn().mockReturnValue(second.promise);
    const b = c.run(key, taskB);
    expect(taskB).toHaveBeenCalledTimes(1);
    second.resolve(2);
    await expect(b).resolves.toBe(2);
  });

  it('a rejected task clears the slot so the next call is not blocked', async () => {
    const c = new LaunchCoalescer<number>();
    const first = pending<number>();
    const taskA = vi.fn().mockReturnValue(first.promise);
    const key = launchKey(3, 0);
    const a = c.run(key, taskA);
    first.reject(new Error('boom'));
    await expect(a).rejects.toThrow('boom');
    expect(c.has(key)).toBe(false);

    const taskB = vi.fn().mockResolvedValue(42);
    await expect(c.run(key, taskB)).resolves.toBe(42);
  });

  it('different keys do not interfere — the second task runs even while the first is still pending', async () => {
    const c = new LaunchCoalescer<number>();
    const g1 = pending<number>();
    const g2 = pending<number>();
    const taskA = vi.fn().mockReturnValue(g1.promise);
    const taskB = vi.fn().mockReturnValue(g2.promise);

    const a = c.run(launchKey(1, 0), taskA);
    const b = c.run(launchKey(2, 0), taskB);
    expect(taskA).toHaveBeenCalledTimes(1);
    expect(taskB).toHaveBeenCalledTimes(1);

    g2.resolve(20);
    await expect(b).resolves.toBe(20);
    g1.resolve(10);
    await expect(a).resolves.toBe(10);
  });

  it('launchKey formats as `<projectId>:<shellIndex>`', () => {
    expect(launchKey(7, 0)).toBe('7:0');
    expect(launchKey(42, 3)).toBe('42:3');
  });
});
