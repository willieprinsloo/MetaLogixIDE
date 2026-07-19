import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@renderer/api';

interface AliveShell {
  projectId: number;
  shellIndex: number;
  pinned: boolean;
  startedAt: string | null;
  lastActiveAt: string | null;
  /** argv[0], stripped to basename — used to label the tab. */
  launchName: string;
}

/**
 * Tracks the set of alive shells for a single project. Re-fetches on the
 * `alive-shells:changed` broadcast so tab strips stay in sync when a shell
 * exits, is killed, or is spawned from anywhere in the app.
 */
export function useProjectShells(projectId: number | null): AliveShell[] {
  const [all, setAll] = useState<AliveShell[]>([]);

  const refresh = useCallback(async () => {
    try {
      const { shells } = await api.invoke('shells:alive-list', undefined as never);
      setAll(shells.map((r) => {
        const bin = r.launchArgv?.[0] ?? '';
        const base = bin.replace(/.*\//, '');
        // `$SHELL` sentinel (plain terminal) → friendlier label. Otherwise
        // capitalise the binary name so "claude" → "Claude".
        const launchName = base === '$SHELL' || base.match(/^(zsh|bash|sh|fish)$/)
          ? 'Terminal'
          : base ? base[0]!.toUpperCase() + base.slice(1) : `Shell ${r.shellIndex}`;
        return {
          projectId: r.projectId,
          shellIndex: r.shellIndex,
          pinned: !!r.pinned,
          startedAt: r.startedAt ?? null,
          lastActiveAt: r.lastActiveAt ?? null,
          launchName,
        };
      }));
    } catch { /* main not up yet */ }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const off = api.on('alive-shells:changed', () => { void refresh(); });
    return () => { off(); };
  }, [refresh]);

  return useMemo(() => {
    if (projectId == null) return [];
    return all.filter((s) => s.projectId === projectId).sort((a, b) => a.shellIndex - b.shellIndex);
  }, [all, projectId]);
}
