/**
 * Which agent tool calls act on files, and how to resolve one to a
 * project-relative path that the FilesTab viewer can open. Shared by the
 * Activity tab's clickable targets and the agent file-follow mode.
 */
import { api } from './api';
import type { ActivityEntry } from '@shared/activity';

/** Claude tools whose `target` is the file they acted on. */
export const FILE_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'Read', 'MultiEdit', 'NotebookEdit']);

/** True when an Activity entry points at a file the viewer might open. */
export function isFileToolActivity(entry: ActivityEntry): boolean {
  return entry.kind === 'tool' && entry.tool != null && FILE_TOOLS.has(entry.tool) && !!entry.target;
}

/**
 * Resolve an activity target (absolute or project-relative) to a
 * project-relative path, reusing the peek IPC's filesystem resolution.
 * Returns null when the file is missing on disk or belongs to a project
 * other than `projectId` — callers toast rather than open the wrong viewer.
 */
export async function resolveFileTarget(projectId: number, target: string): Promise<{ relPath: string; projectId: number } | null> {
  try {
    const res = await api.invoke('files:peek', { projectId, relPath: target, maxLines: 1 });
    if (!res.found || res.projectId !== projectId) return null;
    return { relPath: res.relPath, projectId: res.projectId };
  } catch {
    // The peek IPC rejects when the project vanished mid-flight (follow mode
    // fires autonomously, so this can race a root removal). Null flows to
    // the caller's toast instead of an unhandled rejection.
    return null;
  }
}
