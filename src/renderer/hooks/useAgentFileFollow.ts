/**
 * Agent file-follow: while enabled, every successful agent edit/write to a
 * file (PostToolUse with ok, from the shared activity log) is handed to
 * `onFile` so the IDE can live-open it in the viewer. Fires synchronously —
 * the App's pending-open slot replaces itself, so a burst of edits collapses
 * to the newest file rather than queueing.
 */
import { useEffect, useRef } from 'react';
import { api } from '../api';
import { FILE_TOOLS } from '../agent-file-targets';
import type { ActivityEntry } from '@shared/activity';

export function useAgentFileFollow(projectId: number | null, enabled: boolean, onFile: (target: string) => void): void {
  // Ref, not dep: App recreates its handler every render; the subscription
  // should only churn when the project or the toggle changes.
  const onFileRef = useRef(onFile);
  onFileRef.current = onFile;
  useEffect(() => {
    if (!enabled || projectId == null) return;
    return api.on('activity:changed', (ev) => {
      const entry: ActivityEntry = ev.entry;
      if (ev.projectId !== projectId) return;
      if (entry.kind !== 'tool' || entry.ok !== true) return;
      if (entry.tool == null || !FILE_TOOLS.has(entry.tool) || !entry.target) return;
      onFileRef.current(entry.target);
    });
  }, [projectId, enabled]);
}
