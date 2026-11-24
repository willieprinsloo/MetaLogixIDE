/** Contract tests for one inspected local primary session and visible-shell risk. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { consentRisk, currentSessionRisk, isPrimaryVisible, needsFreshConsent } from '@renderer/unload-session';
import type { PrimarySessionInspection } from '@shared/unload-session-contract';
import { createElement, createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { UnloadSessionState } from '@renderer/hooks/useUnloadSessionWorkflow';
import { useUnloadSessionWorkflow } from '@renderer/hooks/useUnloadSessionWorkflow';
import { UnloadSessionDialogView } from '@renderer/components/UnloadSessionDialog';
import { useAliveShellIds } from '@renderer/hooks/useAliveShellIds';

const live = (state: 'idle' | 'busy' | 'blocked' | null): PrimarySessionInspection => ({
  kind: 'live', generation: 'launch-a', agent: state === null ? null : 'claude', state,
});

const view = { selectedProjectId: 7, mainTab: 'shell' as const, activeShellIndex: 0, rightShellIndex: null };

describe('local primary-session consent', () => {
  it('only counts shell 0 as visible in the selected Shell main tab or actual split', () => {
    expect(isPrimaryVisible(7, view)).toBe(true);
    expect(isPrimaryVisible(7, { ...view, activeShellIndex: 2, rightShellIndex: 0 })).toBe(true);
    expect(isPrimaryVisible(7, { ...view, activeShellIndex: 2, rightShellIndex: null })).toBe(false);
    expect(isPrimaryVisible(7, { ...view, mainTab: 'files' })).toBe(false);
    expect(isPrimaryVisible(7, { ...view, selectedProjectId: 8 })).toBe(false);
  });

  it('uses the inspected shell rather than an aggregate or a different shell', () => {
    expect(consentRisk(live('idle'), false)).toEqual({ work: false, input: false, visible: false });
    expect(consentRisk(live(null), false)).toEqual({ work: false, input: false, visible: false });
    expect(consentRisk(live('busy'), false)).toEqual({ work: true, input: false, visible: false });
    expect(consentRisk(live('blocked'), false)).toEqual({ work: true, input: true, visible: false });
    expect(consentRisk(live('idle'), true)).toEqual({ work: false, input: false, visible: true });
    expect(consentRisk({ kind: 'gone' }, true)).toEqual({ work: false, input: false, visible: false });
  });
  it('does not turn an unidentified primary into an agent warning from another shell', () => {
    expect(currentSessionRisk(live(null), false, 'blocked')).toEqual({ work: false, input: false, visible: false });
    expect(currentSessionRisk(live('idle'), false, 'busy')).toEqual({ work: true, input: false, visible: false });
    expect(currentSessionRisk(live('idle'), false, 'blocked')).toEqual({ work: true, input: true, visible: false });
  });

  it('requires new explicit consent only for newly reported work or newly visible terminal', () => {
    const neutral = consentRisk(live('idle'), false);
    const busy = consentRisk(live('busy'), false);
    const blocked = consentRisk(live('blocked'), false);
    expect(needsFreshConsent(neutral, busy)).toBe(true);
    expect(needsFreshConsent(neutral, blocked)).toBe(true);
    expect(needsFreshConsent(neutral, consentRisk(live('idle'), true))).toBe(true);
    expect(needsFreshConsent(busy, consentRisk(live('busy'), true))).toBe(true);
    expect(needsFreshConsent(busy, blocked)).toBe(false);
    expect(needsFreshConsent(busy, neutral)).toBe(false);
  });
});


const rt = await vi.hoisted(async () => {
  const { createHookRuntime } = await import('./helpers/hook-runtime');
  return createHookRuntime();
});
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: rt.useState,
  useRef: rt.useRef,
  useCallback: rt.useCallback,
  useEffect: rt.useEffect,
}));
const invoke = vi.hoisted(() => vi.fn());
const on = vi.hoisted(() => vi.fn<(channel: string, listener: () => void) => () => void>(() => () => {}));
vi.mock('@renderer/api', () => ({ api: { invoke, on } }));

describe('primary-shell liveness subscription', () => {
  beforeEach(() => { rt.reset(); invoke.mockReset(); on.mockClear(); });
  afterEach(() => rt.unmount());

  it('keeps nonzero-only projects in use while removing their unload action', async () => {
    invoke.mockResolvedValue({ shells: [
      { projectId: 7, shellIndex: 2 },
      { projectId: 8, shellIndex: 0 },
    ] });
    rt.render(() => useAliveShellIds());
    await Promise.resolve();
    const result = rt.render(() => useAliveShellIds());
    expect([...result.aliveIds]).toEqual([7, 8]);
    expect([...result.primaryIds]).toEqual([8]);
    expect(on).toHaveBeenCalledWith('alive-shells:changed', expect.any(Function));
  });

  it('updates primary availability on alive-list changes without removing a living sibling', async () => {
    invoke.mockResolvedValueOnce({ shells: [{ projectId: 7, shellIndex: 0 }, { projectId: 7, shellIndex: 2 }] })
      .mockResolvedValueOnce({ shells: [{ projectId: 7, shellIndex: 2 }] });
    rt.render(() => useAliveShellIds());
    await Promise.resolve();
    expect([...rt.render(() => useAliveShellIds()).primaryIds]).toEqual([7]);
    const listener = on.mock.calls.find(([channel]) => channel === 'alive-shells:changed')?.[1];
    expect(listener).toBeDefined();
    listener?.();
    await Promise.resolve();
    const after = rt.render(() => useAliveShellIds());
    expect([...after.aliveIds]).toEqual([7]);
    expect([...after.primaryIds]).toEqual([]);
  });
});

describe('inspected primary-session workflow', () => {
  const target = { id: 7, name: 'Local' };
  const ready = { kind: 'live' as const, generation: 'launch-a', agent: 'claude' as const, state: 'idle' as const };
  const onClose = vi.fn();
  const onStopped = vi.fn();
  const read = (visible = false, signal: 'idle' | 'busy' | 'blocked' = 'idle') =>
    rt.render(() => useUnloadSessionWorkflow(target, visible, signal, onClose, onStopped));

  beforeEach(() => {
    rt.reset();
    invoke.mockReset();
    onClose.mockClear();
    onStopped.mockClear();
    invoke.mockResolvedValue(ready);
  });
  afterEach(() => rt.unmount());

  it('inspects before allowing a stop, pins target and generation, and signals success only on stopped', async () => {
    let inspectResolve: (value: typeof ready) => void = () => {};
    invoke.mockImplementationOnce(() => new Promise((resolve) => { inspectResolve = resolve; }))
      .mockResolvedValueOnce(ready).mockResolvedValueOnce({ kind: 'stopped' });
    expect(read().state.kind).toBe('loading');
    expect(invoke).toHaveBeenCalledWith('shells:inspect-primary', { projectId: 7 });
    await read().confirm();
    expect(invoke).toHaveBeenCalledTimes(1);
    inspectResolve(ready);
    await Promise.resolve();
    expect(read().state.kind).toBe('ready');
    await read().confirm();
    expect(invoke).toHaveBeenNthCalledWith(3, 'shells:stop-primary', {
      projectId: 7, generation: 'launch-a', acknowledgedWorkRisk: false,
    });
    expect(onStopped).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('rejects a replaced generation without stopping or reporting success', async () => {
    invoke.mockResolvedValueOnce(ready).mockResolvedValueOnce({ ...ready, generation: 'launch-b' });
    read();
    await Promise.resolve();
    await read().confirm();
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(read().state.kind).toBe('replaced');
    expect(onStopped).not.toHaveBeenCalled();
  });

  it('requires a second explicit click after new work or visibility, including before a pending stop', async () => {
    invoke.mockResolvedValueOnce(ready).mockResolvedValueOnce({ ...ready, state: 'busy' })
      .mockResolvedValueOnce({ ...ready, state: 'busy' }).mockResolvedValueOnce({ kind: 'stopped' });
    read();
    await Promise.resolve();
    expect(read(true, 'busy').risk).toEqual({ work: true, input: false, visible: true });
    await read(true, 'busy').confirm();
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(read(true, 'busy').state.kind).toBe('ready');
    expect(onStopped).not.toHaveBeenCalled();
    await read(true, 'busy').confirm();
    expect(invoke).toHaveBeenNthCalledWith(4, 'shells:stop-primary', {
      projectId: 7, generation: 'launch-a', acknowledgedWorkRisk: true,
    });
  });

  it('does not issue duplicate stop requests while the first remains pending', async () => {
    let stopResolve: (value: { kind: 'stopped' }) => void = () => {};
    invoke.mockResolvedValueOnce(ready).mockResolvedValueOnce(ready)
      .mockImplementationOnce(() => new Promise((resolve) => { stopResolve = resolve; }));
    read();
    await Promise.resolve();
    const first = read().confirm();
    const second = read().confirm();
    await Promise.resolve();
    expect(read().state.kind).toBe('pending');
    expect(invoke).toHaveBeenCalledTimes(3);
    await second;
    stopResolve({ kind: 'stopped' });
    await first;
    expect(onStopped).toHaveBeenCalledTimes(1);
  });

  it('treats gone and backend replacement as non-success, requiring a fresh inspection', async () => {
    invoke.mockResolvedValueOnce(ready).mockResolvedValueOnce({ kind: 'gone' });
    read();
    await Promise.resolve();
    await read().confirm();
    expect(read().state.kind).toBe('gone');
    expect(onStopped).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalledWith('shells:stop-primary', expect.anything());
  });

  it('does not report success when a replacement appears while stopping', async () => {
    invoke.mockResolvedValueOnce(ready).mockResolvedValueOnce(ready).mockResolvedValueOnce({ kind: 'replaced' });
    read();
    await Promise.resolve();
    await read().confirm();
    expect(read().state.kind).toBe('replaced');
    expect(onStopped).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('leaves a failed stop actionable and rechecks the generation before retry', async () => {
    invoke.mockResolvedValueOnce(ready).mockResolvedValueOnce(ready)
      .mockRejectedValueOnce(new Error('stop denied')).mockResolvedValueOnce(ready)
      .mockResolvedValueOnce(ready).mockResolvedValueOnce({ kind: 'stopped' });
    read();
    await Promise.resolve();
    await read().confirm();
    expect(read().state).toMatchObject({ kind: 'error', message: 'Could not unload this session. Retry or keep it open.' });
    expect(onStopped).not.toHaveBeenCalled();
    await read().retry();
    expect(read().state.kind).toBe('ready');
    await read().confirm();
    expect(onStopped).toHaveBeenCalledTimes(1);
  });

  it('requires another confirmation when main refuses a newly busy session', async () => {
    invoke.mockResolvedValueOnce(ready).mockResolvedValueOnce(ready)
      .mockResolvedValueOnce({ kind: 'escalated' }).mockResolvedValueOnce({ ...ready, state: 'busy' })
      .mockResolvedValueOnce({ ...ready, state: 'busy' }).mockResolvedValueOnce({ kind: 'stopped' });
    read();
    await Promise.resolve();
    await read().confirm();
    expect(read().state).toMatchObject({ kind: 'ready', error: 'The agent started working. Review this warning and confirm again to unload.' });
    expect(read().risk.work).toBe(true);
    expect(onStopped).not.toHaveBeenCalled();
    await read().confirm();
    expect(invoke).toHaveBeenNthCalledWith(6, 'shells:stop-primary', {
      projectId: 7, generation: 'launch-a', acknowledgedWorkRisk: true,
    });
  });

  it('keeps failures visible and retries status inspection without treating failure as idle', async () => {
    invoke.mockRejectedValueOnce(new Error('status unavailable')).mockResolvedValueOnce(ready);
    read();
    await Promise.resolve();
    await Promise.resolve();
    expect(read().state.kind).toBe('error');
    await read().confirm();
    expect(invoke).toHaveBeenCalledTimes(1);
    await read().retry();
    expect(read().state.kind).toBe('ready');
    expect(onStopped).not.toHaveBeenCalled();
  });
});

describe('safe primary-session confirmation', () => {
  const viewDialog = (state: UnloadSessionState, risk = { work: false, input: false, visible: false }) =>
    renderToStaticMarkup(createElement(UnloadSessionDialogView, {
      name: 'Local <script>alert(1)</script>', state, risk,
      onKeep: vi.fn(), onConfirm: vi.fn(), onRetry: vi.fn(), onKeyDown: vi.fn(),
      panelRef: createRef<HTMLDivElement>(), keepRef: createRef<HTMLButtonElement>(),
    }));

  it('associates title and consequence with a modal, escapes target name and starts with only the safe button', () => {
    const html = viewDialog({ kind: 'loading' });
    const panel = /<section[^>]*role="dialog"[^>]*>/.exec(html)?.[0] ?? '';
    const title = /<h2[^>]*id="([^"]+)"/.exec(html)?.[1];
    const description = /<p[^>]*id="([^"]+)"[^>]*data-testid="unload-session-description"/.exec(html)?.[1];
    expect(panel).toContain('aria-modal="true"');
    expect(panel).toContain(`aria-labelledby="${title}"`);
    expect(panel).toContain(`aria-describedby="${description}"`);
    expect(html).toContain('Local &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('Other terminal tabs and split shells will keep running.');
    expect(html).toContain('Keep session');
    expect(html).not.toContain('data-testid="unload-session-confirm"');
  });

  it('shows a blocked work warning plus visible-terminal loss without relying on colour', () => {
    const html = viewDialog({ kind: 'gone' }, { work: true, input: true, visible: true });
    expect(html).toContain('The agent needs your input.');
    expect(html).toContain('This terminal is currently visible and will stop.');
    expect(html).toContain('role="alert"');
    expect(html).toContain('This session has already ended.');
    expect(html).not.toContain('data-testid="unload-session-confirm"');
    expect(viewDialog({ kind: 'replaced' })).toContain('The session changed.');
    expect(viewDialog({ kind: 'replaced' })).toContain('data-testid="unload-session-retry"');
  });

  it('shows a neutral live primary with destructive action separated from the safe default', () => {
    const inspection = { kind: 'live' as const, generation: 'launch-a', agent: 'claude' as const, state: 'idle' as const };
    const consent = { work: false, input: false, visible: false };
    const html = viewDialog({ kind: 'ready', inspection, consent, error: null });
    expect(html).toContain('data-testid="unload-session-confirm"');
    expect(html).not.toContain('data-testid="unload-session-warning"');
    expect(html).toMatch(/data-testid="unload-session-confirm"[^>]*>Unload session<\/button>[\s\S]*data-testid="unload-session-keep"/);
    expect(html).toContain('Only shell 0 will stop.');
    const pending = viewDialog({ kind: 'pending', inspection, consent });
    expect(pending).toMatch(/data-testid="unload-session-confirm"[^>]*disabled/);
    expect(pending).toMatch(/data-testid="unload-session-keep"[^>]*disabled/);
    expect(pending).toContain('aria-busy="true"');
    expect(pending).toContain('Unloading session…');
    expect(viewDialog({ kind: 'error', message: 'Could not check this session. Retry or keep it open.' })).toContain('data-testid="unload-session-retry"');
  });
});