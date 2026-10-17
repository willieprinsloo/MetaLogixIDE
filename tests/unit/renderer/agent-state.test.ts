/** Renderer agent-status contract: per-shell identity, independent rollups and snapshot/delta selectors. */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StatusDot } from '@renderer/components/StatusDot';
import {
  applyDelta, applySnapshot, keyFor, overallSnapshotGetter, overallStateOf,
  projectSnapshotGetter, projectStateOf, shellSnapshotGetter, shellStateOf,
} from '@renderer/agent-state';
import type { AgentShellStateEntry } from '@shared/agent-state';

const claudeBusy: AgentShellStateEntry = { projectId: 1, shellIndex: 0, agent: 'claude', state: 'busy' };
const ompBlocked: AgentShellStateEntry = { projectId: 1, shellIndex: 1, agent: 'omp', state: 'blocked' };
const otherBusy: AgentShellStateEntry = { projectId: 11, shellIndex: 0, agent: 'omp', state: 'busy' };

describe('agent state snapshots and deltas (AC8, AC10)', () => {
  it('keeps identity for idle agents but treats absent/non-agent shells as idle', () => {
    const idle: AgentShellStateEntry = { ...claudeBusy, state: 'idle' };
    const map = applySnapshot([idle, { projectId: 1, shellIndex: 2, agent: null, state: 'idle' }]);
    expect(shellStateOf(map, 1, 0)).toEqual({ agent: 'claude', state: 'idle' });
    expect(shellStateOf(map, 1, 2)).toEqual({ agent: null, state: 'idle' });
    expect(shellStateOf(map, 1, 3)).toEqual({ agent: null, state: 'idle' });
  });

  it('retains two agents in one project and prioritizes blocked over busy over idle', () => {
    const map = applySnapshot([claudeBusy, ompBlocked, otherBusy]);
    expect(shellStateOf(map, 1, 0)).toEqual({ agent: 'claude', state: 'busy' });
    expect(shellStateOf(map, 1, 1)).toEqual({ agent: 'omp', state: 'blocked' });
    expect(projectStateOf(map, 1)).toBe('blocked');
    expect(projectStateOf(map, 11)).toBe('busy');
    expect(projectStateOf(map, 2)).toBe('idle');
    expect(overallStateOf(map)).toBe('blocked');
    expect(overallStateOf(new Map())).toBe('idle');
  });

  it('replaces stale shells on a fresh snapshot for a new window', () => {
    const stale = applySnapshot([ompBlocked]);
    const refreshed = applySnapshot([claudeBusy]);
    expect(shellStateOf(stale, 1, 1).state).toBe('blocked');
    expect(shellStateOf(refreshed, 1, 1)).toEqual({ agent: null, state: 'idle' });
    expect(shellStateOf(refreshed, 1, 0).state).toBe('busy');
  });

  it('applies idle/exit deltas to one shell only', () => {
    const before = applySnapshot([claudeBusy, ompBlocked]);
    const idled = applyDelta(before, { ...ompBlocked, state: 'idle' });
    expect(shellStateOf(idled, 1, 1)).toEqual({ agent: 'omp', state: 'idle' });
    expect(projectStateOf(idled, 1)).toBe('busy');
    const exited = applyDelta(idled, { ...claudeBusy, agent: null, state: 'idle' });
    expect(shellStateOf(exited, 1, 0)).toEqual({ agent: null, state: 'idle' });
    expect(shellStateOf(exited, 1, 1).agent).toBe('omp');
    expect(projectStateOf(exited, 1)).toBe('idle');
  });

  it('does not notify on duplicate deltas or absent non-agent idle entries', () => {
    const map = applySnapshot([claudeBusy]);
    expect(applyDelta(map, { ...claudeBusy })).toBe(map);
    expect(applyDelta(map, { projectId: 5, shellIndex: 0, agent: null, state: 'idle' })).toBe(map);
  });

  it('keeps shell selectors stable across unrelated changes and updates identity changes', () => {
    let map = applySnapshot([claudeBusy]);
    const shell = shellSnapshotGetter(() => map, 1, 0);
    const missing = shellSnapshotGetter(() => map, 4, 0);
    const original = shell();
    const missingOriginal = missing();
    map = applyDelta(map, ompBlocked);
    expect(shell()).toBe(original);
    expect(missing()).toBe(missingOriginal);
    map = applyDelta(map, { ...claudeBusy, agent: 'omp' });
    expect(shell()).not.toBe(original);
    expect(shell().agent).toBe('omp');
  });

  it('keeps aggregate snapshots primitive and stable until severity changes', () => {
    let map = applySnapshot([claudeBusy]);
    const project = projectSnapshotGetter(() => map, 1);
    const global = overallSnapshotGetter(() => map);
    map = applyDelta(map, otherBusy);
    expect(project()).toBe('busy');
    expect(global()).toBe('busy');
    map = applyDelta(map, ompBlocked);
    expect(project()).toBe('blocked');
    expect(global()).toBe('blocked');
    map = applyDelta(map, { ...ompBlocked, agent: null, state: 'idle' });
    expect(project()).toBe('busy');
    expect(global()).toBe('busy');
    expect(keyFor(1, 0)).not.toBe(keyFor(11, 0));
  });
});

describe('live IPC selectors (AC10)', () => {
  it('replays a delta arriving during snapshot fetch and refreshes stale shells on alive changes', async () => {
    const responses: Array<(value: { shells: AgentShellStateEntry[] }) => void> = [];
    const handlers = new Map<string, (entry: AgentShellStateEntry) => void>();
    const unsubs: Array<() => void> = [];
    let renders = 0;
    vi.doMock('@renderer/api', () => ({
      api: {
        invoke: () => new Promise<{ shells: AgentShellStateEntry[] }>((resolve) => { responses.push(resolve); }),
        on: (channel: string, cb: (entry: AgentShellStateEntry) => void) => {
          handlers.set(channel, cb);
          return () => { handlers.delete(channel); };
        },
      },
    }));
    vi.doMock('react', () => ({
      useSyncExternalStore: (subscribe: (listener: () => void) => () => void, getSnapshot: () => unknown) => {
        let last = getSnapshot();
        unsubs.push(subscribe(() => {
          const next = getSnapshot();
          if (!Object.is(last, next)) renders++;
          last = next;
        }));
        return getSnapshot();
      },
    }));
    try {
      // Import after doMock so the hook captures the test's IPC and React subscription boundary.
      const { useShellAgentState, useProjectAgentState, useOverallAgentState } = await import('@renderer/hooks/useAgentStates');
      expect(useShellAgentState(1, 0)).toEqual({ agent: null, state: 'idle' });
      expect(responses).toHaveLength(1);
      handlers.get('agent-state:changed')?.(ompBlocked);
      responses[0]?.({ shells: [claudeBusy] });
      await Promise.resolve();
      expect(useShellAgentState(1, 0)).toEqual({ agent: 'claude', state: 'busy' });
      expect(useShellAgentState(1, 1)).toEqual({ agent: 'omp', state: 'blocked' });
      expect(useProjectAgentState(1)).toBe('blocked');
      expect(useOverallAgentState()).toBe('blocked');
      const beforeUnrelated = renders;
      handlers.get('agent-state:changed')?.(otherBusy);
      expect(renders).toBe(beforeUnrelated);
      handlers.get('alive-shells:changed')?.(claudeBusy);
      expect(responses).toHaveLength(2);
      responses[1]?.({ shells: [ompBlocked] });
      await Promise.resolve();
      expect(useShellAgentState(1, 0)).toEqual({ agent: null, state: 'idle' });
      expect(useShellAgentState(1, 1)).toEqual({ agent: 'omp', state: 'blocked' });
      handlers.get('agent-state:changed')?.({ ...ompBlocked, state: 'idle' });
      expect(useShellAgentState(1, 1)).toEqual({ agent: 'omp', state: 'idle' });
      expect(useProjectAgentState(1)).toBe('idle');
      expect(useOverallAgentState()).toBe('idle');
    } finally {
      for (const unsubscribe of unsubs) unsubscribe();
      vi.doUnmock('@renderer/api');
      vi.doUnmock('react');
      vi.resetModules();
    }
  });
});

describe('status dot accessibility (AC9, AC13)', () => {
  it.each([
    ['claude', 'idle', 'Claude is idle'],
    ['claude', 'busy', 'Claude is working'],
    ['claude', 'blocked', 'Claude needs your input'],
    ['omp', 'idle', 'OMP is idle'],
    ['omp', 'busy', 'OMP is working'],
    ['omp', 'blocked', 'OMP needs your input'],
    [null, 'idle', 'Idle'],
  ] as const)('names %s / %s without leaking session text', (agent, state, label) => {
    const html = renderToStaticMarkup(createElement(StatusDot, { agent, state }));
    expect(html).toContain(`aria-label="${label}"`);
    expect(html).toContain(`title="${label}"`);
    expect(html).toContain('data-testid="claude-dot"');
    expect(html).toContain(`data-claude-state="${state}"`);
  });

  it.each([
    ['idle', 'Idle'], ['busy', 'Working'], ['blocked', 'Needs input'],
  ] as const)('never assigns agent name to aggregate %s', (state, label) => {
    const html = renderToStaticMarkup(createElement(StatusDot, { state }));
    expect(html).toContain(`aria-label="${label}"`);
    expect(html).toContain(`title="${label}"`);
    expect(html).not.toMatch(/Claude|OMP/);
  });

  it.each([
    ['claude', 'Claude is idle'],
    ['omp', 'OMP is idle'],
  ] as const)('keeps inactive %s idle tab gray and static without suppressing its identity', (agent, label) => {
    const idle = renderToStaticMarkup(createElement(StatusDot, { agent, state: 'idle', inactiveWhenIdle: true }));
    expect(idle).toContain(`aria-label="${label}"`);
    expect(idle).toContain(`title="${label}"`);
    expect(idle).toContain('bg-[--text-muted]');
    expect(idle).not.toContain('live-dot');
    expect(idle).not.toContain('data-claude-state=');
    const active = renderToStaticMarkup(createElement(StatusDot, { agent, state: 'busy', inactiveWhenIdle: true }));
    expect(active).toContain('live-dot');
    expect(active).toContain('data-claude-state="busy"');
  });

  it('escapes caller class markup and derives labels only from the shared contract', () => {
    const html = renderToStaticMarkup(createElement(StatusDot, { agent: 'omp', state: 'blocked', className: '"><script>alert(1)</script>' }));
    expect(html).not.toContain('<script>');
    expect(html).toContain('aria-label="OMP needs your input"');
  });
});

describe('status dot consumers (AC8, AC9)', () => {
  it.each([
    ['claude', false, 'Claude is idle'],
    ['omp', false, 'OMP is idle'],
    ['claude', true, 'Claude is idle'],
    ['omp', true, 'OMP is idle'],
  ] as const)('names the %s shell in %s tab without changing inactive state', async (agent, isActive, label) => {
    const shellState = vi.fn(() => ({ agent, state: 'idle' as const }));
    vi.doMock('@renderer/hooks/useAgentStates', () => ({ useShellAgentState: shellState }));
    try {
      const { ShellTabDot } = await import('@renderer/components/ShellTabDot');
      const html = renderToStaticMarkup(createElement(ShellTabDot, { projectId: 7, shellIndex: 2, isActive }));
      expect(shellState).toHaveBeenCalledWith(7, 2);
      expect(html).toContain(`aria-label="${label}"`);
      expect(html).toContain(`title="${label}"`);
      expect(html.includes('data-claude-state="idle"')).toBe(isActive);
      expect(html.includes('bg-[--text-muted]')).toBe(!isActive);
    } finally {
      vi.doUnmock('@renderer/hooks/useAgentStates');
      vi.resetModules();
    }
  });

  it('shows severity-only dots on the In use heading and project row', async () => {
    const project = {
      id: 7, rootId: 1, name: 'Workspace', path: '/work/Workspace',
      metaprojectProjectId: null, linkedChatChannelId: null, lastOpenedAt: null,
      pinned: false, hidden: false, firstLaunchedAt: null, config: {},
    };
    const projectState = vi.fn(() => 'idle' as const);
    const overallState = vi.fn(() => 'blocked' as const);
    vi.doMock('@renderer/api', () => ({ api: { invoke: vi.fn() } }));
    vi.doMock('@renderer/hooks/useRoots', () => ({ useRoots: () => ({ roots: [], refresh: vi.fn() }) }));
    vi.doMock('@renderer/hooks/useProjects', () => ({ useProjects: () => ({ projects: [project], refresh: vi.fn() }) }));
    vi.doMock('@renderer/hooks/useRecents', () => ({ useRecents: () => ({ recents: [] }) }));
    vi.doMock('@renderer/hooks/useAliveShellIds', () => ({ useAliveShellIds: () => ({ aliveIds: new Set([7]) }) }));
    vi.doMock('@renderer/hooks/useAgentStates', () => ({
      useOverallAgentState: overallState,
      useProjectAgentState: projectState,
    }));
    vi.stubGlobal('localStorage', { getItem: () => null });
    try {
      const { Sidebar } = await import('@renderer/components/Sidebar');
      const { createElement: h } = await import('react');
      const { renderToStaticMarkup: render } = await import('react-dom/server');
      const html = render(h(Sidebar, {
        selectedProjectId: 7, onSelect: vi.fn(), onEditEnv: vi.fn(), onProjectSettings: vi.fn(),
      }));
      expect(html).toContain('In use');
      expect(projectState).toHaveBeenCalledWith(7);
      expect(overallState).toHaveBeenCalled();
      expect(html).toContain('aria-label="Needs input"');
      expect(html).toContain('aria-label="Idle"');
      expect(html).not.toMatch(/aria-label="(?:Claude|OMP) is idle"/);
    } finally {
      vi.unstubAllGlobals();
      for (const path of [
        '@renderer/api', '@renderer/hooks/useRoots', '@renderer/hooks/useProjects',
        '@renderer/hooks/useRecents', '@renderer/hooks/useAliveShellIds',
        '@renderer/hooks/useAgentStates',
      ]) vi.doUnmock(path);
      vi.resetModules();
    }
  });
});

describe('popout shell status (AC9)', () => {
  it('exposes an idle OMP identity in the actual popout header', async () => {
    const shellState = vi.fn(() => ({ agent: 'omp' as const, state: 'idle' as const }));
    vi.stubGlobal('window', { location: { search: '?popout=1&projectId=7&shellIndex=2' } });
    vi.doMock('@renderer/api', () => ({ api: { invoke: vi.fn() } }));
    vi.doMock('@renderer/fonts/use-apply-ui-font', () => ({ useApplyUiFont: vi.fn() }));
    vi.doMock('@renderer/hooks/useTheme', () => ({ useTheme: vi.fn() }));
    vi.doMock('@renderer/hooks/useWindowTerminalFocus', () => ({
      useWindowTerminalFocus: vi.fn(),
      terminalFocus: { requestFocus: vi.fn() },
    }));
    vi.doMock('@renderer/hooks/useAgentStates', () => ({
      useShellAgentState: shellState, useProjectAgentState: () => 'idle',
    }));
    vi.doMock('@renderer/components/ShellTab', () => ({ ShellTab: () => null }));
    try {
      // App must load after its window and status boundaries have been replaced.
      const { App } = await import('@renderer/App');
      const { createElement: h } = await import('react');
      const { renderToStaticMarkup: render } = await import('react-dom/server');
      const html = render(h(App));
      expect(shellState).toHaveBeenCalledWith(7, 2);
      expect(html).toContain('aria-label="OMP is idle"');
      expect(html).toContain('title="OMP is idle"');
      expect(html).toContain('Shell 2');
    } finally {
      vi.unstubAllGlobals();
      for (const path of [
        '@renderer/api', '@renderer/fonts/use-apply-ui-font', '@renderer/hooks/useTheme',
        '@renderer/hooks/useWindowTerminalFocus', '@renderer/hooks/useAgentStates',
        '@renderer/components/ShellTab',
      ]) vi.doUnmock(path);
      vi.resetModules();
    }
  });
});
