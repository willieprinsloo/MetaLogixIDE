// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ChatEntry } from '@shared/chat';
import type { GroupView } from '@shared/group-chat';

const initial: ChatEntry[] = [{
  id: 'e1',
  ts: '2026-11-18T10:00:00Z',
  from: { device: 'laptop', shell: 1, agent: 'claude', label: 'Claude' },
  to: [],
  body: 'hello',
}];

/**
 * Mutable per-test state, so one test can give the dock a running group
 * without every other test seeing it. The module-level `vi.mock` factory
 * closes over these so each render re-reads them.
 */
let groupsResponse: GroupView[] = [];

vi.mock('@renderer/api', () => ({
  api: {
    invoke: vi.fn().mockImplementation((ch: string) => {
      if (ch === 'chat:list') return Promise.resolve({ entries: initial });
      if (ch === 'chat:append') return Promise.resolve({ entry: { id: 'x', ts: '', from: { device: 'laptop', shell: -1, agent: 'human' }, to: [], body: '' } });
      // These two feed hooks AgentChatTab mounts (useChatRoster + useAgentIntent).
      // Returning an empty-but-well-shaped object keeps those hooks' consumers
      // (Map iteration, Array iteration) from blowing up during render.
      if (ch === 'chat:roster') return Promise.resolve({ rows: [], selfDevice: 'laptop' });
      if (ch === 'intent:list') return Promise.resolve({ updates: [] });
      // Group-chat hook feeds the Start-round affordance. An empty
      // groups list keeps the dock in ambient-chat mode for every test
      // except the one that explicitly exercises round rendering.
      if (ch === 'groups:list') return Promise.resolve({ groups: groupsResponse });
      if (ch === 'groups:stop') return Promise.resolve({ group: groupsResponse[0] });
      return Promise.resolve({});
    }),
    on: vi.fn().mockReturnValue(() => {}),
  },
}));

import { AgentChatTab } from '@renderer/components/AgentChatTab';

beforeEach(() => { groupsResponse = []; });
afterEach(() => { cleanup(); });

describe('AgentChatTab', () => {
  it('renders the initial entries', async () => {
    render(<AgentChatTab projectId={1} selfDevice="laptop" />);
    const el = await screen.findByText('hello');
    expect(el.textContent).toBe('hello');
  });

  it('thread scroll region carries min-h-0 so overflow-y-auto actually engages', async () => {
    // jsdom does no layout, so we can't assert scrollability. We CAN assert
    // the classes that make it work in a real browser — without min-h-0 on
    // every flex ancestor, the inner overflow-y-auto gets clipped and
    // scrolling silently fails.
    const { container } = render(<AgentChatTab projectId={1} selfDevice="laptop" />);
    const root = container.querySelector('[data-testid="agent-chat-tab"]')!;
    expect(root.className).toMatch(/\bmin-h-0\b/);
    const section = root.querySelector('section')!;
    expect(section.className).toMatch(/\bmin-h-0\b/);
    const scroller = section.querySelector('div')!;
    expect(scroller.className).toMatch(/\bmin-h-0\b/);
    expect(scroller.className).toMatch(/\boverflow-y-auto\b/);
  });

  it('bumping focusTick focuses the composer textarea', async () => {
    // The ⇧⌘A shortcut needs to land focus in the composer without the
    // user clicking the pane. The parent owns a monotonic counter and
    // bumps it on each shortcut press; a change fires the effect that
    // .focus()es the textarea. First render (tick > 0) should also focus.
    const { rerender } = render(<AgentChatTab projectId={1} selfDevice="laptop" focusTick={1} />);
    const box = await screen.findByRole('textbox');
    expect(document.activeElement).toBe(box);
    (box as HTMLTextAreaElement).blur();
    expect(document.activeElement).not.toBe(box);
    rerender(<AgentChatTab projectId={1} selfDevice="laptop" focusTick={2} />);
    expect(document.activeElement).toBe(box);
  });

  it('composer sends via chat:append', async () => {
    const { api } = await import('@renderer/api');
    render(<AgentChatTab projectId={1} selfDevice="laptop" />);
    const box = await screen.findByRole('textbox');
    fireEvent.change(box, { target: { value: '@codex hi' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => {
      expect(api.invoke).toHaveBeenCalledWith('chat:append', expect.objectContaining({ body: '@codex hi' }));
    });
  });

  it('renders a running round\'s log inline with the chat thread', async () => {
    // Round mode is the single-dock UX for Martin's group-chat feature:
    // formal round messages appear in the SAME scroll region as ambient
    // chat, distinguished by an R<n> chip and an engine badge, so users
    // never have to remember which panel they typed in.
    groupsResponse = [{
      id: 'g1',
      projectId: 1,
      projectName: 'demo',
      name: 'demo',
      members: ['m1'],
      memberInfo: { m1: { name: 'Claude', kind: 'claude-tab', engine: 'claude', model: null, available: true, phase: null } },
      maxRounds: 4,
      status: 'running',
      round: { n: 1, waiting: [], answers: {} },
      k: 1,
      seq: 1,
      held: [],
      joined: [],
      log: [
        // Mid-session timestamp so the row sorts after the chat entry (10:00:00Z).
        { at: '2026-11-18T10:01:00Z', kind: 'reply', from: 'm1', text: 'thinking out loud', round: 1 },
      ],
      createdAt: '2026-11-18T10:00:30Z',
      updatedAt: '2026-11-18T10:01:00Z',
    }];
    render(<AgentChatTab projectId={1} selfDevice="laptop" />);
    // The running-group banner lives in the pill bar so the user can Stop at any time.
    expect(await screen.findByText(/Round 1\/4/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Stop/i })).toBeTruthy();
    // The round log entry renders in the thread — R1 chip, Claude engine badge, body.
    expect(await screen.findByText('R1')).toBeTruthy();
    expect(screen.getByText('thinking out loud')).toBeTruthy();
    // Both Claude engine badges render ("Claude" appears for pill + log row); using getAll*
    // avoids the "single element" assertion failing on the second.
    expect(screen.getAllByText('Claude').length).toBeGreaterThanOrEqual(1);
  });

  it('Stop button on a running round fires groups:stop', async () => {
    const { api } = await import('@renderer/api');
    groupsResponse = [{
      id: 'g1',
      projectId: 1,
      projectName: 'demo',
      name: 'demo',
      members: [],
      memberInfo: {},
      maxRounds: 4,
      status: 'running',
      round: { n: 1, waiting: [], answers: {} },
      k: 1,
      seq: 1,
      held: [],
      joined: [],
      log: [],
      createdAt: '2026-11-18T10:00:30Z',
      updatedAt: '2026-11-18T10:00:30Z',
    }];
    render(<AgentChatTab projectId={1} selfDevice="laptop" />);
    const stop = await screen.findByRole('button', { name: /Stop/i });
    fireEvent.click(stop);
    await waitFor(() => {
      expect(api.invoke).toHaveBeenCalledWith('groups:stop', { id: 'g1' });
    });
  });
});

describe('AgentChatTab dock layout', () => {
  const cls = (el: Element | null): string[] => (el?.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);

  it('puts the roster bar above the panel and the composer below it, both outside it', async () => {
    const { container } = render(<AgentChatTab projectId={1} selfDevice="laptop"
      panelClassName="workspace-sheet rounded-[14px] bg-[--surface-sheet]" barEnd={<button>Close dock</button>} />);
    await screen.findByText('hello');
    const bar = container.querySelector('[data-testid="agent-chat-bar"]');
    const panel = container.querySelector('[data-testid="agent-chat-panel"]');
    expect(bar).not.toBeNull();
    expect(panel).not.toBeNull();
    expect(panel!.contains(bar)).toBe(false);
    const composer = container.querySelector('[data-testid="agent-chat-composer"]');
    expect(composer).not.toBeNull();
    expect(composer!.querySelector('textarea')).not.toBeNull();
    expect(panel!.contains(composer)).toBe(false);
    expect(panel!.querySelector('textarea')).toBeNull();
    expect(panel!.compareDocumentPosition(composer!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(panel!.textContent).toContain('hello');
    expect(cls(panel)).toEqual(expect.arrayContaining(['workspace-sheet', 'rounded-[14px]', 'bg-[--surface-sheet]']));
    expect(bar!.contains(screen.getByRole('button', { name: 'Close dock' }))).toBe(true);
  });

  it('draws no borders between the bar, the thread and the composer', async () => {
    const { container } = render(<AgentChatTab projectId={1} selfDevice="laptop" />);
    await screen.findByText('hello');
    const bar = container.querySelector('[data-testid="agent-chat-bar"]');
    const composer = container.querySelector('[data-testid="agent-chat-composer"]');
    expect(bar).not.toBeNull();
    expect(composer).not.toBeNull();
    expect(cls(bar)).not.toContain('border-b');
    expect(cls(composer)).not.toContain('border-t');
  });

  it('wraps the roster bar instead of clipping it, so Start round stays visible', async () => {
    const { container } = render(<AgentChatTab projectId={1} selfDevice="laptop" />);
    await screen.findByText('hello');
    const bar = cls(container.querySelector('[data-testid="agent-chat-bar"]'));
    expect(bar).toContain('flex-wrap');
    expect(bar).not.toContain('overflow-x-auto');
  });

  it('gives the roster bar no horizontal padding', async () => {
    const { container } = render(<AgentChatTab projectId={1} selfDevice="laptop" />);
    await screen.findByText('hello');
    const bar = cls(container.querySelector('[data-testid="agent-chat-bar"]'));
    expect(bar).toContain('px-0');
    expect(bar.some((c) => /^(px|pl|pr)-(?!0$)/.test(c))).toBe(false);
  });

  it('gives the composer textbox a darker background than the panel', async () => {
    render(<AgentChatTab projectId={1} selfDevice="laptop" />);
    const box = await screen.findByRole('textbox');
    expect(cls(box)).toContain('bg-black/20');
    expect(cls(box)).not.toContain('bg-[--surface]');
  });

  it('applies the bar height it is given, so the panel starts where the Shell sheet starts', async () => {
    const { container } = render(<AgentChatTab projectId={1} selfDevice="laptop" barMinHeight={44} />);
    await screen.findByText('hello');
    expect((container.querySelector('[data-testid="agent-chat-bar"]') as HTMLElement).style.minHeight).toBe('44px');
  });
});
