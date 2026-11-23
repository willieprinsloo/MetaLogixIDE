// @vitest-environment jsdom
/**
 * FilesTab open-request consumption: a re-fired consume effect (App re-render
 * with a fresh onOpenRelPathConsumed arrow, or openPath identity churn) must
 * never open the same file twice. Reproduces the peek duplicate-tab race the
 * e2e suite catches at peek-click-routing.spec.ts:239.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

interface WorkspaceRequest {
  deviceId?: string;
  method?: string;
  params?: { projectId?: number; relPath?: string };
}

const reads = vi.hoisted(() => ({
  // Resolves only when the test releases the gate, so two opens can race
  // with uncommitted state — exactly what the real app does.
  gate: [] as Array<() => void>,
  count: 0,
  remote: vi.fn<(request: WorkspaceRequest) => Promise<unknown>>(),
}));

vi.mock('@renderer/api', () => ({
  api: {
    invoke: vi.fn(async (channel: string, payload: WorkspaceRequest & { relPath?: string }) => {
      if (channel === 'p2p:rpc-call') return { result: await reads.remote(payload) };
      if (channel === 'files:tree') return { entries: [] };
      if (channel === 'git:status') return { staged: [], unstaged: [], untracked: [] };
      if (channel === 'files:read') {
        reads.count += 1;
        await new Promise<void>((resolve) => { reads.gate.push(resolve); });
        return { content: `content of ${payload.relPath}`, kind: 'text' as const, sizeBytes: 10 };
      }
      return undefined; // any other channel the mounted tree touches
    }),
  },
}));

import { FilesTab } from '@renderer/components/FilesTab';
import { DiffTab } from '@renderer/components/DiffTab';
import { api } from '@renderer/api';
import { remoteWorkspace } from '@renderer/p2p/remote-workspace';

const release = () => { for (const r of reads.gate.splice(0)) r(); };

afterEach(() => {
  cleanup();
  reads.remote.mockReset();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('FilesTab open-request consumption', () => {
  it('racing re-fires of the consume effect never duplicate the file tab', async () => {
    reads.count = 0; reads.gate.length = 0;
    const consumedA = vi.fn();
    const consumedB = vi.fn();

    // Mount with an open request; the files:read calls hang on the gate.
    // The effect may fire once or twice (env-dependent); the outcome must be
    // the same either way, which is the point of the fix.
    const view = render(
      <FilesTab projectId={1} openRelPath="src/here.ts" openLine={null} onOpenRelPathConsumed={consumedA} />,
    );
    await waitFor(() => expect(reads.count).toBeGreaterThan(0));

    // App re-renders with a NEW inline arrow (same openRelPath value) while
    // the reads are still gated — the effect re-fires openPath again.
    view.rerender(
      <FilesTab projectId={1} openRelPath="src/here.ts" openLine={null} onOpenRelPathConsumed={consumedB} />,
    );
    await waitFor(() => expect(reads.count).toBeGreaterThan(1), { timeout: 3000 });

    release(); // every in-flight read resolves; every append commits
    await waitFor(() => expect(view.getAllByTestId('file-tab').length).toBeGreaterThan(0), { timeout: 3000 });
    const tabs = view.getAllByTestId('file-tab');
    expect(tabs.length, 'one tab per file no matter how many opens raced').toBe(1);
    view.unmount();
  });
});

function scopedRequest(method: string, params: object, deviceId = 'host-a') {
  return { deviceId, method: `workspace.${method}`, params: { projectId: 1, ...params } };
}

describe('remote FilesTab', () => {
  it('shows binary unavailability and only previews, edits and saves remote HTML as text', async () => {
    reads.remote.mockImplementation(async ({ method, params }) => {
      if (method === 'workspace.fileTree') return { entries: [
        { name: 'photo.jpg', relPath: 'photo.jpg', isDir: false },
        { name: 'manual.pdf', relPath: 'manual.pdf', isDir: false },
        { name: 'index.html', relPath: 'index.html', isDir: false },
        { name: 'readme.md', relPath: 'readme.md', isDir: false },
      ] };
      if (method === 'workspace.fileRead') {
        if (params?.relPath === 'index.html') return { content: '<img src="./local-secret.png">', kind: 'text', sizeBytes: 30 };
        if (params?.relPath === 'readme.md') return { content: '![asset](./local-secret.png)', kind: 'text', sizeBytes: 29 };
        if (params?.relPath === 'manual.pdf') return { content: '%PDF-1.4', kind: 'text', sizeBytes: 8 };
        return { content: '', kind: 'binary', sizeBytes: 100 };
      }
      if (method === 'workspace.fileWrite') return { ok: true, sizeBytes: 11 };
      throw new Error(`Unexpected request: ${method}`);
    });
    const view = render(<FilesTab projectId={1} remote={remoteWorkspace('host-a')} />);
    const photo = await screen.findByRole('button', { name: 'photo.jpg' });
    expect(photo.getAttribute('draggable')).toBe('false');
    const setData = vi.fn();
    fireEvent.dragStart(photo, { dataTransfer: { setData } });
    expect(setData).not.toHaveBeenCalled();
    fireEvent.click(photo);
    await screen.findByText('Binary preview is not available for remote files.');
    expect(screen.queryByTestId('force-text-edit')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'manual.pdf' }));
    await screen.findByRole('tab', { name: /manual.pdf/ });
    expect(screen.getByText('Binary preview is not available for remote files.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'index.html' }));
    await screen.findByRole('tab', { name: /index.html/ });
    expect(screen.getByTestId('file-preview').textContent).toContain('<img src="./local-secret.png">');
    expect(view.container.querySelector('iframe, img')).toBeNull();
    fireEvent.click(screen.getByTestId('file-edit-toggle'));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'edited html' } });
    fireEvent.click(screen.getByTestId('file-save'));
    await waitFor(() => {
      const button = screen.getByTestId('file-save');
      expect(button.hasAttribute('disabled')).toBe(true);
    });
    expect(reads.remote).toHaveBeenCalledWith(scopedRequest('fileWrite', { relPath: 'index.html', content: 'edited html' }));
    fireEvent.click(screen.getByRole('button', { name: 'readme.md' }));
    await screen.findByRole('tab', { name: /readme.md/ });
    expect(screen.getByTestId('file-preview').textContent).toContain('![asset](./local-secret.png)');
    expect(view.container.querySelector('iframe, img')).toBeNull();
    expect(reads.remote).toHaveBeenCalledWith(scopedRequest('fileRead', { relPath: 'photo.jpg' }));
    expect(reads.remote).toHaveBeenCalledWith(scopedRequest('fileRead', { relPath: 'manual.pdf' }));
    expect(vi.mocked(api.invoke).mock.calls.map(([channel]) => channel)).toEqual(Array(6).fill('p2p:rpc-call'));
  });

  it('uses only remote CRUD for folder context menus and never offers local reveal', async () => {
    const tree = { entries: [{ name: 'src', relPath: 'src', isDir: true }] };
    reads.remote.mockImplementation(async ({ method }) => method === 'workspace.fileTree' ? tree
      : method === 'workspace.fileWrite' ? { ok: true, sizeBytes: 0 } : { ok: true });
    const prompt = vi.spyOn(window, 'prompt');
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<FilesTab projectId={1} remote={remoteWorkspace('host-a')} />);
    const folder = await screen.findByRole('button', { name: 'src' });
    function chooseMenuItem(name: string) {
      fireEvent.contextMenu(folder);
      expect(screen.queryByRole('menuitem', { name: 'Reveal in Finder' })).toBeNull();
      fireEvent.click(screen.getByRole('menuitem', { name }));
    }
    prompt.mockReturnValueOnce('new.txt');
    chooseMenuItem('New File…');
    await waitFor(() => expect(reads.remote).toHaveBeenCalledWith(scopedRequest('fileWrite', { relPath: 'src/new.txt', content: '' })));
    prompt.mockReturnValueOnce('nested');
    chooseMenuItem('New Folder…');
    await waitFor(() => expect(reads.remote).toHaveBeenCalledWith(scopedRequest('fileMkdir', { relPath: 'src/nested' })));
    prompt.mockReturnValueOnce('renamed');
    chooseMenuItem('Rename…');
    await waitFor(() => expect(reads.remote).toHaveBeenCalledWith(scopedRequest('fileRename', { from: 'src', to: 'renamed' })));
    chooseMenuItem('Delete');
    expect(confirm).toHaveBeenCalledWith('Delete folder src? This cannot be undone.');
    await waitFor(() => expect(reads.remote).toHaveBeenCalledWith(scopedRequest('fileDelete', { relPath: 'src' })));
    expect(vi.mocked(api.invoke).mock.calls.every(([channel]) => channel === 'p2p:rpc-call')).toBe(true);
  });

  it('does not display or consume an old peer’s in-flight open request', async () => {
    let finishOld: (result: unknown) => void = () => { throw new Error('expected a pending read'); };
    reads.remote.mockImplementation(async ({ method, deviceId }) => {
      if (method === 'workspace.fileTree') return { entries: [] };
      if (deviceId === 'host-a') return new Promise((resolve) => { finishOld = resolve; });
      return { content: 'second peer text', kind: 'text', sizeBytes: 16 };
    });
    const consumedOld = vi.fn();
    const consumedNew = vi.fn();
    const view = render(<FilesTab projectId={1} remote={remoteWorkspace('host-a')} openRelPath="same.txt"
      onOpenRelPathConsumed={consumedOld} />);
    expect(reads.remote).toHaveBeenCalledWith(scopedRequest('fileRead', { relPath: 'same.txt' }));
    view.rerender(<FilesTab projectId={1} remote={remoteWorkspace('host-b')} openRelPath="same.txt"
      onOpenRelPathConsumed={consumedNew} />);
    await screen.findByText('second peer text');
    await act(async () => { finishOld({ content: 'first peer only', kind: 'text', sizeBytes: 15 }); });
    expect(screen.queryByText('first peer only')).toBeNull();
    expect(reads.remote).toHaveBeenCalledWith(scopedRequest('fileRead', { relPath: 'same.txt' }, 'host-b'));
    expect(consumedOld).not.toHaveBeenCalled();
    expect(consumedNew).toHaveBeenCalled();
  });
});

describe('remote workspace DiffTab', () => {
  it('polls remote status without overlap, selects the right side request and refreshes', async () => {
    vi.useFakeTimers();
    const status = {
      isRepo: true, branch: 'main', ahead: 0, behind: 0,
      staged: [{ path: 'renamed.ts', status: 'R', origPath: 'old.ts' }],
      unstaged: [{ path: 'working.ts', status: 'M' }],
      untracked: ['fresh.ts'],
    };
    let finishStatus: (result: unknown) => void = () => { throw new Error('expected a pending status read'); };
    let finishSides: (result: unknown) => void = () => { throw new Error('expected pending sides'); };
    reads.remote
      .mockImplementationOnce(() => new Promise((resolve) => { finishStatus = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { finishSides = resolve; }));
    reads.remote.mockImplementation(async ({ method }) => method === 'workspace.diffStatus' ? status : { status: 'too-large' });
    const view = render(<DiffTab projectId={1} remote={remoteWorkspace('host-a')} />);
    expect(reads.remote).toHaveBeenCalledWith(scopedRequest('diffStatus', {}));
    await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
    expect(reads.remote).toHaveBeenCalledTimes(1);
    await act(async () => { finishStatus(status); });
    expect(screen.getAllByTestId('diff-row').map((row) => row.getAttribute('data-group')))
      .toEqual(['staged', 'unstaged', 'untracked']);
    expect(reads.remote).toHaveBeenCalledWith(scopedRequest('diffSides', { kind: 'staged', path: 'renamed.ts', origPath: 'old.ts' }));
    await act(async () => { fireEvent.click(screen.getByText('fresh.ts')); });
    expect(reads.remote).toHaveBeenCalledTimes(2);
    await act(async () => { finishSides({ status: 'too-large' }); });
    expect(reads.remote).toHaveBeenLastCalledWith(scopedRequest('diffSides', { kind: 'untracked', path: 'fresh.ts' }));
    expect(screen.getByText('Diff too large to show')).toBeTruthy();
    reads.remote.mockClear();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Refresh' })); });
    expect(reads.remote).toHaveBeenCalledWith(scopedRequest('diffStatus', {}));
    expect(reads.remote).toHaveBeenCalledWith(scopedRequest('diffSides', { kind: 'untracked', path: 'fresh.ts' }));
    view.unmount();
    reads.remote.mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
    expect(reads.remote).not.toHaveBeenCalled();
    expect(vi.mocked(api.invoke).mock.calls.every(([channel]) => channel === 'p2p:rpc-call')).toBe(true);
  });
});
