import { StatusDot } from './StatusDot';
import { useShellAgentState } from '../hooks/useAgentStates';

/** One stable per-shell tab subscriber; inactive idle retains its static gray treatment. */
export function ShellTabDot({ projectId, shellIndex, isActive }: { projectId: number; shellIndex: number; isActive: boolean }) {
  const { agent, state } = useShellAgentState(projectId, shellIndex);
  return <StatusDot agent={agent} state={state} inactiveWhenIdle={!isActive} />;
}
