/** Shared status dot: per-shell labels include agent identity, aggregate labels communicate severity only. */
import {
  AGENT_DOT, AGENT_STATE_LABEL, AGGREGATE_STATE_LABEL,
  type AgentKind, type AgentState,
} from '@shared/agent-state';

export interface StatusDotProps {
  state: AgentState;
  agent?: AgentKind | null;
  inactiveWhenIdle?: boolean;
  ring?: boolean;
  className?: string;
}

/** Displays existing color, pulse, inactive-idle gray and optional palette ring with a fixed accessible label. */
export function StatusDot({ state, agent = null, inactiveWhenIdle = false, ring = false, className = '' }: StatusDotProps) {
  const staticGrey = inactiveWhenIdle && state === 'idle';
  const label = agent ? AGENT_STATE_LABEL[agent][state] : AGGREGATE_STATE_LABEL[state];
  const classes = [
    'status-dot',
    'inline-block w-1.5 h-1.5 rounded-full shrink-0',
    staticGrey ? 'bg-[--text-muted]' : 'live-dot',
    ring ? 'status-dot-ring' : '',
    className,
  ].filter(Boolean).join(' ');
  return (
    <span
      data-testid={AGENT_DOT.testId}
      data-claude-state={staticGrey ? undefined : state}
      role="img"
      title={label}
      aria-label={label}
      className={classes}
    />
  );
}
