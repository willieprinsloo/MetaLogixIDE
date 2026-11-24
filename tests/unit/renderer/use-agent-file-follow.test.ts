// @vitest-environment jsdom
/** Agent file-follow: live-opens agent-edited files from activity events, gated by a persisted toggle. */
import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActivityEntry } from '@shared/activity';

const bridge = vi.hoisted(() => ({
  listeners: new Map<string, Set<(ev: unknown) => void>>(),
}));

vi.mock('@renderer/api', () => ({
  api: {
    on: (channel: string, listener: (ev: unknown) => void) => {
      if (channel !== 'activity:changed') throw new Error(`unexpected channel ${channel}`);
      const set = bridge.listeners.get(channel) ?? new Set<(ev: unknown) => void>();
      set.add(listener);
      bridge.listeners.set(channel, set);
      return () => { set.delete(listener); };
    },
  },
}));

import { useAgentFileFollow } from '@renderer/hooks/useAgentFileFollow';

const emit = (ev: { projectId: number; entry: ActivityEntry }) => {
  for (const cb of bridge.listeners.get('activity:changed') ?? []) cb(ev);
};

const edit = (ok: boolean | undefined, target = '/work/1/docs/a.md'): ActivityEntry => ({
  id: 'x', ts: '2026-11-14T00:00:00.000Z', agent: 'claude', shellIndex: 0, kind: 'tool',
  tool: 'Edit', ...(ok === undefined ? {} : { ok }), target,
});

afterEach(() => { bridge.listeners.clear(); });

describe('useAgentFileFollow', () => {
  it('fires onFile for a successful PostToolUse Edit', () => {
    const onFile = vi.fn();
    renderHook(() => useAgentFileFollow(1, true, onFile));
    emit({ projectId: 1, entry: edit(true) });
    expect(onFile).toHaveBeenCalledWith('/work/1/docs/a.md');
  });
  it('ignores PreToolUse entries (ok undefined)', () => {
    const onFile = vi.fn();
    renderHook(() => useAgentFileFollow(1, true, onFile));
    emit({ projectId: 1, entry: edit(undefined) });
    expect(onFile).not.toHaveBeenCalled();
  });
  it('ignores failed PostToolUse entries', () => {
    const onFile = vi.fn();
    renderHook(() => useAgentFileFollow(1, true, onFile));
    emit({ projectId: 1, entry: edit(false) });
    expect(onFile).not.toHaveBeenCalled();
  });
  it('ignores events for other projects', () => {
    const onFile = vi.fn();
    renderHook(() => useAgentFileFollow(1, true, onFile));
    emit({ projectId: 2, entry: edit(true) });
    expect(onFile).not.toHaveBeenCalled();
  });
  it('ignores non-file tools', () => {
    const onFile = vi.fn();
    renderHook(() => useAgentFileFollow(1, true, onFile));
    emit({ projectId: 1, entry: { id: 'x', ts: '2026-11-14T00:00:00.000Z', agent: 'claude', shellIndex: 0, kind: 'tool', tool: 'Bash', ok: true, target: 'git status' } });
    expect(onFile).not.toHaveBeenCalled();
  });
  it('subscribes nothing when disabled', () => {
    const onFile = vi.fn();
    renderHook(() => useAgentFileFollow(1, false, onFile));
    expect(bridge.listeners.get('activity:changed')?.size ?? 0).toBe(0);
    emit({ projectId: 1, entry: edit(true) });
    expect(onFile).not.toHaveBeenCalled();
  });
  it('unsubscribes on unmount', () => {
    const onFile = vi.fn();
    const { unmount } = renderHook(() => useAgentFileFollow(1, true, onFile));
    unmount();
    expect(bridge.listeners.get('activity:changed')?.size ?? 0).toBe(0);
  });
});
