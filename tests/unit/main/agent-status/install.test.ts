import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { installAgentStatus } from '@main/agent-status/install';

class FakePty extends EventEmitter {
  agent: 'claude' | null = null;
  rows: string[] = [];
  liveShell(): { pid: number; generation: string; agent: 'claude' | null } { return { pid: 12, generation: 'g1', agent: this.agent }; }
  async liveStatus(): Promise<{ rows: string[]; title: string }> { return { rows: this.rows, title: '' }; }
}

describe('status installer', () => {
  it('broadcasts a spawned agent shell and clears it on exit', () => {
    const ptyManager = new FakePty();
    ptyManager.agent = 'claude';
    const broadcast = vi.fn();
    const { tracker, stop } = installAgentStatus({ ptyManager, broadcast, platform: 'win32' });
    ptyManager.emit('spawn', { projectId: 2, shellIndex: 1, pid: 12, generation: 'g1', agent: 'claude' });
    expect(broadcast).toHaveBeenLastCalledWith('agent-state:changed', { projectId: 2, shellIndex: 1, agent: 'claude', state: 'idle' });
    ptyManager.emit('status-exit', { projectId: 2, shellIndex: 1, pid: 12, generation: 'g1', agent: 'claude' });
    expect(broadcast).toHaveBeenLastCalledWith('agent-state:changed', { projectId: 2, shellIndex: 1, agent: null, state: 'idle' });
    expect(tracker.list()).toEqual([]);
    stop();
  });
  it('samples a manually launched POSIX Claude and clears it when the foreground changes', async () => {
    vi.useFakeTimers();
    try {
      const ptyManager = new FakePty();
      ptyManager.agent = null;
      ptyManager.rows = ['✳ Thinking…', 'esc to interrupt'];
      const observeForeground = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      const broadcast = vi.fn();
      const { tracker, stop } = installAgentStatus({
        ptyManager, broadcast, platform: 'darwin', observeForeground,
      });
      try {
        ptyManager.emit('spawn', { projectId: 2, shellIndex: 1, pid: 12, generation: 'g1', agent: null });
        await vi.advanceTimersByTimeAsync(250);
        expect(tracker.list()).toEqual([{ projectId: 2, shellIndex: 1, agent: 'claude', state: 'busy' }]);
        expect(observeForeground).toHaveBeenCalledWith(12);
        expect(broadcast).toHaveBeenLastCalledWith('agent-state:changed', {
          projectId: 2, shellIndex: 1, agent: 'claude', state: 'busy',
        });
        await vi.advanceTimersByTimeAsync(250);
        expect(tracker.list()).toEqual([]);
        expect(broadcast).toHaveBeenLastCalledWith('agent-state:changed', {
          projectId: 2, shellIndex: 1, agent: null, state: 'idle',
        });
      } finally {
        stop();
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
