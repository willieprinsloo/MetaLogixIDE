import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@renderer/api';
import { harnessOf, HARNESS_LABEL, type AgentHarness } from '@shared/agent-harness';
import { useAgentStateMap } from './useAgentStates';
import { keyFor } from '@renderer/agent-state';
import { shellLaunchName } from '@shared/shell-launch-name';

interface AliveShell {
  projectId: number;
  shellIndex: number;
  pinned: boolean;
  startedAt: string | null;
  lastActiveAt: string | null;
  /** argv[0], stripped to basename — used to label the tab; a harness detected running in the shell takes over. */
  launchName: string;
  /** The harness the shell was launched as, if any. */
  launchHarness?: AgentHarness | null;
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
        const launchName = shellLaunchName(r.launchArgv, r.shellIndex);
        return {
          projectId: r.projectId,
          shellIndex: r.shellIndex,
          pinned: !!r.pinned,
          startedAt: r.startedAt ?? null,
          lastActiveAt: r.lastActiveAt ?? null,
          launchName,
          launchHarness: harnessOf(r.launchArgv ?? []),
        };
      }));
    } catch { /* main not up yet */ }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const off = api.on('alive-shells:changed', () => { void refresh(); });
    return () => { off(); };
  }, [refresh]);

  const agents = useAgentStateMap();
  return useMemo(() => {
    if (projectId == null) return [];
    return all.filter((s) => s.projectId === projectId).sort((a, b) => a.shellIndex - b.shellIndex)
      .map((s) => {
        // A terminal where the user started Claude, Codex or opencode is labelled as that agent while it runs.
        const detected = agents.get(keyFor(s.projectId, s.shellIndex))?.agent ?? null;
        return detected && detected !== s.launchHarness ? { ...s, launchName: HARNESS_LABEL[detected] } : s;
      });
  }, [all, projectId, agents]);
}
