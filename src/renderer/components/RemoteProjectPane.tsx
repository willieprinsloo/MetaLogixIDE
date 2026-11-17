import { useEffect, useState } from 'react';
import { api } from '@renderer/api';
import { ShellTab } from './ShellTab';
import { StatusDot } from './StatusDot';
import { SHELL_TAB_TEST_ID } from '@shared/agent-state';
import { shellChipLabel } from '@renderer/shell-label';
import { useRemoteProjectShells } from '@renderer/p2p/useRemoteProjectShells';

interface Props {
  deviceId: string;
  deviceName: string;
  projectId: number;
  projectName: string;
  /** The tab to open on; a fleet notice names the shell it is about. */
  initialShellIndex?: number;
  onClose?: () => void;
}

/**
 * Main-area pane for a project that lives on a paired device: `Project @ Machine` header, one tab per
 * shell the project has running there, and the selected shell.
 */
export function RemoteProjectPane({ deviceId, deviceName, projectId, projectName, initialShellIndex, onClose }: Props) {
  const [launched, setLaunched] = useState<{ key: string; index: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = `${deviceId}:${projectId}`;
  const shells = useRemoteProjectShells(deviceId, projectId);
  // The tab the user picked, for this (device, project) only.
  const [picked, setPicked] = useState<{ key: string; index: number } | null>(
    initialShellIndex === undefined ? null : { key, index: initialShellIndex },
  );
  // A later request for another tab of the same project (a second notice) selects it too.
  useEffect(() => {
    if (initialShellIndex !== undefined) setPicked({ key: `${deviceId}:${projectId}`, index: initialShellIndex });
  }, [deviceId, projectId, initialShellIndex]);

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
    if (shellIndex === null || error) return;
    api.invoke('p2p:viewing', { shell: { deviceId, projectId, shellIndex } }).catch(() => { /* worst case: one extra notice */ });
    return () => { api.invoke('p2p:viewing', { shell: null }).catch(() => {}); };
  }, [deviceId, projectId, shellIndex, error]);

  return (
    <div className="flex-1 min-h-0 flex flex-col" data-testid="remote-project-pane">
      <div className="h-[34px] shrink-0 flex items-center gap-2 pl-[14px] pr-2 text-[12px] text-[--text]">
        <span className="font-semibold">{`${projectName} @ ${deviceName}`}</span>
        <span
          data-testid="p2p-badge"
          className="px-1.5 rounded text-[10px] leading-[16px] border border-[--border] text-[--text-muted]"
        >P2P</span>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close remote project"
            data-testid="remote-pane-close"
            className="ml-auto w-6 h-6 flex items-center justify-center rounded text-[--text-muted] hover:text-[--text] hover:bg-[--panel-strong]"
          >×</button>
        )}
      </div>
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
