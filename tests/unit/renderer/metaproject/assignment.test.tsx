// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { MetaprojectSessionProvider } from '@renderer/metaproject/session';
import { AssignmentPanel } from '@renderer/metaproject/AssignmentPanel';
import { NewProjectDialog } from '@renderer/components/NewProjectDialog';

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

const operationId = '0856d88e-bbed-4f3e-8157-b9d3a4b34eea';
const origin = 'https://fixture.invalid';
const signedIn = { phase: 'signed-in', epoch: 4, actor: { id: 1, username: 'fixture' }, origin, connected: true, warning: 'not-remembered', remembered: false };
const linked = { kind: 'linked', projectId: 7, localName: 'seven', localPath: '/fixture/seven', revision: 'a'.repeat(64), origin, remoteId: 41 };
const choices = { ok: true, value: { epoch: 4, projects: [{ id: 42, name: 'Remote' }] } };

function fixture() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('crypto', { randomUUID: () => operationId });
  bridge.invoke.mockReset();
  const node = document.body.appendChild(document.createElement('div'));
  const root = createRoot(node);
  return {
    node,
    render: async (children: React.ReactNode) => act(async () => root.render(<MetaprojectSessionProvider>{children}</MetaprojectSessionProvider>)),
    click: async (text: string) => {
      const button = [...node.querySelectorAll('button')].find((b) => b.textContent === text);
      if (!button || button.disabled) throw new Error(`Unavailable button ${text}`);
      await act(async () => button.click());
    },
    select: async () => {
      const select = node.querySelector<HTMLSelectElement>('[data-testid="mp-link-select"]');
      if (!select) throw new Error('Missing project picker');
      await act(async () => { select.value = '42'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    },
    dispose: () => { act(() => root.unmount()); node.remove(); vi.unstubAllGlobals(); },
  };
}

it.each(['target', 'leave', 'cancel'])('cancels the exact in-flight assignment when the editor %s changes', async (transition) => {
  const ui = fixture();
  let finish: ((value: unknown) => void) | undefined;
  bridge.invoke.mockImplementation(async (channel, input) => {
    if (channel === 'metaproject:session-status') return signedIn;
    if (channel === 'metaproject:assignment-get') return { ok: true, value: { ...linked, projectId: input.projectId } };
    if (channel === 'metaproject:assignment-list') return choices;
    if (channel === 'metaproject:assignment-save') return new Promise((resolve) => { finish = resolve; });
    if (channel === 'metaproject:assignment-cancel') return { ok: true };
    throw new Error(`Unexpected ${channel}`);
  });
  try {
    await ui.render(<AssignmentPanel projectId={7} />);
    await ui.click('Change assignment');
    expect(ui.node.textContent).toContain('could not be remembered');
    await ui.select();
    await ui.click('Save assignment');
    expect(bridge.invoke).toHaveBeenCalledWith('metaproject:assignment-save', { operationId, projectId: 7, revision: linked.revision, remoteId: 42, epoch: 4 });
    if (transition === 'target') await ui.render(<AssignmentPanel projectId={8} />);
    if (transition === 'leave') await ui.render(null);
    if (transition === 'cancel') await ui.click('Cancel assignment change');
    expect(bridge.invoke).toHaveBeenCalledWith('metaproject:assignment-cancel', { operationId });
    const writes = bridge.invoke.mock.calls.filter(([name]) => ['metaproject:assignment-save', 'metaproject:assignment-cancel'].includes(name));
    expect(writes.map(([name]) => name)).toEqual(['metaproject:assignment-save', 'metaproject:assignment-cancel']);
    await act(async () => finish?.({ ok: true, value: { kind: 'assigned', assignment: { ...linked, remoteId: 42 } } }));
    expect(ui.node.textContent).not.toContain('assignment saved');
  } finally { ui.dispose(); }
});

it('keeps explicit removal available offline and distinguishes committed bytes from failed readback', async () => {
  const ui = fixture();
  let reads = 0;
  let removed = false;
  bridge.invoke.mockImplementation(async (channel) => {
    if (channel === 'metaproject:session-status') return { phase: 'signed-out', epoch: 4, origin };
    if (channel === 'metaproject:assignment-get') {
      reads++;
      return { ok: true, value: removed ? { ...linked, kind: 'unlinked' } : linked };
    }
    if (channel === 'metaproject:assignment-remove') {
      removed = true;
      return { ok: true, value: { kind: 'committed-reload', projectId: 7 } };
    }
    throw new Error(`Unexpected ${channel}`);
  });
  try {
    await ui.render(<AssignmentPanel projectId={7} />);
    await ui.click('Remove assignment');
    expect(bridge.invoke.mock.calls.some(([channel]) => channel === 'metaproject:assignment-remove')).toBe(false);
    await ui.click('Confirm removal');
    expect(bridge.invoke).toHaveBeenCalledWith('metaproject:assignment-remove', { operationId, projectId: 7, revision: linked.revision });
    expect(ui.node.querySelector('[role="alert"]')?.textContent).toContain('written to disk');
    expect(ui.node.textContent).not.toContain('Assignment removed.');
    const beforeReload = reads;
    await ui.click('Reload assignment');
    expect(reads).toBe(beforeReload + 1);
    expect(ui.node.textContent).toContain('No Metaproject assignment');
  } finally { ui.dispose(); }
});

it.each(['preflight', 'mutation', 'committed'])('keeps the New Project assignment safe during %s', async (phase) => {
  const ui = fixture();
  const onCreated = vi.fn();
  const roots = [{ id: 1, path: '/fixture', addedAt: '2026-11-23T12:00:00Z', sortOrder: 0 }];
  const project = { id: 7, name: 'seven' };
  let finish: ((value: unknown) => void) | undefined;
  const deferred = () => new Promise((resolve) => { finish = resolve; });
  bridge.invoke.mockImplementation(async (channel) => {
    if (channel === 'metaproject:session-status') return signedIn;
    if (channel === 'metaproject:assignment-list') return choices;
    if (channel === 'projects:create') return { project };
    if (channel === 'metaproject:assignment-get') return phase === 'preflight' ? deferred() : { ok: true, value: linked };
    if (channel === 'metaproject:assignment-save') return phase === 'mutation' ? deferred() : { ok: true, value: { kind: 'committed-reload', projectId: 7 } };
    if (channel === 'metaproject:assignment-cancel') return { ok: true };
    throw new Error(`Unexpected ${channel}`);
  });
  try {
    const onClose = vi.fn();
    await ui.render(<NewProjectDialog open roots={roots} onClose={onClose} onCreated={onCreated} />);
    expect(ui.node.textContent).toContain('could not be remembered');
    const name = ui.node.querySelector<HTMLInputElement>('[data-testid="new-project-name"]');
    if (!name) throw new Error('Missing folder name input');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(name, 'seven');
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await ui.click('Link existing');
    await ui.select();
    await ui.click('Create');
    if (phase === 'committed') {
      expect(ui.node.textContent).toContain('written to disk');
      expect(onCreated).not.toHaveBeenCalled();
      await ui.click('Open local project');
      expect(onCreated).toHaveBeenCalledWith(project);
      return;
    }
    expect(finish).toBeDefined();
    await ui.click('Cancel');
    expect(onClose).toHaveBeenCalledOnce();
    await ui.render(null);
    if (phase === 'preflight') {
      await act(async () => finish?.({ ok: true, value: linked }));
      expect(bridge.invoke.mock.calls.some(([channel]) => channel === 'metaproject:assignment-save' || channel === 'metaproject:assignment-cancel')).toBe(false);
    } else {
      expect(bridge.invoke).toHaveBeenCalledWith('metaproject:assignment-cancel', { operationId });
      await act(async () => finish?.({ ok: true, value: { kind: 'assigned', assignment: linked } }));
    }
    expect(onCreated).not.toHaveBeenCalled();
  } finally { ui.dispose(); }
});

it.each(['wrong-folder', 'read-failed', 'write-failed', 'remote-created', 'assigned'] as const)('opens the already-created local folder safely after %s', async (outcome) => {
  const ui = fixture();
  const onCreated = vi.fn();
  const roots = [{ id: 1, path: '/fixture', addedAt: '2026-11-23T12:00:00Z', sortOrder: 0 }];
  const project = { id: 7, name: 'seven' };
  bridge.invoke.mockImplementation(async (channel) => {
    if (channel === 'metaproject:session-status') return signedIn;
    if (channel === 'projects:create') return { project };
    if (channel === 'metaproject:assignment-get') {
      if (outcome === 'read-failed') return { ok: false, reason: 'network' };
      return { ok: true, value: outcome === 'wrong-folder' ? { ...linked, projectId: 8 } : linked };
    }
    if (channel === 'metaproject:assignment-create') {
      if (outcome === 'write-failed') return { ok: false, reason: 'denied' };
      if (outcome === 'remote-created') return { ok: true, value: { kind: 'created-not-assigned', reason: 'conflict', project: { id: 42, name: 'seven' } } };
      return { ok: true, value: { kind: 'assigned', assignment: linked } };
    }
    throw new Error(`Unexpected ${channel}`);
  });
  try {
    await ui.render(<NewProjectDialog open roots={roots} onClose={vi.fn()} onCreated={onCreated} />);
    const name = ui.node.querySelector<HTMLInputElement>('[data-testid="new-project-name"]');
    if (!name) throw new Error('Missing folder name input');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(name, 'seven');
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await ui.click('Create new');
    await ui.click('Create');
    expect(bridge.invoke).toHaveBeenCalledWith('projects:create', { rootId: 1, name: 'seven', initGit: true });
    expect(bridge.invoke).toHaveBeenCalledWith('metaproject:assignment-get', { projectId: 7 });
    const notices = {
      'wrong-folder': 'without a confirmed assignment', 'read-failed': 'Could not reach Metaproject',
      'write-failed': 'does not have access', 'remote-created': 'Created Metaproject project seven (#42), but it was not assigned',
    };
    if (outcome !== 'assigned') {
      expect(onCreated).not.toHaveBeenCalled();
      expect(ui.node.textContent).toContain(notices[outcome]);
      await ui.click('Open local project');
    }
    expect(onCreated.mock.calls).toEqual([[project]]);
    const writes = (channel: string) => bridge.invoke.mock.calls.filter(([name]) => name === channel);
    expect(writes('projects:create')).toHaveLength(1);
    if (outcome === 'wrong-folder' || outcome === 'read-failed') expect(writes('metaproject:assignment-create')).toHaveLength(0);
    else expect(writes('metaproject:assignment-create')).toEqual([['metaproject:assignment-create', { operationId, projectId: 7, revision: linked.revision, epoch: 4, name: 'seven' }]]);
  } finally { ui.dispose(); }
});
