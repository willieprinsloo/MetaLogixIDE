// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ChatEntry } from '@shared/chat';

const initial: ChatEntry[] = [{
  id: 'e1',
  ts: '2026-11-18T10:00:00Z',
  from: { device: 'laptop', shell: 1, agent: 'claude', label: 'Claude' },
  to: [],
  body: 'hello',
}];

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
      return Promise.resolve({});
    }),
    on: vi.fn().mockReturnValue(() => {}),
  },
}));

import { AgentChatTab } from '@renderer/components/AgentChatTab';

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
});
