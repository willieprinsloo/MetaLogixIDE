// @vitest-environment jsdom
/** Mounted App behaviour for the activity-log switch: tab visibility, Shell fallback and Follow files gating. */
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
      if (channel === 'projects:open') return { project: project(payload?.id ?? 1) };
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
}) => request ? <div role="dialog" aria-label="Commands">{commands.filter((item) => ['shell.unload', 'view.shell', 'term.new'].includes(item.id))
  .map((item) => <button key={item.id} onClick={() => { onClose(); void item.run(); }}>{item.title}</button>)}</div> : null }));
vi.mock('@renderer/components/ShellTab', () => ({ ShellTab: () => null }));
vi.mock('@renderer/components/FilesTab', () => ({ FilesTab: () => <div data-testid="files-view"><textarea aria-label="Workspace draft" /></div> }));
vi.mock('@renderer/components/ActivityTab', () => ({ ActivityTab: () => <div data-testid="activity-tab" /> }));
vi.mock('@renderer/components/ChatTab', () => ({ ChatTab: () => null }));
vi.mock('@renderer/components/Settings', () => ({ Settings: () => null }));
vi.mock('@renderer/components/NewProjectDialog', () => ({ NewProjectDialog: ({ open }: { open: boolean }) =>
  open ? <div role="dialog" aria-label="New project">New project</div> : null }));
vi.mock('@renderer/components/ShellTabsBar', () => ({ ShellTabsBar: () => null }));
vi.mock('@renderer/components/ShellSplit', () => ({ ShellSplit: () => <div data-testid="shell-view" /> }));

let container: HTMLDivElement | null = null;
let root: Root | null = null;
const flush = async (): Promise<void> => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
const tabButton = () => document.querySelector('[data-testid="activity-tab-button"]');
const stored = (key: string) => JSON.parse(localStorage.getItem(key) ?? 'null') as unknown;
const peeks = () => bridge.calls.filter((c) => c.channel === 'files:peek');

/** Mounts App with the setting and saved tab given, then selects project 1. */
async function mount(opts: { activity: boolean; tab?: string; follow?: boolean }): Promise<void> {
  bridge.activity = opts.activity;
  localStorage.clear();
  if (opts.tab) localStorage.setItem('metaide.mainTab', JSON.stringify(opts.tab));
  if (opts.follow) localStorage.setItem('metaide.followFiles', 'true');
  container = document.createElement('div');
  document.body.append(container);
  const mountedRoot = createRoot(container);
  root = mountedRoot;
  await act(async () => { mountedRoot.render(<App />); });
  await act(async () => { [...document.querySelectorAll('button')].find((b) => b.textContent === 'Select 1')!.click(); });
  await flush();
  await flush();
}

/** Delivers `settings:changed` for the key, as main does after `settings:set`. */
async function changeSetting(activity: boolean): Promise<void> {
  bridge.activity = activity;
  await act(async () => { for (const l of bridge.listeners.get('settings:changed') ?? []) l({ key: 'activity_log_enabled' }); });
  await flush();
  await flush();
}

async function emitFollow(): Promise<void> {
  const entry = { id: 'e1', ts: '2026-01-01T00:00:00.000Z', agent: 'claude', shellIndex: 0, kind: 'tool', tool: 'Edit', target: 'src/a.ts', ok: true };
  await act(async () => { for (const l of bridge.listeners.get('activity:changed') ?? []) l({ projectId: 1, entry }); });
  await flush();
  await flush();
}

beforeEach(() => {
  bridge.calls = [];
  bridge.listeners.clear();
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

it('does not expose hidden local workspace actions after a remote Fleet notice', async () => {
  await mount({ activity: true, tab: 'files' });
  const paletteContent = () => document.querySelector('[aria-label="Commands"]')?.textContent;
  await act(async () => { document.querySelector<HTMLButtonElement>('[data-testid="status-bar-palette-hint"]')?.click(); });
  expect(paletteContent()).toContain('Switch to Shell tab');
  await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });

  await act(async () => {
    for (const listener of bridge.listeners.get('p2p:focus-remote-shell') ?? []) {
      listener({ deviceId: 'tower', deviceName: 'Tower', projectId: 1, projectName: 'Remote', shellIndex: 0 });
    }
  });
  expect(document.querySelector('[data-testid="remote-project-pane"]')?.textContent).toContain('Remote @ Tower');
  await act(async () => { document.querySelector<HTMLButtonElement>('[data-testid="status-bar-palette-hint"]')?.click(); });
  expect(paletteContent()).toBe('');
  await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  const before = bridge.calls.length;
  await act(async () => {
    for (const key of ['t', 'w']) window.dispatchEvent(new KeyboardEvent('keydown', { key, metaKey: true, bubbles: true, cancelable: true }));
  });
  expect(bridge.calls.slice(before).map(({ channel }) => channel)).not.toContain('shells:launch-plain');
  expect(bridge.calls.slice(before).map(({ channel }) => channel)).not.toContain('shells:kill');
  expect(stored('metaide.mainTab')).toBe('files');
});

describe('App activity-log switch', () => {
  it('shows the Activity tab button when on and hides it when off (AC8)', async () => {
    await mount({ activity: true, tab: 'shell' });
    expect(tabButton()?.getAttribute('aria-label')).toBe('Activity');
    await root!.unmount();
    root = null; container!.remove();
    await mount({ activity: false, tab: 'shell' });
    expect(tabButton()).toBeNull();
  });

  it('switching off while on Activity lands on Shell and rewrites the saved tab (AC9, AC15)', async () => {
    await mount({ activity: true, tab: 'activity' });
    expect(document.querySelector('[data-testid="activity-tab"]')).not.toBeNull();
    await changeSetting(false);
    expect(document.querySelector('[data-testid="activity-tab"]')).toBeNull();
    expect(document.querySelector('[data-testid="shell-view"]')).not.toBeNull();
    expect(tabButton()).toBeNull();
    expect(stored('metaide.mainTab')).toBe('shell');
  });

  it('switching back on restores the button without forcing a tab (AC16)', async () => {
    await mount({ activity: false, tab: 'files' });
    await changeSetting(true);
    expect(tabButton()).not.toBeNull();
    expect(stored('metaide.mainTab')).toBe('files');
  });

  it('launching with a saved Activity tab while off settles on Shell and rewrites storage (AC10)', async () => {
    await mount({ activity: false, tab: 'activity' });
    expect(document.querySelector('[data-testid="activity-tab"]')).toBeNull();
    expect(document.querySelector('[data-testid="shell-view"]')).not.toBeNull();
    expect(stored('metaide.mainTab')).toBe('shell');
  });

  it('leaves other saved tabs alone when off', async () => {
    await mount({ activity: false, tab: 'files' });
    expect(stored('metaide.mainTab')).toBe('files');
  });

  it('Follow files is inert while off and the saved preference is kept (AC12)', async () => {
    await mount({ activity: false, tab: 'shell', follow: true });
    await emitFollow();
    expect(peeks()).toHaveLength(0);
    expect(document.querySelector('[data-testid="files-view"]')).toBeNull();
    expect(stored('metaide.followFiles')).toBe(true);
  });

  it('Follow files resumes after switching back on (AC16)', async () => {
    await mount({ activity: false, tab: 'shell', follow: true });
    await changeSetting(true);
    await emitFollow();
    expect(peeks()).toHaveLength(1);
    expect(document.querySelector('[data-testid="files-view"]')).not.toBeNull();
    expect(stored('metaide.followFiles')).toBe(true);
  });

  it('Follow files stops at once when switched off while following (AC12)', async () => {
    await mount({ activity: true, tab: 'shell', follow: true });
    await changeSetting(false);
    await emitFollow();
    expect(peeks()).toHaveLength(0);
  });
});


it('keeps the same unsaved Files surface behind Board and restores focus on return', async () => {
  await mount({ activity: true, tab: 'files' });
  const opener = document.querySelector<HTMLButtonElement>('[data-testid="metaproject-board"]');
  const draft = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Workspace draft"]');
  if (!opener || !draft) throw new Error('Missing workspace controls');
  draft.value = 'unsaved draft';
  await act(async () => { opener.focus(); opener.click(); });
  expect(bridge.calls).toContainEqual({ channel: 'metaproject:board-open', payload: expect.objectContaining({ projectId: 1, epoch: 4 }) });
  expect(draft.closest('[inert]')).not.toBeNull();
  expect(stored('metaide.mainTab')).toBe('files');
  const reads = bridge.calls.filter(({ channel }) => channel === 'metaproject:assignment-get').length;
  await act(async () => { for (const listener of bridge.listeners.get('projects:changed') ?? []) listener({ kind: 'updated' }); });
  expect(bridge.calls.filter(({ channel }) => channel === 'metaproject:assignment-get')).toHaveLength(reads + 1);
  expect(bridge.calls.filter(({ channel }) => channel === 'metaproject:board-open')).toHaveLength(1);
  expect(bridge.calls.some(({ channel }) => channel === 'metaproject:board-close')).toBe(false);
  expect(document.querySelector('textarea[aria-label="Workspace draft"]')).toBe(draft);
  const back = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Return to workspace');
  await act(async () => back?.click());
  expect(bridge.calls).toContainEqual({ channel: 'metaproject:board-close', payload: { viewId: '0856d88e-bbed-4f3e-8157-b9d3a4b34eea' } });
  expect(document.querySelector('textarea[aria-label="Workspace draft"]')).toBe(draft);
  expect(draft.value).toBe('unsaved draft');
  expect(draft.closest('[inert]')).toBeNull();
  expect(document.activeElement).toBe(opener);
});
