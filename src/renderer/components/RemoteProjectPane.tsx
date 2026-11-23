import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { api } from '@renderer/api';
import { ShellTab } from './ShellTab';
import { StatusDot } from './StatusDot';
import { SHELL_TAB_TEST_ID } from '@shared/agent-state';
import { visibleMainTab, type MainTab } from '@renderer/main-tab';
import { remoteWorkspace, type RemoteWorkspace } from '@renderer/p2p/remote-workspace';
import { PROJECT_SETTINGS_COPY, PROJECT_SETTINGS_TESTIDS } from '@renderer/project-settings-contract';
import { shellChipLabel } from '@renderer/shell-label';
import { useRemoteProjectShells } from '@renderer/p2p/useRemoteProjectShells';
import { ActivityTab } from './ActivityTab';
import { DiffTab } from './DiffTab';
import { FilesTab } from './FilesTab';
import { RemoteProjectSettings, type RemoteProjectSettingsProps } from './RemoteProjectSettings';
import { WorkspaceDestinations } from './WorkspaceDestinations';

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
}

function useRemoteActivityEnabled(remote: RemoteWorkspace, projectId: number): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh(): Promise<void> {
      let delay = 5000;
      try {
        const info = await remote.call('workspace.info', { projectId });
        if (!disposed) setEnabled(info.activityEnabled);
      } catch {
        // Back off on older or disconnected peers. Preserve the last host setting on a transient failure.
        delay = 30_000;
      } finally {
        if (!disposed) timer = setTimeout(() => void refresh(), delay);
      }
    }
    void refresh();
    return () => { disposed = true; clearTimeout(timer); };
  }, [remote, projectId]);
  return enabled;
}

/** Keep tab state and pending reads scoped to a device/project pair, not just its numeric ID. */
export function RemoteProjectPane(props: Props): ReactElement {
  return <RemoteWorkspacePane key={`${props.deviceId}:${props.projectId}`} {...props} />;
}

function RemoteWorkspacePane({ deviceId, deviceName, projectId, projectName, initialShellIndex, openRequest, onClose }: Props): ReactElement {
  const [tab, setTab] = useState<MainTab>('shell');
  const [fileTarget, setFileTarget] = useState<string | null>(null);
  const consumeFileTarget = useCallback(() => setFileTarget(null), []);
  const remote = useMemo(() => remoteWorkspace(deviceId), [deviceId]);
  const activityEnabled = useRemoteActivityEnabled(remote, projectId);
  const visibleTab = visibleMainTab(tab, activityEnabled);
  const requestedShellIndex = openRequest?.shellIndex ?? initialShellIndex;
  useEffect(() => {
    if (requestedShellIndex !== undefined) setTab('shell');
  }, [openRequest, requestedShellIndex]);
  useEffect(() => {
    if (visibleTab !== tab) setTab(visibleTab);
  }, [tab, visibleTab]);

  return (
    <div className="flex-1 min-h-0 min-w-0 flex flex-col" data-testid="remote-project-pane">
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-3 py-1.5 text-xs text-[--text]">
        <WorkspaceDestinations active={visibleTab} activityEnabled={activityEnabled} onSelect={setTab} />
        <RemoteProjectIdentity projectName={projectName} deviceName={deviceName} onClose={onClose} />
      </div>
      <div className="flex flex-1 min-h-0 min-w-0 flex-col">
        <RemoteProjectShells active={visibleTab === 'shell'} deviceId={deviceId} deviceName={deviceName} projectId={projectId}
          projectName={projectName} initialShellIndex={requestedShellIndex} openRequest={openRequest} />
        {visibleTab === 'files' && <FilesTab projectId={projectId} remote={remote} openRelPath={fileTarget}
          onOpenRelPathConsumed={consumeFileTarget} />}
        {visibleTab === 'diff' && <DiffTab projectId={projectId} remote={remote} />}
        {visibleTab === 'settings' && <RemoteSettingsView projectId={projectId} projectName={projectName} remote={remote} />}
        {visibleTab === 'activity' && <ActivityTab projectId={projectId} remote={remote} followFiles={false}
          onFollowFilesChange={() => {}} onOpenTarget={(path) => { setFileTarget(path); setTab('files'); }} />}
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

function RemoteProjectIdentity({ projectName, deviceName, onClose }: Pick<Props, 'projectName' | 'deviceName' | 'onClose'>): ReactElement {
  return (
    <div className="ml-auto flex min-w-0 items-center gap-2">
      <span className="truncate font-semibold">{`${projectName} @ ${deviceName}`}</span>
      <span data-testid="p2p-badge" className="px-1.5 rounded text-[10px] leading-[16px] border border-[--border] text-[--text-muted]">P2P</span>
      {onClose && <button type="button" onClick={onClose} aria-label="Close remote project" data-testid="remote-pane-close"
        className="w-6 h-6 flex items-center justify-center rounded text-[--text-muted] hover:text-[--text] hover:bg-[--panel-strong]">×</button>}
    </div>
  );
}

type ShellProps = Omit<Props, 'onClose'> & { readonly active: boolean };

function RemoteProjectShells({ active, deviceId, deviceName, projectId, projectName, initialShellIndex, openRequest }: ShellProps): ReactElement | null {
  const [launched, setLaunched] = useState<{ key: string; index: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = `${deviceId}:${projectId}`;
  const shells = useRemoteProjectShells(deviceId, projectId, active);
  // The tab the user picked, for this (device, project) only.
  const [picked, setPicked] = useState<{ key: string; index: number } | null>(
    initialShellIndex === undefined ? null : { key, index: initialShellIndex },
  );
  // A later request for another tab of the same project (a second notice) selects it too.
  useEffect(() => {
    if (initialShellIndex !== undefined) setPicked({ key: `${deviceId}:${projectId}`, index: initialShellIndex });
  }, [deviceId, projectId, initialShellIndex, openRequest]);

  // shells.launch is idempotent per project on the host (it reuses the live shell), so StrictMode's
  // double-mount just launches twice and the `cancelled` flag drops the stale result. Deliberately no
  // shells.kill on cancel: it would kill the very shell the second mount attaches to.
  useEffect(() => {
    let cancelled = false;
    setError(null);
    api.invoke('p2p:rpc-call', { deviceId, method: 'shells.launch', params: { projectId } }).then(
      (res) => {
        if (cancelled) return;
        const r = res.result as { shellIndex?: number } | undefined;
        setLaunched({ key, index: typeof r?.shellIndex === 'number' ? r.shellIndex : 0 });
      },
      (e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); },
    );
    return () => { cancelled = true; };
  }, [deviceId, projectId, key]);
  // A result for a previous (device, project) never renders against the new one.
  const launchedIndex = launched && launched.key === key ? launched.index : null;
  const pickedIndex = picked && picked.key === key ? picked.index : null;
  // A picked tab whose shell has since gone falls back to the launched one, so the pane never sits on a dead tab.
  const shellIndex = launchedIndex === null ? null
    : pickedIndex !== null && shells.some((s) => s.shellIndex === pickedIndex) ? pickedIndex : launchedIndex;

  // Tell main which remote shell is on screen, so a fleet notice for it is held back while it is in view.
  useEffect(() => {
    if (!active || shellIndex === null || error) return;
    api.invoke('p2p:viewing', { shell: { deviceId, projectId, shellIndex } }).catch(() => { /* worst case: one extra notice */ });
    return () => { api.invoke('p2p:viewing', { shell: null }).catch(() => {}); };
  }, [active, deviceId, projectId, shellIndex, error]);

  if (!active) return null;
  return (
    <div className="flex-1 min-h-0 flex flex-col bg-[--surface-sheet]" data-sheet-content="shell">
      {!error && shellIndex !== null && shells.length > 0 && (
        <div className="flex items-center gap-1 pl-2 pr-[14px] py-1 text-xs shrink-0 overflow-x-auto" role="tablist" aria-label={`Shells of ${projectName} on ${deviceName}`} data-testid="remote-shell-tabs">
          {shells.map((s) => {
            const isActive = s.shellIndex === shellIndex;
            return (
              <button
                key={s.shellIndex}
                type="button"
                role="tab"
                aria-selected={isActive}
                data-testid={SHELL_TAB_TEST_ID}
                data-shell-index={s.shellIndex}
                onClick={() => setPicked({ key, index: s.shellIndex })}
                className={`flex items-center gap-1 px-2 py-0.5 rounded-md whitespace-nowrap ${isActive ? 'bg-[--surface-active]' : 'hover:bg-[--surface-hover]'}`}
              >
                {s.agentState ? <StatusDot agent={s.agent} state={s.agentState} inactiveWhenIdle={!isActive} /> : null}
                <span className={isActive ? 'text-[--text] font-medium' : 'text-[--text-muted]'}>{shellChipLabel(shells, s.shellIndex)}</span>
              </button>
            );
          })}
        </div>
      )}
      <div className="flex-1 min-h-0 relative">
        {error && <div className="p-4 text-[12px] text-[--danger]">Could not open remote shell: {error}</div>}
        {!error && shellIndex !== null && (
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
