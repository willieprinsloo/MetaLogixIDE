import { useCallback, useEffect, useRef, useState } from 'react';
import type { Project } from '@shared/types';
import { useGitStatus } from '@renderer/hooks/useGitStatus';
import { usePorts } from '@renderer/hooks/usePorts';
import { api } from '@renderer/api';
import { toast } from '@renderer/hooks/useToasts';
import { PALETTE_COPY, PALETTE_TESTIDS } from '@renderer/command-palette-contract';
import type { ShortcutPlatform } from '@renderer/shortcut-contract';
import { SHORTCUT_COPY } from '@renderer/shortcut-copy';
import { RUNTIME_SHORTCUT_PLATFORM, useShortcutPlatform } from '@renderer/shortcut-platform';

interface LiveShell {
  projectId: number; shellIndex: number; projectName: string; pid: number;
  cpuPercent: number; memMB: number; uptimeMs: number; idleMs: number;
  launchName: string; hanging: boolean;
}

interface StatusBarProps {
  readonly project: Project | null;
  readonly aliveCount: number;
  /** Opens the command palette exactly as ⌘K does. */
  readonly onOpenPalette: () => void;
}

/** The window's bottom bar: project, git branch, shells chip, port chips, the ⌘K palette hint and the app version. */
export function StatusBar({ project, aliveCount, onOpenPalette }: StatusBarProps): React.JSX.Element {
  const { status: git } = useGitStatus(project?.id ?? null);
  const ports = usePorts(project?.id ?? null);
  const platform = useShortcutPlatform();
  // App version shown at the far right so users know exactly which build
  // they're running when they hit a bug or file feedback. Cached for the
  // session — a version bump requires a relaunch anyway.
  const [version, setVersion] = useState<string>('');
  useEffect(() => {
    void api.invoke('app:get-version', undefined as never).then(({ version }) => setVersion(version)).catch(() => {});
  }, []);
  return (
    <div className="h-[34px] shrink-0 px-3 text-xs text-[--text-muted] flex items-center gap-4 tabular-nums" data-testid="status-bar">
      <span className="flex items-center gap-1.5">
        <span className={`inline-block w-1.5 h-1.5 rounded-full ${project ? 'bg-[color:var(--accent-mark,var(--accent))]' : 'bg-[--text-muted]/50'}`} />
        {project ? project.name : 'no project'}
      </span>
      {git.isRepo && (
        <span className="flex items-center gap-1" title={
          `${git.branch ?? 'detached'}${git.ahead ? ` · ahead ${git.ahead}` : ''}${git.behind ? ` · behind ${git.behind}` : ''}${git.dirty ? ` · ${Object.keys(git.files).length} changed` : ''}`
        }>
          <span className="text-[--hue-pink] flex"><BranchIcon /></span>
          <span className="text-[--text]">{git.branch ?? 'HEAD'}</span>
          {git.dirty && <span className="text-[--hue-yellow]">●</span>}
          {git.ahead > 0 && <span className="text-[--hue-cyan]">↑{git.ahead}</span>}
          {git.behind > 0 && <span className="text-[--hue-pink]">↓{git.behind}</span>}
        </span>
      )}
      <ShellsChip aliveCount={aliveCount} />
      {ports.length > 0 && (
        <span className="flex items-center gap-1" title="Ports opened by this project's shells — click to open in your browser">
          <span className="text-[9px] uppercase opacity-70">ports</span>
          {ports.map((p) => (
            <button
              key={p}
              onClick={() => { void api.invoke('app:open-external', { url: `http://localhost:${p}` }); }}
              className="px-1.5 py-0 rounded-md bg-[--accent-soft] text-[--accent-soft-text] hover:brightness-125 font-mono"
              title={`Open http://localhost:${p}`}
              data-testid={`port-chip-${p}`}
            >
              {p}
            </button>
          ))}
        </span>
      )}
      <span className="ml-auto min-w-0 overflow-hidden flex items-center gap-3 opacity-70 whitespace-nowrap">
        <PaletteHint onOpen={onOpenPalette} platform={platform} />
        {version && (
          <>
            <span className="opacity-40">·</span>
            <span className="opacity-80" title={`MetaLogix IDE ${version}`}>v{version}</span>
          </>
        )}
      </span>
    </div>
  );
}

/**
 * Compact "N shells · CPU%" chip in the status bar. Click opens a popover
 * listing each alive shell with its project, uptime, CPU, memory, and a
 * kill button. Shells flagged as hanging (long-idle + zero-CPU) get a red
 * badge; high-CPU shells get amber. Refreshes the sampler every 2s while
 * the popover is open so the numbers stay live.
 */
function ShellsChip({ aliveCount }: { aliveCount: number }) {
  const [open, setOpen] = useState(false);
  const [shells, setShells] = useState<LiveShell[]>([]);
  const anchorRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      const { shells } = await api.invoke('shells:live-stats', undefined as never);
      setShells(shells);
    } catch { /* main not up yet */ }
  }, []);

  useEffect(() => {
    if (!open) return;
    void refresh();
    const id = window.setInterval(refresh, 2000);
    return () => window.clearInterval(id);
  }, [open, refresh]);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!anchorRef.current) return;
      const t = e.target as Node | null;
      if (t && !anchorRef.current.contains(t)) setOpen(false);
    }
    function onEsc(e: KeyboardEvent) { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  // For the chip label we sum CPU across shells when known; when the
  // popover has never been opened we don't have live data yet, so fall
  // back to just the alive count.
  const totalCpu = shells.reduce((n, s) => n + s.cpuPercent, 0);
  const anyHanging = shells.some((s) => s.hanging);
  const anyHot     = shells.some((s) => s.cpuPercent > 70);

  async function killShell(s: LiveShell) {
    if (!window.confirm(`Kill ${s.launchName} in ${s.projectName}? (shell ${s.shellIndex}, pid ${s.pid})`)) return;
    try {
      await api.invoke('shells:kill', { projectId: s.projectId, shellIndex: s.shellIndex });
      toast(`Killed ${s.launchName} in ${s.projectName}`, { kind: 'success' });
      void refresh();
    } catch (e) {
      toast('Kill failed', { kind: 'error', detail: String(e).replace(/^Error:\s*/, '') });
    }
  }

  return (
    <div ref={anchorRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1.5 px-1.5 py-0 rounded-md ${
          anyHanging ? 'bg-[--danger]/15 text-[--danger]'
          : anyHot ? 'bg-[--hue-yellow]/15 text-[--hue-yellow]'
          : 'text-[--text-muted] hover:text-[--text] hover:bg-[--surface-hover]'
        }`}
        title="Alive shells — click to see details / kill"
        data-testid="shells-chip"
      >
        <span>{aliveCount} shell{aliveCount === 1 ? '' : 's'}</span>
        {open && shells.length > 0 && (
          <span className="opacity-70">· {totalCpu.toFixed(0)}%</span>
        )}
      </button>
      {open && (
        <div className="absolute bottom-full right-0 mb-2 w-[380px] max-h-[400px] overflow-y-auto rounded-md border border-[--border] bg-[--panel-strong] shadow-xl z-50 text-[11px]" data-overlay>
          <div className="px-3 py-2 border-b border-[--border] flex items-center gap-2">
            <span className="font-semibold text-[--text]">Alive shells</span>
            <span className="text-[--text-muted]">·  refresh every 2s</span>
            <button
              onClick={() => setOpen(false)}
              className="ml-auto text-[--text-muted] hover:text-[--text] w-5 h-5 flex items-center justify-center rounded hover:bg-[--panel]"
              title="Close"
            >
              ✕
            </button>
          </div>
          {shells.length === 0 && (
            <div className="px-3 py-4 text-center text-[--text-muted]">No live shells.</div>
          )}
          <div className="divide-y divide-[--border]">
            {shells.map((s) => {
              const uptime = fmtDuration(s.uptimeMs);
              const idle   = fmtDuration(s.idleMs);
              const hot    = s.cpuPercent > 70;
              return (
                <div
                  key={`${s.projectId}:${s.shellIndex}`}
                  className={`px-3 py-2 flex items-center gap-2 ${
                    s.hanging ? 'bg-[--danger]/10'
                    : hot     ? 'bg-amber-500/10'
                    : ''
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[--text] font-medium truncate">{s.projectName}</span>
                      <span className="text-[--text-muted]">/</span>
                      <span className="text-[--text-muted]">{s.launchName}</span>
                      {s.hanging && <span className="px-1 rounded bg-[--danger]/30 text-[--danger] text-[9px] uppercase tracking-wider">hanging</span>}
                      {hot && !s.hanging && <span className="px-1 rounded bg-amber-500/30 text-amber-400 text-[9px] uppercase tracking-wider">hot</span>}
                    </div>
                    <div className="text-[10px] text-[--text-muted] font-mono mt-0.5 flex gap-2 flex-wrap">
                      <span>pid {s.pid}</span>
                      <span>up {uptime}</span>
                      <span>idle {idle}</span>
                      <span className={hot ? 'text-amber-400' : ''}>{s.cpuPercent.toFixed(1)}% cpu</span>
                      <span>{s.memMB} MB</span>
                    </div>
                  </div>
                  <button
                    onClick={() => void killShell(s)}
                    className="text-[10px] px-2 py-1 rounded border border-[--border] hover:bg-[--danger]/20 hover:text-[--danger] hover:border-[--danger]/50"
                    title={`Kill pid ${s.pid}`}
                  >
                    Kill
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function BranchIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="18" cy="18" r="2.5" />
      <path d="M6 8.5v4a4 4 0 0 0 4 4h5.5" />
    </svg>
  );
}

interface PaletteHintProps {
  readonly onOpen: () => void;
  /** Label notation for the key and accessible name; defaults to the runtime platform. */
  readonly platform?: ShortcutPlatform;
}

/** The status bar's single "⌘K command palette" hint (`Ctrl+K` off mac): a muted button that opens the palette (AC29-AC31). */
export function PaletteHint({ onOpen, platform = RUNTIME_SHORTCUT_PLATFORM }: PaletteHintProps): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={SHORTCUT_COPY.statusHintLabel(platform)}
      data-testid={PALETTE_TESTIDS.statusHint}
      className="flex items-center gap-1 rounded-sm hover:text-[--text]"
    >
      <kbd>{SHORTCUT_COPY.statusHintKey(platform)}</kbd> {PALETTE_COPY.statusHintText}
    </button>
  );
}
