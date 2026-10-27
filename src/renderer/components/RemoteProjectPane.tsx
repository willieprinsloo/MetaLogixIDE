import { useEffect, useState } from 'react';
import { api } from '@renderer/api';
import { ShellTab } from './ShellTab';

interface Props {
  deviceId: string;
  deviceName: string;
  projectId: number;
  projectName: string;
  onClose?: () => void;
}

/** Main-area pane for a project that lives on a paired device: `Project @ Machine` header + a remote-sourced shell. */
export function RemoteProjectPane({ deviceId, deviceName, projectId, projectName, onClose }: Props) {
  const [launched, setLaunched] = useState<{ key: string; index: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = `${deviceId}:${projectId}`;

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
  const shellIndex = launched && launched.key === key ? launched.index : null;

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
      <div className="flex-1 min-h-0 relative">
        {error && <div className="p-4 text-[12px] text-[--danger]">Could not open remote shell: {error}</div>}
        {!error && shellIndex !== null && (
          <ShellTab
            key={`${deviceId}:${projectId}:${shellIndex}`}
            projectId={projectId}
            shellIndex={shellIndex}
            primary
            source={{ kind: 'remote', deviceId }}
          />
        )}
      </div>
    </div>
  );
}
