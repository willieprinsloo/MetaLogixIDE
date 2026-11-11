import { beforeEach, describe, expect, it, vi } from 'vitest';
import { startReceivers } from '@main/startup/receivers';

type ReceiverServices = Parameters<typeof startReceivers>[0];

describe('startReceivers', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  beforeEach(() => warn.mockClear());

  function makeServices(hookStart: () => Promise<void>) {
    const start = vi.fn(hookStart);
    return { start, services: { hookRuntime: { start } } as unknown as ReceiverServices };
  }

  it('starts the Claude hook receiver', async () => {
    const { services, start } = makeServices(async () => undefined);
    await startReceivers(services);
    expect(start).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('degrades when the Claude hook receiver fails', async () => {
    const { services } = makeServices(async () => { throw new Error('port in use'); });
    await expect(startReceivers(services)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('[metaide] Claude hook receiver unavailable; Claude hook notifications disabled');
  });
});
