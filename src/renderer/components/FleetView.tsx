import { useMemo } from 'react';
import { useFleet } from '@renderer/p2p/useFleet';
import { useRemoteAliveShells } from '@renderer/p2p/useRemoteAliveShells';
import type { FleetEntry } from '@shared/p2p-contract';
import type { OpenPaneRequest } from './MachinesSection';

interface AliveShell { projectId: number; projectName: string; projectPath: string; shellIndex: number; launchArgv: string[]; }

/**
 * Top-level Fleet pane — one row per paired device (including self).
 * Click a device to see its live shells; click a shell row to jump
 * (locally: switch project + shell; remotely: open the remote pane).
 *
 * Builds on existing p2p plumbing — the local shells come from the same
 * `shells:alive-list` IPC the MachinesSection uses; remote shells come
 * from `useRemoteAliveShells`.
 */
export function FleetView({
  localShells,
  onOpenLocal,
  onOpenRemote,
}: {
  localShells: AliveShell[];
  /** Fired when user picks a local shell row. */
  onOpenLocal: (projectId: number, shellIndex: number) => void;
  /** Fired when user picks a remote project to open its pane. */
  onOpenRemote: (req: OpenPaneRequest) => void;
}) {
  const { machines, loading, error } = useFleet();
  const sorted = useMemo(() => {
    return [...machines].sort((a, b) => {
      if (a.self && !b.self) return -1;
      if (!a.self && b.self) return 1;
      if (a.online !== b.online) return a.online ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }, [machines]);

  return (
    <div className="h-full flex flex-col min-h-0 overflow-auto" data-testid="fleet-view">
      <div className="px-6 py-4 border-b border-[--border]">
        <h2 className="text-lg font-semibold text-[--text]">Fleet</h2>
        <p className="text-xs text-[--text-muted] mt-1">
          Every machine you&apos;re paired with, every live shell it&apos;s running. Click a shell to jump.
        </p>
      </div>
      {error && <div className="px-6 py-3 text-sm text-[--danger]">{error}</div>}
      {loading && machines.length === 0 && <div className="p-6 text-sm text-[--text-muted]">Discovering machines…</div>}
      {!loading && machines.length === 0 && (
        <div className="p-6 text-sm text-[--text-muted]">
          No paired machines yet. Settings → P2P generates a pair code; another metaIDE enters it to join the fleet.
        </div>
      )}
      <div className="flex-1 min-h-0 px-4 py-3 space-y-3">
        {sorted.map((m) => (
          <FleetRow
            key={m.deviceId}
            machine={m}
            localShells={m.self ? localShells : null}
            onOpenLocal={onOpenLocal}
            onOpenRemote={onOpenRemote}
          />
        ))}
      </div>
    </div>
  );
}

function FleetRow({
  machine, localShells, onOpenLocal, onOpenRemote,
}: {
  machine: FleetEntry;
  localShells: AliveShell[] | null;
  onOpenLocal: (projectId: number, shellIndex: number) => void;
  onOpenRemote: (req: OpenPaneRequest) => void;
}) {
  // Remote shells come from a per-device hook; passing a stable key avoids
  // tearing the subscription down when machines[] reshuffles.
  const remote = useRemoteAliveShells(machine.self ? '' : machine.deviceId);
  const shellCount = machine.self ? (localShells?.length ?? 0) : remote.shellCount;
  const since = machine.lastSeenAt == null ? null :
    (() => {
      const h = Math.floor((Date.now() - machine.lastSeenAt!) / 3600_000);
      if (h < 1) return 'now';
      if (h < 48) return `${h}h ago`;
      return `${Math.floor(h / 24)}d ago`;
    })();

  return (
    <div className="rounded-lg border border-[--border] overflow-hidden bg-[--panel]/40">
      <div className="px-4 py-2 flex items-center gap-3 border-b border-[--border] bg-[--panel]/60">
        <span className={machine.online ? 'text-green-500' : 'text-[--text-muted]'}>{machine.online ? '⬤' : '○'}</span>
        <div className="flex-1 min-w-0">
          <div className="text-[13px] text-[--text] font-medium truncate flex items-center gap-2">
            {machine.name}
            {machine.self && <span className="text-[10px] text-[--text-muted] font-normal uppercase tracking-wider">this</span>}
          </div>
          <div className="text-[11px] text-[--text-muted] font-mono truncate">{machine.deviceId}</div>
        </div>
        <div className="text-[11px] text-[--text-muted] tabular-nums shrink-0 text-right">
          <div>{shellCount} shell{shellCount === 1 ? '' : 's'}</div>
          {!machine.online && since && <div>last seen {since}</div>}
        </div>
      </div>
      {machine.online && machine.self && localShells && localShells.length > 0 && (
        <div className="divide-y divide-[--border]">
          {localShells.map((s) => (
            <button
              key={`${s.projectId}:${s.shellIndex}`}
              onClick={() => onOpenLocal(s.projectId, s.shellIndex)}
              className="w-full text-left px-4 py-1.5 text-[12px] hover:bg-[--surface-hover] flex items-center gap-3"
            >
              <span className="text-[--text-muted] w-6 tabular-nums">#{s.shellIndex}</span>
              <span className="text-[--text] flex-1 truncate">{s.projectName}</span>
              <span className="text-[--text-muted] font-mono truncate max-w-[40%]">{labelFor(s.launchArgv)}</span>
            </button>
          ))}
        </div>
      )}
      {machine.online && !machine.self && (
        <div className="px-4 py-2 text-[11px] text-[--text-muted]">
          Open from Sidebar → Machines → {machine.name} to see this device&apos;s projects.
          <button
            onClick={() => onOpenRemote({ source: { kind: 'remote', deviceId: machine.deviceId }, deviceName: machine.name, projectId: -1, projectName: '' })}
            className="ml-2 underline hover:text-[--text]"
          >
            Open sidebar view
          </button>
        </div>
      )}
    </div>
  );
}

function labelFor(argv: string[]): string {
  const bin = argv[0] ?? '';
  const base = bin.replace(/.*\//, '');
  if (base === '$SHELL' || /^(zsh|bash|sh|fish)$/.test(base)) return 'Terminal';
  return argv.join(' ');
}
