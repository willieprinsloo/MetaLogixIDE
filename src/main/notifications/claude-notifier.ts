/**
 * Turns the hooks the Claude state tracker applied into OS notifications
 * (service layer), so notifications follow the same state as the dots
 * (AC12). "Needs input" shows for a needs-input Notification that left the
 * shell blocked; "finished" for a `Stop` with no background tasks that moved
 * the shell from busy to idle. Each then notifies subject to the per-kind
 * toggle (read per event), OS support and the "user is viewing this shell"
 * rule, with at most one outstanding notification per shell. Session
 * confirmation happens in the tracker. Also hosts the generic notifier's
 * confirmed-shell filter.
 */
import { classifyHookEvent, type HookEvent } from '@main/claude-hooks/hook-event';
import type { ShellKey } from '@main/claude-hooks/session-registry';
import type { AppliedHook } from '@main/claude-status/state-tracker';
import type { ClaudeShellState } from '@shared/claude-state';
import type { NotificationHandle, NotificationsPort } from './os-notifications';

/** The two toggles the notifier reads. */
export type ClaudeNotifyToggle = 'notify_claude_needs_input' | 'notify_claude_finished';

/** Injected ports. */
export interface ClaudeNotifierDeps {
  notifications: NotificationsPort;
  isViewing: (shell: ShellKey) => boolean;
  navigate: (shell: ShellKey) => void;
  settings: { get(key: ClaudeNotifyToggle): boolean };
  projectName: (projectId: number) => string | null;
}

const MAX_BODY_CHARS = 200;
const NEEDS_INPUT_FALLBACK = 'Claude needs your input';
const FINISHED_BODY = 'Claude finished and is waiting for you';
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

const shellKeyString = (shell: ShellKey): string => `${shell.projectId}:${shell.shellIndex}`;

function needsInputBody(message: string | null): string {
  const clean = (message ?? '').replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  if (clean === '') return NEEDS_INPUT_FALLBACK;
  return Array.from(clean).slice(0, MAX_BODY_CHARS).join('');
}

function isFinishedTurn(event: HookEvent, from: ClaudeShellState, to: ClaudeShellState): boolean {
  return event.backgroundTaskCount === 0 && from === 'busy' && to === 'idle';
}

function contentFor({ hook: { event }, from, to }: AppliedHook): { toggle: ClaudeNotifyToggle; body: string } | null {
  const kind = classifyHookEvent(event);
  if (kind === 'needs-input' && to === 'blocked') return { toggle: 'notify_claude_needs_input', body: needsInputBody(event.message) };
  if (kind === 'finished' && isFinishedTurn(event, from, to)) return { toggle: 'notify_claude_finished', body: FINISHED_BODY };
  return null;
}

/** Shows Claude needs-input / finished notifications; see the module docblock. */
export class ClaudeNotifier {
  private readonly outstanding = new Map<string, NotificationHandle>();

  constructor(private readonly deps: ClaudeNotifierDeps) {}

  /** Processes one hook the state tracker applied (it already confirmed the session). */
  handle(applied: AppliedHook): void {
    const { hook } = applied;
    const content = contentFor(applied);
    if (!content || !this.deps.settings.get(content.toggle)) return;
    if (!this.deps.notifications.isSupported() || this.deps.isViewing(hook.shell)) return;
    this.show(hook.shell, content.body);
  }

  /** Closes and forgets the shell's outstanding notification (AC26). */
  shellExited(shell: ShellKey): void {
    const key = shellKeyString(shell);
    this.outstanding.get(key)?.close();
    this.outstanding.delete(key);
  }

  private show(shell: ShellKey, body: string): void {
    const key = shellKeyString(shell);
    this.outstanding.get(key)?.close();
    const name = this.deps.projectName(shell.projectId) ?? `#${shell.projectId}`;
    const target = { ...shell };
    const handle = this.deps.notifications.show({
      title: `${name} — shell ${shell.shellIndex}`,
      body,
      onClick: () => this.deps.navigate(target),
    });
    this.outstanding.set(key, handle);
  }
}

/** Drops hook-confirmed shells from the generic notifier's done list (AC18); other shells pass unchanged (AC19). */
export function withoutHookConfirmed<T extends ShellKey>(done: readonly T[], isConfirmed: (shell: ShellKey) => boolean): T[] {
  return done.filter((d) => !isConfirmed(d));
}
