/**
 * Parses Claude hook payloads for OS notification eligibility, never dots.
 * The needs-input notification types have one shared definition here.
 */

/** The subset of a Claude Code hook input the app uses; every other field is dropped at parse time. */
export interface HookEvent {
  hookEventName: string;
  notificationType: string | null;
  message: string | null;
  /** Length of `background_tasks` when it is an array, else 0; the tasks themselves are never read (AC28). */
  backgroundTaskCount: number;
  /** For PreToolUse / PostToolUse: the tool name (e.g. "Edit", "Write", "Bash", "Read"). */
  toolName: string | null;
  /** Best-effort summary of the tool's target: file_path for Edit/Write/Read, command for Bash. */
  toolTarget: string | null;
  /** PostToolUse only: whether the tool reported success. null when the field is absent. */
  toolOk: boolean | null;
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
  const toolName = typeof raw.tool_name === 'string' ? raw.tool_name : null;
  const toolTarget = extractToolTarget(toolName, raw.tool_input);
  const toolOk = extractToolOk(raw.tool_response);
  return { hookEventName, notificationType, message, backgroundTaskCount, toolName, toolTarget, toolOk };
}

/**
 * Best-effort "what did this tool act on" extractor. Covers the built-in
 * Claude tools whose inputs follow well-known shapes; returns null for any
 * tool whose input isn't an obvious single-target action.
 */
function extractToolTarget(toolName: string | null, input: unknown): string | null {
  if (!toolName || !isRecord(input)) return null;
  const field =
    toolName === 'Bash' ? input.command :
    toolName === 'Edit' || toolName === 'Write' || toolName === 'Read' || toolName === 'MultiEdit' ? input.file_path :
    toolName === 'Grep' || toolName === 'Glob' ? (input.path ?? input.pattern) :
    toolName === 'WebFetch' || toolName === 'WebSearch' ? (input.url ?? input.query) :
    null;
  return typeof field === 'string' ? field : null;
}

/** Peeks at `tool_response` for a success flag; many tools omit it entirely. */
function extractToolOk(response: unknown): boolean | null {
  if (!isRecord(response)) return null;
  if (typeof response.success === 'boolean') return response.success;
  if (response.error) return false;
  return null;
}

/** Maps an event to needs-input (blocking Notification), finished (`Stop`) or ignored (everything else). */
export function classifyHookEvent(event: HookEvent): HookEventKind {
  if (event.hookEventName === 'Stop') return 'finished';
  if (event.hookEventName !== 'Notification' || event.notificationType === null) return 'ignored';
  return NEEDS_INPUT_TYPES.has(event.notificationType) ? 'needs-input' : 'ignored';
}
