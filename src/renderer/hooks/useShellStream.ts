import { useEffect, useRef } from 'react';
import { api } from '@renderer/api';

export function useShellStream(
  projectId: number | null,
  shellIndex: number,
  onData: (data: string) => void,
  onExit: (code: number | null) => void,
): void {
  const cbData = useRef(onData); cbData.current = onData;
  const cbExit = useRef(onExit); cbExit.current = onExit;
  useEffect(() => {
    if (projectId == null) return;
    const offData = api.on('pty:data', ev => { if (ev.projectId === projectId && ev.shellIndex === shellIndex) cbData.current(ev.data); });
    const offExit = api.on('pty:exit', ev => { if (ev.projectId === projectId && ev.shellIndex === shellIndex) cbExit.current(ev.code); });
    return () => { offData(); offExit(); };
  }, [projectId, shellIndex]);
}
