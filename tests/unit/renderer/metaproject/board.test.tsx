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
    if (['metaproject:board-layout', 'metaproject:board-close', 'metaproject:board-external', 'metaproject:board-dismiss-external'].includes(channel)) return { ok: true };
    throw new Error(`Unexpected ${channel}`);
  });
  const node = document.body.appendChild(document.createElement('div'));
  const root = createRoot(node);
  const candidateId = '0856d88e-bbed-4f3e-8157-b9d3a4b34eeb';
  const confirm = () => [...node.querySelectorAll('button')].find((b) => b.textContent === 'Open external link');
  try {
    await act(async () => root.render(<BoardLease projectId={target.projectId} revision={target.revision} epoch={target.epoch} covered={false} />));
    const emit = listeners.get('metaproject:board-external-candidate');
    const observeState = listeners.get('metaproject:board-state');
    if (!emit || !observeState) throw new Error('Board listeners missing');
    await act(async () => observeState({ ...target, phase: 'ready' }));
    await act(async () => emit({ ...target, epoch: 3, candidateId, label: 'outside.invalid' }));
    expect(confirm()).toBeUndefined();
    await act(async () => emit({ ...target, candidateId, label: 'outside.invalid' }));
    expect(confirm()).toBeDefined();
    const button = (text: string) => [...node.querySelectorAll('button')].find((b) => b.textContent === text);
    expect(document.activeElement).toBe(button('Cancel external link'));
    await act(async () => button('Cancel external link')?.click());
    expect(bridge.invoke).toHaveBeenCalledWith('metaproject:board-dismiss-external', { viewId, candidateId });
    expect(document.activeElement).toBe(button('Focus Board'));
    const nextId = '0856d88e-bbed-4f3e-8157-b9d3a4b34eec';
    await act(async () => emit({ ...target, candidateId: nextId, label: 'next.invalid' }));
    expect(confirm()).toBeDefined();
    expect(bridge.invoke.mock.calls.filter(([name]) => name === 'metaproject:board-external')).toHaveLength(0);
    await act(async () => confirm()?.click());
    expect(bridge.invoke).toHaveBeenCalledWith('metaproject:board-external', { viewId, candidateId: nextId });
  } finally {
    act(() => root.unmount()); node.remove(); vi.unstubAllGlobals(); bridge.on.mockReset().mockImplementation(() => () => {});
  }
});

function readyLease() {
  const viewId = '0856d88e-bbed-4f3e-8157-b9d3a4b34eea';
  const target = { viewId, projectId: 2, revision: 'a'.repeat(64), epoch: 4 };
  const main = document.body.appendChild(document.createElement('main'));
  const root = createRoot(main);
  const onSettings = vi.fn();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('crypto', { randomUUID: () => viewId });
  vi.stubGlobal('visualViewport', Object.assign(new EventTarget(), { scale: 1.25 }));
  const callbacks = new Map<number, FrameRequestCallback>();
  let frame = 0;
  vi.stubGlobal('requestAnimationFrame', (draw: FrameRequestCallback) => { callbacks.set(++frame, draw); return frame; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { callbacks.delete(id); });
  const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this === main ? new DOMRect(120.25, 100.5, 600, 350) : new DOMRect(0, 80, 920, 600);
  });
  bridge.invoke.mockReset();
  const invoke = (channel: string) => {
    if (channel === 'metaproject:board-open') return { ok: true, value: { ...target, phase: 'ready' } };
    if (['metaproject:board-layout', 'metaproject:board-focus', 'metaproject:board-close'].includes(channel)) return { ok: true };
    throw new Error(`Unexpected ${channel}`);
  };
  bridge.invoke.mockImplementation(async (channel) => invoke(channel));
  return {
    main, target, onSettings, invoke,
    bounds: { x: 151, y: 126, width: 749, height: 437 },
    render: () => act(async () => root.render(<BoardLease projectId={target.projectId} revision={target.revision} epoch={target.epoch} covered={false} onSettings={onSettings} />)),
    draw: () => act(async () => { const scheduled = [...callbacks.values()]; callbacks.clear(); for (const draw of scheduled) draw(0); }),
    click: async (name: string) => {
      const button = [...main.querySelectorAll('button')].find((b) => b.textContent === name);
      if (!button || button.disabled) throw new Error(`Unavailable ${name} button`);
      await act(async () => button.click());
    },
    dispose: () => { act(() => root.unmount()); rect.mockRestore(); main.remove(); vi.unstubAllGlobals(); },
  };
}

it('lays out Board inside the scaled main column, detaches under a modal and restores the same lease', async () => {
  const ui = readyLease();
  const dialog = document.createElement('div');
  dialog.setAttribute('aria-modal', 'true');
  try {
    await ui.render();
    expect(bridge.invoke).toHaveBeenCalledWith('metaproject:board-open', ui.target);
    await ui.draw();
    const shown = { viewId: ui.target.viewId, bounds: ui.bounds };
    expect(bridge.invoke).toHaveBeenLastCalledWith('metaproject:board-layout', shown);
    const calls = bridge.invoke.mock.calls.length;
    await act(async () => { window.dispatchEvent(new Event('resize')); window.dispatchEvent(new Event('scroll')); });
    await ui.draw();
    expect(bridge.invoke).toHaveBeenCalledTimes(calls);
    await act(async () => { document.body.append(dialog); });
    expect(bridge.invoke).toHaveBeenLastCalledWith('metaproject:board-layout', { ...shown, bounds: null });
    await act(async () => { dialog.remove(); });
    await ui.draw();
    expect(bridge.invoke).toHaveBeenLastCalledWith('metaproject:board-layout', shown);
    await ui.click('Focus Board');
    expect(bridge.invoke).toHaveBeenLastCalledWith('metaproject:board-focus', { viewId: ui.target.viewId });
  } finally { dialog.remove(); ui.dispose(); }
});

it('routes layout denial to Project Settings, retries the lease, and reports independent browser failure', async () => {
  const ui = readyLease();
  let deny = true;
  bridge.invoke.mockImplementation(async (channel, input) => {
    if (channel === 'metaproject:board-layout' && input.bounds && deny) return { ok: false, reason: 'denied' };
    if (channel === 'metaproject:board-browser') throw new Error('socket or OS error detail');
    return ui.invoke(channel);
  });
  try {
    await ui.render();
    await ui.draw();
    expect(bridge.invoke).toHaveBeenCalledWith('metaproject:board-layout', { viewId: ui.target.viewId, bounds: ui.bounds });
    expect(ui.main.querySelector('[role="alert"]')?.textContent).toContain('does not have access');
    await ui.click('Open Project Settings');
    expect(ui.onSettings).toHaveBeenCalledOnce();
    deny = false;
    await ui.click('Retry Board');
    await ui.draw();
    expect(bridge.invoke.mock.calls.filter(([name]) => name === 'metaproject:board-open')).toHaveLength(2);
    expect(ui.main.querySelector('[role="alert"]')).toBeNull();
    await ui.click('Open in Browser');
    expect(bridge.invoke).toHaveBeenCalledWith('metaproject:board-browser', { projectId: ui.target.projectId, revision: ui.target.revision });
    expect(ui.main.querySelector('[role="alert"]')?.textContent).toContain('Could not complete the operation');
    expect(ui.main.textContent).not.toContain('socket or OS error detail');
  } finally { ui.dispose(); }
});
