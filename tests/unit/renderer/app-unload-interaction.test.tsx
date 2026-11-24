// @vitest-environment jsdom
/** Mounted shell routing and overlay interactions against a stateful, in-process IPC bridge. */
import { App } from '@renderer/App';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@shared/types';
import { MODAL_TIER_Z, TOAST_Z } from '@renderer/modal-glass';
import { toastBus } from '@renderer/hooks/useToasts';

const project = (id: number): Project => ({
  id, rootId: 1, path: `/work/${id}`, name: `Project ${id}`, metaprojectProjectId: null,
  linkedChatChannelId: null, lastOpenedAt: null, pinned: false, hidden: false,
  firstLaunchedAt: null, config: {},
});
const bridge = vi.hoisted(() => ({
  shells: [{ projectId: 1, shellIndex: 0 }, { projectId: 1, shellIndex: 2 }, { projectId: 2, shellIndex: 0 }],
  generation: 'launch-1',
  state: 'idle' as 'idle' | 'busy' | 'blocked',
  failStop: false,
  calls: [] as Array<{ channel: string; payload: unknown }>,
  listeners: new Map<string, Set<() => void>>(),
}));

vi.mock('@renderer/api', () => ({
  api: {
    on: (channel: string, listener: () => void) => {
      const listeners = bridge.listeners.get(channel) ?? new Set<() => void>();
      listeners.add(listener);
      bridge.listeners.set(channel, listeners);
      return () => { listeners.delete(listener); };
    },
    invoke: async (channel: string, payload: { id?: number; projectId?: number; generation?: string } | undefined) => {
      bridge.calls.push({ channel, payload });
      if (channel === 'projects:open') return { project: project(payload?.id ?? 1) };
      if (channel === 'shells:alive-list') return { shells: bridge.shells };
      if (channel === 'shells:inspect-primary') {
        return bridge.shells.some((shell) => shell.projectId === payload?.projectId && shell.shellIndex === 0)
          ? { kind: 'live', generation: bridge.generation, state: bridge.state, agent: 'claude' }
          : { kind: 'gone' };
      }
      if (channel === 'shells:stop-primary') {
        if (bridge.failStop) throw new Error('stop failed');
        if (payload?.generation !== bridge.generation) return { kind: 'replaced' };
        bridge.shells = bridge.shells.filter((shell) => shell.projectId !== payload?.projectId || shell.shellIndex !== 0);
        for (const listener of bridge.listeners.get('alive-shells:changed') ?? []) listener();
        return { kind: 'stopped' };
      }
      if (channel === 'shells:launch-plain') return { shellIndex: 3 };
      return {};
    },
  },
}));
vi.mock('motion/react', () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => children,
  useReducedMotion: () => true,
  m: { div: ({ children, className }: { children: ReactNode; className?: string }) => <div className={className}>{children}</div> },
}));
vi.mock('@renderer/fonts/use-apply-ui-font', () => ({ useApplyUiFont: () => undefined }));
vi.mock('@renderer/hooks/useTheme', () => ({ useTheme: () => ({
  mode: 'dark', effective: 'dark', cycle: () => undefined, setMode: () => undefined, setPalette: () => undefined,
}) }));
vi.mock('@renderer/hooks/useClaudePermissionMode', () => ({ useClaudePermissionMode: () => ({ status: 'chosen', mode: 'default' }) }));
vi.mock('@renderer/hooks/useAgentStates', () => ({
  useProjectAgentState: () => 'idle',
  useShellAgentState: () => ({ state: bridge.state }),
  useAgentStateMap: () => new Map(),
}));
vi.mock('@renderer/hooks/useWindowTerminalFocus', () => ({
  useWindowTerminalFocus: () => undefined,
  terminalFocus: { requestProjectFocus: () => undefined, cancelRequest: () => undefined, requestFocus: () => undefined },
}));
vi.mock('@renderer/hooks/useTerminalGeometryHold', () => ({ useTerminalGeometryHold: () => undefined }));
vi.mock('@renderer/hooks/usePrefersReducedMotion', () => ({ usePrefersReducedMotion: () => false }));
vi.mock('@renderer/hooks/useRoots', () => ({ useRoots: () => ({ roots: [], refresh: async () => undefined }) }));
vi.mock('@renderer/hooks/useGitStatus', () => ({ useGitStatus: () => ({
  status: { isRepo: false, dirty: false, files: {}, branch: null, ahead: 0, behind: 0 },
  refresh: async () => undefined,
}) }));
vi.mock('@renderer/hooks/useTaskCount', () => ({ useTaskCount: () => 0 }));
vi.mock('@renderer/hooks/useKeepAwake', () => ({ useKeepAwake: () => null }));
vi.mock('@renderer/hooks/useEnvDrafts', () => ({ useEnvDrafts: () => ({ isDirty: () => false }) }));
vi.mock('@renderer/hooks/usePoppedShells', () => ({ usePoppedShells: () => ({ isPopped: () => false }) }));
vi.mock('@renderer/hooks/useReportViewedShells', () => ({ useReportViewedShells: () => undefined }));
vi.mock('@renderer/hooks/useFrostedGlassAttributes', () => ({ useFrostedGlassAttributes: () => undefined }));
vi.mock('@renderer/hooks/useExternalDragGuard', () => ({ useExternalDragGuard: () => undefined }));
vi.mock('@renderer/components/FoldPane', () => ({ FoldPane: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@renderer/components/Sidebar', () => ({
  Sidebar: ({ onSelect, onUnloadSession }: {
    onSelect: (project: Project) => void;
    onUnloadSession: (project: Project, opener: HTMLElement) => void;
  }) => <aside>{[1, 2].map((id) => <div key={id}>
    <button onClick={() => onSelect(project(id))}>Select {id}</button>
    {bridge.shells.some((shell) => shell.projectId === id && shell.shellIndex === 0) &&
      <button onClick={(event) => onUnloadSession(project(id), event.currentTarget)}>Row unload {id}</button>}
  </div>)}</aside>,
}));
vi.mock('@renderer/components/StatusBar', () => ({ StatusBar: ({ onOpenPalette }: { onOpenPalette: () => void }) =>
  <button data-testid="status-bar-palette-hint" onClick={onOpenPalette}>Commands</button> }));
vi.mock('@renderer/components/CommandPalette', () => ({ CommandPalette: ({ request, commands, onClose }: {
  request: unknown; commands: Array<{ id: string; run: () => Promise<void> }>; onClose: () => void;
}) => request ? <div role="dialog" aria-label="Commands">{commands.filter((item) => item.id === 'shell.unload')
  .map((item) => <button key={item.id} onClick={() => { onClose(); void item.run(); }}>Unload current session</button>)}</div> : null }));
vi.mock('@renderer/components/ShellTab', () => ({ ShellTab: () => null }));
vi.mock('@renderer/components/FilesTab', () => ({ FilesTab: () => null }));
vi.mock('@renderer/components/ChatTab', () => ({ ChatTab: () => null }));
vi.mock('@renderer/components/Settings', () => ({ Settings: () => null }));
vi.mock('@renderer/components/NewProjectDialog', () => ({ NewProjectDialog: ({ open }: { open: boolean }) =>
  open ? <div role="dialog" aria-label="New project">New project</div> : null }));
vi.mock('@renderer/components/ShellTabsBar', () => ({ ShellTabsBar: () => null }));
vi.mock('@renderer/components/ShellSplit', () => ({ ShellSplit: () => null }));

let container: HTMLDivElement | null = null;
let root: Root | null = null;
const flush = async (): Promise<void> => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
const button = (label: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find((el) => el.textContent?.includes(label) || el.getAttribute('aria-label') === label);
  if (!found) throw new Error(`Button not found: ${label}`);
  return found;
};
const click = async (label: string): Promise<void> => {
  await act(async () => { button(label).click(); });
  await flush();
};
const shortcut = async (key: string, shiftKey = false): Promise<void> => {
  await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key, metaKey: true, shiftKey, bubbles: true })); });
  await flush();
};
const stops = () => bridge.calls.filter((call) => call.channel === 'shells:stop-primary');

beforeEach(async () => {
  bridge.shells = [{ projectId: 1, shellIndex: 0 }, { projectId: 1, shellIndex: 2 }, { projectId: 2, shellIndex: 0 }];
  bridge.calls = [];
  bridge.listeners.clear();
  bridge.state = 'idle';
  bridge.generation = 'launch-1';
  bridge.failStop = false;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const rect = new DOMRect(0, 0, 44, 44);
  const visibleRects = {
    0: rect,
    length: 1,
    item: (index: number) => index === 0 ? rect : null,
    [Symbol.iterator]: () => [rect][Symbol.iterator](),
  };
  const nativeRects = HTMLElement.prototype.getClientRects;
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function (this: HTMLElement): DOMRectList {
    return this.isConnected && !this.hidden && this.closest('[aria-modal="true"]') && !this.closest('[hidden], [aria-hidden="true"]')
      ? visibleRects : nativeRects.call(this);
  });
  localStorage.clear();
  localStorage.setItem('metaide.mainTab', JSON.stringify('files'));
  container = document.createElement('div');
  document.body.append(container);
  const mountedRoot = createRoot(container);
  root = mountedRoot;
  await act(async () => { mountedRoot.render(<App />); });
  await click('Select 1');
});
afterEach(async () => {
  const mountedRoot = root;
  if (mountedRoot) await act(async () => { mountedRoot.unmount(); });
  root = null;
  container?.remove();
  container = null;
  let active: readonly { id: number }[] = [];
  const unsubscribe = toastBus.subscribe((items) => { active = items; });
  for (const item of active) toastBus.dismiss(item.id);
  unsubscribe();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('mounted App guarded unload', () => {
  it('routes unselected row without switching selection; cancel and Escape restore opener focus', async () => {
    const opener = button('Row unload 2');
    opener.focus();
    await click('Row unload 2');
    expect(document.querySelector('[role="dialog"][aria-modal="true"]')?.textContent).toContain('Project 2');
    expect(document.querySelector<HTMLElement>('[data-chrome-root]')?.inert).toBe(true);
    expect(document.title).toContain('Project 1');
    expect(stops()).toHaveLength(0);
    expect(document.activeElement).toBe(button('Keep session'));
    await act(async () => { button('Keep session').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(stops()).toHaveLength(0);
    await click('Keep session');
    await act(async () => { await new Promise<void>((resolve) => requestAnimationFrame(() => resolve())); });
    expect(document.activeElement).toBe(opener);
    expect(document.querySelector<HTMLElement>('[data-chrome-root]')?.inert).toBe(false);
    await click('Row unload 2');
    await click('Row unload 1');
    expect(document.querySelector('[aria-modal="true"]')?.textContent).toContain('Project 2');
    await act(async () => { button('Keep session').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    await flush();
    expect(document.querySelector('[aria-modal="true"]')).toBeNull();
    expect(stops()).toHaveLength(0);
    await click('Row unload 2');
    await act(async () => { document.querySelector<HTMLElement>('[data-testid="unload-session-dialog-scrim"]')?.click(); });
    expect(document.querySelector('[aria-modal="true"]')).toBeNull();
  });

  it('routes header and palette to selected shell only, preserving sibling and identity on success', async () => {
    await click('Unload session (close shell)');
    expect(document.querySelector('[aria-modal="true"]')?.textContent).toContain('Project 1');
    await click('Unload session');
    expect(stops()).toEqual([{ channel: 'shells:stop-primary', payload: {
      projectId: 1, generation: 'launch-1', acknowledgedWorkRisk: false,
    } }]);
    expect(bridge.shells).toEqual([{ projectId: 1, shellIndex: 2 }, { projectId: 2, shellIndex: 0 }]);
    expect(document.title).toContain('Project 1');
    await act(async () => { await new Promise<void>((resolve) => requestAnimationFrame(() => resolve())); });
    expect(document.activeElement).toBe(document.querySelector('[data-testid="status-bar-palette-hint"]'));
    expect(document.querySelector('[role="status"]')?.textContent).toContain('Session unloaded');
    await click('Select 2');
    await click('Commands');
    await click('Unload current session');
    expect(document.querySelector('[aria-modal="true"]')?.textContent).toContain('Project 2');
    expect(stops()).toHaveLength(1);
    await click('Keep session');
    await act(async () => { await new Promise<void>((resolve) => requestAnimationFrame(() => resolve())); });
    expect(document.activeElement).toBe(document.querySelector('[data-testid="status-bar-palette-hint"]'));
    await click('Commands');
    await click('Unload current session');
    await click('Unload session');
    expect(stops()).toHaveLength(2);
    expect(stops()[1]?.payload).toEqual({ projectId: 2, generation: 'launch-1', acknowledgedWorkRisk: false });
    expect(bridge.shells).toEqual([{ projectId: 1, shellIndex: 2 }]);
  });

  it('makes header and palette unload unavailable without primary even if a sibling survives', async () => {
    await act(async () => {
      bridge.shells = bridge.shells.filter((shell) => !(shell.projectId === 1 && shell.shellIndex === 0));
      for (const listener of bridge.listeners.get('alive-shells:changed') ?? []) listener();
    });
    await flush();
    expect(button('Select 1')).toBeTruthy();
    expect([...document.querySelectorAll('button')].some((el) => el.textContent === 'Row unload 1')).toBe(false);
    expect(document.querySelector('button[title="Unload session (close shell)"]')).toBeNull();
    await click('Commands');
    expect(document.querySelector('[role="dialog"][aria-label="Commands"]')?.textContent).not.toContain('Unload current session');
    expect(stops()).toHaveLength(0);
  });

  it('blocks global New Terminal/New Project while open and resumes both after dismissal; modal keyboard remains active', async () => {
    await click('Row unload 2');
    await shortcut('t');
    await shortcut('n', true);
    expect(bridge.calls.filter((call) => call.channel === 'shells:launch-plain')).toHaveLength(0);
    expect(document.querySelector('[aria-label="New project"]')).toBeNull();
    const keep = button('Keep session');
    await act(async () => { keep.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })); });
    expect(document.activeElement).toBe(button('Unload session'));
    expect(document.querySelector('[aria-modal="true"]')).toBeTruthy();
    await click('Keep session');
    await shortcut('t');
    expect(bridge.calls.filter((call) => call.channel === 'shells:launch-plain')).toHaveLength(1);
    await shortcut('n', true);
    expect(document.querySelector('[aria-label="New project"]')).toBeTruthy();
  });

  it('keeps failed stop in modal and a pre-existing notification visible and dismissible outside inert chrome', async () => {
    bridge.failStop = true;
    await act(async () => { toastBus.push({ title: 'Action required', kind: 'warning', timeoutMs: 0 }); });
    await flush();
    const status = [...document.querySelectorAll('[role="status"]')].find((el) => el.textContent?.includes('Action required'));
    expect(status).toBeTruthy();
    await click('Row unload 2');
    expect(document.querySelector('[role="status"]')).toBe(status);
    expect(status?.closest('[data-chrome-root]')).toBeNull();
    expect(Number.parseInt(status?.parentElement?.style.zIndex ?? '0', 10)).toBe(TOAST_Z);
    expect(TOAST_Z).toBeGreaterThan(MODAL_TIER_Z.modal[1]);
    await act(async () => { status?.querySelector<HTMLButtonElement>('[aria-label="Dismiss notification"]')?.click(); });
    expect([...document.querySelectorAll('[role="status"]')].some((el) => el.textContent?.includes('Action required'))).toBe(false);
    await click('Unload session');
    const modal = document.querySelector('[aria-modal="true"]');
    expect(modal).not.toBeNull();
    expect(modal?.textContent).toContain('Could not unload');
    expect([...document.querySelectorAll('[role="status"]')].filter((el) => el.textContent?.includes('Session unloaded'))).toHaveLength(0);
    await click('Keep session');
    expect(stops()).toHaveLength(1);
  });
});
