import { useEffect, useMemo, useState } from 'react';
import { api } from '@renderer/api';
import type { GroupView } from '@shared/group-chat';

/**
 * Track every group chat in this project and expose a "currently running"
 * convenience. The dock uses this to:
 *   - decide whether the ⚙ "Start round" affordance is clickable (no running
 *     group → clickable; running → disabled with a Stop next to it);
 *   - render the live round's log entries interleaved with the chat bus
 *     thread, so users see everything in one place.
 *
 * Refresh strategy mirrors `useAgentChat`: eager fetch on mount, re-fetch
 * on the main-process `groups:changed` event for this project. Empty-shape
 * responses (no groups yet) are normal, not errors.
 */
export function useGroupChat(projectId: number): {
  groups: GroupView[];
  running: GroupView | null;
} {
  const [groups, setGroups] = useState<GroupView[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await api.invoke('groups:list', { projectId });
        if (!cancelled) setGroups(res.groups);
      } catch {
        /* ok — the main process may not have groupChat wired in headless tests */
      }
    };
    void load();
    const off = api.on('groups:changed', (p: { projectId: number }) => {
      if (p.projectId === projectId) void load();
    });
    return () => { cancelled = true; off(); };
  }, [projectId]);

  const running = useMemo(() => groups.find((g) => g.status === 'running') ?? null, [groups]);
  return { groups, running };
}
