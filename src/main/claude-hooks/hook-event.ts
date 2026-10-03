/**
 * Typed view of a Claude Code hook POST body, its parser, its notification
 * classifier and its Claude-state transition rule. Single home of the
 * needs-input `notification_type` set (spec risk "payload drift").
 */

/** The subset of a Claude Code hook input the app uses; every other field is dropped at parse time. */
export interface HookEvent {
  hookEventName: string;
  notificationType: string | null;
  message: string | null;
  /** Length of `background_tasks` when it is an array, else 0; the tasks themselves are never read (AC28). */
  backgroundTaskCount: number;
}

/** What a hook event means for notifications. */
export type HookEventKind = 'needs-input' | 'finished' | 'ignored';

/** `Notification` types that mean Claude is blocked on the user (spec Definitions; AskUserQuestion arrives as `permission_prompt`). */
export const NEEDS_INPUT_TYPES: ReadonlySet<string> = new Set([
  'permission_prompt',
  'elicitation_dialog',
  'elicitation_url_dialog',
  'agent_needs_input',
]);

function optionalString(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Parses an untrusted JSON value into a `HookEvent`. Returns null when the
 * value is not an object, `hook_event_name` is not a non-empty string, or
 * `message` / `notification_type` are present with a non-string value.
 * `background_tasks` is reduced to its length; `session_crons` is never read.
 */
export function parseHookEvent(raw: unknown): HookEvent | null {
  if (!isRecord(raw)) return null;
  const hookEventName = raw.hook_event_name;
  if (typeof hookEventName !== 'string' || hookEventName === '') return null;
  const notificationType = optionalString(raw.notification_type);
  const message = optionalString(raw.message);
  if (notificationType === undefined || message === undefined) return null;
  const backgroundTaskCount = Array.isArray(raw.background_tasks) ? raw.background_tasks.length : 0;
  return { hookEventName, notificationType, message, backgroundTaskCount };
}

/** Maps an event to needs-input (blocking Notification), finished (`Stop`) or ignored (everything else). */
export function classifyHookEvent(event: HookEvent): HookEventKind {
  if (event.hookEventName === 'Stop') return 'finished';
  if (event.hookEventName !== 'Notification' || event.notificationType === null) return 'ignored';
  return NEEDS_INPUT_TYPES.has(event.notificationType) ? 'needs-input' : 'ignored';
}

/**
 * What a hook event does to its shell's Claude state. The two `-unless-`
 * rules depend on tracker state (answered since the last hook; waiting on
 * background work), so the tracker resolves them.
 */
export type HookTransition = 'busy' | 'blocked' | 'blocked-unless-stale' | 'background' | 'idle' | 'idle-unless-waiting';

const TRANSITION_BY_EVENT: ReadonlyMap<string, HookTransition> = new Map([
  ['UserPromptSubmit', 'busy'],
  ['PreToolUse', 'busy'],
  ['PostToolUse', 'busy'],
  ['PostToolUseFailure', 'busy'],
  ['PermissionRequest', 'blocked'],
  ['StopFailure', 'idle'],
]);

function notificationTransition(notificationType: string | null): HookTransition | null {
  if (notificationType === null) return null;
  if (NEEDS_INPUT_TYPES.has(notificationType)) return 'blocked-unless-stale';
  return notificationType === 'idle_prompt' ? 'idle-unless-waiting' : null;
}

/**
 * The transition rule a hook event applies to its shell, or null when the
 * event leaves the state unchanged. Single home of the spec's hook-event
 * transition table; a `Stop` with background tasks pauses rather than ends
 * the turn (AC24). Independent of `classifyHookEvent`, which names the
 * notification an event could raise.
 */
export function stateTransitionFor(event: HookEvent): HookTransition | null {
  if (event.hookEventName === 'Notification') return notificationTransition(event.notificationType);
  if (event.hookEventName === 'Stop') return event.backgroundTaskCount > 0 ? 'background' : 'idle';
  return TRANSITION_BY_EVENT.get(event.hookEventName) ?? null;
}
