import { describe, it, expect } from 'vitest';
import type { IpcMain } from 'electron';
import { registerIpc } from '@main/ipc/register';

function fakeIpcMain(): IpcMain & { handlers: Map<string, (e: unknown, req: unknown) => Promise<unknown>> } {
  const handlers = new Map<string, (e: unknown, req: unknown) => Promise<unknown>>();
  return {
    handle: (channel: string, fn: (e: unknown, req: unknown) => Promise<unknown>) => handlers.set(channel, fn),
    handlers,
  } as unknown as ReturnType<typeof fakeIpcMain>;
}

describe('registerIpc', () => {
  it('registers every declared channel', async () => {
    const ipc = fakeIpcMain();
    const services = {} as unknown as Parameters<typeof registerIpc>[1]; // handlers are not invoked in this test
    registerIpc(ipc as unknown as IpcMain, services, () => {});
    const expected = [
      'roots:list', 'roots:add', 'roots:remove', 'roots:rescan',
      'projects:list', 'projects:open', 'projects:pin', 'projects:hide',
      'projects:update-config', 'projects:recents',
      'shells:launch', 'shells:kill', 'shells:resize', 'shells:write',
      'shells:alive-list', 'shells:pin',
      'settings:get', 'settings:set',
      'files:tree', 'app:ping',
    ];
    for (const c of expected) expect(ipc.handlers.has(c)).toBe(true);
  });
});
