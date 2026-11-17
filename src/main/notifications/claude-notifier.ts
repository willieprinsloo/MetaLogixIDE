/** Converts confirmed Claude notification history into OS alerts without reading dot state. */
import { classifyHookEvent, type HookEvent } from '@main/claude-hooks/hook-event';
import type { ShellKey } from '@main/claude-hooks/session-registry';
import type { AppliedHook } from './claude-hook-history';
import type { AgentState } from '@shared/agent-state';
import type { NotificationHandle, NotificationsPort } from './os-notifications';

/** The two toggles the notifier reads. */
export type ClaudeNotifyToggle = 'notify_claude_needs_input' | 'notify_claude_finished';

/** A classified notification, as a paired machine receives it. */
export interface ClaudeNotice {
  kind: 'needs-input' | 'finished';
  body: string;
}

/** The setting that enables notices of this kind, here or on the machine that receives them. */
export function toggleFor(kind: ClaudeNotice['kind']): ClaudeNotifyToggle {
  return kind === 'needs-input' ? 'notify_claude_needs_input' : 'notify_claude_finished';
}

/** Injected ports. `forward` returns true once the fleet's active IDE instance took the notice, which skips the local one. */
export interface ClaudeNotifierDeps {
  forward: (shell: ShellKey, notice: ClaudeNotice) => boolean;
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

function isFinishedTurn(event: HookEvent, from: AgentState, to: AgentState): boolean {
  return event.backgroundTaskCount === 0 && from === 'busy' && to === 'idle';
}

function contentFor({ hook: { event }, from, to }: AppliedHook): ClaudeNotice | null {
  const kind = classifyHookEvent(event);
  if (kind === 'needs-input' && to === 'blocked') return { kind, body: needsInputBody(event.message) };
  if (kind === 'finished' && isFinishedTurn(event, from, to)) return { kind, body: FINISHED_BODY };
  return null;
}

/** Shows Claude needs-input / finished notifications; see the module docblock. */
export class ClaudeNotifier {
  private readonly outstanding = new Map<string, NotificationHandle>();

  constructor(private readonly deps: ClaudeNotifierDeps) {}

  /** Processes an authenticated hook independently of screen-based status. */
  handle(applied: AppliedHook): void {
    const { hook } = applied;
    const content = contentFor(applied);
    if (!content) return;
    // The IDE instance in use gets the notice, under its own toggles and its own view. Only when that is
    // this machine do the local toggles and the local view apply: an unattended machine often still has
    // the shell on screen in a focused window, and that must not swallow the notice.
    if (this.deps.forward(hook.shell, content)) return;
    if (!this.deps.settings.get(toggleFor(content.kind))) return;
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
