/**
 * Shared contract for the per-shell Claude state shown on the live dots
 * (idle green, busy amber, blocked red). Declarations only: main derives
 * the state, renderers colour dots from it, and the E2E suite selects on
 * the DOM hooks below.
 */

/** Claude state of one shell; shells without a hook-tracked Claude session are always `idle`. */
export type ClaudeShellState = 'idle' | 'busy' | 'blocked';

/** One shell's state, as listed by `claude-state:list` and pushed by `claude-state:changed`. */
export interface ClaudeShellStateEntry {
  projectId: number;
  shellIndex: number;
  state: ClaudeShellState;
}

/** Visible and accessible text per state (spec AC18). */
export const CLAUDE_STATE_LABEL: Readonly<Record<ClaudeShellState, string>> = {
  idle: 'Idle',
  busy: 'Claude is working',
  blocked: 'Claude needs your input',
};

/** DOM hooks shared by StatusDot and the E2E suite. */
export const CLAUDE_DOT = { testId: 'claude-dot', stateAttr: 'data-claude-state' } as const;

/** Test id of a shell tab button in the tab strip (distinct from ShellTab.tsx's `shell-tab` terminal container); it also carries `data-shell-index`. */
export const SHELL_TAB_TEST_ID = 'shell-tab-button';
