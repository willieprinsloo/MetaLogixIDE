import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js/lib/common';
import 'highlight.js/styles/github-dark.css';
import { api } from '@renderer/api';
import { ResizeHandle } from './ResizeHandle';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { usePersistedNumber } from '@renderer/hooks/usePersistedNumber';
import { toast } from '@renderer/hooks/useToasts';

interface Entry { name: string; isDir: boolean; relPath: string; }
interface OpenFile {
  relPath: string;
  content: string;                 // last-saved content
  buffer: string;                  // in-flight edits (dirty when != content)
  kind: 'text' | 'binary';
  editing: boolean;
}

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
  typographer: true,
  highlight: (str: string, lang: string) => {
    if (lang && hljs.getLanguage(lang)) {
      try { return hljs.highlight(str, { language: lang, ignoreIllegals: true }).value; } catch { /* fall through */ }
    }
    try { return hljs.highlightAuto(str).value; } catch { return ''; }
  },
});

const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cs: 'csharp', swift: 'swift',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  json: 'json', jsonc: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini',
  html: 'xml', xml: 'xml', css: 'css', scss: 'scss',
  sql: 'sql', dockerfile: 'dockerfile',
};

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
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [treeWidth, setTreeWidth] = usePersistedNumber('metaide.filesTreeWidth', 256, 160, 500);

  const activeFile = useMemo(
    () => openFiles.find((f) => f.relPath === activePath) ?? null,
    [openFiles, activePath],
  );

  const loadDir = useCallback(async (relPath?: string) => {
    setError(null);
    try {
      const { entries } = await api.invoke('files:tree', { projectId, relPath });
      setEntries(entries);
      setDir(relPath);
    } catch (e) { setError(String(e)); }
  }, [projectId]);

  const openPath = useCallback(async (relPath: string) => {
    setError(null);
    if (openFiles.some((f) => f.relPath === relPath)) { setActivePath(relPath); return; }
    try {
      const { content, kind } = await api.invoke('files:read', { projectId, relPath });
      setOpenFiles((prev) => [...prev, { relPath, content, buffer: content, kind, editing: false }]);
      setActivePath(relPath);
    } catch (err) { setError(String(err)); }
  }, [projectId, openFiles]);

  const updateBuffer = useCallback((relPath: string, buffer: string) => {
    setOpenFiles((prev) => prev.map((f) => (f.relPath === relPath ? { ...f, buffer } : f)));
  }, []);

  const setEditing = useCallback((relPath: string, editing: boolean) => {
    setOpenFiles((prev) => prev.map((f) => (f.relPath === relPath ? { ...f, editing } : f)));
  }, []);

  const saveFile = useCallback(async (relPath: string) => {
    const cur = openFiles.find((f) => f.relPath === relPath);
    if (!cur || cur.kind !== 'text') return;
    if (cur.buffer === cur.content) return; // clean
    try {
      await api.invoke('files:write', { projectId, relPath, content: cur.buffer });
      setOpenFiles((prev) => prev.map((f) => (f.relPath === relPath ? { ...f, content: cur.buffer } : f)));
      toast(`Saved ${relPath.split('/').pop()}`, { kind: 'success', timeoutMs: 1500 });
    } catch (err) {
      toast('Save failed', { kind: 'error', detail: String(err).replace(/^Error:\s*/, '') });
    }
  }, [openFiles, projectId]);

  const openEntry = useCallback((e: Entry) => {
    if (e.isDir) { void loadDir(e.relPath); return; }
    void openPath(e.relPath);
  }, [loadDir, openPath]);

  const closeFile = useCallback((relPath: string) => {
    setOpenFiles((prev) => {
      const target = prev.find((f) => f.relPath === relPath);
      if (target && target.buffer !== target.content) {
        const ok = window.confirm(`Discard unsaved changes to ${relPath}?`);
        if (!ok) return prev;
      }
      const next = prev.filter((f) => f.relPath !== relPath);
      // If the active file is closing, promote the previous tab (or none).
      setActivePath((curActive) => {
        if (curActive !== relPath) return curActive;
        if (next.length === 0) return null;
        const closingIdx = prev.findIndex((f) => f.relPath === relPath);
        const nextIdx = Math.max(0, closingIdx - 1);
        const promoted = next[Math.min(nextIdx, next.length - 1)];
        return promoted ? promoted.relPath : null;
      });
      return next;
    });
  }, []);

  // Reset when project switches.
  useEffect(() => { void loadDir(undefined); setOpenFiles([]); setActivePath(null); }, [loadDir]);

  // ⌘S to save the active file.
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === 's' && activePath) {
        e.preventDefault();
        void saveFile(activePath);
      }
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, [activePath, saveFile]);

  // React to Cmd+P file-finder pick — open the relative path directly.
  useEffect(() => {
    if (!openRelPath) return;
    void openPath(openRelPath).finally(() => onOpenRelPathConsumed?.());
  }, [openRelPath, openPath, onOpenRelPathConsumed]);

  return (
    <div ref={rootRef} tabIndex={-1} className="h-full flex min-h-0 focus:outline-none">
      <FileTreePane
        projectId={projectId}
        entries={entries}
        dir={dir}
        openFileRelPath={activePath}
        onGoUp={() => loadDir(undefined)}
        onOpen={openEntry}
        onRefresh={() => loadDir(dir)}
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
      <div className="flex-1 min-h-0 flex flex-col border-l border-[--border] bg-[--panel]/40">
        {openFiles.length > 0 && (
          <FileTabBar
            openFiles={openFiles}
            activePath={activePath}
            onActivate={setActivePath}
            onClose={closeFile}
          />
        )}
        <div className="flex-1 min-h-0">
          {error && <div className="p-4 text-sm text-[--danger]">{error}</div>}
          {!error && !activeFile && (
            <div className="h-full flex items-center justify-center p-8 text-center text-sm text-[--text-muted]">
              Pick a file on the left to preview it. <br />
              <span className="opacity-70">⌘P finds a file by name across the project.</span>
            </div>
          )}
          {!error && activeFile && (
            <FilePreview
              file={activeFile}
              onChange={(v) => updateBuffer(activeFile.relPath, v)}
              onToggleEdit={() => setEditing(activeFile.relPath, !activeFile.editing)}
              onSave={() => saveFile(activeFile.relPath)}
              dirty={activeFile.buffer !== activeFile.content}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function FileTabBar({
  openFiles, activePath, onActivate, onClose,
}: {
  openFiles: OpenFile[];
  activePath: string | null;
  onActivate: (relPath: string) => void;
  onClose: (relPath: string) => void;
}) {
  return (
    <div
      role="tablist"
      data-testid="file-tabbar"
      className="flex items-center overflow-x-auto border-b border-[--border] bg-[--panel]/60 shrink-0"
    >
      {openFiles.map((f) => {
        const active = f.relPath === activePath;
        const name = f.relPath.split('/').pop() ?? f.relPath;
        const dirty = f.buffer !== f.content;
        return (
          <div
            key={f.relPath}
            role="tab"
            aria-selected={active}
            data-testid="file-tab"
            className={`group flex items-center gap-1.5 pl-2.5 pr-1 py-1 text-[12px] border-r border-[--border] cursor-pointer shrink-0 ${
              active
                ? 'bg-[--panel-strong] text-[--text]'
                : 'text-[--text-muted] hover:text-[--text] hover:bg-[--panel-strong]/60'
            }`}
            onClick={() => onActivate(f.relPath)}
            onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onClose(f.relPath); } }}
            title={dirty ? `${f.relPath} — unsaved changes` : f.relPath}
          >
            <FileIcon isDir={false} name={name} />
            <span className="truncate max-w-[160px]">{name}</span>
            <button
              onClick={(e) => { e.stopPropagation(); onClose(f.relPath); }}
              className={`w-4 h-4 flex items-center justify-center rounded transition ${
                active
                  ? 'text-[--text-muted] hover:text-[--danger] hover:bg-[--panel]'
                  : 'text-[--text-muted] opacity-0 group-hover:opacity-100 hover:text-[--danger]'
              }`}
              title="Close tab"
              aria-label={`Close ${name}`}
            >
              {dirty ? <span className="w-1.5 h-1.5 rounded-full bg-[--text]" aria-hidden /> : <TabXIcon />}
            </button>
          </div>
        );
      })}
    </div>
  );
}

function TabXIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function FileTreePane({
  projectId, entries, dir, openFileRelPath, onGoUp, onOpen, onRefresh, width,
}: {
  projectId: number;
  entries: Entry[];
  dir: string | undefined;
  openFileRelPath: string | null;
  onGoUp: () => void;
  onOpen: (e: Entry) => void;
  onRefresh: () => void;
  width: number;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number; entry: Entry | null } | null>(null);

  const closeMenu = useCallback(() => setMenu(null), []);
  const bgMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, entry: null });
  }, []);
  const rowMenu = useCallback((e: React.MouseEvent, entry: Entry) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, entry });
  }, []);

  async function newFile() {
    const name = window.prompt('New file name:', 'untitled.md');
    if (!name) return;
    const relPath = dir ? `${dir}/${name}` : name;
    try {
      await api.invoke('files:write', { projectId, relPath, content: '' });
      onRefresh();
    } catch (e) { toast('Failed to create file', { kind: 'error', detail: String(e).replace(/^Error:\s*/, '') }); }
  }
  async function newFolder() {
    const name = window.prompt('New folder name:');
    if (!name) return;
    const relPath = dir ? `${dir}/${name}` : name;
    try {
      await api.invoke('files:mkdir', { projectId, relPath });
      onRefresh();
    } catch (e) { toast('Failed to create folder', { kind: 'error', detail: String(e).replace(/^Error:\s*/, '') }); }
  }
  async function renameEntry(entry: Entry) {
    const parts = entry.relPath.split('/');
    const oldName = parts.pop() ?? '';
    const parent = parts.join('/');
    const next = window.prompt(`Rename ${oldName} to:`, oldName);
    if (!next || next === oldName) return;
    const to = parent ? `${parent}/${next}` : next;
    try {
      await api.invoke('files:rename', { projectId, from: entry.relPath, to });
      onRefresh();
    } catch (e) { toast('Rename failed', { kind: 'error', detail: String(e).replace(/^Error:\s*/, '') }); }
  }
  async function deleteEntry(entry: Entry) {
    const kind = entry.isDir ? 'folder' : 'file';
    if (!window.confirm(`Delete ${kind} ${entry.name}? This cannot be undone.`)) return;
    try {
      await api.invoke('files:delete', { projectId, relPath: entry.relPath });
      onRefresh();
    } catch (e) { toast('Delete failed', { kind: 'error', detail: String(e).replace(/^Error:\s*/, '') }); }
  }
  async function reveal(entry: Entry) {
    try { await api.invoke('files:reveal', { projectId, relPath: entry.relPath }); }
    catch (e) { toast('Reveal failed', { kind: 'error', detail: String(e).replace(/^Error:\s*/, '') }); }
  }

  const rowItems = (entry: Entry): ContextMenuItem[] => [
    ...(entry.isDir
      ? [
          { label: 'New File…',   onClick: async () => {
            const name = window.prompt('New file name:', 'untitled.md');
            if (!name) return;
            try {
              await api.invoke('files:write', { projectId, relPath: `${entry.relPath}/${name}`, content: '' });
              onRefresh();
            } catch (e) { toast('Failed', { kind: 'error', detail: String(e).replace(/^Error:\s*/, '') }); }
          } },
          { label: 'New Folder…', onClick: async () => {
            const name = window.prompt('New folder name:');
            if (!name) return;
            try {
              await api.invoke('files:mkdir', { projectId, relPath: `${entry.relPath}/${name}` });
              onRefresh();
            } catch (e) { toast('Failed', { kind: 'error', detail: String(e).replace(/^Error:\s*/, '') }); }
          }, separatorAfter: true },
        ]
      : []),
    { label: 'Rename…',            onClick: () => renameEntry(entry) },
    { label: 'Reveal in Finder',   onClick: () => reveal(entry) },
    { label: 'Copy path',          onClick: () => { void navigator.clipboard.writeText(entry.relPath); toast('Path copied', { kind: 'success', timeoutMs: 1200 }); }, separatorAfter: true },
    { label: 'Delete',             onClick: () => deleteEntry(entry), danger: true },
  ];

  const bgItems: ContextMenuItem[] = [
    { label: 'New File…',   onClick: newFile },
    { label: 'New Folder…', onClick: newFolder, separatorAfter: true },
    { label: 'Refresh',     onClick: onRefresh },
  ];

  return (
    <div className="shrink-0 overflow-y-auto py-2 px-1 text-sm" style={{ width }} onContextMenu={bgMenu}>
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
              onContextMenu={(ev) => rowMenu(ev, e)}
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
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menu.entry ? rowItems(menu.entry) : bgItems}
          onClose={closeMenu}
        />
      )}
    </div>
  );
}

function FilePreview({
  file, onChange, onToggleEdit, onSave, dirty,
}: {
  file: OpenFile;
  onChange: (v: string) => void;
  onToggleEdit: () => void;
  onSave: () => void;
  dirty: boolean;
}) {
  const ext = extOf(file.relPath);
  const isMd = MD_EXT.has(ext);
  const isImg = IMG_EXT.has(ext);
  const editable = file.kind === 'text';
  const editing = file.editing && editable;
  const html = useMemo(() => (isMd ? md.render(file.buffer) : ''), [file.buffer, isMd]);

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
      <div className="px-3 py-1.5 border-b border-[--border] text-[11px] text-[--text-muted] font-mono flex items-center gap-2 overflow-hidden">
        <div className="flex-1 flex items-center gap-1 overflow-hidden">
          <Breadcrumbs relPath={file.relPath} />
          {dirty && <span className="text-[10px] text-[--accent] ml-1" title="Unsaved changes">●</span>}
        </div>
        {editable && (
          <>
            <button
              onClick={onToggleEdit}
              className="text-[11px] px-2 py-0.5 rounded border border-[--border] hover:bg-[--panel-strong]"
              title={editing ? 'Switch to preview' : 'Edit (⌘S to save)'}
              data-testid="file-edit-toggle"
            >
              {editing ? (isMd ? 'Preview' : 'View') : 'Edit'}
            </button>
            <button
              onClick={onSave}
              disabled={!dirty}
              className={`text-[11px] px-2 py-0.5 rounded ${
                dirty ? 'bg-[color:var(--accent)] text-white hover:brightness-110' : 'bg-[--panel] text-[--text-muted] cursor-not-allowed'
              }`}
              title="Save (⌘S)"
              data-testid="file-save"
            >
              Save
            </button>
          </>
        )}
      </div>
      <div className="flex-1 overflow-auto min-h-0">
        {file.kind === 'binary' && !isImg && (
          <div className="p-6 text-sm text-[--text-muted]">Binary file — no preview.</div>
        )}
        {file.kind === 'binary' && isImg && (
          <div className="p-4 text-sm text-[--text-muted]">Image preview is a Phase 2 feature.</div>
        )}
        {file.kind === 'text' && editing && (
          <textarea
            data-testid="file-editor"
            value={file.buffer}
            onChange={(e) => onChange(e.target.value)}
            spellCheck={false}
            className="w-full h-full bg-transparent p-4 text-[13px] leading-6 font-mono outline-none resize-none border-0"
          />
        )}
        {file.kind === 'text' && !editing && isMd && (
          <div
            className="markdown p-6 max-w-3xl mx-auto"
            onClick={onPreviewClick}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}
        {file.kind === 'text' && !editing && !isMd && (
          <SyntaxHighlightedPre content={file.buffer} lang={EXT_TO_LANG[ext] ?? ''} />
        )}
      </div>
    </div>
  );
}

function SyntaxHighlightedPre({ content, lang }: { content: string; lang: string }) {
  const html = useMemo(() => {
    try {
      if (lang && hljs.getLanguage(lang)) return hljs.highlight(content, { language: lang, ignoreIllegals: true }).value;
      return hljs.highlightAuto(content).value;
    } catch { return escapeHtml(content); }
  }, [content, lang]);
  return (
    <pre className="p-4 text-[12px] leading-5 font-mono whitespace-pre overflow-auto">
      <code className={`hljs language-${lang || 'plaintext'}`} dangerouslySetInnerHTML={{ __html: html }} />
    </pre>
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    c === '&' ? '&amp;' :
    c === '<' ? '&lt;' :
    c === '>' ? '&gt;' :
    c === '"' ? '&quot;' :
    '&#39;'
  ));
}

function Breadcrumbs({ relPath }: { relPath: string }) {
  const parts = relPath.split('/');
  return (
    <>
      {parts.map((p, i) => {
        const last = i === parts.length - 1;
        return (
          <span key={i} className="flex items-center gap-1 truncate">
            {i > 0 && <span className="opacity-60">›</span>}
            <span className={last ? 'text-[--text]' : ''}>{p}</span>
          </span>
        );
      })}
    </>
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
