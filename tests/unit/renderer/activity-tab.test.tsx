// @vitest-environment jsdom
/** ActivityTab renders entries that have no matching pair (a tool without a result, a turn end without a prompt) without error (AC14). */
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActivityEntry } from '@shared/activity';

const bridge = vi.hoisted(() => ({
  entries: [] as unknown[],
  listeners: new Set<(ev: unknown) => void>(),
}));

vi.mock('@renderer/api', () => ({
  api: {
    invoke: async () => ({ entries: bridge.entries }),
    on: (_channel: string, listener: (ev: unknown) => void) => {
      bridge.listeners.add(listener);
      return () => { bridge.listeners.delete(listener); };
    },
  },
}));

import { ActivityTab } from '@renderer/components/ActivityTab';

const base = { ts: '2026-01-01T10:00:00.000Z', agent: 'claude', shellIndex: 0 };
const preToolOnly: ActivityEntry = { ...base, id: 'a', kind: 'tool', tool: 'Bash', target: 'ls unpaired-tool' };
const turnEndOnly: ActivityEntry = { ...base, id: 'b', kind: 'turn-end' };
const lateNotification: ActivityEntry = { ...base, id: 'c', kind: 'notification', text: 'live unpaired note' };

afterEach(() => { bridge.listeners.clear(); vi.restoreAllMocks(); });

describe('ActivityTab unpaired entries (AC14)', () => {
  it('renders listed and live unpaired entries without throwing or console errors', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    bridge.entries = [preToolOnly, turnEndOnly];
    render(<ActivityTab projectId={1} followFiles={false} onFollowFilesChange={() => {}} />);
    await screen.findByText('ls unpaired-tool');
    await act(async () => { for (const l of bridge.listeners) l({ projectId: 1, entry: lateNotification }); });
    const tab = document.querySelector('[data-testid="activity-tab"]')!;
    expect(tab.textContent).toContain('ls unpaired-tool');
    expect(tab.textContent).toContain('turn-end');
    expect(tab.textContent).toContain('live unpaired note');
    expect(tab.textContent).toContain('3 / 3');
    expect(error).not.toHaveBeenCalled();
  });
});
