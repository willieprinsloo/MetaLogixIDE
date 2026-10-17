import { beforeEach, describe, expect, it, vi } from 'vitest';
import { startReceivers } from '@main/startup/receivers';

type ReceiverServices = Parameters<typeof startReceivers>[0];

describe('startReceivers', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  beforeEach(() => warn.mockClear());

  function makeServices(hookStart: () => Promise<void>, ompStart: () => Promise<void>) {
    const order: string[] = [];
    return {
      order,
      services: {
        hookRuntime: { start: vi.fn(async () => { order.push('hook:start'); await hookStart(); order.push('hook:done'); }) },
        ompReceiver: { start: vi.fn(async () => { order.push('omp:start'); await ompStart(); }) },
      } as unknown as ReceiverServices,
    };
  }

  it('starts the Claude hook receiver to completion before the OMP receiver', async () => {
    const { services, order } = makeServices(async () => undefined, async () => undefined);
    await startReceivers(services);
    expect(order).toEqual(['hook:start', 'hook:done', 'omp:start']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('degrades when the Claude hook receiver fails and still starts OMP', async () => {
    const { services, order } = makeServices(async () => { throw new Error('port in use'); }, async () => undefined);
    await expect(startReceivers(services)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('[metaide] Claude hook receiver unavailable; Claude hook notifications disabled');
    expect(order).toEqual(['hook:start', 'omp:start']);
  });

  it('degrades when the OMP receiver fails', async () => {
    const { services } = makeServices(async () => undefined, async () => { throw new Error('socket'); });
    await expect(startReceivers(services)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('[metaide] OMP status receiver unavailable; OMP launches remain runnable without status integration');
  });
});
