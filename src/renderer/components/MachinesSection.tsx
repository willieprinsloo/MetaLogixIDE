import { useEffect, useState } from 'react';
import { api } from '@renderer/api';
import { useFleet } from '@renderer/p2p/useFleet';
import { useRemoteProjects } from '@renderer/p2p/useRemoteProjects';
import type { FleetEntry } from '@shared/p2p-contract';

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
  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        data-testid={`machine-${m.deviceId}`}
        className="w-full flex items-start gap-2 text-left py-1 text-[13px] text-[--text] hover:bg-[--panel-strong] rounded"
      >
        <span className={m.online ? 'text-green-500' : 'text-[--text-muted]'}>{m.online ? '⬤' : '○'}</span>
        <span className="flex-1 min-w-0">
          <span className="block truncate">
            <span>{m.name}</span>{self && <span className="text-[--text-muted]">{' (this)'}</span>}
          </span>
          {!m.online && <span className="block text-[11px] text-[--text-muted]">{lastSeen(m.lastSeenAt)}</span>}
        </span>
      </button>
      {/* No RPCs fire for a collapsed row: projects/shells are fetched only on expand. */}
      {expanded && <MachineExpanded m={m} onOpenPane={onOpenPane} />}
    </div>
  );
}

function MachineExpanded({ m, onOpenPane }: { m: FleetEntry; onOpenPane?: (r: OpenPaneRequest) => void }) {
  const { projects, loading, error } = useRemoteProjects(m.deviceId);
  const [shells, setShells] = useState<number | null>(null);
  useEffect(() => {
    if (loading || error) return;
    let cancelled = false;
    setShells(null);
    Promise.all(projects.map((p) =>
      api.invoke('p2p:rpc-call', { deviceId: m.deviceId, method: 'shells.list', params: { projectId: p.id } })
        .then((r) => (Array.isArray(r.result) ? r.result.length : 0), () => 0),
    )).then((counts) => { if (!cancelled) setShells(counts.reduce((a, b) => a + b, 0)); });
    return () => { cancelled = true; };
  }, [m.deviceId, projects, loading, error]);
  return (
    <div className="pl-5">
      {loading && <div className="text-[11px] text-[--text-muted]">Loading…</div>}
      {error && <div className="text-[11px] text-[--danger]">{error}</div>}
      {!loading && !error && shells !== null && (
        <div className="text-[11px] text-[--text-muted]">
          {projects.length} {projects.length === 1 ? 'project' : 'projects'} · {shells} live {shells === 1 ? 'shell' : 'shells'}
        </div>
      )}
      {projects.map((p) => (
        <button
          key={p.id}
          onClick={() => onOpenPane?.({
            source: { kind: 'remote', deviceId: m.deviceId },
            deviceName: m.name, projectId: p.id, projectName: p.name,
          })}
          className="w-full text-left py-1 text-[13px] text-[--text] hover:bg-[--panel-strong] rounded truncate"
        >{p.name}</button>
      ))}
    </div>
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
