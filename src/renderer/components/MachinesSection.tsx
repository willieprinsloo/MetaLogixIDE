import { useMemo, useState } from 'react';
import { rootHueVar } from '@renderer/root-hue';
import { api } from '@renderer/api';
import { toast } from '@renderer/hooks/useToasts';
import { useFleet } from '@renderer/p2p/useFleet';
import { useRemoteProjects } from '@renderer/p2p/useRemoteProjects';
import { useRemoteRoots } from '@renderer/p2p/useRemoteRoots';
import { useRemoteAliveShells } from '@renderer/p2p/useRemoteAliveShells';
import type { FleetEntry } from '@shared/p2p-contract';
import type { Project, Root } from '@shared/types';
import { ICON_SIZE, ICON_STROKE } from './icon-size';

/** What the sidebar hands to App when a remote project is clicked. */
export interface OpenPaneRequest {
  source: { kind: 'remote'; deviceId: string };
  deviceName: string;
  projectId: number;
  projectName: string;
}

function lastSeen(ts: number | null): string {
  if (ts == null) return 'never seen';
  const h = Math.max(0, Math.floor((Date.now() - ts) / 3600_000));
  if (h < 1) return 'last seen <1h ago';
  if (h < 48) return `last seen ${h}h ago`;
  return `last seen ${Math.floor(h / 24)}d ago`;
}

function MachineRow({ m, onOpenPane }: { m: FleetEntry; onOpenPane?: (r: OpenPaneRequest) => void }) {
  const [open, setOpen] = useState(false);
  const self = !!m.self;
  const expanded = open && m.online && !self;
  async function reconnect(e: React.MouseEvent) {
    e.stopPropagation();
    try {
      await api.invoke('p2p:reconnect-device', { deviceId: m.deviceId });
      toast(`Reconnected to ${m.name}`, { kind: 'success', timeoutMs: 1500 });
    } catch (err) {
      toast('Reconnect failed', { kind: 'error', detail: String(err).replace(/^Error:\s*/, '') });
    }
  }
  return (
    <div className="group">
      <div
        className="w-full flex items-center gap-2 py-1 text-[13px] text-[--text] hover:bg-[--panel-strong] rounded"
      >
        <button
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          data-testid={`machine-${m.deviceId}`}
          className="flex-1 min-w-0 flex items-start gap-2 text-left"
        >
          <span className={m.online ? 'text-green-500' : 'text-[--text-muted]'}>{m.online ? '⬤' : '○'}</span>
          <span className="flex-1 min-w-0">
            <span className="block truncate">
              <span>{m.name}</span>{self && <span className="text-[--text-muted]">{' (this)'}</span>}
            </span>
            {!m.online && <span className="block text-[11px] text-[--text-muted]">{lastSeen(m.lastSeenAt)}</span>}
          </span>
        </button>
        {!self && (
          <button
            onClick={reconnect}
            data-testid={`machine-${m.deviceId}-reconnect`}
            title="Reconnect — tear down and rebuild the P2P link"
            aria-label={`Reconnect to ${m.name}`}
            className="w-5 h-5 flex items-center justify-center rounded text-[--text-muted] hover:text-[--text] hover:bg-[--surface-hover] opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
          >
            <ReconnectIcon />
          </button>
        )}
      </div>
      {expanded && <MachineExpanded m={m} onOpenPane={onOpenPane} />}
    </div>
  );
}

function ReconnectIcon() {
  return (
    <svg aria-hidden width={ICON_SIZE.sm} height={ICON_SIZE.sm} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={ICON_STROKE.outline} strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12a9 9 0 1 1-3-6.7" />
      <path d="M21 4v5h-5" />
    </svg>
  );
}

function MachineExpanded({ m, onOpenPane }: { m: FleetEntry; onOpenPane?: (r: OpenPaneRequest) => void }) {
  const { projects, loading, error } = useRemoteProjects(m.deviceId);
  const { roots } = useRemoteRoots(m.deviceId);
  const { aliveProjectIds } = useRemoteAliveShells(m.deviceId);

  const inUse = useMemo(() => projects.filter((p) => aliveProjectIds.has(p.id)), [projects, aliveProjectIds]);

  // Recents: projects with a lastOpenedAt, newest first, excluding anything in In Use. Cap 6, same as local.
  const recents = useMemo(() => {
    const skip = new Set(inUse.map((p) => p.id));
    return projects
      .filter((p) => !skip.has(p.id) && p.lastOpenedAt)
      .slice()
      .sort((a, b) => (b.lastOpenedAt ?? '').localeCompare(a.lastOpenedAt ?? ''))
      .slice(0, 6);
  }, [projects, inUse]);

  // Folders: group by rootId. If the host didn't return roots (older host),
  // fall back to grouping by `dirname(path)`.
  const grouped = useMemo(() => {
    const byRoot = new Map<number, Project[]>();
    for (const p of projects) {
      const rid = p.rootId ?? -1;
      if (!byRoot.has(rid)) byRoot.set(rid, []);
      byRoot.get(rid)!.push(p);
    }
    return byRoot;
  }, [projects]);

  const open = (p: Project) => onOpenPane?.({
    source: { kind: 'remote', deviceId: m.deviceId },
    deviceName: m.name, projectId: p.id, projectName: p.name,
  });

  return (
    <div className="pl-5 space-y-3 pt-1">
      {loading && <div className="text-[11px] text-[--text-muted]">Loading…</div>}
      {error && <div className="text-[11px] text-[--danger]">{error}</div>}

      {inUse.length > 0 && (
        <RemoteSection title="In use" testId={`machine-${m.deviceId}-in-use`}>
          {inUse.map((p) => (
            <RemoteProjectRow key={p.id} project={p} alive onClick={() => open(p)} />
          ))}
        </RemoteSection>
      )}

      {recents.length > 0 && (
        <RemoteSection title="Recents" testId={`machine-${m.deviceId}-recents`}>
          {recents.map((p) => (
            <RemoteProjectRow key={p.id} project={p} alive={aliveProjectIds.has(p.id)} onClick={() => open(p)} />
          ))}
        </RemoteSection>
      )}

      {!loading && !error && projects.length > 0 && (
        <RemoteSection title="Projects" testId={`machine-${m.deviceId}-folders`}>
          {roots.map((r) => (
            <RemoteRootBlock
              key={r.id}
              root={r}
              projects={grouped.get(r.id) ?? []}
              aliveProjectIds={aliveProjectIds}
              onOpen={open}
            />
          ))}
          {/* Orphaned projects (no matching root — e.g. older host): render under one bucket. */}
          {(grouped.get(-1) ?? []).length > 0 && (
            <div className="pt-1">
              {(grouped.get(-1) ?? []).map((p) => (
                <RemoteProjectRow key={p.id} project={p} alive={aliveProjectIds.has(p.id)} onClick={() => open(p)} />
              ))}
            </div>
          )}
        </RemoteSection>
      )}
    </div>
  );
}

/** Collapsible sub-section inside an expanded machine. Local state only — not persisted.
 * Styling mirrors the local Sidebar's Section header (11px, uppercase, 0.06em tracking). */
function RemoteSection({
  title, testId, defaultCollapsed = false, children,
}: {
  title: string;
  testId: string;
  defaultCollapsed?: boolean;
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  return (
    <div data-testid={testId}>
      <button
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
        className="w-full h-[22px] mb-0.5 flex items-center gap-2 text-left text-[11px] uppercase tracking-[0.06em] font-medium text-[--text-muted] hover:text-[--text]"
      >
        <span className="flex-1">{title}</span>
        <ChevronIcon collapsed={collapsed} />
      </button>
      {!collapsed && <div>{children}</div>}
    </div>
  );
}

function RemoteProjectRow({
  project, alive, indent = 0, onClick,
}: {
  project: Project;
  alive: boolean;
  indent?: number;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={project.path}
      data-testid="remote-project-row"
      className="w-full h-[28px] flex items-center gap-2 text-[13px] text-[--text] hover:bg-[--panel-strong] rounded px-1.5"
      style={{ paddingLeft: 6 + indent }}
    >
      <span
        aria-hidden
        className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${
          alive ? 'bg-green-500' : 'bg-[--surface-active]'
        }`}
      />
      <span className="truncate flex-1 text-left">{project.name}</span>
    </button>
  );
}

function RemoteRootBlock({
  root, projects, aliveProjectIds, onOpen,
}: {
  root: Root;
  projects: Project[];
  aliveProjectIds: Set<number>;
  onOpen: (p: Project) => void;
}) {
  // Match local Sidebar: roots default OPEN. Expanding the machine should
  // show the full tree, not a wall of collapsed folders needing one click each.
  const [open, setOpen] = useState(true);
  if (projects.length === 0) return null;
  const aliveInRoot = projects.filter((p) => aliveProjectIds.has(p.id)).length;
  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full text-left px-1.5 py-1 text-xs text-[--text-muted] hover:text-[--text] flex items-center gap-2"
      >
        <RootFolderGlyph color={rootHueVar(root.path)} />
        <span className="truncate flex-1" title={root.path}>{rootFolderName(root.path)}</span>
        <span className="text-[10px] opacity-70">
          {aliveInRoot > 0 ? `${aliveInRoot}/${projects.length}` : projects.length}
        </span>
        <ChevronIcon collapsed={!open} />
      </button>
      {open && projects.map((p) => (
        <RemoteProjectRow
          key={p.id}
          project={p}
          alive={aliveProjectIds.has(p.id)}
          indent={14}
          onClick={() => onOpen(p)}
        />
      ))}
    </div>
  );
}

function rootFolderName(path: string): string {
  const sep = path.includes('\\') && !path.includes('/') ? '\\' : '/';
  const trimmed = path.length > 1 ? path.replace(/[\\/]+$/u, '') : path;
  const last = trimmed.split(sep).pop();
  return last && last.length > 0 ? last : trimmed;
}

function RootFolderGlyph({ color }: { color: string }) {
  return (
    <svg aria-hidden width={ICON_SIZE.sm} height={ICON_SIZE.sm} viewBox="0 0 24 24" fill={color} fillOpacity={0.25} stroke={color} strokeWidth="1.8" strokeLinejoin="round" className="shrink-0">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

function ChevronIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      aria-hidden
      width={ICON_SIZE.sm}
      height={ICON_SIZE.sm}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={ICON_STROKE.outline}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0 text-[--text-muted] transition-transform duration-150"
      style={{ transform: collapsed ? 'rotate(-90deg)' : 'none' }}
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

/** Paired devices, above the local project list. Hidden entirely when nothing is paired. */
export function MachinesSection({ onOpenPane }: { onOpenPane?: (r: OpenPaneRequest) => void }) {
  const { machines } = useFleet();
  if (machines.length === 0) return null;
  return (
    <div data-testid="section-machines">
      <h3 className="h-[26px] mb-1 flex items-center text-[11px] uppercase tracking-[0.06em] font-medium text-[--text-muted]">Machines</h3>
      {machines.map((m) => <MachineRow key={m.deviceId} m={m} onOpenPane={onOpenPane} />)}
    </div>
  );
}
