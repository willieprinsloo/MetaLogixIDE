/** Claude Code permission modes the app lets the user choose between. */
export const CLAUDE_PERMISSION_MODES = ['auto', 'bypass'] as const;
export type ClaudePermissionMode = typeof CLAUDE_PERMISSION_MODES[number];

/** Env hook for automated runs: pre-seeds the mode when none is chosen yet. */
export const CLAUDE_PERMISSION_MODE_ENV = 'METAIDE_CLAUDE_PERMISSION_MODE';

/** Narrows an untrusted value (IPC payload, env var) to a known mode. */
export function isClaudePermissionMode(v: unknown): v is ClaudePermissionMode {
  return typeof v === 'string' && (CLAUDE_PERMISSION_MODES as readonly string[]).includes(v);
}
