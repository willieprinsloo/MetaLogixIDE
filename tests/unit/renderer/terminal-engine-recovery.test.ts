import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openRecoverableTerminal, type TerminalRenderer } from '@renderer/terminal/terminal-engine-recovery';

function rig() {
  const ghostty = Promise.withResolvers<TerminalRenderer>();
  const standby = Promise.withResolvers<TerminalRenderer>();
  const candidate = { dispose: vi.fn() };
  const xterm = { dispose: vi.fn() };
  const events: string[] = [];
  const focus = vi.fn(() => true);
  const openGhostty = vi.fn<(signal: AbortSignal, fault: () => void) => Promise<TerminalRenderer>>(() => ghostty.promise);
  const promoteXterm = vi.fn<(signal: AbortSignal, restoreFocus: boolean) => Promise<TerminalRenderer>>(() => standby.promise);
  const view = openRecoverableTerminal({ openGhostty, promoteXterm, hasFocus: focus, onState: state => events.push(state.kind) });
  return { view, ghostty, standby, candidate, xterm, events, focus, openGhostty, promoteXterm };
}

describe('one-view renderer recovery', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }); });
  afterEach(() => vi.useRealTimers());

  it('keeps the candidate active once ready and does not promote on the expired load timer', async () => {
    const r = rig();
    r.ghostty.resolve(r.candidate);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(r.events).toEqual(['loading', 'ghostty']);
    expect(r.promoteXterm).not.toHaveBeenCalled();
    r.view.dispose();
    expect(r.candidate.dispose).toHaveBeenCalledOnce();
  });

  it('promotes at five seconds, never retries within the view, and disposes late Ghostty success', async () => {
    const r = rig();
    await vi.advanceTimersByTimeAsync(4999);
    expect(r.promoteXterm).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(r.events).toEqual(['loading', 'recovering']);
    expect(r.openGhostty.mock.calls[0]?.[0].aborted).toBe(true);
    expect(r.promoteXterm.mock.calls).toEqual([[expect.any(AbortSignal), true]]);
    r.standby.resolve(r.xterm);
    r.ghostty.resolve(r.candidate);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(r.events).toEqual(['loading', 'recovering', 'xterm']);
    expect(r.openGhostty).toHaveBeenCalledOnce();
    expect(r.candidate.dispose).toHaveBeenCalledOnce();
    expect(r.xterm.dispose).not.toHaveBeenCalled();
    r.view.dispose();
    expect(r.xterm.dispose).toHaveBeenCalledOnce();
  });

  it('starts fallback immediately for a rejected import instead of waiting on the load timeout', async () => {
    const r = rig();
    await vi.advanceTimersByTimeAsync(0);
    r.ghostty.reject(new Error('missing browser module'));
    await vi.advanceTimersByTimeAsync(0);
    expect(r.events).toEqual(['loading', 'recovering']);
    expect(r.promoteXterm).toHaveBeenCalledOnce();
    r.view.dispose();
  });

  it('disposes the failing renderer before promotion and neither steals focus nor promotes twice', async () => {
    const r = rig();
    r.focus.mockReturnValue(false);
    r.promoteXterm.mockImplementation(() => {
      expect(r.candidate.dispose).toHaveBeenCalledOnce();
      return r.standby.promise;
    });
    r.ghostty.resolve(r.candidate);
    await vi.advanceTimersByTimeAsync(8000);
    const fault = r.openGhostty.mock.calls[0]?.[1];
    expect(fault).toBeDefined();
    fault?.();
    fault?.();
    expect(r.events).toEqual(['loading', 'ghostty', 'recovering']);
    await vi.advanceTimersByTimeAsync(0);
    expect(r.promoteXterm.mock.calls).toEqual([[expect.any(AbortSignal), false]]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(r.events.at(-1)).toBe('failed');
    expect(r.promoteXterm.mock.calls[0]?.[0].aborted).toBe(true);
    r.standby.resolve(r.xterm);
    await vi.advanceTimersByTimeAsync(0);
    expect(r.xterm.dispose).toHaveBeenCalledOnce();
  });

  it('reports standby rejection without waiting for its deadline', async () => {
    const r = rig();
    await vi.advanceTimersByTimeAsync(0);
    r.ghostty.reject(new Error('compile failed'));
    await vi.advanceTimersByTimeAsync(0);
    r.standby.reject(new Error('standby failed'));
    await vi.advanceTimersByTimeAsync(0);
    expect(r.events).toEqual(['loading', 'recovering', 'failed']);
    expect(r.promoteXterm.mock.calls[0]?.[0].aborted).toBe(true);
  });

  it('ignores late faults and readiness after disposal', async () => {
    const r = rig();
    await vi.advanceTimersByTimeAsync(0);
    r.view.dispose();
    r.view.dispose();
    r.openGhostty.mock.calls[0]?.[1]();
    r.ghostty.resolve(r.candidate);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(r.events).toEqual(['loading']);
    expect(r.candidate.dispose).toHaveBeenCalledOnce();
    expect(r.promoteXterm).not.toHaveBeenCalled();
  });
});
