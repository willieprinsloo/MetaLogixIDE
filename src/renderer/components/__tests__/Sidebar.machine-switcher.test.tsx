// @vitest-environment jsdom
/**
 * Sidebar with the machine switcher (docs/specs/machine-switcher-dots.md AC1, AC2, AC7, AC9–AC15,
 * AC19, AC31; plan ruling C6): band presence, the hidden-but-mounted local list, the remote list,
 * and the zero-peer structure the chrome e2e specs measure. Only the IPC bridge is mocked.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within, act } from '@testing-library/react';
import { Profiler } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const invoke = vi.fn();
const handlers = new Map<string, (payload: unknown) => void>();
vi.mock('@renderer/api', () => ({
  api: {
    invoke: (...a: unknown[]) => invoke(...a),
    on: (ch: string, cb: (payload: unknown) => void) => { handlers.set(ch, cb); return () => { handlers.delete(ch); }; },
  },
}));
vi.mock('@renderer/hooks/useAgentStates', async (importOriginal) => ({
  ...await importOriginal<typeof import('@renderer/hooks/useAgentStates')>(),
  useOverallAgentState: () => localOverall, useProjectAgentState: () => 'idle',
}));
let localOverall: 'idle' | 'busy' | 'blocked' = 'idle';
let agentSnapshot: Array<{ projectId: number; shellIndex: number; agent: string | null; state: string }> = [];
const agentDelta = (entry: { projectId: number; shellIndex: number; agent: string | null; state: string }) => act(() => { handlers.get('agent-state:changed')?.(entry); });

import { Sidebar } from '../Sidebar';
import { MACHINE_TESTIDS, SIDEBAR_TESTIDS } from '@renderer/sidebar-copy';
import { LOCAL_MACHINE_ID } from '@renderer/machine-switcher-contract';
import { SWITCHER_PANEL_ID, machineTabId } from '@renderer/machine-dots';

const TOWER = { deviceId: 'tower', name: 'Tower', online: true, lastSeenAt: 1 };
const ATLAS = { deviceId: 'atlas', name: 'Atlas', online: false, lastSeenAt: null };
const LOCAL_PROJECT = {
  id: 11, rootId: 1, name: 'home-app', path: '/work/home-app', metaprojectProjectId: null, linkedChatChannelId: null,
  lastOpenedAt: null, pinned: false, hidden: false, firstLaunchedAt: null, config: {},
};
const REMOTE_PROJECTS = [{ id: 7, name: 'alpha', path: '/a/alpha', rootId: 1, lastOpenedAt: null, config: {} }];

let fleetReplies: Array<{ fleet: unknown[] } | Error>;
let localAlive: Array<{ projectId: number; shellIndex: number }>;
let remoteAlive: Record<string, unknown[]>;
let remoteProjects: Record<string, () => Promise<unknown>>;

function nextFleet() {
  const r = fleetReplies.length > 1 ? fleetReplies.shift()! : fleetReplies[0]!;
  return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  Element.prototype.scrollIntoView = vi.fn();
  localStorage.clear();
  invoke.mockReset();
  fleetReplies = [{ fleet: [] }];
  agentSnapshot = [];
  localOverall = 'idle';
  localAlive = [];
  remoteAlive = {};
  remoteProjects = {};
  invoke.mockImplementation(async (ch: string, a: { method?: string; deviceId?: string }) => {
    switch (ch) {
      case 'p2p:fleet-list': return nextFleet();
      case 'p2p:settings-get': return { deviceName: 'Laptop' };
      case 'projects:list': return { projects: [LOCAL_PROJECT] };
      case 'roots:list': return { roots: [{ id: 1, path: '/work', addedAt: '', sortOrder: 0 }] };
      case 'projects:recents': return { projects: [] };
      case 'shells:alive-list': return { shells: localAlive };
      case 'agent-state:list': return { shells: agentSnapshot };
      case 'p2p:rpc-call':
        if (a.method === 'projects.list') return remoteProjects[a.deviceId!]?.() ?? { result: REMOTE_PROJECTS };
        if (a.method === 'shells.alive') return { result: remoteAlive[a.deviceId!] ?? [] };
        if (a.method === 'roots.list') return { result: [{ id: 1, path: '/remote' }] };
        return { result: [] };
      default: throw new Error(`unexpected ${ch}`);
    }
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const base = { selectedProjectId: null as number | null, onSelect: vi.fn(), onUnloadSession: vi.fn(), onEditEnv: vi.fn(), onProjectSettings: vi.fn() };
const calls = (ch: string) => invoke.mock.calls.filter((c) => c[0] === ch).length;
const pollOnce = () => act(async () => { vi.advanceTimersByTime(5000); await Promise.resolve(); });
const aside = () => document.querySelector('aside')!;
const scrollArea = () => screen.getByTestId(SIDEBAR_TESTIDS.sectionAll).closest('.overflow-y-auto') as HTMLElement;

async function renderSidebar(props: Partial<typeof base> & { onOpenPane?: () => void } = {}) {
  const utils = render(<Sidebar {...base} {...props} />);
  await waitFor(() => expect(calls('p2p:fleet-list')).toBe(1));
  await screen.findAllByText('home-app');
  return utils;
}

describe('Sidebar with no paired machine (AC1, AC7)', () => {
  test.each([
    ['an empty fleet', () => { fleetReplies = [{ fleet: [] }]; }],
    ['a rejected fleet call (P2P off)', () => { fleetReplies = [new Error('p2p_not_started')]; }],
  ])('%s renders no band, no Machines heading and no tabpanel', async (_label, arrange) => {
    arrange();
    await renderSidebar();
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByTestId(MACHINE_TESTIDS.band)).toBeNull();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByText('Machines')).toBeNull();
    expect(screen.queryByTestId(MACHINE_TESTIDS.localList)).toBeNull();
    expect(scrollArea().getAttribute('role')).toBeNull();
    expect(scrollArea().id).toBe('');
  });

  test('keeps today\'s structure: sections sit directly in the scroll area, and the drag fill reaches the bottom', async () => {
    await renderSidebar();
    const kids = [...aside().children];
    expect(kids).toHaveLength(4);
    expect(kids[2]).toBe(scrollArea());
    expect(screen.getByTestId(SIDEBAR_TESTIDS.sectionAll).parentElement).toBe(scrollArea());
    const fill = screen.getByTestId('sidebar-drag-fill');
    expect(kids[3]).toBe(fill);
    expect(fill.className).toBe('drag flex-1 min-h-0 -mt-7 -mb-5');
    expect(scrollArea().className).toBe('flex-initial min-h-0 overflow-y-auto overflow-x-hidden pr-4 flex flex-col gap-7');
  });
});

describe('Sidebar with a paired machine', () => {
  beforeEach(() => { fleetReplies = [{ fleet: [TOWER] }]; });

  test('shows two dots with this machine active and its list visible (AC2, AC10)', async () => {
    await renderSidebar();
    const tabs = await screen.findAllByRole('tab');
    expect(tabs.map((t) => t.getAttribute('aria-label'))).toEqual(['Laptop, this machine', 'Tower, online']);
    expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual(['true', 'false']);
    const local = screen.getByTestId(MACHINE_TESTIDS.localList);
    expect(local.hidden).toBe(false);
    expect(within(local).getByTestId(SIDEBAR_TESTIDS.sectionAll)).toBeTruthy();
    expect(screen.queryByTestId(MACHINE_TESTIDS.remoteList)).toBeNull();
  });

  test('renders no machine- test ids and no Machines heading (AC7)', async () => {
    await renderSidebar();
    await screen.findAllByRole('tab');
    expect(document.querySelectorAll('[data-testid^="machine-"]')).toHaveLength(0);
    expect(screen.queryByRole('heading', { name: /machines/i })).toBeNull();
    expect(screen.queryByText('Machines')).toBeNull();
  });

  test('floats a tight frosted pill over the bottom of the list without moving the list or the drag fill (AC2, AC8, AC9, AC32, AC33)', async () => {
    await renderSidebar();
    const band = await screen.findByTestId(MACHINE_TESTIDS.band);
    const fill = screen.getByTestId('sidebar-drag-fill');
    expect(band.parentElement).toBe(aside());
    expect(fill.nextElementSibling).toBe(band);
    expect(fill.className).toBe('drag flex-1 min-h-0 -mt-7 -mb-5');
    expect(scrollArea().className).toBe('flex-initial min-h-0 overflow-y-auto overflow-x-hidden pr-4 flex flex-col gap-7 pb-9');
    for (const c of ['machine-pill', 'absolute', 'bottom-2', 'left-1/2', '-translate-x-1/2', 'no-drag', 'max-w-[calc(100%-16px)]', 'flex', 'rounded-full', 'border', 'border-[--border]']) {
      expect(band.classList).toContain(c);
    }
    for (const c of ['drag', 'h-7', 'w-full', 'inset-x-0']) expect(band.classList).not.toContain(c);
    expect([...band.classList].filter((c) => /^(shadow|bg-|backdrop|p[xytblr]?-)/.test(c))).toEqual([]);
    expect(band.firstElementChild).toBe(within(band).getByTestId(MACHINE_TESTIDS.row));
  });

  test('the pill sits above the list rows it overlaps', async () => {
    await renderSidebar();
    const band = await screen.findByTestId(MACHINE_TESTIDS.band);
    const z = [...band.classList].find((c) => /^z-/.test(c));
    expect(z).toBe('z-10');
    expect(scrollArea().querySelector('[class*="z-"]')).toBeNull();
  });

  test('tints this machine\'s dot from the local agent store and a peer\'s from its shells.alive poll (AC34, AC35)', async () => {
    agentSnapshot = [{ projectId: 3, shellIndex: 0, agent: 'claude', state: 'busy' }];
    const base = invoke.getMockImplementation()!;
    invoke.mockImplementation((ch: string, a: { method?: string }) => (
      a?.method === 'shells.alive' ? Promise.resolve({ result: [{ projectId: 7, shellIndex: 0, agentState: 'blocked' }] }) : base(ch, a)
    ));
    await renderSidebar();
    await waitFor(() => expect(screen.getByTestId(MACHINE_TESTIDS.dot('tower')).getAttribute('aria-label')).toBe('Tower, online, agent Needs input'));
    const mark = (id: string) => screen.getByTestId(MACHINE_TESTIDS.dot(id)).querySelector('[data-dot]')!;
    expect(mark('tower').getAttribute('data-agent-state')).toBe('blocked');
    expect(mark(LOCAL_MACHINE_ID).getAttribute('data-agent-state')).toBe('busy');
    expect(mark(LOCAL_MACHINE_ID).classList).toContain('live-dot');
    expect(screen.getByTestId(MACHINE_TESTIDS.dot(LOCAL_MACHINE_ID)).getAttribute('aria-label')).toBe('Laptop, this machine, agent Working');
  });

  test('the shared In use section reads the shared poll: one shells.alive per peer per 5 s (AC34)', async () => {
    remoteAlive.tower = [{ projectId: 7, shellIndex: 0, agentState: 'idle' }];
    const alive = () => invoke.mock.calls.filter((c) => (c[1] as { method?: string } | undefined)?.method === 'shells.alive').length;
    await renderSidebar();
    await waitFor(() => expect(alive()).toBe(1));
    fireEvent.click(screen.getByTestId(MACHINE_TESTIDS.dot('tower')));
    const inUse = await screen.findByTestId('section-in-use');
    await waitFor(() => expect(within(inUse).getAllByTestId(MACHINE_TESTIDS.inUseRemoteRow).map((r) => r.getAttribute('title'))).toEqual(['alpha on Tower']));
    expect(alive()).toBe(1);
    await pollOnce();
    await waitFor(() => expect(alive()).toBe(2));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(alive()).toBe(2);
  });

  test('labels the list area as the tabpanel of the active dot', async () => {
    await renderSidebar();
    await screen.findAllByRole('tab');
    const panel = screen.getByRole('tabpanel');
    expect(panel).toBe(scrollArea());
    expect(panel.id).toBe(SWITCHER_PANEL_ID);
    expect(panel.getAttribute('aria-labelledby')).toBe(machineTabId(LOCAL_MACHINE_ID));
    fireEvent.click(screen.getByTestId(MACHINE_TESTIDS.dot('tower')));
    expect(panel.getAttribute('aria-labelledby')).toBe(machineTabId('tower'));
    expect(screen.getByRole('tabpanel', { name: 'Tower, online' })).toBe(panel);
  });

  test('selecting the peer hides (not unmounts) the local list and shows the remote one, leaving the main pane alone (AC11, AC13)', async () => {
    const onSelect = vi.fn();
    const onOpenPane = vi.fn();
    await renderSidebar({ onSelect, onOpenPane });
    fireEvent.click(await screen.findByTestId(MACHINE_TESTIDS.dot('tower')));
    const local = screen.getByTestId(MACHINE_TESTIDS.localList);
    expect(local.hidden).toBe(true);
    expect(within(local).getByText('home-app')).toBeTruthy();
    const remote = screen.getByTestId(MACHINE_TESTIDS.remoteList);
    expect(scrollArea().firstElementChild).toBe(remote);
    await waitFor(() => expect(within(remote).getAllByTestId(MACHINE_TESTIDS.remoteProjectRow).map((r) => r.textContent)).toEqual(['alpha']));
    expect(screen.getByTestId(MACHINE_TESTIDS.dot('tower')).getAttribute('aria-selected')).toBe('true');
    expect(screen.getAllByRole('tab', { selected: true })).toHaveLength(1);
    expect(onSelect).not.toHaveBeenCalled();
    expect(onOpenPane).not.toHaveBeenCalled();
  });

  test('switching back keeps the highlight and collapse state of the local list (AC14)', async () => {
    await renderSidebar({ selectedProjectId: 11 });
    await screen.findAllByRole('tab');
    const row = () => screen.getByText('home-app').closest('[title]')!;
    expect(row().className).toContain('bg-[--accent-soft]');
    const rootToggle = screen.getByTestId('root-toggle');
    fireEvent.click(rootToggle);
    expect(screen.getByTestId('root-toggle').getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(screen.getByTestId(`${SIDEBAR_TESTIDS.sectionAll}-toggle`));
    fireEvent.click(screen.getByTestId(`${SIDEBAR_TESTIDS.sectionAll}-toggle`));
    fireEvent.click(screen.getByTestId(MACHINE_TESTIDS.dot('tower')));
    await screen.findByTestId(MACHINE_TESTIDS.remoteHeader);
    fireEvent.click(screen.getByTestId(MACHINE_TESTIDS.dot(LOCAL_MACHINE_ID)));
    expect(screen.queryByTestId(MACHINE_TESTIDS.remoteList)).toBeNull();
    expect(screen.getByTestId(MACHINE_TESTIDS.localList).hidden).toBe(false);
    expect(screen.getByTestId('root-toggle').getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(screen.getByTestId('root-toggle'));
    expect(row().className).toContain('bg-[--accent-soft]');
  });

  test('keeps a collapsed Projects section collapsed across a round trip (AC14)', async () => {
    await renderSidebar();
    await screen.findAllByRole('tab');
    fireEvent.click(screen.getByTestId(`${SIDEBAR_TESTIDS.sectionAll}-toggle`));
    expect(screen.getByTestId(`${SIDEBAR_TESTIDS.sectionAll}-toggle`).getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(screen.getByTestId(MACHINE_TESTIDS.dot('tower')));
    fireEvent.click(screen.getByTestId(MACHINE_TESTIDS.dot(LOCAL_MACHINE_ID)));
    expect(screen.getByTestId(`${SIDEBAR_TESTIDS.sectionAll}-toggle`).getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('home-app')).toBeNull();
  });

  test('a round trip to the peer and back requests nothing for the local list (C6, AC12)', async () => {
    await renderSidebar();
    await screen.findAllByRole('tab');
    const before = ['projects:list', 'roots:list', 'projects:recents', 'shells:alive-list'].map(calls);
    fireEvent.click(screen.getByTestId(MACHINE_TESTIDS.dot('tower')));
    await screen.findByText('alpha');
    fireEvent.click(screen.getByTestId(MACHINE_TESTIDS.dot(LOCAL_MACHINE_ID)));
    fireEvent.click(screen.getByTestId(MACHINE_TESTIDS.dot(LOCAL_MACHINE_ID)));
    expect(['projects:list', 'roots:list', 'projects:recents', 'shells:alive-list'].map(calls)).toEqual(before);
  });

  test('clicking a remote row opens the remote pane (AC18)', async () => {
    const onOpenPane = vi.fn();
    await renderSidebar({ onOpenPane });
    fireEvent.click(await screen.findByTestId(MACHINE_TESTIDS.dot('tower')));
    fireEvent.click(await screen.findByText('alpha'));
    expect(onOpenPane.mock.calls).toEqual([[{
      source: { kind: 'remote', deviceId: 'tower' }, deviceName: 'Tower', projectId: 7, projectName: 'alpha',
    }]]);
  });

  test('the filter field stays, keeps its text across switches and filters the remote list (AC19, AC31)', async () => {
    await renderSidebar();
    await screen.findAllByRole('tab');
    fireEvent.change(screen.getByTestId(SIDEBAR_TESTIDS.filter), { target: { value: 'zzz' } });
    fireEvent.click(screen.getByTestId(MACHINE_TESTIDS.dot('tower')));
    await screen.findByTestId(MACHINE_TESTIDS.remoteFolders);
    expect((screen.getByTestId(SIDEBAR_TESTIDS.filter) as HTMLInputElement).value).toBe('zzz');
    expect(screen.queryByTestId(MACHINE_TESTIDS.remoteProjectRow)).toBeNull();
    fireEvent.change(screen.getByTestId(SIDEBAR_TESTIDS.filter), { target: { value: 'ALP' } });
    expect(screen.getAllByTestId(MACHINE_TESTIDS.remoteProjectRow).map((r) => r.textContent)).toEqual(['alpha']);
  });
});

describe('Sidebar shared In use section (AC36–AC42)', () => {
  const ORBIT = { deviceId: 'orbit', name: 'Orbit', online: true, lastSeenAt: 1 };
  const inUse = () => screen.getByTestId('section-in-use');
  const remoteRows = () => within(inUse()).queryAllByTestId(MACHINE_TESTIDS.inUseRemoteRow);
  const localRows = () => within(inUse()).queryAllByTestId('project-row').map((r) => r.textContent);
  const remoteView = () => remoteRows().map((r) => [
    within(r).getByTestId(MACHINE_TESTIDS.inUseRowName).textContent, within(r).getByTestId(MACHINE_TESTIDS.inUseMachineTag).textContent,
  ].join('@'));
  const headingDot = () => screen.getByTestId('section-in-use-toggle').querySelector('[data-testid="claude-dot"]')!;

  beforeEach(() => {
    fleetReplies = [{ fleet: [TOWER, ORBIT] }];
    localAlive = [{ projectId: 11, shellIndex: 0 }];
    remoteAlive = {
      tower: [{ projectId: 7, shellIndex: 0, agentState: 'busy' }, { projectId: 8, shellIndex: 0, agentState: null }],
      orbit: [{ projectId: 3, shellIndex: 0, agentState: 'idle' }],
    };
    remoteProjects = {
      tower: async () => ({ result: [...REMOTE_PROJECTS, { id: 8, name: 'aardvark', path: '/a/aardvark', rootId: 1, lastOpenedAt: null, config: {} }] }),
      orbit: async () => ({ result: [{ id: 3, name: 'zulu', path: '/o/zulu', rootId: 1, lastOpenedAt: null, config: {} }] }),
    };
  });

  test('is the first item of the list on this machine\'s dot: local rows first, then each peer in dot order, by name (AC36, AC37)', async () => {
    await renderSidebar();
    await waitFor(() => expect(remoteView()).toEqual(['zulu@Orbit', 'aardvark@Tower', 'alpha@Tower']));
    expect(scrollArea().firstElementChild).toBe(inUse());
    expect(localRows()).toEqual(['home-app']);
    const rows = [...inUse().querySelectorAll('[data-testid="project-row"], [data-testid="in-use-remote-row"]')];
    expect(rows[0]!.getAttribute('data-testid')).toBe('project-row');
    expect(screen.getAllByTestId('section-in-use')).toHaveLength(1);
    expect(within(screen.getByTestId(MACHINE_TESTIDS.localList)).queryByText('In use')).toBeNull();
  });

  test('stays first, once, whichever dot is selected; the remote header comes right after it (AC31, AC36)', async () => {
    await renderSidebar();
    fireEvent.click(await screen.findByTestId(MACHINE_TESTIDS.dot('tower')));
    await waitFor(() => expect(remoteRows()).toHaveLength(3));
    expect(scrollArea().firstElementChild).toBe(inUse());
    expect(inUse().nextElementSibling).toBe(screen.getByTestId(MACHINE_TESTIDS.remoteList));
    expect(screen.getByTestId(MACHINE_TESTIDS.remoteList).firstElementChild).toBe(screen.getByTestId(MACHINE_TESTIDS.remoteHeader));
    expect(screen.getAllByTestId('section-in-use')).toHaveLength(1);
    expect(within(screen.getByTestId(MACHINE_TESTIDS.remoteList)).queryByText('In use')).toBeNull();
    expect(localRows()).toEqual(['home-app']);
  });

  test('local rows keep today\'s behaviour: selection highlight and the unload button (AC37)', async () => {
    await renderSidebar({ selectedProjectId: 11 });
    await waitFor(() => expect(localRows()).toEqual(['home-app']));
    const row = within(inUse()).getByTestId('project-row').closest('[title]')!;
    expect(row.className).toContain('bg-[--accent-soft]');
    expect(within(inUse()).getByTestId('row-unload')).toBeTruthy();
    expect(within(row as HTMLElement).queryByTestId(MACHINE_TESTIDS.inUseMachineTag)).toBeNull();
  });

  test('a remote row opens the remote pane as AC18 does, without switching the dot or selecting a local project (AC38)', async () => {
    const onOpenPane = vi.fn();
    const onSelect = vi.fn();
    await renderSidebar({ onOpenPane, onSelect });
    await waitFor(() => expect(remoteRows()).toHaveLength(3));
    fireEvent.click(remoteRows().find((r) => r.getAttribute('title') === 'alpha on Tower')!);
    expect(onOpenPane.mock.calls).toEqual([[{
      source: { kind: 'remote', deviceId: 'tower' }, deviceName: 'Tower', projectId: 7, projectName: 'alpha',
    }]]);
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByTestId(MACHINE_TESTIDS.dot(LOCAL_MACHINE_ID)).getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByTestId(MACHINE_TESTIDS.remoteList)).toBeNull();
  });

  test('a remote row is a keyboard-operable button named by its status, project and machine (AC37, AC42)', async () => {
    await renderSidebar();
    await waitFor(() => expect(remoteRows()).toHaveLength(3));
    const alpha = screen.getByRole('button', { name: 'Working alpha Tower' });
    expect(alpha.tagName).toBe('BUTTON');
    expect(alpha.getAttribute('type')).toBe('button');
  });

  test('the machine tag truncates after the project name does, with the full names in the row title (AC37)', async () => {
    const long = 'An extremely long machine name that cannot fit in a sidebar';
    fleetReplies = [{ fleet: [{ ...TOWER, name: long }] }];
    await renderSidebar();
    await waitFor(() => expect(remoteRows()).toHaveLength(2));
    const row = remoteRows()[1]!;
    const tag = within(row).getByTestId(MACHINE_TESTIDS.inUseMachineTag);
    const name = within(row).getByTestId(MACHINE_TESTIDS.inUseRowName);
    expect(tag.textContent).toBe(long);
    expect(tag.classList).toContain('truncate');
    expect(tag.classList).toContain('shrink-0');
    expect(name.classList).toContain('truncate');
    expect(name.classList).toContain('min-w-0');
    expect(name.classList).toContain('flex-1');
    expect(row.getAttribute('title')).toBe(`alpha on ${long}`);
  });

  test('remote rows carry the per-project StatusDot; no agent reads as idle (AC42)', async () => {
    await renderSidebar();
    await waitFor(() => expect(remoteRows()).toHaveLength(3));
    const dot = (title: string) => remoteRows().find((r) => r.getAttribute('title') === title)!.querySelector('[data-testid="claude-dot"]')!;
    expect(dot('alpha on Tower').getAttribute('data-claude-state')).toBe('busy');
    expect(dot('aardvark on Tower').getAttribute('data-claude-state')).toBe('idle');
    expect(dot('zulu on Orbit').getAttribute('aria-label')).toBe('Idle');
  });

  test('the selected peer\'s own list shows the same per-project StatusDot on its live rows (AC42)', async () => {
    await renderSidebar();
    fireEvent.click(await screen.findByTestId(MACHINE_TESTIDS.dot('tower')));
    const folders = await screen.findByTestId(MACHINE_TESTIDS.remoteFolders);
    const row = (n: string) => within(folders).getAllByTestId(MACHINE_TESTIDS.remoteProjectRow).find((r) => r.textContent === n)!;
    await waitFor(() => expect(row('alpha').querySelector('[data-testid="claude-dot"]')?.getAttribute('data-claude-state')).toBe('busy'));
  });

  test('the heading dot is the worst state across machines with rows (AC40)', async () => {
    remoteAlive.orbit = [{ projectId: 3, shellIndex: 0, agentState: 'blocked' }];
    await renderSidebar();
    await waitFor(() => expect(headingDot().getAttribute('data-claude-state')).toBe('blocked'));
    fireEvent.change(screen.getByTestId(SIDEBAR_TESTIDS.filter), { target: { value: 'a' } });
    expect(remoteView()).toEqual(['aardvark@Tower', 'alpha@Tower']);
    expect(headingDot().getAttribute('data-claude-state')).toBe('busy');
  });

  test('the heading takes this machine\'s state only while it has rows (AC40)', async () => {
    localOverall = 'blocked';
    await renderSidebar();
    await waitFor(() => expect(remoteRows()).toHaveLength(3));
    expect(headingDot().getAttribute('data-claude-state')).toBe('blocked');
    fireEvent.change(screen.getByTestId(SIDEBAR_TESTIDS.filter), { target: { value: 'alpha' } });
    expect(localRows()).toEqual([]);
    expect(headingDot().getAttribute('data-claude-state')).toBe('busy');
  });

  test('the filter applies by project name, and the section hides with no rows (AC36, AC39)', async () => {
    await renderSidebar();
    await waitFor(() => expect(remoteRows()).toHaveLength(3));
    fireEvent.change(screen.getByTestId(SIDEBAR_TESTIDS.filter), { target: { value: 'ZUL' } });
    expect(remoteView()).toEqual(['zulu@Orbit']);
    expect(localRows()).toEqual([]);
    fireEvent.change(screen.getByTestId(SIDEBAR_TESTIDS.filter), { target: { value: 'nothing' } });
    expect(screen.queryByTestId('section-in-use')).toBeNull();
  });

  test('an offline peer contributes no rows and its list follows the section (AC36, AC39)', async () => {
    fleetReplies = [{ fleet: [ATLAS] }];
    await renderSidebar();
    await waitFor(() => expect(localRows()).toEqual(['home-app']));
    fireEvent.click(await screen.findByTestId(MACHINE_TESTIDS.dot('atlas')));
    expect(scrollArea().firstElementChild).toBe(inUse());
    expect(inUse().nextElementSibling).toBe(screen.getByTestId(MACHINE_TESTIDS.remoteList));
    expect(remoteRows()).toEqual([]);
  });

  test('a peer\'s rows wait for its project names; a failed projects.list leaves only that peer out (AC39)', async () => {
    let settle!: (v: unknown) => void;
    remoteProjects.tower = () => new Promise((r) => { settle = r; });
    remoteProjects.orbit = async () => { throw new Error('peer_unreachable'); };
    await renderSidebar();
    await waitFor(() => expect(calls('p2p:rpc-call')).toBeGreaterThanOrEqual(4));
    await act(async () => { await Promise.resolve(); });
    expect(remoteRows()).toEqual([]);
    expect(localRows()).toEqual(['home-app']);
    await act(async () => { settle({ result: REMOTE_PROJECTS }); await Promise.resolve(); });
    await waitFor(() => expect(remoteView()).toEqual(['alpha@Tower']));
    expect(localRows()).toEqual(['home-app']);
  });

  test('a live peer project whose name the shared section has not got yet stays in that peer\'s Recents (AC36)', async () => {
    let settle!: (v: unknown) => void;
    let towerCalls = 0;
    const towerRows = { result: [{ ...REMOTE_PROJECTS[0]!, lastOpenedAt: '2026-01-01T00:00:00.000Z' }] };
    remoteProjects.tower = () => (++towerCalls === 1 ? new Promise((r) => { settle = r; }) : Promise.resolve(towerRows));
    await renderSidebar();
    await waitFor(() => expect(towerCalls).toBe(1));
    fireEvent.click(await screen.findByTestId(MACHINE_TESTIDS.dot('tower')));
    const recents = await screen.findByTestId(MACHINE_TESTIDS.remoteRecents);
    expect(within(recents).getAllByTestId(MACHINE_TESTIDS.remoteProjectRow).map((r) => r.textContent)).toEqual(['alpha']);
    expect(remoteView()).toEqual(['zulu@Orbit']);
    await act(async () => { settle(towerRows); await Promise.resolve(); });
    await waitFor(() => expect(remoteView()).toEqual(['zulu@Orbit', 'alpha@Tower']));
    expect(screen.queryByTestId(MACHINE_TESTIDS.remoteRecents)).toBeNull();
  });

  test('collapsing the section hides local and remote rows together', async () => {
    await renderSidebar();
    await waitFor(() => expect(remoteRows()).toHaveLength(3));
    fireEvent.click(screen.getByTestId('section-in-use-toggle'));
    expect(remoteRows()).toEqual([]);
    expect(localRows()).toEqual([]);
  });
});

describe('Sidebar In use with no paired machine (AC41)', () => {
  test('lists only this machine\'s live projects in place, and asks no peer for names', async () => {
    localAlive = [{ projectId: 11, shellIndex: 0 }];
    await renderSidebar();
    const inUse = await screen.findByTestId('section-in-use');
    expect(inUse.parentElement).toBe(scrollArea());
    expect(inUse.nextElementSibling).toBe(screen.getByTestId(SIDEBAR_TESTIDS.sectionAll));
    expect(within(inUse).getAllByTestId('project-row').map((r) => r.textContent)).toEqual(['home-app']);
    expect(within(inUse).queryAllByTestId(MACHINE_TESTIDS.inUseRemoteRow)).toEqual([]);
    expect(calls('p2p:rpc-call')).toBe(0);
  });
});

describe('Sidebar with an offline machine', () => {
  test('shows the offline panel with the filter field still rendered (AC22, AC31)', async () => {
    fleetReplies = [{ fleet: [ATLAS] }];
    await renderSidebar();
    fireEvent.click(await screen.findByTestId(MACHINE_TESTIDS.dot('atlas')));
    expect(screen.getByTestId(MACHINE_TESTIDS.remoteLastSeen).textContent).toBe('never seen');
    expect(screen.getByTestId(SIDEBAR_TESTIDS.filter)).toBeTruthy();
    expect(screen.queryByTestId(MACHINE_TESTIDS.remoteProjectRow)).toBeNull();
  });
});

describe('machine pill and dot styles (AC21, AC32, AC34)', () => {
  const css = readFileSync(resolve(__dirname, '../../styles.css'), 'utf8');
  const reduceBlocks = [...css.matchAll(/@media \(prefers-reduced-transparency: reduce\)\s*\{((?:[^{}]*\{[^}]*\})*)\s*\}/g)].map((m) => m[1]!);
  const reduced = reduceBlocks.find((b) => b.includes('.machine-pill')) ?? '';
  const topLevel = reduceBlocks.reduce((acc, b) => acc.replace(b, ''), css);
  const esc = (sel: string) => sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = (src: string, sel: string) => new RegExp(`(?:^|[}\\s])${esc(sel)}\\s*\\{([^}]*)\\}`).exec(src)?.[1] ?? '';

  test('the pill is the translucent sidebar panel colour with a backdrop blur and no shadow', () => {
    const pill = rule(topLevel, '.machine-pill');
    expect(pill).toMatch(/background:\s*rgb\(from var\(--panel-strong\) r g b \/ 0?\.\d+\)/);
    expect(pill).toMatch(/backdrop-filter:\s*blur\(\d+px\)/);
    expect(pill).not.toMatch(/box-shadow/);
  });

  test('under Reduce transparency the pill is opaque with no blur', () => {
    expect(rule(reduced, '.machine-pill')).toMatch(/background:\s*rgb\(from var\(--panel-strong\) r g b \/ 1\)/);
    expect(rule(reduced, '.machine-pill')).toMatch(/backdrop-filter:\s*none/);
  });

  test('a dot with no agent is a solid --text-muted circle: no glass, ring, highlight, edge or shadow', () => {
    const base = rule(topLevel, '.machine-dot');
    expect(base).toMatch(/background:\s*var\(--text-muted\)/);
    expect(css).not.toMatch(/\.machine-dot[^{]*\{[^}]*(backdrop-filter|box-shadow)/);
    expect(base).not.toMatch(/border/);
    expect(css).not.toMatch(/\.machine-dot\[data-active\]\s*\{/);
  });

  test.each(['idle', 'busy', 'blocked'])('a %s dot is filled with its agent colour at full strength', (state) => {
    expect(rule(topLevel, `.machine-dot[data-agent-state="${state}"]`).trim()).toBe(`background: var(--agent-${state});`);
  });

  test('an offline dot is a 1px --text-muted outline with no fill at 50%; the active offline dot is not dimmed', () => {
    const off = rule(topLevel, '.machine-dot[data-online="0"]');
    expect(off).toMatch(/background:\s*transparent/);
    expect(off).toMatch(/border:\s*1px solid var\(--text-muted\)/);
    expect(off).toMatch(/opacity:\s*0?\.5\b/);
    expect(rule(topLevel, '.machine-dot[data-online="0"][data-active]')).toMatch(/opacity:\s*1\b/);
  });

  test('Reduce transparency leaves the solid dots alone', () => {
    for (const b of reduceBlocks) expect(b).not.toMatch(/\.machine-dot/);
  });

  const block = (at: string, from = 0) => {
    const start = css.indexOf(`${at} {`, from);
    if (start < 0) return '';
    let depth = 0;
    for (let i = css.indexOf('{', start); i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}' && --depth === 0) return css.slice(start, i + 1);
    }
    return '';
  };
  const frames = (name: string) => {
    const kf = block(`@keyframes ${name}`);
    const step = (at: string) => new RegExp(`${at}\\s*\\{([^}]*)\\}`).exec(kf)?.[1] ?? '';
    const num = (s: string, re: RegExp) => Number(re.exec(s)?.[1]);
    return { fromScale: num(step('from'), /scale\(([\d.]+)\)/), fromOpacity: num(step('from'), /opacity:\s*([\d.]+)/), toScale: num(step('to'), /scale\(([\d.]+)\)/), toOpacity: num(step('to'), /opacity:\s*([\d.]+)/) };
  };

  test('a busy machine dot pulses with its own smaller, softer, desaturated glow; the shared status-dot pulse is unchanged', () => {
    const after = rule(topLevel, '.machine-dot.live-dot::after');
    const name = /animation:\s*([\w-]+)/.exec(after)?.[1];
    expect(name).toBeTruthy();
    expect(name).not.toBe('livePulse');
    expect(after).toMatch(/filter:\s*saturate\(0?\.\d+\)/);
    const own = frames(name!);
    expect(own.fromScale).toBe(1);
    expect(own.toScale).toBeLessThanOrEqual(2);
    expect(own.toScale).toBeGreaterThan(1);
    expect(own.fromOpacity).toBeLessThanOrEqual(0.4);
    expect(own.fromOpacity).toBeGreaterThan(0);
    expect(own.toOpacity).toBe(0);
    expect(frames('livePulse')).toEqual({ fromScale: 1, fromOpacity: 0.6, toScale: 2.6, toOpacity: 0 });
    expect(rule(css, '.live-dot::after')).toMatch(/animation:\s*livePulse 2s/);
  });

  test('under reduced motion the machine dot pulse is hidden too, by a rule as specific as its own', () => {
    const own = css.indexOf('.machine-dot.live-dot::after {');
    const motion = block('@media (prefers-reduced-motion: reduce)', own);
    expect(own).toBeGreaterThan(0);
    const off = rule(motion, '.machine-dot.live-dot::after');
    expect(off).toMatch(/animation:\s*none/);
    expect(off).toMatch(/opacity:\s*0\b/);
  });

});

describe('Sidebar Reconnect across a switch (AC20)', () => {
  test('a reconnect still in flight keeps the button disabled after switching away and back', async () => {
    fleetReplies = [{ fleet: [ATLAS] }];
    let settle!: (v: unknown) => void;
    const base = invoke.getMockImplementation()!;
    invoke.mockImplementation((ch: string, a: unknown) => (
      ch === 'p2p:reconnect-device' ? new Promise((r) => { settle = r; }) : base(ch, a)
    ));
    const button = () => screen.getByTestId(MACHINE_TESTIDS.remoteReconnect) as HTMLButtonElement;
    await renderSidebar();
    fireEvent.click(await screen.findByTestId(MACHINE_TESTIDS.dot('atlas')));
    fireEvent.click(button());
    expect(button().disabled).toBe(true);
    fireEvent.click(screen.getByTestId(MACHINE_TESTIDS.dot(LOCAL_MACHINE_ID)));
    expect(screen.queryByTestId(MACHINE_TESTIDS.remoteReconnect)).toBeNull();
    fireEvent.click(screen.getByTestId(MACHINE_TESTIDS.dot('atlas')));
    expect(button().disabled).toBe(true);
    fireEvent.click(button());
    expect(calls('p2p:reconnect-device')).toBe(1);
    await act(async () => { settle({ ok: true }); await Promise.resolve(); });
    await waitFor(() => expect(button().disabled).toBe(false));
    fireEvent.click(button());
    expect(calls('p2p:reconnect-device')).toBe(2);
    await act(async () => { settle({ ok: true }); await Promise.resolve(); });
    await waitFor(() => expect(button().disabled).toBe(false));
  });
});

describe('Sidebar Reconnect per machine (AC20)', () => {
  test('a reconnect in flight for one machine leaves another machine\'s Reconnect enabled', async () => {
    fleetReplies = [{ fleet: [ATLAS, { ...TOWER, online: false }] }];
    let settle!: (v: unknown) => void;
    const base = invoke.getMockImplementation()!;
    invoke.mockImplementation((ch: string, a: unknown) => (
      ch === 'p2p:reconnect-device' ? new Promise((r) => { settle = r; }) : base(ch, a)
    ));
    const button = () => screen.getByTestId(MACHINE_TESTIDS.remoteReconnect) as HTMLButtonElement;
    await renderSidebar();
    fireEvent.click(await screen.findByTestId(MACHINE_TESTIDS.dot('atlas')));
    fireEvent.click(button());
    fireEvent.click(screen.getByTestId(MACHINE_TESTIDS.dot('tower')));
    expect(button().disabled).toBe(false);
    fireEvent.click(screen.getByTestId(MACHINE_TESTIDS.dot('atlas')));
    expect(button().disabled).toBe(true);
    await act(async () => { settle({ ok: true }); await Promise.resolve(); });
    await waitFor(() => expect(button().disabled).toBe(false));
  });
});

describe('Sidebar poll cost (F4)', () => {
  const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 10)); });

  test('with zero peers, unchanged fleet polls stop committing the sidebar; a changed one still does', async () => {
    fleetReplies = [{ fleet: [] }, { fleet: [] }, { fleet: [] }, { fleet: [] }, { fleet: [] }, { fleet: [TOWER] }];
    let commits = 0;
    render(<Profiler id="sidebar" onRender={() => { commits++; }}><Sidebar {...base} /></Profiler>);
    await screen.findByText('home-app');
    await settle();
    await pollOnce();
    await settle();
    expect(calls('p2p:fleet-list')).toBe(2);
    const steady = commits;
    for (let i = 0; i < 3; i++) { await pollOnce(); await settle(); }
    expect(calls('p2p:fleet-list')).toBe(5);
    expect(commits).toBe(steady);
    await pollOnce();
    await screen.findByTestId(MACHINE_TESTIDS.band);
    expect(commits).toBeGreaterThan(steady);
  });
});

describe('Sidebar agent-state cost (AC34)', () => {
  test('a local agent delta that leaves the machine\'s worst state unchanged does not commit the sidebar; one that changes it does', async () => {
    fleetReplies = [{ fleet: [TOWER] }];
    agentSnapshot = [{ projectId: 3, shellIndex: 0, agent: 'claude', state: 'busy' }];
    let commits = 0;
    render(<Profiler id="sidebar" onRender={() => { commits++; }}><Sidebar {...base} /></Profiler>);
    const local = () => screen.getByTestId(MACHINE_TESTIDS.dot(LOCAL_MACHINE_ID)).querySelector('[data-dot]')!;
    await waitFor(() => expect(local().getAttribute('data-agent-state')).toBe('busy'));
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    const steady = commits;
    await agentDelta({ projectId: 4, shellIndex: 0, agent: 'codex', state: 'busy' });
    await agentDelta({ projectId: 4, shellIndex: 0, agent: 'codex', state: 'idle' });
    await agentDelta({ projectId: 4, shellIndex: 0, agent: null, state: 'idle' });
    expect(commits).toBe(steady);
    await agentDelta({ projectId: 4, shellIndex: 0, agent: 'codex', state: 'blocked' });
    expect(local().getAttribute('data-agent-state')).toBe('blocked');
    expect(commits).toBeGreaterThan(steady);
    const blocked = commits;
    await agentDelta({ projectId: 4, shellIndex: 0, agent: null, state: 'idle' });
    await agentDelta({ projectId: 3, shellIndex: 0, agent: null, state: 'idle' });
    expect(local().hasAttribute('data-agent-state')).toBe(false);
    expect(commits).toBeGreaterThan(blocked);
  });
});

describe('Sidebar fleet changes (AC9, AC15)', () => {
  test('the band appears when a first machine is paired mid-run', async () => {
    fleetReplies = [{ fleet: [] }, { fleet: [TOWER] }];
    await renderSidebar();
    expect(screen.queryByTestId(MACHINE_TESTIDS.band)).toBeNull();
    await pollOnce();
    expect(await screen.findByTestId(MACHINE_TESTIDS.band)).toBeTruthy();
    expect(screen.getByText('home-app')).toBeTruthy();
  });

  test('falls back to this machine when the shown peer is unpaired, and stays there when it returns', async () => {
    fleetReplies = [{ fleet: [TOWER, ATLAS] }, { fleet: [ATLAS] }, { fleet: [TOWER, ATLAS] }];
    await renderSidebar();
    fireEvent.click(await screen.findByTestId(MACHINE_TESTIDS.dot('tower')));
    await screen.findByTestId(MACHINE_TESTIDS.remoteList);
    await pollOnce();
    await waitFor(() => expect(screen.queryByTestId(MACHINE_TESTIDS.remoteList)).toBeNull());
    expect(screen.getByTestId(MACHINE_TESTIDS.localList).hidden).toBe(false);
    expect(screen.getByTestId(MACHINE_TESTIDS.dot(LOCAL_MACHINE_ID)).getAttribute('aria-selected')).toBe('true');
    await pollOnce();
    await screen.findByTestId(MACHINE_TESTIDS.dot('tower'));
    expect(screen.getByTestId(MACHINE_TESTIDS.dot(LOCAL_MACHINE_ID)).getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByTestId(MACHINE_TESTIDS.remoteList)).toBeNull();
  });

  test('a failed poll while a peer is shown changes nothing', async () => {
    fleetReplies = [{ fleet: [TOWER] }, new Error('relay down')];
    await renderSidebar();
    fireEvent.click(await screen.findByTestId(MACHINE_TESTIDS.dot('tower')));
    await pollOnce();
    await waitFor(() => expect(calls('p2p:fleet-list')).toBe(2));
    expect(screen.getByTestId(MACHINE_TESTIDS.remoteList)).toBeTruthy();
    expect(screen.getByTestId(MACHINE_TESTIDS.band)).toBeTruthy();
  });
});
