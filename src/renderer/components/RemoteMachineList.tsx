import { useMemo, useState, useSyncExternalStore } from 'react';
import { rootHueVar } from '@renderer/root-hue';
import { api } from '@renderer/api';
import { toast } from '@renderer/hooks/useToasts';
import { useRemoteProjects } from '@renderer/p2p/useRemoteProjects';
import { useRemoteRoots } from '@renderer/p2p/useRemoteRoots';
import type { Project, Root } from '@shared/types';
import type { MachineDot, OpenPaneRequest } from '@renderer/machine-switcher-contract';
import { MACHINE_COPY, MACHINE_TESTIDS, SIDEBAR_COPY } from '@renderer/sidebar-copy';
import { lastSeen, remoteSections, type RemoteSections } from '@renderer/machine-dots';
import { RootFolderGlyph, rootFolderName } from './RootFolderGlyph';
import { ChevronIcon } from './ChevronIcon';

interface Props {
  machine: MachineDot;
  /** The sidebar's shared filter text; applies to the project rows, not to the offline panel. */
  filter: string;
  /** Live project ids from the switcher's shared `shells.alive` poll; the list polls nothing itself. */
  aliveProjectIds: ReadonlySet<number>;
  onOpenPane?: (req: OpenPaneRequest) => void;
}

/**
 * The sidebar list for one paired machine (docs/specs/machine-switcher-dots.md AC16–AC24, AC31):
 * a header that scrolls with the list (name, online/offline state, last seen, Reconnect), then —
 * only while the machine is online — In use, Recents and Projects fetched for that device. Mount it
 * under `key={deviceId}` so each switch starts with fresh, all-open sections and refetches.
 */
export function RemoteMachineList({ machine, filter, aliveProjectIds, onOpenPane }: Props) {
  return (
    <div data-testid={MACHINE_TESTIDS.remoteList} className="flex flex-col gap-7">
      <RemoteHeader machine={machine} />
      {machine.online && <RemoteMachineProjects machine={machine} filter={filter} aliveProjectIds={aliveProjectIds} onOpenPane={onOpenPane} />}
    </div>
  );
}

const inFlight = new Set<string>();
const inFlightListeners = new Set<() => void>();

function subscribeInFlight(listener: () => void): () => void {
  inFlightListeners.add(listener);
  return () => { inFlightListeners.delete(listener); };
}

function setInFlight(deviceId: string, on: boolean): void {
  if (on) inFlight.add(deviceId);
  else inFlight.delete(deviceId);
  inFlightListeners.forEach((l) => l());
}

/**
 * Reconnects a machine and toasts the outcome (AC20). Its id is marked in flight at module level,
 * outside the `key={deviceId}` subtree, so switching dots away and back keeps that machine's button
 * disabled until the call settles; other machines' buttons are unaffected.
 */
async function reconnect(machine: MachineDot): Promise<void> {
  setInFlight(machine.deviceId, true);
  try {
    await api.invoke('p2p:reconnect-device', { deviceId: machine.deviceId });
    toast(MACHINE_COPY.reconnected(machine.name), { kind: 'success', timeoutMs: 1500 });
  } catch (err) {
    toast(MACHINE_COPY.reconnectFailed, { kind: 'error', detail: String(err).replace(/^Error:\s*/, '') });
  } finally {
    setInFlight(machine.deviceId, false);
  }
}

function RemoteHeader({ machine }: { machine: MachineDot }) {
  const busy = useSyncExternalStore(subscribeInFlight, () => inFlight.has(machine.deviceId));
  return (
    <div data-testid={MACHINE_TESTIDS.remoteHeader} className="flex items-center gap-2 pl-2">
      <div className="flex-1 min-w-0">
        <div className="truncate min-w-0 text-[13px] font-medium text-[--text]" title={machine.name}>{machine.name}</div>
        <div className="flex items-center gap-1.5 text-[11px] text-[--text-muted]">
          <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${machine.online ? 'bg-green-500' : 'border border-[--text-muted]'}`} />
          <span>{machine.online ? MACHINE_COPY.online : MACHINE_COPY.offline}</span>
          {!machine.online && (
            <>
              <span aria-hidden>·</span>
              <span data-testid={MACHINE_TESTIDS.remoteLastSeen} className="truncate">{lastSeen(machine.lastSeenAt, Date.now())}</span>
            </>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={() => void reconnect(machine)}
        disabled={busy}
        aria-label={MACHINE_COPY.reconnectLabel(machine.name)}
        data-testid={MACHINE_TESTIDS.remoteReconnect}
        className="shrink-0 h-6 px-2 rounded-md text-[11px] text-[--text-muted] border border-[--border] hover:text-[--text] hover:bg-[--surface-hover] disabled:opacity-50 disabled:pointer-events-none transition-colors"
      >
        {MACHINE_COPY.reconnect}
      </button>
    </div>
  );
}

function RemoteMachineProjects({ machine, filter, aliveProjectIds, onOpenPane }: Props) {
  const { projects, loading, error } = useRemoteProjects(machine.deviceId);
  const { roots, loading: rootsLoading } = useRemoteRoots(machine.deviceId);
  const sections = useMemo(
    () => remoteSections(projects, roots, aliveProjectIds, filter),
    [projects, roots, aliveProjectIds, filter],
  );
  const open = (p: Project) => onOpenPane?.({
    source: { kind: 'remote', deviceId: machine.deviceId },
    deviceName: machine.name, projectId: p.id, projectName: p.name,
  });
  const row = (p: Project, indent = 0) => (
    <RemoteProjectRow key={p.id} project={p} alive={aliveProjectIds.has(p.id)} indent={indent} onClick={() => open(p)} />
  );

  if (error || loading || rootsLoading) return <RemoteListStatus error={error} />;
  return <RemoteSectionsView sections={sections} aliveProjectIds={aliveProjectIds} row={row} />;
}

function RemoteListStatus({ error }: { error?: string }) {
  if (error) return <div className="pl-2 text-[11px] text-[--danger]">{error}</div>;
  return <div className="pl-2 text-[11px] text-[--text-muted]">{MACHINE_COPY.loading}</div>;
}

function RemoteSectionsView({ sections, aliveProjectIds, row }: {
  sections: RemoteSections;
  aliveProjectIds: ReadonlySet<number>;
  row: (p: Project, indent?: number) => React.ReactNode;
}) {
  return (
    <>
      {sections.inUse.length > 0 && (
        <RemoteSection title="In use" testId={MACHINE_TESTIDS.remoteInUse}>{sections.inUse.map((p) => row(p))}</RemoteSection>
      )}
      {sections.recents.length > 0 && (
        <RemoteSection title="Recents" testId={MACHINE_TESTIDS.remoteRecents}>{sections.recents.map((p) => row(p))}</RemoteSection>
      )}
      {sections.projects && (
        <RemoteSection title={SIDEBAR_COPY.projectsHeading} testId={MACHINE_TESTIDS.remoteFolders}>
          {sections.projects.folders.map((f) => (
            <RemoteRootBlock key={f.root.id} root={f.root} projects={f.projects} aliveProjectIds={aliveProjectIds} row={row} />
          ))}
          {sections.projects.orphans.length > 0 && <div className="pt-1">{sections.projects.orphans.map((p) => row(p))}</div>}
        </RemoteSection>
      )}
    </>
  );
}

function RemoteSection({ title, testId, children }: { title: string; testId: string; children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div data-testid={testId}>
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
        className="w-full h-[26px] mb-1 px-0 flex items-center gap-2 text-left text-[11px] uppercase tracking-[0.06em] font-medium text-[--text-muted] hover:text-[--text]"
      >
        <span className="flex-1">{title}</span>
        <ChevronIcon collapsed={collapsed} />
      </button>
      {!collapsed && children}
    </div>
  );
}

function RemoteProjectRow({ project, alive, indent, onClick }: { project: Project; alive: boolean; indent: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={project.path}
      data-testid={MACHINE_TESTIDS.remoteProjectRow}
      className="w-full h-7 flex items-center gap-2.5 px-2 text-sm text-[--text] rounded-lg hover:bg-[--surface-hover] transition-colors"
      style={{ paddingLeft: 8 + indent }}
    >
      <span aria-hidden className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${alive ? 'bg-green-500' : 'bg-[--surface-active]'}`} />
      <span className="truncate flex-1 text-left">{project.name}</span>
    </button>
  );
}

function RemoteRootBlock({ root, projects, aliveProjectIds, row }: {
  root: Root;
  projects: Project[];
  aliveProjectIds: ReadonlySet<number>;
  row: (p: Project, indent?: number) => React.ReactNode;
}) {
  const [open, setOpen] = useState(true);
  const aliveInRoot = projects.filter((p) => aliveProjectIds.has(p.id)).length;
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full text-left px-2 py-0.5 text-xs text-[--text-muted] hover:text-[--text] flex items-center gap-2.5"
      >
        <RootFolderGlyph color={rootHueVar(root.path)} testId={null} />
        <span className="truncate flex-1" title={root.path}>{rootFolderName(root.path)}</span>
        <span className="text-[10px] opacity-70">{aliveInRoot > 0 ? `${aliveInRoot}/${projects.length}` : projects.length}</span>
        <ChevronIcon collapsed={!open} />
      </button>
      {open && projects.map((p) => row(p, 12))}
    </div>
  );
}
