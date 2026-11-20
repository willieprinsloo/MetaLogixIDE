/**
 * Parses Claude hook payloads for OS notification eligibility, never dots.
 * The needs-input notification types have one shared definition here.
 * Group chats also keep `session_id` and `transcript_path`: which Claude
 * conversation a tab holds, and where to read a group answer from
 * (docs/superpowers/specs/2026-11-19-group-chats-design.md §7.3).
 */
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/** The subset of a Claude Code hook input the app uses; every other field is dropped at parse time. */
export interface HookEvent {
  hookEventName: string;
  notificationType: string | null;
  message: string | null;
  /** Length of `background_tasks` when it is an array, else 0; the tasks themselves are never read (AC28). */
  backgroundTaskCount: number;
  /**
   * Claude's own conversation id (`session_id`), or null. Optional so events
   * built by hand (tests, notifiers) stay valid; `parseHookEvent` always sets it.
   */
  claudeSessionId?: string | null;
  /** `transcript_path` as sent, unvalidated; check it with `isClaudeTranscriptPath` before reading. */
  transcriptPath?: string | null;
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
 * `session_id` / `transcript_path` are kept when they are non-empty strings,
 * else null; a bad value never rejects the event.
 */
export function parseHookEvent(raw: unknown): HookEvent | null {
  if (!isRecord(raw)) return null;
  const hookEventName = raw.hook_event_name;
  if (typeof hookEventName !== 'string' || hookEventName === '') return null;
  const notificationType = optionalString(raw.notification_type);
  const message = optionalString(raw.message);
  if (notificationType === undefined || message === undefined) return null;
  const backgroundTaskCount = Array.isArray(raw.background_tasks) ? raw.background_tasks.length : 0;
  const claudeSessionId = nonEmptyString(raw.session_id);
  const transcriptPath = nonEmptyString(raw.transcript_path);
  return { hookEventName, notificationType, message, backgroundTaskCount, claudeSessionId, transcriptPath };
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * True only for an absolute `.jsonl` path that resolves inside
 * `<homeDir>/.claude/projects`, so a hook payload can't point the app at
 * an arbitrary file.
 */
export function isClaudeTranscriptPath(p: string, homeDir: string): boolean {
  if (!isAbsolute(p) || !p.toLowerCase().endsWith('.jsonl')) return false;
  const root = resolve(join(homeDir, '.claude', 'projects'));
  const rel = relative(root, resolve(p));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).includes('..');
}

/** Maps an event to needs-input (blocking Notification), finished (`Stop`) or ignored (everything else). */
export function classifyHookEvent(event: HookEvent): HookEventKind {
  if (event.hookEventName === 'Stop') return 'finished';
  if (event.hookEventName !== 'Notification' || event.notificationType === null) return 'ignored';
  return NEEDS_INPUT_TYPES.has(event.notificationType) ? 'needs-input' : 'ignored';
}
