// @vitest-environment jsdom
/** Mounted App: the Agents dock paints the same rounded sheet surface as the Shell sheet. */
import { App } from '@renderer/App';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@shared/types';

const project = (id: number): Project => ({
  id, rootId: 1, path: `/work/${id}`, name: `Project ${id}`, metaprojectProjectId: null,
  linkedChatChannelId: null, lastOpenedAt: null, pinned: false, hidden: false,
  firstLaunchedAt: null, config: {},
});
const bridge = vi.hoisted(() => ({
  activity: true as boolean,
  calls: [] as Array<{ channel: string; payload: unknown }>,
  listeners: new Map<string, Set<(payload: unknown) => void>>(),
  holdLocalOpen: null as Promise<{ project: Project }> | null,
}));

vi.mock('@renderer/api', () => ({
  api: {
    on: (channel: string, listener: (payload: unknown) => void) => {
      const listeners = bridge.listeners.get(channel) ?? new Set<(payload: unknown) => void>();
      listeners.add(listener);
      bridge.listeners.set(channel, listeners);
      return () => { listeners.delete(listener); };
    },
    invoke: async (channel: string, payload: { id?: number; key?: string } | undefined) => {
      bridge.calls.push({ channel, payload });
      if (channel === 'metaproject:session-status') return { phase: 'signed-in', epoch: 4, origin: 'https://fixture.invalid', configuredOrigin: 'https://fixture.invalid', actor: { id: 1, username: 'fixture' }, connected: true, remembered: false };
      if (channel === 'metaproject:assignment-get') return { ok: true, value: { kind: 'linked', projectId: 1, revision: 'a'.repeat(64), remoteId: 42, origin: 'https://fixture.invalid', localName: 'Project 1', localPath: '/work/1' } };
      if (channel === 'metaproject:board-open') return new Promise(() => {});
      if (channel === 'metaproject:board-layout' || channel === 'metaproject:board-close') return { ok: true };
      if (channel === 'projects:open') return bridge.holdLocalOpen ?? { project: project(payload?.id ?? 1) };
      if (channel === 'projects:list') return { projects: [project(1)] };
      if (channel === 'shells:alive-list') return { shells: [{ projectId: 1, shellIndex: 0 }] };
      if (channel === 'settings:get') return { value: payload?.key === 'activity_log_enabled' ? bridge.activity : undefined };
      if (channel === 'files:peek') return { found: true, projectId: 1, relPath: 'src/a.ts' };
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
  useShellAgentState: () => ({ state: 'idle' }),
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
  Sidebar: ({ onSelect }: { onSelect: (project: Project) => void }) =>
    <aside><button onClick={() => onSelect(project(1))}>Select 1</button></aside>,
}));
vi.mock('@renderer/components/StatusBar', () => ({ StatusBar: ({ onOpenPalette }: { onOpenPalette: () => void }) =>
  <button data-testid="status-bar-palette-hint" onClick={onOpenPalette}>Commands</button> }));
vi.mock('@renderer/components/CommandPalette', () => ({ CommandPalette: ({ request, commands, onClose }: {
  request: unknown; commands: Array<{ id: string; title: string; run: () => Promise<void> }>; onClose: () => void;
}) => request ? <div role="dialog" aria-label="Commands">{commands.filter((item) => ['shell.unload', 'shell.popout', 'view.shell', 'term.new'].includes(item.id))
  .map((item) => <button key={item.id} onClick={() => { onClose(); void item.run(); }}>{item.title}</button>)}</div> : null }));
vi.mock('@renderer/components/ShellTab', () => ({ ShellTab: () => null }));
vi.mock('@renderer/components/FilesTab', () => ({ FilesTab: () => <div data-testid="files-view"><textarea aria-label="Workspace draft" /></div> }));
vi.mock('@renderer/components/ActivityTab', () => ({ ActivityTab: () => <div data-testid="activity-tab" /> }));
vi.mock('@renderer/components/ChatTab', () => ({ ChatTab: () => null }));
vi.mock('@renderer/components/Settings', () => ({ Settings: () => null }));
vi.mock('@renderer/components/NewProjectDialog', () => ({ NewProjectDialog: ({ open }: { open: boolean }) =>
  open ? <div role="dialog" aria-label="New project">New project</div> : null }));
vi.mock('@renderer/components/ShellTabsBar', () => ({ ShellTabsBar: () => null }));
vi.mock('@renderer/components/AgentChatTab', () => ({ AgentChatTab: () => <div data-testid="agent-chat-tab" /> }));
vi.mock('@renderer/components/ShellSplit', () => ({ ShellSplit: () => <div data-testid="shell-view" /> }));

let container: HTMLDivElement | null = null;
let root: Root | null = null;
const flush = async (): Promise<void> => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };

/** Mounts App on the Shell tab with the Agents dock open, then selects project 1. */
async function mount(): Promise<void> {
  localStorage.clear();
  localStorage.setItem('metaide.mainTab', JSON.stringify('shell'));
  localStorage.setItem('metaide.agentsDockOpen', 'true');
  container = document.createElement('div');
  document.body.append(container);
  const mountedRoot = createRoot(container);
  root = mountedRoot;
  await act(async () => { mountedRoot.render(<App />); });
  await act(async () => { [...document.querySelectorAll('button')].find((b) => b.textContent === 'Select 1')!.click(); });
  await flush();
  await flush();
}

beforeEach(() => {
  bridge.calls = [];
  bridge.listeners.clear();
  bridge.holdLocalOpen = null;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('crypto', { randomUUID: () => '0856d88e-bbed-4f3e-8157-b9d3a4b34eea' });
});
afterEach(async () => {
  const mountedRoot = root;
  if (mountedRoot) await act(async () => { mountedRoot.unmount(); });
  root = null;
  container?.remove();
  container = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const classes = (el: Element | null): string[] => (el?.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);

describe('Agents dock surface', () => {
  it('carries the Shell sheet content marker, so the shell surface and border rules apply to it', async () => {
    await mount();
    const sheet = document.querySelector('main.workspace-sheet');
    const dock = document.querySelector('[data-testid="agents-dock"]');
    expect(sheet?.getAttribute('data-sheet-content')).toBe('shell');
    expect(dock).not.toBeNull();
    expect(dock?.getAttribute('data-sheet-content')).toBe('shell');
    expect(dock?.querySelector('[data-testid="agent-chat-tab"]')).not.toBeNull();
  });

  it('paints the same background, corners and sheet class as the Shell sheet, without the old edge border', async () => {
    await mount();
    const sheet = classes(document.querySelector('main.workspace-sheet'));
    const dock = classes(document.querySelector('[data-testid="agents-dock"]'));
    for (const shared of ['workspace-sheet', 'rounded-[14px]', 'bg-[--surface-sheet]']) {
      expect(sheet).toContain(shared);
      expect(dock).toContain(shared);
    }
    expect(dock).not.toContain('bg-[--surface]');
    expect(dock).not.toContain('border-l');
  });

  it('is inset 8px from the window edge on top, right and bottom', async () => {
    await mount();
    const dock = classes(document.querySelector('[data-testid="agents-dock"]'));
    expect(dock).toEqual(expect.arrayContaining(['mt-2', 'mr-2', 'mb-2']));
    expect(dock).not.toContain('h-full');
  });
});
