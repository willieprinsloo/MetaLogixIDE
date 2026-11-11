/**
 * Glue: subscribe to the hook fanout, translate each hook into one
 * `ActivityEntry`, write it to the owning project's activity log and
 * broadcast `activity:changed` so open renderers can refresh live.
 */
import type { HookSource } from '../claude-hooks/hook-fanout';
import type { ReceivedHook } from '../claude-hooks/receiver';
import type { ProjectsRepo } from '../repos/projects-repo';
import type { ActivityEntry, ActivityKind } from '@shared/activity';
import { appendActivity, nextActivityId } from './log';

export interface ActivityWireDeps {
  hooks: HookSource;
  projects: ProjectsRepo;
  broadcast: (projectId: number, entry: ActivityEntry) => void;
}

export function wireActivityLog(deps: ActivityWireDeps): void {
  deps.hooks.onHook((hook) => {
    const entry = hookToEntry(hook);
    if (!entry) return;
    const project = deps.projects.get(hook.shell.projectId);
    if (!project) return;
    appendActivity(project.path, entry);
    deps.broadcast(hook.shell.projectId, entry);
  });
}

function hookToEntry(hook: ReceivedHook): ActivityEntry | null {
  const { event, shell } = hook;
  const base = {
    id: nextActivityId(),
    ts: new Date().toISOString(),
    agent: 'claude',
    shellIndex: shell.shellIndex,
  };
  switch (event.hookEventName) {
    case 'PreToolUse':
      if (!event.toolName) return null;
      return { ...base, kind: 'tool' as ActivityKind, tool: event.toolName, target: event.toolTarget ?? undefined };
    case 'PostToolUse':
      if (!event.toolName) return null;
      return {
        ...base,
        kind: 'tool' as ActivityKind,
        tool: event.toolName,
        target: event.toolTarget ?? undefined,
        ok: event.toolOk ?? undefined,
      };
    case 'UserPromptSubmit':
      return { ...base, kind: 'prompt' as ActivityKind, text: event.message ?? undefined };
    case 'Notification':
      return { ...base, kind: 'notification' as ActivityKind, text: event.message ?? event.notificationType ?? undefined };
    case 'Stop':
      return { ...base, kind: 'turn-end' as ActivityKind };
    default:
      return null;
  }
}
