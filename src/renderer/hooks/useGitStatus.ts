import { useCallback, useEffect, useState } from 'react';
import type { GitFileStatus } from '@shared/ipc-contract';
import { api } from '@renderer/api';

export interface GitStatusView {
  isRepo: boolean;
  branch: string | null;
  ahead: number;
  behind: number;
  files: Record<string, GitFileStatus>;
  dirty: boolean;
}

const EMPTY: GitStatusView = { isRepo: false, branch: null, ahead: 0, behind: 0, files: {}, dirty: false };

/**
 * Polls git status for the current project every 4s while mounted and
 * refetches immediately when the project changes. Cheap enough for the
 * status bar chip and file-tree badges.
 */
export function useGitStatus(projectId: number | null, intervalMs = 4000): { status: GitStatusView; refresh: () => Promise<void> } {
  const [status, setStatus] = useState<GitStatusView>(EMPTY);

  const refresh = useCallback(async () => {
    if (projectId == null) { setStatus(EMPTY); return; }
    try {
      const s = await api.invoke('git:status', { projectId });
      setStatus(s);
    } catch {
      setStatus(EMPTY);
    }
  }, [projectId]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (projectId == null) return;
    const id = window.setInterval(() => { void refresh(); }, intervalMs);
    return () => window.clearInterval(id);
  }, [projectId, intervalMs, refresh]);

  return { status, refresh };
}
