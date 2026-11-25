// @vitest-environment jsdom
/**
 * FilesTab open-request consumption: a re-fired consume effect (App re-render
 * with a fresh onOpenRelPathConsumed arrow, or openPath identity churn) must
 * never open the same file twice. Reproduces the peek duplicate-tab race the
 * e2e suite catches at peek-click-routing.spec.ts:239.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

interface WorkspaceRequest {
  deviceId?: string;
  method?: string;
  params?: { projectId?: number; relPath?: string };
}

interface LocalFileRequest {
  relPath?: string;
  from?: string;
  to?: string;
  content?: string;
  forceText?: boolean;
}

const reads = vi.hoisted(() => ({
  // Resolves only when the test releases the gate, so two opens can race
  // with uncommitted state — exactly what the real app does.
  gate: [] as Array<() => void>,
  count: 0,
  remote: vi.fn<(request: WorkspaceRequest) => Promise<unknown>>(),
  localFiles: vi.fn<(channel: string, payload: LocalFileRequest) => Promise<unknown>>(),
}));

vi.mock('@renderer/api', () => ({
  api: {
    invoke: vi.fn(async (channel: string, payload: WorkspaceRequest & LocalFileRequest) => {
      if (channel === 'p2p:rpc-call') return { result: await reads.remote(payload) };
      if (channel.startsWith('files:') && reads.localFiles.getMockImplementation()) {
        return reads.localFiles(channel, payload);
      }
      if (channel === 'files:tree') return { entries: [] };
      if (channel === 'git:status') return { isRepo: false, branch: null, ahead: 0, behind: 0, files: {}, dirty: false };
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
import * as toasts from '@renderer/hooks/useToasts';
import { APP_FILE_DRAG_TYPE } from '@shared/terminal-drop-contract';

const release = () => { for (const r of reads.gate.splice(0)) r(); };

afterEach(() => {
  cleanup();
  reads.remote.mockReset();
  reads.localFiles.mockReset();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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

function chooseFileMenu(target: HTMLElement, name: string): void {
  fireEvent.contextMenu(target);
  fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name }));
}

describe('local FilesTab', () => {
  it('reflects local create, rename and delete in the refreshed tree, and offers local reveal', async () => {
    const entries = new Map<string, boolean>();
    reads.localFiles.mockImplementation(async (channel, { relPath, from, to }) => {
      if (channel === 'files:tree') {
        return { entries: [...entries].map(([name, isDir]) => ({ name, relPath: name, isDir })) };
      }
      if (channel === 'files:write' && relPath) entries.set(relPath, false);
      else if (channel === 'files:mkdir' && relPath) entries.set(relPath, true);
      else if (channel === 'files:rename' && from && to) {
        const isDir = entries.get(from);
        if (isDir === undefined) throw new Error('Source missing');
        entries.delete(from);
        entries.set(to, isDir);
      } else if (channel === 'files:delete' && relPath) entries.delete(relPath);
      else if (channel === 'files:reveal') throw new Error('Finder unavailable');
      else throw new Error(`Unexpected file request: ${channel}`);
      return { ok: true };
    });
    vi.spyOn(window, 'prompt').mockReturnValueOnce('new.txt').mockReturnValueOnce('docs').mockReturnValueOnce('renamed.txt');
    vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    const notify = vi.spyOn(toasts, 'toast').mockReturnValue(1);
    render(<FilesTab projectId={9} />);
    const root = screen.getByTitle('/');

    chooseFileMenu(root, 'New File…');
    const file = await screen.findByRole('button', { name: 'new.txt' });
    chooseFileMenu(root, 'New Folder…');
    expect((await screen.findByRole('button', { name: 'docs' })).getAttribute('draggable')).toBe('false');
    chooseFileMenu(file, 'Rename…');
    const renamed = await screen.findByRole('button', { name: 'renamed.txt' });
    expect(screen.queryByRole('button', { name: 'new.txt' })).toBeNull();

    chooseFileMenu(renamed, 'Reveal in Finder');
    await waitFor(() => expect(notify).toHaveBeenCalledWith('Reveal failed', { kind: 'error', detail: 'Finder unavailable' }));
    chooseFileMenu(renamed, 'Delete');
    expect(screen.getByRole('button', { name: 'renamed.txt' })).toBe(renamed);
    expect(api.invoke).not.toHaveBeenCalledWith('files:delete', expect.anything());
    chooseFileMenu(renamed, 'Delete');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'renamed.txt' })).toBeNull());
    expect(screen.getByRole('button', { name: 'docs' })).toBeTruthy();
    expect(vi.mocked(api.invoke).mock.calls.filter(([channel]) => channel !== 'git:status' && channel !== 'files:tree')).toEqual([
      ['files:write', { projectId: 9, relPath: 'new.txt', content: '' }],
      ['files:mkdir', { projectId: 9, relPath: 'docs' }],
      ['files:rename', { projectId: 9, from: 'new.txt', to: 'renamed.txt' }],
      ['files:reveal', { projectId: 9, relPath: 'renamed.txt' }],
      ['files:delete', { projectId: 9, relPath: 'renamed.txt' }],
    ]);
  });

  it('starts a local file drag and saves the submitted snapshot without marking newer typing clean', async () => {
    const pending = Promise.withResolvers<{ ok: boolean }>();
    vi.spyOn(toasts, 'toast').mockReturnValue(1);
    reads.localFiles.mockImplementation(async (channel, { forceText, content }) => {
      if (channel === 'files:tree') return { entries: [{ name: 'data.dat', relPath: 'data.dat', isDir: false }] };
      if (channel === 'files:read') return { content: forceText ? 'original text' : '', kind: forceText ? 'text' : 'binary' };
      if (channel === 'files:start-drag') return { ok: true };
      if (channel === 'files:write') return content === 'first edit' ? pending.promise : { ok: true };
      throw new Error(`Unexpected file request: ${channel}`);
    });
    const fullscreen = vi.fn();
    render(<FilesTab projectId={9} isFullscreen onFullscreenToggle={fullscreen} />);
    const entry = await screen.findByRole('button', { name: 'data.dat' });
    expect(entry.getAttribute('draggable')).toBe('true');
    const setData = vi.fn();
    fireEvent.dragStart(entry, { dataTransfer: { setData } });
    expect(setData).toHaveBeenCalledWith(APP_FILE_DRAG_TYPE, JSON.stringify({ projectId: 9, relPath: 'data.dat' }));
    expect(api.invoke).toHaveBeenCalledWith('files:start-drag', { projectId: 9, paths: ['data.dat'] });

    fireEvent.click(entry);
    fireEvent.click(await screen.findByTestId('force-text-edit'));
    const editor = await screen.findByRole('textbox');
    expect(editor).toHaveProperty('value', 'original text');
    expect(api.invoke).toHaveBeenCalledWith('files:read', { projectId: 9, relPath: 'data.dat', forceText: true });
    expect(screen.getByTitle(/^Exit fullscreen/)).toBeTruthy();
    fireEvent.keyDown(editor, { metaKey: true, shiftKey: true, key: 'Enter' });
    expect(fullscreen).toHaveBeenCalledTimes(1);

    const save = screen.getByTestId('file-save');
    fireEvent.change(editor, { target: { value: 'first edit' } });
    fireEvent.click(save);
    fireEvent.change(editor, { target: { value: 'newer edit' } });
    await act(async () => { pending.resolve({ ok: true }); });
    expect(editor).toHaveProperty('value', 'newer edit');
    expect(save).toHaveProperty('disabled', false);
    fireEvent.click(save);
    await waitFor(() => expect(save).toHaveProperty('disabled', true));
    expect(vi.mocked(api.invoke).mock.calls.filter(([channel]) => channel === 'files:write')).toEqual([
      ['files:write', { projectId: 9, relPath: 'data.dat', content: 'first edit' }],
      ['files:write', { projectId: 9, relPath: 'data.dat', content: 'newer edit' }],
    ]);
    expect(api.invoke).not.toHaveBeenCalledWith('p2p:rpc-call', expect.anything());
  });

  it('keeps rendered Markdown for local files and opens editable SVG source on a peer', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    reads.localFiles.mockImplementation(async (channel) => {
      if (channel === 'files:tree') return { entries: [{ name: 'guide.md', relPath: 'guide.md', isDir: false }] };
      if (channel === 'files:read') return { content: '# Local guide', kind: 'text' };
      throw new Error(`Unexpected file request: ${channel}`);
    });
    reads.remote.mockImplementation(async ({ method }) => {
      if (method === 'workspace.fileTree') return { entries: [{ name: 'logo.svg', relPath: 'logo.svg', isDir: false }] };
      if (method === 'workspace.fileRead') return { content: '<svg></svg>', kind: 'text', sizeBytes: 11 };
      throw new Error(`Unexpected request: ${method}`);
    });
    const view = render(<FilesTab projectId={1} />);
    fireEvent.click(await screen.findByRole('button', { name: 'guide.md' }));
    expect(await screen.findByRole('heading', { name: 'Local guide' })).toBeTruthy();

    view.rerender(<FilesTab projectId={1} remote={remoteWorkspace('host-a')} />);
    fireEvent.click(await screen.findByRole('button', { name: 'logo.svg' }));
    fireEvent.click(await screen.findByTestId('file-edit-toggle'));
    expect(screen.getByRole('textbox')).toHaveProperty('value', '<svg></svg>');
    expect(screen.queryByRole('heading', { name: 'Local guide' })).toBeNull();
    expect(reads.remote).toHaveBeenCalledWith(scopedRequest('fileRead', { relPath: 'logo.svg' }));
  });

  it.each([
    { path: 'photo.jpg', viewer: 'image-viewer' },
    { path: 'manual.pdf', viewer: 'pdf-viewer' },
  ])('routes local $path to its byte-backed viewer and shows read failure there', async ({ path, viewer }) => {
    reads.localFiles.mockImplementation(async (channel) => {
      if (channel === 'files:tree') return { entries: [{ name: path, relPath: path, isDir: false }] };
      if (channel === 'files:read') return { content: '', kind: 'binary', sizeBytes: 8 };
      if (channel === 'files:read-bytes') throw new Error('Local bytes unavailable');
      throw new Error(`Unexpected file request: ${channel}`);
    });
    render(<FilesTab projectId={9} />);
    fireEvent.click(await screen.findByRole('button', { name: path }));
    const preview = await screen.findByTestId(viewer);
    expect(await within(preview).findByText('Local bytes unavailable')).toBeTruthy();
    expect(api.invoke).toHaveBeenCalledWith('files:read-bytes', { projectId: 9, relPath: path });
    expect(api.invoke).not.toHaveBeenCalledWith('p2p:rpc-call', expect.anything());
  });
});

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
    expect(screen.queryByTitle(/fullscreen/i)).toBeNull();
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
    await waitFor(() => expect(reads.remote).toHaveBeenCalledWith(scopedRequest('fileWrite', {
      relPath: 'src/new.txt', content: '', createOnly: true,
    })));
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

  it('reports an exclusive-create conflict without refreshing or trying a normal or local write', async () => {
    const notify = vi.spyOn(toasts, 'toast').mockReturnValue(1);
    const ask = vi.spyOn(window, 'prompt').mockReturnValueOnce(null).mockReturnValueOnce('untitled.md');
    reads.remote.mockImplementation(async ({ method }) => {
      if (method === 'workspace.fileTree') return { entries: [{ name: 'untitled.md', isDir: false, relPath: 'untitled.md' }] };
      if (method === 'workspace.fileWrite') throw new Error('destination already exists');
      throw new Error(`Unexpected request: ${method}`);
    });
    render(<FilesTab projectId={1} remote={remoteWorkspace('host-a')} />);
    const entry = await screen.findByRole('button', { name: 'untitled.md' });
    function newFile() {
      fireEvent.contextMenu(screen.getByTitle('/'));
      fireEvent.click(screen.getByRole('menuitem', { name: 'New File…' }));
    }
    newFile();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(reads.remote).toHaveBeenCalledTimes(1);
    newFile();
    await waitFor(() => expect(notify).toHaveBeenCalledWith('Failed to create file', {
      kind: 'error', detail: 'destination already exists',
    }));
    expect(reads.remote.mock.calls).toEqual([
      [scopedRequest('fileTree', {})],
      [scopedRequest('fileWrite', { relPath: 'untitled.md', content: '', createOnly: true })],
    ]);
    expect(screen.getByRole('button', { name: 'untitled.md' })).toBe(entry);
    expect(vi.mocked(api.invoke).mock.calls.map(([channel]) => channel)).toEqual(['p2p:rpc-call', 'p2p:rpc-call']);
  });

  it('keeps a rejected save dirty and retries with the same text', async () => {
    const notify = vi.spyOn(toasts, 'toast').mockReturnValue(1);
    let fail = true;
    reads.remote.mockImplementation(async ({ method }) => {
      if (method === 'workspace.fileTree') return { entries: [{ name: 'draft.txt', isDir: false, relPath: 'draft.txt' }] };
      if (method === 'workspace.fileRead') return { content: 'on host', kind: 'text', sizeBytes: 7 };
      if (method === 'workspace.fileWrite' && fail) throw new Error('host rejected save');
      if (method === 'workspace.fileWrite') return { ok: true, sizeBytes: 5 };
      throw new Error(`Unexpected request: ${method}`);
    });
    render(<FilesTab projectId={1} remote={remoteWorkspace('host-a')} />);
    fireEvent.click(await screen.findByRole('button', { name: 'draft.txt' }));
    fireEvent.click(await screen.findByTestId('file-edit-toggle'));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'draft' } });
    fireEvent.click(screen.getByTestId('file-save'));
    await waitFor(() => expect(notify).toHaveBeenCalledWith('Save failed', {
      kind: 'error', detail: 'host rejected save',
    }));
    expect(screen.getByRole('textbox')).toHaveProperty('value', 'draft');
    expect(screen.getByTestId('file-save').hasAttribute('disabled')).toBe(false);
    fail = false;
    fireEvent.click(screen.getByTestId('file-save'));
    await waitFor(() => expect(screen.getByTestId('file-save').hasAttribute('disabled')).toBe(true));
    expect(reads.remote.mock.calls.filter(([request]) => request.method === 'workspace.fileWrite')).toEqual([
      [scopedRequest('fileWrite', { relPath: 'draft.txt', content: 'draft' })],
      [scopedRequest('fileWrite', { relPath: 'draft.txt', content: 'draft' })],
    ]);
  });

  it('shows remote tree and file read errors without falling back locally', async () => {
    reads.remote.mockRejectedValueOnce(new Error('host is offline'));
    reads.remote.mockRejectedValueOnce(new Error('file unavailable'));
    const remote = remoteWorkspace('host-a');
    const view = render(<FilesTab projectId={1} remote={remote} />);
    expect((await screen.findByRole('alert')).textContent).toContain('host is offline');
    view.rerender(<FilesTab projectId={1} remote={remote} openRelPath="missing.txt" />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('file unavailable'));
    expect(screen.queryByRole('tab')).toBeNull();
    expect(vi.mocked(api.invoke).mock.calls.map(([channel]) => channel)).toEqual(['p2p:rpc-call', 'p2p:rpc-call']);
  });

  it('preserves a draft and defers opens and refreshes while the retained panel is inactive', async () => {
    const remote = remoteWorkspace('host-a');
    const consumed = vi.fn();
    reads.remote.mockImplementation(async ({ method, params }) => {
      if (method === 'workspace.fileTree' && params?.relPath === undefined) {
        return { entries: [{ name: 'sub', relPath: 'sub', isDir: true }] };
      }
      if (method === 'workspace.fileTree') return { entries: [{ name: 'draft.txt', relPath: 'sub/draft.txt', isDir: false }] };
      if (method === 'workspace.fileRead') return { content: 'on host', kind: 'text', sizeBytes: 7 };
      throw new Error(`Unexpected request: ${method}`);
    });
    const view = render(<FilesTab projectId={1} remote={remote} active={false} />);
    expect(reads.remote).not.toHaveBeenCalled();
    view.rerender(<FilesTab projectId={1} remote={remote} />);
    fireEvent.click(await screen.findByRole('button', { name: 'sub' }));
    fireEvent.click(await screen.findByRole('button', { name: 'draft.txt' }));
    fireEvent.click(await screen.findByTestId('file-edit-toggle'));
    const editor = screen.getByRole('textbox');
    fireEvent.change(editor, { target: { value: 'draft' } });
    reads.remote.mockClear();
    view.rerender(<FilesTab projectId={1} remote={remote} active={false}
      openRelPath="other.txt" onOpenRelPathConsumed={consumed} />);
    fireEvent.keyDown(editor, { ctrlKey: true, metaKey: true, key: 's' });
    expect(reads.remote).not.toHaveBeenCalled();
    expect(consumed).not.toHaveBeenCalled();
    view.rerender(<FilesTab projectId={1} remote={remote} openRelPath="other.txt" onOpenRelPathConsumed={consumed} />);
    await screen.findByRole('tab', { name: /other.txt/ });
    expect(reads.remote).toHaveBeenCalledWith(scopedRequest('fileTree', { relPath: 'sub' }));
    expect(reads.remote).toHaveBeenCalledWith(scopedRequest('fileRead', { relPath: 'other.txt' }));
    await waitFor(() => expect(consumed).toHaveBeenCalled());
    view.rerender(<FilesTab projectId={1} remote={remote} />);
    fireEvent.click(screen.getByRole('tab', { name: /draft.txt/ }));
    expect(screen.getByRole('textbox')).toHaveProperty('value', 'draft');
    expect(screen.getByTestId('file-save').hasAttribute('disabled')).toBe(false);
    expect(reads.remote.mock.calls.every(([request]) => request.method !== 'workspace.fileWrite')).toBe(true);
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

  it('waits for a remote create to finish, then refreshes the directory navigated to in the meantime', async () => {
    const create = Promise.withResolvers<{ ok: true; sizeBytes: number }>();
    let committed = false;
    vi.spyOn(window, 'prompt').mockReturnValue('new.txt');
    reads.remote.mockImplementation(async ({ method, params }) => {
      if (method === 'workspace.fileWrite') {
        const result = await create.promise;
        committed = true;
        return result;
      }
      if (method !== 'workspace.fileTree') throw new Error(`Unexpected request: ${method}`);
      if (params?.relPath === 'docs') {
        return { entries: committed ? [{ name: 'new.txt', relPath: 'docs/new.txt', isDir: false }] : [] };
      }
      return { entries: [{ name: 'docs', relPath: 'docs', isDir: true }] };
    });
    render(<FilesTab projectId={1} remote={remoteWorkspace('host-a')} />);
    const docs = await screen.findByRole('button', { name: 'docs' });
    chooseFileMenu(docs, 'New File…');
    expect(reads.remote.mock.calls).toEqual([
      [scopedRequest('fileTree', {})],
      [scopedRequest('fileWrite', { relPath: 'docs/new.txt', content: '', createOnly: true })],
    ]);
    fireEvent.click(docs);
    await screen.findByRole('button', { name: '← root' });
    expect(screen.queryByRole('button', { name: 'new.txt' })).toBeNull();
    await act(async () => { create.resolve({ ok: true, sizeBytes: 0 }); });
    expect(screen.getByTitle('docs')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'new.txt' })).toBeTruthy();
    expect(reads.remote.mock.calls.slice(2)).toEqual([
      [scopedRequest('fileTree', { relPath: 'docs' })],
      [scopedRequest('fileTree', { relPath: 'docs' })],
    ]);
  });

  it.each(['success', 'failure'])('ignores an older folder request after newer navigation (%s)', async (outcome) => {
    const earlier = Promise.withResolvers<unknown>();
    reads.remote.mockImplementation(async ({ method, params }) => {
      if (method !== 'workspace.fileTree') throw new Error(`Unexpected request: ${method}`);
      if (params?.relPath === 'slow') return earlier.promise;
      if (params?.relPath === 'fast') {
        return { entries: [{ name: 'current.txt', relPath: 'fast/current.txt', isDir: false }] };
      }
      return { entries: [
        { name: 'slow', relPath: 'slow', isDir: true },
        { name: 'fast', relPath: 'fast', isDir: true },
      ] };
    });
    render(<FilesTab projectId={1} remote={remoteWorkspace('host-a')} />);
    fireEvent.click(await screen.findByRole('button', { name: 'slow' }));
    fireEvent.click(screen.getByRole('button', { name: 'fast' }));
    await screen.findByRole('button', { name: 'current.txt' });
    expect(reads.remote).toHaveBeenCalledWith(scopedRequest('fileTree', { relPath: 'slow' }));
    await act(async () => {
      if (outcome === 'success') {
        earlier.resolve({ entries: [{ name: 'old.txt', relPath: 'slow/old.txt', isDir: false }] });
      } else {
        earlier.reject(new Error('Slow folder unavailable'));
      }
    });
    expect(screen.getByTitle('fast')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'current.txt' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'old.txt' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does not refresh or announce writes completed for a peer the panel has left', async () => {
    const save = Promise.withResolvers<unknown>();
    const create = Promise.withResolvers<unknown>();
    const notify = vi.spyOn(toasts, 'toast').mockReturnValue(1);
    vi.spyOn(window, 'prompt').mockReturnValue('new.txt');
    reads.remote.mockImplementation(async ({ deviceId, method, params }) => {
      if (method === 'workspace.fileTree') return { entries: [{ name: 'draft.txt', relPath: 'draft.txt', isDir: false }] };
      if (method === 'workspace.fileRead') return { content: `from ${deviceId}`, kind: 'text', sizeBytes: 11 };
      if (method === 'workspace.fileWrite' && params?.relPath === 'draft.txt') return save.promise;
      if (method === 'workspace.fileWrite' && params?.relPath === 'new.txt') return create.promise;
      throw new Error(`Unexpected request: ${method}`);
    });
    const view = render(<FilesTab projectId={1} remote={remoteWorkspace('host-a')} />);
    fireEvent.click(await screen.findByRole('button', { name: 'draft.txt' }));
    fireEvent.click(await screen.findByTestId('file-edit-toggle'));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'unsaved text' } });
    fireEvent.click(screen.getByTestId('file-save'));
    chooseFileMenu(screen.getByTitle('/'), 'New File…');
    expect(reads.remote).toHaveBeenCalledWith(scopedRequest('fileWrite', { relPath: 'draft.txt', content: 'unsaved text' }));
    expect(reads.remote).toHaveBeenCalledWith(scopedRequest('fileWrite', { relPath: 'new.txt', content: '', createOnly: true }));

    view.rerender(<FilesTab projectId={1} remote={remoteWorkspace('host-b')} />);
    fireEvent.click(await screen.findByRole('button', { name: 'draft.txt' }));
    await within(await screen.findByTestId('file-preview')).findByText('from host-b');
    const requestCount = reads.remote.mock.calls.length;
    await act(async () => {
      save.resolve({ ok: true, sizeBytes: 12 });
      create.resolve({ ok: true, sizeBytes: 0 });
    });
    expect(reads.remote).toHaveBeenCalledTimes(requestCount);
    expect(notify).not.toHaveBeenCalled();
    expect(screen.getByText('from host-b')).toBeTruthy();
    expect(screen.queryByText('unsaved text')).toBeNull();
    expect(screen.queryByRole('button', { name: 'new.txt' })).toBeNull();
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
