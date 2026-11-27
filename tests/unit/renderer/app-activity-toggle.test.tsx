// @vitest-environment jsdom
/** Mounted App behaviour for the activity-log switch: tab visibility, Shell fallback and Follow files gating. */
import { App } from '@renderer/App';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { within } from '@testing-library/react';
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
  focus: [] as unknown[],
  localShells: [0] as number[],
  rpc: null as ((payload: { method?: string; params?: Record<string, unknown> }) => unknown) | null,
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
      if (channel === 'shells:alive-list') return { shells: bridge.localShells.map((shellIndex) => ({ projectId: 1, shellIndex })) };
      if (channel === 'p2p:rpc-call' && bridge.rpc) return bridge.rpc(payload as { method?: string });
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
  terminalFocus: {
    requestProjectFocus: (projectId: number, machine?: string) => { bridge.focus.push(machine === undefined ? { project: projectId } : { project: projectId, machine }); },
    cancelRequest: () => undefined,
    requestFocus: (key: { projectId: number; shellIndex: number }) => { bridge.focus.push({ shell: key }); },
  },
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
vi.mock('@renderer/components/ProjectSettingsTab', () => ({ ProjectSettingsTab: ({ children }: { children: ReactNode }) =>
  <section data-testid="project-settings-view">{children}</section> }));
vi.mock('@renderer/components/ProjectEnvTab', () => ({ ProjectEnvTab: () => null }));
vi.mock('@renderer/components/ShellTabsBar', () => ({ ShellTabsBar: ({ onSelect, active }: { onSelect: (shellIndex: number) => void; active: number }) =>
  <button data-active-shell={active} onClick={() => onSelect(2)}>Terminal tab 2</button> }));
vi.mock('@renderer/components/ShellSplit', () => ({ ShellSplit: () => <div data-testid="shell-view" /> }));

let container: HTMLDivElement | null = null;
let root: Root | null = null;
const flush = async (): Promise<void> => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
const tabButton = () => document.querySelector('[data-testid="activity-tab-button"]');
const stored = (key: string) => JSON.parse(localStorage.getItem(key) ?? 'null') as unknown;
const peeks = () => bridge.calls.filter((c) => c.channel === 'files:peek');

/** Mounts App with the setting and saved tab given, then selects project 1 unless `select` is false. */
async function mount(opts: { activity: boolean; tab?: string; follow?: boolean; select?: boolean }): Promise<void> {
  bridge.activity = opts.activity;
  localStorage.clear();
  if (opts.tab) localStorage.setItem('metaide.mainTab', JSON.stringify(opts.tab));
  if (opts.follow) localStorage.setItem('metaide.followFiles', 'true');
  container = document.createElement('div');
  document.body.append(container);
  const mountedRoot = createRoot(container);
  root = mountedRoot;
  await act(async () => { mountedRoot.render(<App />); });
  if (opts.select === false) { await flush(); return; }
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
  bridge.holdLocalOpen = null;
  bridge.localShells = [0];
  bridge.rpc = null;
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
  await act(async () => {
    [...document.querySelectorAll('button')].find((button) => button.textContent === 'Pop current shell into a new window')?.click();
  });
  expect(bridge.calls).toContainEqual({ channel: 'windows:popout-shell', payload: { projectId: 1, shellIndex: 0 } });
  await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });

  await act(async () => {
    for (const listener of bridge.listeners.get('p2p:focus-remote-shell') ?? []) {
      listener({ deviceId: 'tower', deviceName: 'Tower', projectId: 1, projectName: 'Remote', shellIndex: 0 });
    }
  });
  expect(document.querySelector('[data-testid="remote-project-pane"]')).not.toBeNull();
  // The pane's tabs and identity render in the workspace header row above the sheet, like the local header.
  expect(document.querySelector('[data-testid="remote-workspace-header"]')?.textContent).toContain('Remote @ Tower');
  await act(async () => { document.querySelector<HTMLButtonElement>('[data-testid="status-bar-palette-hint"]')?.click(); });
  expect(paletteContent()).toBe('');
  await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  const before = bridge.calls.length;
  await act(async () => {
    for (const key of ['t', 'w']) window.dispatchEvent(new KeyboardEvent('keydown', { key, metaKey: true, bubbles: true, cancelable: true }));
  });
  expect(bridge.calls.slice(before).map(({ channel }) => channel)).not.toContain('shells:launch-plain');
  expect(bridge.calls.slice(before).map(({ channel }) => channel)).not.toContain('shells:kill');
  // They act on the remote host's tabs instead.
  const remoteMethods = bridge.calls.slice(before).filter(({ channel }) => channel === 'p2p:rpc-call')
    .map(({ payload }) => (payload as { method?: string; deviceId?: string }));
  expect(remoteMethods).toContainEqual(expect.objectContaining({ method: 'shells.launchPlain', deviceId: 'tower' }));
  expect(remoteMethods).toContainEqual(expect.objectContaining({ method: 'shells.kill', deviceId: 'tower' }));
  expect(stored('metaide.mainTab')).toBe('files');
});

it('an unsuperseded OS file-open request reaches the local Files tab', async () => {
  await mount({ activity: true, tab: 'shell' });
  await act(async () => {
    for (const listener of bridge.listeners.get('app:open-file-request') ?? []) listener({ path: '/work/1/readme.md' });
  });
  expect(document.querySelector('[data-testid="files-view"]')).not.toBeNull();
  expect(stored('metaide.mainTab')).toBe('files');
});

it('does not let a pending OS file open replace a later Fleet notice', async () => {
  await mount({ activity: true, tab: 'shell' });
  let completeOpen: (value: { project: Project }) => void = () => {};
  bridge.holdLocalOpen = new Promise((resolve) => { completeOpen = resolve; });
  const before = bridge.calls.length;
  await act(async () => {
    for (const listener of bridge.listeners.get('app:open-file-request') ?? []) listener({ path: '/work/1/readme.md' });
  });
  expect(bridge.calls.slice(before)).toContainEqual({ channel: 'projects:open', payload: { id: 1 } });
  await act(async () => {
    for (const listener of bridge.listeners.get('p2p:focus-remote-shell') ?? []) {
      listener({ deviceId: 'tower', deviceName: 'Tower', projectId: 1, projectName: 'Remote', shellIndex: 0 });
    }
  });
  expect(document.querySelector('[data-testid="remote-project-pane"]')).not.toBeNull();
  await act(async () => { completeOpen({ project: project(1) }); });
  expect(document.querySelector('[data-testid="remote-project-pane"]')).not.toBeNull();
  // The pane's tabs and identity render in the workspace header row above the sheet, like the local header.
  expect(document.querySelector('[data-testid="remote-workspace-header"]')?.textContent).toContain('Remote @ Tower');
  expect(bridge.calls.slice(before).map(({ channel }) => channel)).not.toContain('shells:launch');
  expect(stored('metaide.mainTab')).toBe('shell');
});

describe('selecting a terminal tab focuses its terminal', () => {
  /** Clicks the button whose accessible label or text is `label` (the destination tabs are icon-only). */
  const click = async (label: string) => {
    await act(async () => {
      [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? b.textContent) === label)!.click();
    });
    await flush();
  };

  it('clicking the Shell destination asks for the selected project primary terminal (AC1)', async () => {
    await mount({ activity: true, tab: 'files' });
    bridge.focus = [];
    await click('Shell');
    expect(document.querySelector('[data-testid="shell-view"]')).not.toBeNull();
    expect(bridge.focus).toEqual([{ project: 1 }]);
  });

  it('clicking a tab in the terminal tabs bar asks for exactly that shell (AC2)', async () => {
    await mount({ activity: true, tab: 'shell' });
    bridge.focus = [];
    await click('Terminal tab 2');
    expect(bridge.focus).toEqual([{ shell: { projectId: 1, shellIndex: 2 } }]);
  });

  it('clicking a non-terminal destination asks for no terminal (AC3)', async () => {
    await mount({ activity: true, tab: 'shell' });
    bridge.focus = [];
    await click('Files');
    expect(document.querySelector('[data-testid="files-view"]')).not.toBeNull();
    expect(bridge.focus).toEqual([]);
  });

  it('clicking the Settings destination asks for no terminal (AC3)', async () => {
    await mount({ activity: true, tab: 'shell' });
    bridge.focus = [];
    await click('Settings');
    expect(document.querySelector('[data-testid="project-settings-view"]')).not.toBeNull();
    expect(bridge.focus).toEqual([]);
  });

  it('clicking the Shell destination with no project selected asks for no terminal', async () => {
    await mount({ activity: true, tab: 'files', select: false });
    bridge.focus = [];
    await click('Shell');
    expect(document.querySelector('[data-testid="main-column"]')).not.toBeNull();
    expect(bridge.focus).toEqual([]);
  });
});

it('a remote project\'s Shell tab makes the main sheet a shell sheet, like a local Shell tab; other tabs do not', async () => {
  await mount({ activity: true, tab: 'files' });
  const sheet = () => document.querySelector('main.workspace-sheet')?.getAttribute('data-sheet-content');
  expect(sheet()).toBe('other');
  await act(async () => {
    for (const listener of bridge.listeners.get('p2p:focus-remote-shell') ?? []) {
      listener({ deviceId: 'tower', deviceName: 'Tower', projectId: 1, projectName: 'Remote', shellIndex: 0 });
    }
  });
  await flush();
  expect(sheet()).toBe('shell');
  // The pane draws no terminal box of its own inside the sheet.
  expect(document.querySelector('[data-testid="remote-project-pane"] [data-sheet-content]')).toBeNull();
  await act(async () => {
    within(document.querySelector<HTMLElement>('[data-testid="remote-workspace-header"]')!).getByRole('button', { name: 'Files' }).click();
  });
  expect(sheet()).toBe('other');
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

describe('a remote project in the workspace header (AC1, AC16, AC18, AC19, AC28)', () => {
  const LOCAL_IPC = ['shells:launch-plain', 'shells:kill', 'windows:popout-shell'];
  const header = () => document.querySelector<HTMLElement>('[data-testid="remote-workspace-header"]');
  const pane = () => document.querySelector<HTMLElement>('[data-testid="remote-project-pane"]');
  const localHeader = () => document.querySelector<HTMLElement>('[data-testid="main-tab-bar"]');
  const since = (n: number) => bridge.calls.slice(n);
  const remoteCalls = (n: number) => since(n).filter(({ channel }) => channel === 'p2p:rpc-call')
    .map(({ payload }) => payload as { deviceId: string; method: string; params: Record<string, unknown> });
  const remoteMethods = (n: number) => remoteCalls(n).map(({ method }) => method).filter((m) => m.startsWith('shells.') && m !== 'shells.alive');
  const localCalls = (n: number) => since(n).filter(({ channel }) => LOCAL_IPC.includes(channel));
  const press = async (key: string, opts: { shift?: boolean } = {}) => {
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key, metaKey: true, shiftKey: opts.shift ?? false, bubbles: true, cancelable: true })); });
    await flush();
  };
  const clickIn = async (root: HTMLElement, label: string) => {
    await act(async () => {
      [...root.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? b.textContent) === label)!.click();
    });
    await flush();
  };
  async function openRemote(): Promise<void> {
    await act(async () => {
      for (const listener of bridge.listeners.get('p2p:focus-remote-shell') ?? []) {
        listener({ deviceId: 'tower', deviceName: 'Tower', projectId: 1, projectName: 'Remote', shellIndex: 0 });
      }
    });
    await flush();
    await flush();
  }

  it('renders one header row, the remote one, holding destinations, tabs and identity outside the pane (AC1, AC2)', async () => {
    await mount({ activity: true, tab: 'shell' });
    expect(localHeader()).not.toBeNull();
    await openRemote();
    const rows = document.querySelectorAll('.workspace-header-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toBe(header());
    expect(localHeader()).toBeNull();
    expect(header()!.querySelector('.workspace-destinations')).not.toBeNull();
    expect(header()!.querySelector('.workspace-project-actions')?.textContent).toContain('Remote @ Tower');
    expect(within(header()!).getByRole('button', { name: 'Close remote project' })).toBeTruthy();
    expect(within(header()!).getByText('Terminal tab 2')).toBeTruthy();
    expect(pane()!.querySelector('.workspace-destinations, .workspace-project-actions')).toBeNull();
    await clickIn(header()!, 'Files');
    expect(within(header()!).queryByText('Terminal tab 2')).toBeNull();
  });

  it('on the Shell destination, Cmd+T opens a plain terminal and Cmd+W closes the shown tab on the host, with no local IPC (AC16)', async () => {
    let next = 5;
    bridge.rpc = ({ method }) => (method === 'shells.launch' ? { result: { shellIndex: 3 } } : method === 'shells.launchPlain' ? { result: { shellIndex: next++ } } : { result: [] });
    await mount({ activity: true, tab: 'shell' });
    await openRemote();
    const before = bridge.calls.length;
    await press('t');
    await press('w');
    expect(remoteCalls(before).filter(({ method }) => method === 'shells.launchPlain' || method === 'shells.kill')).toEqual([
      { deviceId: 'tower', method: 'shells.launchPlain', params: { projectId: 1 } },
      { deviceId: 'tower', method: 'shells.kill', params: { projectId: 1, shellIndex: 5 } },
    ]);
    expect(localCalls(before)).toEqual([]);
  });

  it('Cmd+W while no remote tab is shown does nothing (AC16)', async () => {
    bridge.rpc = ({ method }) => (method === 'shells.launch' ? new Promise(() => {}) : { result: [] });
    await mount({ activity: true, tab: 'shell' });
    await openRemote();
    const before = bridge.calls.length;
    await press('w');
    expect(remoteMethods(before)).toEqual([]);
    expect(localCalls(before)).toEqual([]);
  });

  it('when the host cannot be reached, Cmd+T and Cmd+W toast and nothing local runs (AC16)', async () => {
    bridge.rpc = ({ method }) => {
      if (method === 'shells.launch') return { result: { shellIndex: 0 } };
      if (method === 'shells.launchPlain' || method === 'shells.kill') throw new Error('not connected');
      return { result: [] };
    };
    await mount({ activity: true, tab: 'shell' });
    await openRemote();
    const before = bridge.calls.length;
    await press('t');
    await press('w');
    await flush();
    expect(document.body.textContent).toContain('Could not open a terminal on the remote machine');
    expect(document.body.textContent).toContain('Could not close the remote terminal');
    expect(remoteMethods(before)).toEqual(['shells.launchPlain', 'shells.kill']);
    expect(localCalls(before)).toEqual([]);
  });

  it('on a remote destination other than Shell, and for Cmd+Shift+T, the keys do nothing (AC16)', async () => {
    await mount({ activity: true, tab: 'shell' });
    await openRemote();
    let before = bridge.calls.length;
    await press('t', { shift: true });
    expect(remoteMethods(before)).toEqual([]);
    expect(localCalls(before)).toEqual([]);
    await clickIn(header()!, 'Files');
    before = bridge.calls.length;
    await press('t');
    await press('w');
    expect(remoteMethods(before)).toEqual([]);
    expect(localCalls(before)).toEqual([]);
  });

  it('remote chip and Shell destination clicks ask for focus on that machine, never the hidden local project (AC18, AC19)', async () => {
    await mount({ activity: true, tab: 'shell' });
    await openRemote();
    bridge.focus = [];
    await clickIn(header()!, 'Terminal tab 2');
    expect(bridge.focus).toEqual([{ shell: { projectId: 1, shellIndex: 2, machine: 'tower' } }]);
    await clickIn(header()!, 'Files');
    bridge.focus = [];
    await clickIn(header()!, 'Shell');
    expect(bridge.focus).toEqual([{ project: 1, machine: 'tower' }]);
  });

  it('closing the remote project restores the local header, tab and terminal, and the keys act locally again (AC28)', async () => {
    bridge.localShells = [0, 2];
    await mount({ activity: true, tab: 'shell' });
    await clickIn(localHeader()!, 'Terminal tab 2');
    expect(localHeader()!.querySelector('[data-active-shell]')?.getAttribute('data-active-shell')).toBe('2');
    await openRemote();
    await clickIn(header()!, 'Close remote project');
    expect(header()).toBeNull();
    expect(pane()).toBeNull();
    expect(localHeader()).not.toBeNull();
    expect(within(localHeader()!).getByRole('button', { name: 'Shell' }).getAttribute('aria-current')).toBe('page');
    expect(localHeader()!.querySelector('[data-active-shell]')?.getAttribute('data-active-shell')).toBe('2');
    const before = bridge.calls.length;
    await press('w');
    await press('t');
    expect(localCalls(before).map(({ channel, payload }) => ({ channel, payload }))).toEqual([
      { channel: 'shells:kill', payload: { projectId: 1, shellIndex: 2 } },
      expect.objectContaining({ channel: 'shells:launch-plain' }),
    ]);
    expect(remoteMethods(before)).toEqual([]);
  });
});
