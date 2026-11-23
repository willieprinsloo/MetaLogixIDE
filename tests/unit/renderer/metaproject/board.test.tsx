// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { BoardLease, clipBoardBounds } from '@renderer/metaproject/BoardPanel';

const bridge = vi.hoisted(() => ({ invoke: vi.fn(), on: vi.fn<(channel: string, listener: (event: unknown) => void) => () => void>(() => () => {}) }));
vi.mock('@renderer/api', () => ({ api: bridge }));

it('clips inward at the IDE content boundary instead of covering adjacent chrome', () => {
  expect(clipBoardBounds({ left: -2, right: 920, top: 106.25, bottom: 601 }, 900, 600, 1)).toEqual({ x: 0, y: 107, width: 900, height: 493 });
  expect(clipBoardBounds({ left: 900, right: 910, top: 100, bottom: 200 }, 900, 600, 1)).toBeNull();
  expect(clipBoardBounds({ left: 10, right: 50, top: 20, bottom: 80 }, 100, 100, 2)).toEqual({ x: 20, y: 40, width: 80, height: 120 });
});

it('hides a covered lease and closes exactly that lease on unmount even before open resolves', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const viewId = '0856d88e-bbed-4f3e-8157-b9d3a4b34eea';
  vi.stubGlobal('crypto', { randomUUID: () => viewId });
  bridge.invoke.mockReset();
  bridge.invoke.mockImplementation((channel) => {
    if (channel === 'metaproject:board-open') return new Promise(() => {});
    if (channel === 'metaproject:board-layout' || channel === 'metaproject:board-close') return Promise.resolve({ ok: true });
    throw new Error(`Unexpected ${channel}`);
  });
  const node = document.body.appendChild(document.createElement('div'));
  const root = createRoot(node);
  const show = (covered: boolean) => <BoardLease projectId={2} revision={'a'.repeat(64)} epoch={4} covered={covered} />;
  try {
    await act(async () => root.render(show(false)));
    expect(bridge.invoke).toHaveBeenCalledWith('metaproject:board-open', { projectId: 2, revision: 'a'.repeat(64), viewId, epoch: 4 });
    await act(async () => root.render(show(true)));
    expect(bridge.invoke).toHaveBeenCalledWith('metaproject:board-layout', { viewId, bounds: null });
    await act(async () => root.render(null));
    expect(bridge.invoke).toHaveBeenCalledWith('metaproject:board-close', { viewId });
  } finally {
    act(() => root.unmount()); node.remove(); vi.unstubAllGlobals();
  }
});

it('requires confirmation for a candidate owned by the current Board lease', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const viewId = '0856d88e-bbed-4f3e-8157-b9d3a4b34eea';
  vi.stubGlobal('crypto', { randomUUID: () => viewId });
  const listeners = new Map<string, (event: unknown) => void>();
  bridge.on.mockImplementation((channel, listener) => { listeners.set(channel, listener); return () => { listeners.delete(channel); }; });
  const target = { projectId: 2, revision: 'a'.repeat(64), epoch: 4, viewId };
  bridge.invoke.mockReset();
  bridge.invoke.mockImplementation(async (channel) => {
    if (channel === 'metaproject:board-open') return { ok: true, value: { ...target, phase: 'loading' } };
    if (channel === 'metaproject:board-layout' || channel === 'metaproject:board-close' || channel === 'metaproject:board-external') return { ok: true };
    throw new Error(`Unexpected ${channel}`);
  });
  const node = document.body.appendChild(document.createElement('div'));
  const root = createRoot(node);
  const candidateId = '0856d88e-bbed-4f3e-8157-b9d3a4b34eeb';
  const confirm = () => [...node.querySelectorAll('button')].find((b) => b.textContent === 'Open external link');
  try {
    await act(async () => root.render(<BoardLease projectId={target.projectId} revision={target.revision} epoch={target.epoch} covered={false} />));
    const emit = listeners.get('metaproject:board-external-candidate');
    if (!emit) throw new Error('Candidate listener missing');
    await act(async () => emit({ ...target, epoch: 3, candidateId, label: 'outside.invalid' }));
    expect(confirm()).toBeUndefined();
    await act(async () => emit({ ...target, candidateId, label: 'outside.invalid' }));
    expect(confirm()).toBeDefined();
    expect(bridge.invoke.mock.calls.filter(([name]) => name === 'metaproject:board-external')).toHaveLength(0);
    await act(async () => confirm()?.click());
    expect(bridge.invoke).toHaveBeenCalledWith('metaproject:board-external', { viewId, candidateId });
  } finally {
    act(() => root.unmount()); node.remove(); vi.unstubAllGlobals(); bridge.on.mockReset().mockImplementation(() => () => {});
  }
});
