import { useCallback, useEffect, useMemo, useState } from 'react';
import MarkdownIt from 'markdown-it';
import { api } from '@renderer/api';
import { ResizeHandle } from './ResizeHandle';
import { usePersistedNumber } from '@renderer/hooks/usePersistedNumber';

interface Entry { name: string; isDir: boolean; relPath: string; }
interface OpenFile { relPath: string; content: string; kind: 'text' | 'binary' }

const md = new MarkdownIt({ html: false, linkify: true, breaks: false, typographer: true });

const MD_EXT   = new Set(['md', 'markdown', 'mdx']);
const IMG_EXT  = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp']);

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i === -1 ? '' : name.slice(i + 1).toLowerCase();
}

export function FilesTab({
  projectId,
  openRelPath,
  onOpenRelPathConsumed,
}: {
  projectId: number;
  openRelPath?: string | null;
  onOpenRelPathConsumed?: () => void;
}) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [dir, setDir] = useState<string | undefined>(undefined);
  const [openFile, setOpenFile] = useState<OpenFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [treeWidth, setTreeWidth] = usePersistedNumber('metaide.filesTreeWidth', 256, 160, 500);

  const loadDir = useCallback(async (relPath?: string) => {
    setError(null);
    try {
      const { entries } = await api.invoke('files:tree', { projectId, relPath });
      setEntries(entries);
      setDir(relPath);
    } catch (e) { setError(String(e)); }
  }, [projectId]);

  const openEntry = useCallback(async (e: Entry) => {
    if (e.isDir) { void loadDir(e.relPath); return; }
    setError(null);
    try {
      const { content, kind } = await api.invoke('files:read', { projectId, relPath: e.relPath });
      setOpenFile({ relPath: e.relPath, content, kind });
    } catch (err) { setError(String(err)); }
  }, [projectId, loadDir]);

  useEffect(() => { void loadDir(undefined); setOpenFile(null); }, [loadDir]);

  // React to Cmd+P file-finder pick — open the relative path directly.
  useEffect(() => {
    if (!openRelPath) return;
    (async () => {
      try {
        const { content, kind } = await api.invoke('files:read', { projectId, relPath: openRelPath });
        setOpenFile({ relPath: openRelPath, content, kind });
        setError(null);
      } catch (err) {
        setError(String(err));
      } finally {
        onOpenRelPathConsumed?.();
      }
    })();
  }, [openRelPath, projectId, onOpenRelPathConsumed]);

  return (
    <div className="h-full flex min-h-0">
      <FileTreePane
        entries={entries}
        dir={dir}
        openFileRelPath={openFile?.relPath ?? null}
        onGoUp={() => loadDir(undefined)}
        onOpen={openEntry}
        width={treeWidth}
      />
      <ResizeHandle
        value={treeWidth}
        onChange={setTreeWidth}
        onReset={() => setTreeWidth(256)}
        min={160}
        max={500}
        side="left"
      />
      <div className="flex-1 min-h-0 border-l border-[--border] bg-[--panel]/40">
        {error && (
          <div className="p-4 text-sm text-[--danger]">{error}</div>
        )}
        {!error && !openFile && (
          <div className="h-full flex items-center justify-center p-8 text-center text-sm text-[--text-muted]">
            Pick a file on the left to preview it.
          </div>
        )}
        {!error && openFile && <FilePreview file={openFile} />}
      </div>
    </div>
  );
}

function FileTreePane({
  entries, dir, openFileRelPath, onGoUp, onOpen, width,
}: {
  entries: Entry[];
  dir: string | undefined;
  openFileRelPath: string | null;
  onGoUp: () => void;
  onOpen: (e: Entry) => void;
  width: number;
}) {
  return (
    <div className="shrink-0 overflow-y-auto py-2 px-1 text-sm" style={{ width }}>
      <div className="px-2 py-1 text-[11px] text-[--text-muted] font-mono truncate" title={dir ?? '/'}>
        {dir ?? '/'}
      </div>
      {dir && (
        <button
          onClick={onGoUp}
          className="w-full text-left px-2 py-1 rounded-md hover:bg-[--panel-strong] text-[--text-muted]"
        >
          ← root
        </button>
      )}
      <ul>
        {entries.map((e) => (
          <li key={e.relPath}>
            <button
              onClick={() => onOpen(e)}
              data-testid="file-entry"
              className={`w-full flex items-center gap-2 text-left px-2 py-1 rounded-md ${
                openFileRelPath === e.relPath ? 'bg-[color:var(--accent)] text-white' : 'hover:bg-[--panel-strong]'
              }`}
            >
              <FileIcon isDir={e.isDir} name={e.name} />
              <span className="truncate">{e.name}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function FilePreview({ file }: { file: OpenFile }) {
  const ext = extOf(file.relPath);
  const isMd = MD_EXT.has(ext);
  const isImg = IMG_EXT.has(ext);
  const html = useMemo(() => (isMd ? md.render(file.content) : ''), [file.content, isMd]);

  // Intercept any <a> click inside the rendered Markdown and route it
  // through app:open-external so real URLs open in the OS browser instead
  // of navigating the renderer window (which would blow up sandboxing).
  function onPreviewClick(e: React.MouseEvent<HTMLDivElement>) {
    const target = (e.target as HTMLElement).closest('a');
    if (!target) return;
    const href = target.getAttribute('href');
    if (!href) return;
    e.preventDefault();
    if (/^(https?|mailto|file):/i.test(href)) {
      void api.invoke('app:open-external', { url: href }).catch((err) => console.error(err));
    }
  }

  return (
    <div className="h-full flex flex-col min-h-0" data-testid="file-preview">
      <div className="px-3 py-1.5 border-b border-[--border] text-[11px] text-[--text-muted] font-mono truncate">
        {file.relPath}
      </div>
      <div className="flex-1 overflow-auto">
        {file.kind === 'binary' && !isImg && (
          <div className="p-6 text-sm text-[--text-muted]">Binary file — no preview.</div>
        )}
        {file.kind === 'binary' && isImg && (
          <div className="p-4 text-sm text-[--text-muted]">Image preview is a Phase 2 feature.</div>
        )}
        {file.kind === 'text' && isMd && (
          <div
            className="markdown p-6 max-w-3xl mx-auto"
            onClick={onPreviewClick}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}
        {file.kind === 'text' && !isMd && (
          <pre className="p-4 text-[12px] leading-5 font-mono whitespace-pre overflow-auto">
            {file.content}
          </pre>
        )}
      </div>
    </div>
  );
}

function FileIcon({ isDir, name }: { isDir: boolean; name: string }) {
  if (isDir) {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-[--text-muted] shrink-0">
        <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      </svg>
    );
  }
  const ext = extOf(name);
  const color = MD_EXT.has(ext)   ? 'text-[--icon-md]'
              : IMG_EXT.has(ext)  ? 'text-[--icon-img]'
              : ['ts','tsx','js','jsx','py','go','rs'].includes(ext) ? 'text-[--icon-code]'
              : 'text-[--text-muted]';
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`shrink-0 ${color}`}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}
