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
  useOverallAgentState: () => 'idle', useProjectAgentState: () => 'idle',
}));
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
  invoke.mockImplementation(async (ch: string, a: { method?: string }) => {
    switch (ch) {
      case 'p2p:fleet-list': return nextFleet();
      case 'p2p:settings-get': return { deviceName: 'Laptop' };
      case 'projects:list': return { projects: [LOCAL_PROJECT] };
      case 'roots:list': return { roots: [{ id: 1, path: '/work', addedAt: '', sortOrder: 0 }] };
      case 'projects:recents': return { projects: [] };
      case 'shells:alive-list': return { shells: [] };
      case 'agent-state:list': return { shells: agentSnapshot };
      case 'p2p:rpc-call':
        if (a.method === 'projects.list') return { result: REMOTE_PROJECTS };
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
  await screen.findByText('home-app');
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

  test('floats a transparent dot row over the bottom of the list without moving the list or the drag fill (AC2, AC8, AC9, AC32, AC33)', async () => {
    await renderSidebar();
    const band = await screen.findByTestId(MACHINE_TESTIDS.band);
    const fill = screen.getByTestId('sidebar-drag-fill');
    expect(band.parentElement).toBe(aside());
    expect(fill.nextElementSibling).toBe(band);
    expect(fill.className).toBe('drag flex-1 min-h-0 -mt-7 -mb-5');
    expect(scrollArea().className).toBe('flex-initial min-h-0 overflow-y-auto overflow-x-hidden pr-4 flex flex-col gap-7 pb-11');
    for (const c of ['absolute', 'bottom-2', 'left-1/2', '-translate-x-1/2', 'no-drag', 'max-w-[calc(100%-16px)]', 'flex']) {
      expect(band.classList).toContain(c);
    }
    for (const c of ['machine-pill', 'rounded-full', 'border', 'border-[--border]', 'shadow-sm', 'px-1', 'drag', 'h-7', 'w-full', 'inset-x-0']) {
      expect(band.classList).not.toContain(c);
    }
    expect([...band.classList].filter((c) => /^(bg|shadow|border|rounded|backdrop)-?/.test(c))).toEqual([]);
    expect(band.firstElementChild).toBe(within(band).getByTestId(MACHINE_TESTIDS.row));
  });

  test('the dot row sits above the list rows it overlaps', async () => {
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

  test('the remote In use list reads the shared poll: one shells.alive per peer per 5 s (AC34)', async () => {
    const base = invoke.getMockImplementation()!;
    invoke.mockImplementation((ch: string, a: { method?: string }) => (
      a?.method === 'shells.alive' ? Promise.resolve({ result: [{ projectId: 7, shellIndex: 0, agentState: 'idle' }] }) : base(ch, a)
    ));
    const alive = () => invoke.mock.calls.filter((c) => (c[1] as { method?: string } | undefined)?.method === 'shells.alive').length;
    await renderSidebar();
    await waitFor(() => expect(alive()).toBe(1));
    fireEvent.click(screen.getByTestId(MACHINE_TESTIDS.dot('tower')));
    const inUse = await screen.findByTestId(MACHINE_TESTIDS.remoteInUse);
    expect(within(inUse).getAllByTestId(MACHINE_TESTIDS.remoteProjectRow).map((r) => r.textContent)).toEqual(['alpha']);
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

describe('machine dot styles (AC21, AC32, AC34)', () => {
  const css = readFileSync(resolve(__dirname, '../../styles.css'), 'utf8');
  const reduceBlocks = [...css.matchAll(/@media \(prefers-reduced-transparency: reduce\)\s*\{((?:[^{}]*\{[^}]*\})*)\s*\}/g)].map((m) => m[1]!);
  const reduced = reduceBlocks.find((b) => b.includes('.machine-dot')) ?? '';
  const topLevel = reduceBlocks.reduce((acc, b) => acc.replace(b, ''), css);
  const esc = (sel: string) => sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = (src: string, sel: string) => new RegExp(`(?:^|[}\\s])${esc(sel)}\\s*\\{([^}]*)\\}`).exec(src)?.[1] ?? '';

  test('every dot is frosted glass: translucent fill, backdrop blur, 1px translucent edge, inner highlight', () => {
    const base = rule(topLevel, '.machine-dot');
    expect(base).toMatch(/background:\s*rgb\(from var\(--panel-strong\) r g b \/ 0?\.\d+\)/);
    expect(base).toMatch(/backdrop-filter:\s*blur\(\d+px\)/);
    expect(base).toMatch(/border:\s*1px solid rgb\(from var\(--text\) r g b \/ 0?\.\d+\)/);
    expect(base).toMatch(/box-shadow:\s*inset 0 1px 0 /);
  });

  test.each(['idle', 'busy', 'blocked'])('a %s dot is tinted with its agent colour', (state) => {
    const tinted = rule(topLevel, `.machine-dot[data-agent-state="${state}"]`);
    expect(tinted).toMatch(new RegExp(`background:\\s*color-mix\\(in srgb, var\\(--agent-${state}\\) \\d+%, transparent\\)`));
  });

  test('the active dot adds a 1.5px softened accent ring outside the glass and keeps the inner highlight', () => {
    const ring = /box-shadow:\s*inset 0 1px 0 [^,;]*\)\s*,\s*0 0 0 1\.5px color-mix\(in srgb, var\(--accent\) (\d+)%, transparent\)/.exec(rule(topLevel, '.machine-dot[data-active]'));
    expect(ring).not.toBeNull();
    expect(Number(ring![1])).toBeLessThan(100);
    expect(Number(ring![1])).toBeGreaterThan(0);
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

  test('an offline dot is a faint edge with no fill or blur; active offline is not dimmed', () => {
    const off = rule(topLevel, '.machine-dot[data-online="0"]');
    expect(off).toMatch(/background:\s*transparent/);
    expect(off).toMatch(/backdrop-filter:\s*none/);
    expect(off).toMatch(/opacity:\s*0?\.5\b/);
    expect(rule(topLevel, '.machine-dot[data-online="0"][data-active]')).toMatch(/opacity:\s*1\b/);
  });

  test('under Reduce transparency there is no blur, clear glass is the solid panel and a tinted dot the solid agent colour', () => {
    expect(rule(reduced, '.machine-dot')).toMatch(/background:\s*rgb\(from var\(--panel-strong\) r g b \/ 1\)/);
    expect(rule(reduced, '.machine-dot')).toMatch(/backdrop-filter:\s*none/);
    for (const state of ['idle', 'busy', 'blocked']) {
      expect(rule(reduced, `.machine-dot[data-agent-state="${state}"]`)).toMatch(new RegExp(`background:\\s*var\\(--agent-${state}\\)`));
    }
    expect(rule(reduced, '.machine-dot[data-online="0"]')).toMatch(/background:\s*transparent/);
  });

  test('no pill rule remains', () => {
    expect(css).not.toMatch(/\.machine-pill/);
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
