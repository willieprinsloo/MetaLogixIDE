// @vitest-environment jsdom
/** RemoteProjectPane: the main-area pane for a project on a paired machine (moved unchanged from Sidebar.machines.test.tsx). */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const invoke = vi.fn();
vi.mock('@renderer/api', () => ({ api: { invoke: (...a: unknown[]) => invoke(...a), on: () => () => {} } }));
vi.mock('../ShellTab', () => ({ ShellTab: (p: { source: unknown }) => <div data-testid="shell-tab">{JSON.stringify(p.source)}</div> }));

import { RemoteProjectPane } from '../RemoteProjectPane';

beforeEach(() => {
  cleanup();
  invoke.mockReset();
  invoke.mockImplementation(async (_ch: string, a: { method?: string }) => {
    if (a?.method === 'shells.launch') return { result: { shellIndex: 2 } };
    return {};
  });
});

describe('RemoteProjectPane', () => {
  test('header shows Project @ Machine with a P2P badge and a remote ShellTab', async () => {
    render(<RemoteProjectPane deviceId="tower" deviceName="Tower" projectId={7} projectName="alpha" />);
    expect(screen.getByText('alpha @ Tower')).toBeTruthy();
    expect(screen.getByText('P2P')).toBeTruthy();
    const tab = await screen.findByTestId('shell-tab');
    await waitFor(() => expect(tab.textContent).toContain('"deviceId":"tower"'));
  });

  test('the close button calls onClose', () => {
    const onClose = vi.fn();
    render(<RemoteProjectPane deviceId="tower" deviceName="Tower" projectId={7} projectName="alpha" onClose={onClose} />);
    fireEvent.click(screen.getByTestId('remote-pane-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
