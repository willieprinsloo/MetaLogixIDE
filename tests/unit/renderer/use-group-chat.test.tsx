// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, renderHook, waitFor, act } from '@testing-library/react';
import type { GroupView } from '@shared/group-chat';

/**
 * Isolate the hook's two behaviours: initial load from `groups:list`, and
 * re-fetch on `groups:changed` for the hook's own project. Other projects'
 * events must not trigger a re-fetch — the dock is project-scoped and a
 * global refresh would churn every tab in the IDE.
 */
let nextListResponse: { groups: GroupView[] } = { groups: [] };
const listCalls: Array<{ projectId: number }> = [];
let changedHandler: ((p: { projectId: number }) => void) | null = null;

vi.mock('@renderer/api', () => ({
  api: {
    invoke: vi.fn().mockImplementation((ch: string, req: unknown) => {
      if (ch === 'groups:list') {
        listCalls.push(req as { projectId: number });
        return Promise.resolve(nextListResponse);
      }
      return Promise.resolve({});
    }),
    on: vi.fn().mockImplementation((ch: string, cb: (p: { projectId: number }) => void) => {
      if (ch === 'groups:changed') changedHandler = cb;
      return () => { changedHandler = null; };
    }),
  },
}));

import { useGroupChat } from '@renderer/hooks/useGroupChat';

const mkGroup = (id: string, status: GroupView['status']): GroupView => ({
  id, projectId: 1, projectName: 'p', name: id, members: [], memberInfo: {},
  maxRounds: 4, status, round: null, k: 0, seq: 0, held: [], joined: [], log: [],
  createdAt: '2026-11-20T00:00:00Z', updatedAt: '2026-11-20T00:00:00Z',
});

afterEach(() => {
  cleanup();
  listCalls.length = 0;
  changedHandler = null;
  nextListResponse = { groups: [] };
});

describe('useGroupChat', () => {
  it('loads the project\'s groups on mount', async () => {
    nextListResponse = { groups: [mkGroup('g1', 'idle')] };
    const { result } = renderHook(() => useGroupChat(1));
    await waitFor(() => expect(result.current.groups.length).toBe(1));
    expect(listCalls).toEqual([{ projectId: 1 }]);
  });

  it('exposes the first running group as `running`, nothing else', async () => {
    // Several groups per project are possible (one running, past ones
    // stopped); the dock needs the single "active" one for the Stop control.
    nextListResponse = { groups: [mkGroup('g1', 'stopped'), mkGroup('g2', 'running')] };
    const { result } = renderHook(() => useGroupChat(1));
    await waitFor(() => expect(result.current.running?.id).toBe('g2'));
  });

  it('exposes null when no group is running, even if stopped groups exist', async () => {
    nextListResponse = { groups: [mkGroup('g1', 'stopped')] };
    const { result } = renderHook(() => useGroupChat(1));
    await waitFor(() => expect(result.current.groups.length).toBe(1));
    expect(result.current.running).toBeNull();
  });

  it('re-fetches when groups:changed fires for this project', async () => {
    nextListResponse = { groups: [] };
    const { result } = renderHook(() => useGroupChat(5));
    await waitFor(() => expect(listCalls.length).toBe(1));
    // Simulate the main process broadcasting a change for project 5.
    nextListResponse = { groups: [mkGroup('g1', 'running')] };
    act(() => { changedHandler?.({ projectId: 5 }); });
    await waitFor(() => expect(result.current.running?.id).toBe('g1'));
  });

  it('ignores groups:changed for other projects', async () => {
    // A noisy neighbour (another project's group changing) must not cause
    // this dock to re-fetch — the IDE can have many project docks open.
    nextListResponse = { groups: [] };
    renderHook(() => useGroupChat(5));
    await waitFor(() => expect(listCalls.length).toBe(1));
    act(() => { changedHandler?.({ projectId: 99 }); });
    // Wait a tick in case the fetch were (incorrectly) scheduled.
    await new Promise((r) => setTimeout(r, 10));
    expect(listCalls.length).toBe(1);
  });

  it('survives a rejected groups:list (headless test env, no groupChat wired)', async () => {
    const { api } = await import('@renderer/api');
    (api.invoke as unknown as { mockImplementationOnce: (fn: () => Promise<unknown>) => void })
      .mockImplementationOnce(() => Promise.reject(new Error('group chats are not ready yet')));
    const { result } = renderHook(() => useGroupChat(1));
    // Hook never throws; `groups` stays at its initial empty value.
    await new Promise((r) => setTimeout(r, 10));
    expect(result.current.groups).toEqual([]);
    expect(result.current.running).toBeNull();
  });
});
