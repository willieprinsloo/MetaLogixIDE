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
