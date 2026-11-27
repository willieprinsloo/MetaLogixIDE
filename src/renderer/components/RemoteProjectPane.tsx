import { useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { api } from '@renderer/api';
import { ShellTab } from './ShellTab';
import { StatusDot } from './StatusDot';
import { ShellTabsBar, type ShellTabsBarItem } from './ShellTabsBar';
import { RemoteShellCommandsContext, type RemoteShellCommands } from './RemoteShellCommands';
import { terminalFocus } from '@renderer/hooks/useWindowTerminalFocus';
import { visibleMainTab, type MainTab } from '@renderer/main-tab';
import { remoteWorkspace, type RemoteWorkspace } from '@renderer/p2p/remote-workspace';
import { PROJECT_SETTINGS_COPY, PROJECT_SETTINGS_TESTIDS } from '@renderer/project-settings-contract';
import { remoteMachineLabel } from '@renderer/p2p/remote-tabs';
import { useRemoteShellMenu, useRemoteTabs, type RemoteTabs } from '@renderer/p2p/useRemoteTabs';
import { REMOTE_PANE_TESTIDS } from '@renderer/remote-pane-contract';
import { ActivityTab } from './ActivityTab';
import { DiffTab } from './DiffTab';
import { FilesTab } from './FilesTab';
import { RemoteProjectSettings, type RemoteProjectSettingsProps } from './RemoteProjectSettings';
import { WorkspaceDestinations } from './WorkspaceDestinations';
import { useWorkspaceHeaderSlot } from './WorkspaceHeaderSlot';
import type { SheetContent } from '@renderer/frosted-chrome-contract';

interface Props {
  deviceId: string;
  deviceName: string;
  projectId: number;
  projectName: string;
  /** The tab to open on; a fleet notice names the shell it is about. */
  initialShellIndex?: number;
  /** Object identity distinguishes repeated requests for the same shell. */
  openRequest?: { readonly shellIndex?: number };
  onClose?: () => void;
  /**
   * Told whether the pane shows its Shell tab, so the host sheet takes the shell sheet's styling
   * (outline, corners, terminal surface and frost), exactly as a local project's Shell tab does.
   */
  onSheetContentChange?: (content: SheetContent) => void;
}

type WorkspaceStatus = 'checking' | 'unavailable' | 'activity-disabled' | 'activity-enabled';

function useRemoteWorkspaceStatus(remote: RemoteWorkspace, projectId: number): WorkspaceStatus {
  const [status, setStatus] = useState<WorkspaceStatus>('checking');
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh(): Promise<void> {
      let delay = 5000;
      try {
        const info = await remote.call('workspace.info', { projectId });
        if (!disposed) setStatus(info.activityEnabled ? 'activity-enabled' : 'activity-disabled');
      } catch {
        // Do not present a previously enabled workspace as authorized after the host stops confirming it.
        delay = 30_000;
        if (!disposed) setStatus('unavailable');
      } finally {
        if (!disposed) timer = setTimeout(() => void refresh(), delay);
      }
    }
    void refresh();
    return () => { disposed = true; clearTimeout(timer); };
  }, [remote, projectId]);
  return status;
}

/** Keep tab state and pending reads scoped to a device/project pair, not just its numeric ID. */
export function RemoteProjectPane(props: Props): ReactElement {
  return <RemoteWorkspacePane key={`${props.deviceId}:${props.projectId}`} {...props} />;
}

function RemoteWorkspacePane({ deviceId, deviceName, projectId, projectName, initialShellIndex, openRequest, onClose, onSheetContentChange }: Props): ReactElement {
  const [tab, setTab] = useState<MainTab>('shell');
  const [filesVisited, setFilesVisited] = useState(false);
  const [fileTarget, setFileTarget] = useState<string | null>(null);
  const consumeFileTarget = useCallback(() => setFileTarget(null), []);
  const remote = useMemo(() => remoteWorkspace(deviceId), [deviceId]);
  const status = useRemoteWorkspaceStatus(remote, projectId);
  const activityEnabled = status === 'activity-enabled';
  const visibleTab = visibleMainTab(tab, activityEnabled);
  const selectTab = (next: MainTab) => {
    if (next === 'files') setFilesVisited(true);
    setTab(next);
    if (next === 'shell') terminalFocus.requestProjectFocus(projectId, deviceId);
  };
  const requestedShellIndex = openRequest?.shellIndex ?? initialShellIndex;
  useEffect(() => {
    if (requestedShellIndex !== undefined) setTab('shell');
  }, [openRequest, requestedShellIndex]);
  useEffect(() => {
    if (visibleTab !== tab) setTab(visibleTab);
  }, [tab, visibleTab]);
  useEffect(() => {
    onSheetContentChange?.(visibleTab === 'shell' ? 'shell' : 'other');
  }, [onSheetContentChange, visibleTab]);

  return (
    <div className="flex-1 min-h-0 min-w-0 flex flex-col" data-testid={REMOTE_PANE_TESTIDS.pane}>
      <RemoteHeader>
        <WorkspaceDestinations active={visibleTab} activityEnabled={activityEnabled} onSelect={selectTab} />
        <div className="workspace-project-actions flex min-w-0 flex-wrap items-center justify-end gap-2 pr-2">
          <RemoteProjectIdentity projectName={projectName} deviceName={deviceName} onClose={onClose} />
        </div>
      </RemoteHeader>
      {status === 'unavailable' && <p role="status" className="px-3 pb-1 text-xs text-[--text-muted]">
        Workspace access unavailable. Check the host’s P2P permissions and app version.
      </p>}
      <div className="flex flex-1 min-h-0 min-w-0 flex-col">
        <RemoteProjectShells active={visibleTab === 'shell'} deviceId={deviceId} deviceName={deviceName} projectId={projectId}
          projectName={projectName} initialShellIndex={requestedShellIndex} openRequest={openRequest} />
        {filesVisited && <div className="h-full min-h-0" hidden={visibleTab !== 'files'}>
          <FilesTab projectId={projectId} remote={remote} active={visibleTab === 'files'}
            openRelPath={fileTarget} onOpenRelPathConsumed={consumeFileTarget} />
        </div>}
        {visibleTab === 'diff' && <DiffTab projectId={projectId} remote={remote} />}
        {visibleTab === 'settings' && <RemoteSettingsView projectId={projectId} projectName={projectName} remote={remote} />}
        {visibleTab === 'activity' && <ActivityTab projectId={projectId} remote={remote} followFiles={false}
          onFollowFilesChange={() => {}} onOpenTarget={(path) => { setFileTarget(path); selectTab('files'); }} />}
      </div>
    </div>
  );
}

function RemoteSettingsView(props: RemoteProjectSettingsProps): ReactElement {
  return <section aria-label={PROJECT_SETTINGS_COPY.title} data-testid={PROJECT_SETTINGS_TESTIDS.view}
    className="flex-1 min-h-0 min-w-0 overflow-auto text-[--text]">
    <div className="mx-auto max-w-3xl space-y-6 p-4 sm:p-6">
      <h2 className="text-lg font-semibold">{PROJECT_SETTINGS_COPY.title}</h2>
      <RemoteProjectSettings {...props} />
    </div>
  </section>;
}

/**
 * The pane's destinations and project actions: portalled into App's workspace header row (the same
 * row and grid the local workspace uses) when one is provided, otherwise rendered inline above the body.
 */
function RemoteHeader({ children }: { readonly children: ReactNode }): ReactElement {
  const slot = useWorkspaceHeaderSlot();
  if (slot) return createPortal(children, slot);
  return <div className="flex shrink-0 flex-wrap items-center gap-2 px-3 py-1.5 text-xs text-[--text]">{children}</div>;
}

/** "<project> @ <machine>", truncated with the full text as its title, the P2P badge and the close button. */
function RemoteProjectIdentity({ projectName, deviceName, onClose }: Pick<Props, 'projectName' | 'deviceName' | 'onClose'>): ReactElement {
  const label = `${projectName} @ ${remoteMachineLabel(deviceName)}`;
  return (
    <div className="ml-auto flex min-w-0 items-center gap-2">
      <span className="min-w-0 truncate font-semibold" title={label}>{label}</span>
      <span data-testid="p2p-badge" className="px-1.5 rounded text-[10px] leading-[16px] border border-[--border] text-[--text-muted]">P2P</span>
      {onClose && <button type="button" onClick={onClose} aria-label="Close remote project" data-testid="remote-pane-close"
        className="w-6 h-6 flex items-center justify-center rounded text-[--text-muted] hover:text-[--text] hover:bg-[--panel-strong]">×</button>}
    </div>
  );
}

type ShellProps = Omit<Props, 'onClose'> & { readonly active: boolean };

/** Tells main which remote shell is on screen, so a fleet notice for it is held back while it is in view. */
function useViewingReport(showing: boolean, deviceId: string, projectId: number, shellIndex: number | null): void {
  useEffect(() => {
    if (!showing || shellIndex === null) return;
    api.invoke('p2p:viewing', { shell: { deviceId, projectId, shellIndex } }).catch(() => { /* worst case: one extra notice */ });
    return () => { api.invoke('p2p:viewing', { shell: null }).catch(() => {}); };
  }, [showing, deviceId, projectId, shellIndex]);
}

/** Fills App's ⌘T / ⌘W bridge while the Shell tab shows, so those keys act on this host's tabs. */
function useRemoteShellCommands(active: boolean, tabs: RemoteTabs): void {
  const commands = useContext(RemoteShellCommandsContext);
  const latest = useRef(tabs);
  latest.current = tabs;
  useEffect(() => {
    if (!commands || !active) return;
    const own: RemoteShellCommands = {
      newTab: () => { void latest.current.open('shells.launchPlain', {}); },
      closeActive: () => { const i = latest.current.shellIndex; if (i !== null) latest.current.close(i); },
    };
    commands.current = own;
    return () => { if (commands.current === own) commands.current = null; };
  }, [commands, active]);
}

function RemoteProjectShells({ active, deviceId, deviceName, projectId, projectName, initialShellIndex, openRequest }: ShellProps): ReactElement | null {
  const tabs = useRemoteTabs(deviceId, projectId, active, initialShellIndex, openRequest);
  const { shells, shellIndex, error, select, open, close } = tabs;
  const hostLabel = remoteMachineLabel(deviceName);
  const { menu, defaultName } = useRemoteShellMenu(tabs.call, hostLabel);
  const slot = useWorkspaceHeaderSlot();

  useViewingReport(active && !error, deviceId, projectId, shellIndex);
  useRemoteShellCommands(active, tabs);

  if (!active) return null;
  const items = shells.map((s): ShellTabsBarItem => ({
    projectId, shellIndex: s.shellIndex, pinned: false, startedAt: null, lastActiveAt: null,
    launchName: s.launchName, agent: s.agent, state: s.agentState ?? undefined,
  }));
  const bar = (
    <ShellTabsBar
      projectId={projectId}
      shells={items}
      active={shellIndex ?? -1}
      onSelect={select}
      onClose={close}
      defaultCliName={defaultName}
      remoteMenu={menu}
      renderDot={(s, isActive) => s.state ? <StatusDot agent={s.agent ?? null} state={s.state} inactiveWhenIdle={!isActive} /> : null}
      onLaunchProfile={(name, onLaunched) => void open('shells.launchProfile', { profileName: name }, onLaunched)}
      onLaunchPlainTab={(onLaunched) => void open('shells.launchPlain', {}, onLaunched)}
      onLaunchCustom={() => { /* hidden for remote hosts: they run only their saved profiles */ }}
    />
  );
  return (
    // Inside App the host sheet itself is the shell sheet (see onSheetContentChange); standalone, this view styles itself.
    <div className="flex-1 min-h-0 flex flex-col" {...(slot ? {} : { className: 'flex-1 min-h-0 flex flex-col bg-[--surface-sheet]', 'data-sheet-content': 'shell' })}>
      {slot ? createPortal(bar, slot) : <div className="shrink-0 py-1" aria-label={`Shells of ${projectName} on ${hostLabel}`} data-testid={REMOTE_PANE_TESTIDS.shellTabs}>{bar}</div>}
      <div className="flex-1 min-h-0 relative">
        {error && shells.length === 0 && <div className="p-4 text-[12px] text-[--danger]">Could not open remote shell: {error}</div>}
        {!error && shellIndex === null && shells.length === 0 && (
          <div className="p-4 text-[12px] text-[--text-muted]" data-testid={REMOTE_PANE_TESTIDS.noShells}>No terminals open on {hostLabel}. Use + to open one.</div>
        )}
        {shellIndex !== null && (
          <ShellTab
            key={`${deviceId}:${projectId}:${shellIndex}`}
            projectId={projectId}
            shellIndex={shellIndex}
            primary
            source={{ kind: 'remote', deviceId, deviceName }}
          />
        )}
      </div>
    </div>
  );
}
