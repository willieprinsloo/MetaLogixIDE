/**
 * The colour-and-label unit shared by every Claude-state dot site (spec
 * "Dot sites"). Renders the existing pulsing dot shape, coloured per
 * `state` via `.status-dot[data-claude-state]` in `styles.css`, and carries
 * the state as visible/accessible text (`title` + `aria-label`, AC18) so
 * colour is never the only carrier. `inactiveWhenIdle` gives the D1
 * exception for an inactive shell tab: grey and static when idle, coloured
 * and pulsing when busy or blocked. `ring` adds the 1px white ring AC21
 * requires on the accent-filled active ProjectSwitcher row.
 */
import { CLAUDE_DOT, CLAUDE_STATE_LABEL, type ClaudeShellState } from '@shared/claude-state';

export interface StatusDotProps {
  state: ClaudeShellState;
  inactiveWhenIdle?: boolean;
  ring?: boolean;
  className?: string;
}

export function StatusDot({ state, inactiveWhenIdle = false, ring = false, className = '' }: StatusDotProps) {
  const staticGrey = inactiveWhenIdle && state === 'idle';
  const classes = [
    'status-dot',
    'inline-block w-1.5 h-1.5 rounded-full shrink-0',
    staticGrey ? 'bg-[--text-muted]' : 'live-dot',
    ring ? 'status-dot-ring' : '',
    className,
  ].filter(Boolean).join(' ');
  return (
    <span
      data-testid={CLAUDE_DOT.testId}
      data-claude-state={staticGrey ? undefined : state}
      role="img"
      title={CLAUDE_STATE_LABEL[state]}
      aria-label={CLAUDE_STATE_LABEL[state]}
      className={classes}
    />
  );
}
