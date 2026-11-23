import { beforeEach, describe, expect, test, vi } from 'vitest';
import { remoteWorkspace } from '../remote-workspace';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@renderer/api', () => ({ api: { invoke } }));

beforeEach(() => { invoke.mockReset(); });

describe('remoteWorkspace', () => {
  test('scopes each request to its captured machine, even when project IDs match', async () => {
    invoke.mockResolvedValueOnce({ result: { activityEnabled: true } })
      .mockResolvedValueOnce({ result: { activityEnabled: false } });
    const tower = remoteWorkspace('tower');
    const laptop = remoteWorkspace('laptop');
    await expect(tower.call('workspace.info', { projectId: 1 })).resolves.toEqual({ activityEnabled: true });
    await expect(laptop.call('workspace.info', { projectId: 1 })).resolves.toEqual({ activityEnabled: false });
    expect(invoke.mock.calls).toEqual([
      ['p2p:rpc-call', { deviceId: 'tower', method: 'workspace.info', params: { projectId: 1 } }],
      ['p2p:rpc-call', { deviceId: 'laptop', method: 'workspace.info', params: { projectId: 1 } }],
    ]);
  });

  test('rejects invalid responses rather than coercing remote data into view state', async () => {
    invoke.mockResolvedValueOnce({ result: { activityEnabled: 'false' } });
    await expect(remoteWorkspace('tower').call('workspace.info', { projectId: 1 })).rejects.toThrow();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  test('propagates old-host errors without falling back to local IPC', async () => {
    const error = new Error('unknown_method');
    invoke.mockRejectedValueOnce(error);
    await expect(remoteWorkspace('tower').call('workspace.fileTree', { projectId: 1 })).rejects.toBe(error);
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
