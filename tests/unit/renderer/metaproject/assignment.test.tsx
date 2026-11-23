// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { MetaprojectSessionProvider } from '@renderer/metaproject/session';
import { AssignmentPanel } from '@renderer/metaproject/AssignmentPanel';

const bridge = vi.hoisted(() => ({ invoke: vi.fn(), on: vi.fn(() => () => {}) }));
vi.mock('@renderer/api', () => ({ api: bridge }));

it.each([true, false])('distinguishes an accessible empty list from failure (ok=%s)', async (ok) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const node = document.body.appendChild(document.createElement('div'));
  const root = createRoot(node);
  bridge.invoke.mockReset();
  bridge.invoke.mockImplementation(async (channel) => {
    if (channel === 'metaproject:session-status') return { phase: 'signed-in', epoch: 4, actor: { id: 1, username: 'fixture' }, origin: 'https://fixture.invalid' };
    if (channel === 'metaproject:assignment-get') return { ok: true, value: { kind: 'unlinked', projectId: 7, localName: 'seven', localPath: '/fixture/seven', revision: 'a'.repeat(64) } };
    if (channel === 'metaproject:assignment-list') return ok ? { ok: true, value: { epoch: 4, projects: [] } } : { ok: false, reason: 'network' };
    throw new Error(`Unexpected ${channel}`);
  });
  try {
    await act(async () => root.render(<MetaprojectSessionProvider><AssignmentPanel projectId={7} /></MetaprojectSessionProvider>));
    const list = [...node.querySelectorAll('button')].find((b) => b.textContent === 'Link existing');
    await act(async () => list?.click());
    expect(bridge.invoke).toHaveBeenCalledWith('metaproject:assignment-list', { epoch: 4 });
    expect(node.textContent).toContain(ok ? 'No accessible Metaproject projects.' : 'Could not reach Metaproject. Try again.');
    expect(node.textContent?.includes('No accessible Metaproject projects.')).toBe(ok);
  } finally {
    act(() => root.unmount()); node.remove(); vi.unstubAllGlobals();
  }
});
