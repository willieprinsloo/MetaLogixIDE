// @vitest-environment jsdom
/** Mounted App: how the Agents dock is wired to its fold (toggle sources, presence, size, the workspace row). */
import { App } from '@renderer/App';
import { act, isValidElement, type ReactNode } from 'react';
import { DOCK_MARGIN_W, DOCK_MIN_W, MAIN_MIN_W } from '@renderer/agents-dock-layout';
import { AGENTS_DOCK_TESTIDS } from '@renderer/agents-dock-copy';
import type { FoldCustom } from '@renderer/pane-fold';
import type { FoldOptions, FoldSize } from '@renderer/components/FoldPane';
import type { OpenPaneRequest } from '@renderer/machine-switcher-contract';
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
interface FoldProps { size: FoldSize; anchor: 'start' | 'end'; custom: FoldCustom; options?: FoldOptions; onFoldComplete?: unknown }
const rec = vi.hoisted(() => ({
  dock: null as FoldProps | null,
  chatProjects: [] as number[],
  focusTicks: [] as Array<number | undefined>,
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
  AnimatePresence: ({ children, initial, custom }: { children: ReactNode; initial?: boolean; custom?: unknown }) => <>
    <i hidden data-testid="presence" data-initial={String(initial)} data-custom={JSON.stringify(custom ?? null)}
      data-child-key={isValidElement(children) ? String(children.key) : ''} />
    {children}
  </>,
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
vi.mock('@renderer/components/FoldPane', () => ({ FoldPane: ({ children, ...props }: FoldProps & { children: ReactNode }) => {
  if (props.anchor === 'start') rec.dock = props;
  return <div data-testid={`fold-${props.anchor}`}>{children}</div>;
} }));
vi.mock('@renderer/components/Sidebar', () => ({
  Sidebar: ({ onSelect, onOpenPane }: { onSelect: (project: Project) => void; onOpenPane: (req: OpenPaneRequest) => void }) =>
    <aside>
      <button onClick={() => onSelect(project(1))}>Select 1</button>
      <button onClick={() => onSelect(project(2))}>Select 2</button>
      <button onClick={() => onOpenPane({ source: { kind: 'remote', deviceId: 'd1' }, deviceName: 'Remote', projectId: 9, projectName: 'Far' })}>Open remote</button>
    </aside>,
}));
vi.mock('@renderer/components/RemoteProjectPane', () => ({ RemoteProjectPane: ({ onClose }: { onClose: () => void }) =>
  <div data-testid="remote-pane"><button onClick={onClose}>Close remote</button></div> }));
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
vi.mock('@renderer/components/AgentChatTab', () => ({ AgentChatTab: ({ projectId, focusTick, barEnd }: {
  projectId: number; focusTick?: number; barEnd?: ReactNode;
}) => {
  rec.chatProjects.push(projectId);
  rec.focusTicks.push(focusTick);
  return <div data-testid="agent-chat-tab"><div data-testid="agent-chat-bar">{barEnd}</div></div>;
} }));
vi.mock('@renderer/components/ShellSplit', () => ({ ShellSplit: () => <div data-testid="shell-view" /> }));

let container: HTMLDivElement | null = null;
let root: Root | null = null;
const flush = async (): Promise<void> => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
const byText = (text: string): HTMLButtonElement => [...document.querySelectorAll('button')].find((b) => b.textContent === text)!;
const click = async (el: HTMLElement): Promise<void> => { await act(async () => { el.click(); }); await flush(); };
const testid = (id: string): HTMLElement | null => document.querySelector(`[data-testid="${id}"]`);
const row = (): HTMLElement | null => testid(AGENTS_DOCK_TESTIDS.row);
const dock = (): HTMLElement | null => testid(AGENTS_DOCK_TESTIDS.dock);
const dockPresence = (): HTMLElement | null => row()?.querySelector(':scope > [data-testid="presence"]') ?? null;
const dockFold = (): FoldProps => {
  expect(rec.dock, 'the dock rendered a start-anchored FoldPane').not.toBeNull();
  return rec.dock!;
};
const dockCustom = (): FoldCustom => dockFold().custom;
const presenceData = (): DOMStringMap => {
  expect(dockPresence(), 'the workspace row holds the dock presence').not.toBeNull();
  return dockPresence()!.dataset;
};
const classes = (el: Element | null): string[] => (el?.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);

async function press(key: string, shiftKey = false): Promise<void> {
  await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key, metaKey: true, shiftKey, bubbles: true, cancelable: true })); });
  await flush();
}

/** Mounts App on the Shell tab with the given persisted state, then selects project 1 unless told not to. */
async function mount(stored: Record<string, unknown> = { 'metaide.agentsDockOpen': true }, select = true): Promise<void> {
  localStorage.clear();
  localStorage.setItem('metaide.mainTab', JSON.stringify('shell'));
  for (const [key, value] of Object.entries(stored)) localStorage.setItem(key, JSON.stringify(value));
  container = document.createElement('div');
  document.body.append(container);
  const mountedRoot = createRoot(container);
  root = mountedRoot;
  await act(async () => { mountedRoot.render(<App />); });
  if (select) await click(byText('Select 1'));
  await flush();
}

beforeEach(() => {
  bridge.calls = [];
  bridge.listeners.clear();
  bridge.holdLocalOpen = null;
  rec.dock = null;
  rec.chatProjects = [];
  rec.focusTicks = [];
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

describe('Agents dock toggle sources', () => {
  it('slides when the Agents button or the close button flips it (AC1, AC2)', async () => {
    await mount({ 'metaide.agentsDockOpen': false });
    await click(testid(AGENTS_DOCK_TESTIDS.toggle)!);
    expect(dock()).not.toBeNull();
    expect(dockCustom().instant).toBe(false);
    await click(testid(AGENTS_DOCK_TESTIDS.close)!);
    expect(dockCustom().instant).toBe(false);
    expect(JSON.parse(presenceData().custom!)).toEqual(dockCustom());
    expect(localStorage.getItem('metaide.agentsDockOpen')).toBe('false');
  });

  it('switches in one step on ⌘J, open and closed (AC9)', async () => {
    await mount({ 'metaide.agentsDockOpen': false });
    await press('j');
    expect(dock()).not.toBeNull();
    expect(dockCustom().instant).toBe(true);
    await click(testid(AGENTS_DOCK_TESTIDS.toggle)!);
    expect(dock()).toBeNull();
    await press('j');
    expect(dockCustom().instant).toBe(true);
  });

  it('ends a pointer slide in one step when ⌘J flips it mid-slide (AC11)', async () => {
    await mount({ 'metaide.agentsDockOpen': false });
    await click(testid(AGENTS_DOCK_TESTIDS.toggle)!);
    expect(dockCustom().instant).toBe(false);
    await press('j');
    expect(dock()).toBeNull();
    expect(JSON.parse(presenceData().custom!)).toMatchObject({ instant: true });
  });

  it('opens in one step on ⇧⌘A and bumps the composer focus (AC10)', async () => {
    await mount({ 'metaide.agentsDockOpen': false });
    await press('A', true);
    expect(dock()).not.toBeNull();
    expect(dockCustom().instant).toBe(true);
    expect(rec.focusTicks.at(-1)).toBe(1);
    await press('A', true);
    expect(dock()).not.toBeNull();
    expect(rec.focusTicks.at(-1)).toBe(2);
  });

  it('shows the migrated dock in one step (AC16)', async () => {
    await mount({ 'metaide.agentsDockOpen': false, 'metaide.activeView': 'agents' });
    expect(dock()).not.toBeNull();
    expect(dockCustom().instant).toBe(true);
    expect(localStorage.getItem('metaide.activeView')).toBe('"projects"');
  });

  it('does not slide when the dock width changes (AC24)', async () => {
    await mount({ 'metaide.agentsDockOpen': true, 'metaide.agentsDockWidth': 400 });
    await act(async () => { testid('agents-dock')!.previousElementSibling!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
    await flush();
    expect(dockFold().size).toEqual({ clamp: { min: DOCK_MIN_W + DOCK_MARGIN_W, max: 340 + DOCK_MARGIN_W, reserve: MAIN_MIN_W } });
    expect(dockCustom().instant).toBe(true);
  });
});

describe('Agents dock fold props', () => {
  it('folds as a clamp sized to the persisted width, from the start edge, inert while leaving (AC4, AC5, AC23, AC28)', async () => {
    await mount({ 'metaide.agentsDockOpen': true, 'metaide.agentsDockWidth': 400 });
    expect(rec.dock).toMatchObject({
      anchor: 'start',
      size: { clamp: { min: DOCK_MIN_W + DOCK_MARGIN_W, max: 400 + DOCK_MARGIN_W, reserve: MAIN_MIN_W } },
      options: { inertWhileExiting: true, startBleedPx: 2 },
    });
    expect(typeof dockFold().onFoldComplete).toBe('function');
    expect(presenceData().childKey).toBe('agents-dock');
    const fold = testid('fold-start')!;
    expect(fold.contains(dock())).toBe(true);
    expect(fold.firstElementChild?.getAttribute('data-testid')).toBe('resize-handle');
  });

  it('keeps the #35 narrow-window classes in step with the layout constants (AC28)', async () => {
    await mount();
    expect(classes(dock())).toEqual(expect.arrayContaining(['shrink', `min-w-[${DOCK_MIN_W}px]`, `mr-${DOCK_MARGIN_W / 4}`]));
    expect(classes(testid(AGENTS_DOCK_TESTIDS.main))).toContain(`min-w-[${MAIN_MIN_W}px]`);
  });
});

describe('Agents dock workspace row', () => {
  it('wraps the main column and the dock in one container row, the dock last (AC28)', async () => {
    await mount();
    const wrapper = row()!;
    expect(classes(wrapper)).toContain('workspace-row');
    expect(wrapper.contains(testid(AGENTS_DOCK_TESTIDS.main))).toBe(true);
    expect(wrapper.lastElementChild).toBe(testid('fold-start'));
    expect(wrapper.querySelector('[data-testid="fold-end"]')).toBeNull();
  });
});

describe('Agents dock presence and context', () => {
  it('mounts its presence with initial={false} once a local project is selected (AC17, AC20)', async () => {
    await mount({ 'metaide.agentsDockOpen': true }, false);
    expect(dockPresence()).toBeNull();
    expect(dock()).toBeNull();
    await click(byText('Select 1'));
    expect(presenceData().initial).toBe('false');
    expect(dock()).not.toBeNull();
    expect(dockCustom().instant).toBe(true);
  });

  it('drops the presence while a remote pane is open and restores it in one step (AC18)', async () => {
    await mount();
    await click(byText('Open remote'));
    expect(testid('remote-pane')).not.toBeNull();
    expect(dockPresence()).toBeNull();
    expect(dock()).toBeNull();
    await click(byText('Close remote'));
    expect(presenceData().initial).toBe('false');
    expect(dock()).not.toBeNull();
    expect(dockCustom().instant).toBe(true);
  });

  it('only flips the setting when the Agents button is clicked with a remote pane open (AC21)', async () => {
    await mount();
    await click(byText('Open remote'));
    await click(testid(AGENTS_DOCK_TESTIDS.toggle)!);
    expect(dock()).toBeNull();
    expect(localStorage.getItem('metaide.agentsDockOpen')).toBe('false');
    await click(testid(AGENTS_DOCK_TESTIDS.toggle)!);
    await click(byText('Close remote'));
    expect(dock()).not.toBeNull();
    expect(dockCustom().instant).toBe(true);
  });

  it('keeps the same dock element when switching local projects (AC19)', async () => {
    await mount();
    const before = dock();
    await click(byText('Select 2'));
    expect(dock()).toBe(before);
    expect(rec.chatProjects.at(-1)).toBe(2);
  });
});

describe('Agents dock names (AC26)', () => {
  it('keeps the pane and close-button names and test ids', async () => {
    await mount();
    expect(dock()!.tagName).toBe('ASIDE');
    expect(dock()!.getAttribute('aria-label')).toBe('Agents');
    const close = testid(AGENTS_DOCK_TESTIDS.close)!;
    expect(close.getAttribute('aria-label')).toBe('Close Agents pane');
    expect(close.textContent).toBe('×');
    await act(async () => { close.parentElement!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 900)); });
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('Close Agents pane⌘J to reopen');
  });
});
