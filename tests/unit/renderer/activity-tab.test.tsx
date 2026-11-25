// @vitest-environment jsdom
/** ActivityTab renders entries that have no matching pair (a tool without a result, a turn end without a prompt) without error (AC14). */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActivityEntry } from '@shared/activity';

const bridge = vi.hoisted(() => ({
  entries: [] as unknown[],
  listeners: new Set<(ev: unknown) => void>(),
  remote: vi.fn<() => Promise<unknown>>(),
}));

vi.mock('@renderer/api', () => ({
  api: {
    invoke: vi.fn(async (channel: string) => channel === 'p2p:rpc-call'
      ? { result: await bridge.remote() }
      : { entries: bridge.entries }),
    on: vi.fn((_channel: string, listener: (ev: unknown) => void) => {
      bridge.listeners.add(listener);
      return () => { bridge.listeners.delete(listener); };
    }),
  },
}));

import { ActivityTab } from '@renderer/components/ActivityTab';
import { api } from '@renderer/api';
import { remoteWorkspace } from '@renderer/p2p/remote-workspace';

const base = { ts: '2026-01-01T10:00:00.000Z', agent: 'claude', shellIndex: 0 };
const preToolOnly: ActivityEntry = { ...base, id: 'a', kind: 'tool', tool: 'Bash', target: 'ls unpaired-tool' };
const turnEndOnly: ActivityEntry = { ...base, id: 'b', kind: 'turn-end' };
const lateNotification: ActivityEntry = { ...base, id: 'c', kind: 'notification', text: 'live unpaired note' };

afterEach(() => {
  cleanup();
  bridge.listeners.clear();
  bridge.remote.mockReset();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('ActivityTab unpaired entries (AC14)', () => {
  it('renders listed and live unpaired entries without throwing or console errors', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    bridge.entries = [preToolOnly, turnEndOnly];
    render(<ActivityTab projectId={1} followFiles={false} onFollowFilesChange={() => {}} />);
    await screen.findByText('ls unpaired-tool');
    await act(async () => { for (const l of bridge.listeners) l({ projectId: 1, entry: lateNotification }); });
    const tab = document.querySelector('[data-testid="activity-tab"]')!;
    expect(tab.textContent).toContain('ls unpaired-tool');
    expect(tab.textContent).toContain('turn-end');
    expect(tab.textContent).toContain('live unpaired note');
    expect(tab.textContent).toContain('3 / 3');
    expect(error).not.toHaveBeenCalled();
  });
});

describe('ActivityTab remote timeline', () => {
  it('polls the paired project serially, opens remote targets and recovers without local IPC', async () => {
    vi.useFakeTimers();
    let finishRead: (result: unknown) => void = () => { throw new Error('expected a pending read'); };
    const file: ActivityEntry = { ...base, id: 'remote-edit', kind: 'tool', tool: 'Edit', target: 'src/remote.ts' };
    bridge.remote
      .mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve; }))
      .mockRejectedValueOnce(new Error('disconnected'))
      .mockResolvedValueOnce({ entries: [lateNotification] });
    const onOpenTarget = vi.fn();
    const view = render(<ActivityTab projectId={24} remote={remoteWorkspace('host-a')} followFiles={false}
      onFollowFilesChange={vi.fn()} onOpenTarget={onOpenTarget} />);

    expect(screen.getByRole('status').textContent).toContain('Loading remote activity');
    expect(screen.queryByLabelText('Follow files')).toBeNull();
    expect(screen.getByLabelText('Follow')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
    expect(api.invoke).toHaveBeenCalledTimes(1);
    expect(api.invoke).toHaveBeenCalledWith('p2p:rpc-call', {
      deviceId: 'host-a', method: 'workspace.activity', params: { projectId: 24 },
    });
    await act(async () => { finishRead({ entries: [file, preToolOnly] }); });
    fireEvent.click(screen.getByRole('button', { name: 'src/remote.ts' }));
    expect(onOpenTarget).toHaveBeenCalledWith('src/remote.ts');
    expect(screen.queryByRole('button', { name: preToolOnly.target })).toBeNull();

    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.getByRole('alert').textContent).toContain('Remote activity is unavailable');
    expect(screen.queryByText('src/remote.ts')).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.getByText('live unpaired note')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
    expect(bridge.remote).toHaveBeenCalledTimes(3);
    expect(api.invoke).toHaveBeenCalledTimes(3);
    expect(api.on).not.toHaveBeenCalled();
  });

  it('ignores a late result when another peer has the same project ID', async () => {
    let finishOld: (result: unknown) => void = () => { throw new Error('expected a pending read'); };
    bridge.remote
      .mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }))
      .mockResolvedValueOnce({ entries: [lateNotification] });
    function tab(device: string) {
      return <ActivityTab projectId={24} remote={remoteWorkspace(device)} followFiles={false} onFollowFilesChange={vi.fn()} />;
    }
    const view = render(tab('host-a'));
    view.rerender(tab('host-b'));
    await screen.findByText('live unpaired note');
    await act(async () => { finishOld({ entries: [preToolOnly] }); });
    expect(screen.queryByText('ls unpaired-tool')).toBeNull();
    expect(api.invoke).toHaveBeenLastCalledWith('p2p:rpc-call', {
      deviceId: 'host-b', method: 'workspace.activity', params: { projectId: 24 },
    });
  });
});
