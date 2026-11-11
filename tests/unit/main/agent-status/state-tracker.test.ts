import { describe, expect, it, vi } from 'vitest';
import { AgentStatusTracker } from '@main/agent-status/state-tracker';

const shell = { projectId: 1, shellIndex: 0 };
const identity = { ...shell, pid: 10, generation: 'g1', agent: 'claude' as const };

describe('Agent status transitions', () => {
  it('uses app launch identity and current screen without consulting process sampling', async () => {
    let rows = ['> '];
    const observeForeground = vi.fn(async () => false);
    const liveShell = vi.fn(() => ({ pid: 10, generation: 'g1', agent: 'claude' as const }));
    const tracker = new AgentStatusTracker({ liveShell, liveStatus: async () => ({ rows, title: '' }) }, observeForeground, 'win32');
    tracker.spawn(identity);
    expect(tracker.list()).toEqual([{ ...shell, agent: 'claude', state: 'idle' }]);
    rows = ['✻ Thinking…', 'esc to interrupt'];
    await tracker.refresh();
    expect(tracker.list()[0]?.state).toBe('busy');
    rows = ['Allow Bash command?', 'Esc to cancel'];
    await tracker.refresh();
    expect(tracker.list()[0]?.state).toBe('blocked');
    rows = ['> '];
    await tracker.refresh();
    expect(tracker.list()[0]?.state).toBe('idle');
    expect(observeForeground).not.toHaveBeenCalled();
    tracker.exit(identity);
    expect(tracker.list()).toEqual([]);
  });

  it('publishes a title-driven Claude turn and clears it when the title becomes idle', async () => {
    let title = '◐ Claude Code';
    const liveShell = () => ({ pid: 10, generation: 'g1', agent: 'claude' as const });
    const tracker = new AgentStatusTracker(
      { liveShell, liveStatus: async () => ({ rows: ['❯ '], title }) },
      async () => false,
    );
    tracker.spawn(identity);
    await tracker.refresh();
    expect(tracker.list()[0]?.state).toBe('busy');
    title = '✳ Claude Code';
    await tracker.refresh();
    expect(tracker.list()[0]?.state).toBe('idle');
  });

  it('manual Windows remains idle and replaced generations reject old reports', async () => {
    const observed = vi.fn(async () => true);
    let generation = 'g1';
    const liveShell = vi.fn(() => ({ pid: 10, generation, agent: null }));
    const tracker = new AgentStatusTracker({ liveShell, liveStatus: async () => ({ rows: ['Allow Bash command?', 'Esc to cancel'], title: '' }) }, observed, 'win32');
    tracker.spawn({ ...identity, agent: null });
    await tracker.refresh();
    expect(tracker.list()).toEqual([]);
    expect(observed).not.toHaveBeenCalled();
  });
  it('manual POSIX Claude appears only while it owns the foreground and stale samples cannot revive it', async () => {
    let foreground = true;
    const observe = vi.fn(async () => foreground);
    const liveShell = () => ({ pid: 10, generation: 'g1', agent: null });
    const tracker = new AgentStatusTracker({ liveShell, liveStatus: async () => ({ rows: ['✻ Thinking…', 'esc to interrupt'], title: '' }) }, observe, 'darwin');
    tracker.spawn({ ...identity, agent: null });
    await tracker.refresh();
    expect(tracker.list()).toEqual([{ ...shell, agent: 'claude', state: 'busy' }]);
    foreground = false;
    await tracker.refresh();
    expect(tracker.list()).toEqual([]);
    expect(observe).toHaveBeenCalledWith(10);
  });
  it('fails guarded reads only for a failed sample and restores them after a successful sample', async () => {
    let unavailable = true;
    const tracker = new AgentStatusTracker({
      liveShell: () => ({ pid: 10, generation: 'g1', agent: 'claude' }),
      liveStatus: async () => {
        if (unavailable) throw new Error('screen unavailable');
        return { rows: ['✻ Thinking…', 'esc to interrupt'], title: '' };
      },
    }, async () => false, 'win32');
    tracker.spawn(identity);
    await tracker.refresh();
    expect(tracker.list()).toEqual([{ ...shell, agent: 'claude', state: 'idle' }]);
    expect(() => tracker.readForGuard(1, 0, 'g1')).toThrow('agent status unavailable');
    unavailable = false;
    await tracker.refresh();
    expect(tracker.readForGuard(1, 0, 'g1')).toEqual({ agent: 'claude', state: 'busy' });
  });

  it('fails a guarded read after a foreground-sample error but permits a later plain-shell result', async () => {
    let unavailable = true;
    const tracker = new AgentStatusTracker({
      liveShell: () => ({ pid: 10, generation: 'g1', agent: null }),
      liveStatus: async () => ({ rows: [], title: '' }),
    }, async () => {
      if (unavailable) throw new Error('foreground unavailable');
      return false;
    }, 'darwin');
    tracker.spawn({ ...identity, agent: null });
    await tracker.refresh();
    expect(() => tracker.readForGuard(1, 0, 'g1')).toThrow('agent status unavailable');
    unavailable = false;
    await tracker.refresh();
    expect(tracker.readForGuard(1, 0, 'g1')).toEqual({ agent: null, state: null });
  });

  it('never lends a prior generation failure or an unsampled idle state to a replacement', async () => {
    let generation = 'g1';
    let unavailable = true;
    const tracker = new AgentStatusTracker({
      liveShell: () => ({ pid: 10, generation, agent: 'claude' }),
      liveStatus: async () => {
        if (unavailable) throw new Error('old screen unavailable');
        return { rows: ['✻ Thinking…', 'esc to interrupt'], title: '' };
      },
    }, async () => false, 'win32');
    tracker.spawn(identity);
    await tracker.refresh();
    expect(() => tracker.readForGuard(1, 0, 'g1')).toThrow('agent status unavailable');
    generation = 'g2';
    tracker.spawn({ ...identity, generation: 'g2' });
    expect(() => tracker.readForGuard(1, 0, 'g1')).toThrow('agent status unavailable');
    expect(() => tracker.readForGuard(1, 0, 'g2')).toThrow('agent status unavailable');
    unavailable = false;
    await tracker.refresh();
    expect(tracker.readForGuard(1, 0, 'g2')).toEqual({ agent: 'claude', state: 'busy' });
  });
});
