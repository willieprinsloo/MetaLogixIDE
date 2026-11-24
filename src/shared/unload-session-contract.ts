import type { AgentKind, AgentState } from './agent-state';

/** Snapshot of the current local primary shell; the generation identifies one launch, not its tab index. */
export type PrimarySessionInspection =
  | { readonly kind: 'gone' }
  | {
      readonly kind: 'live';
      readonly generation: string;
      readonly agent: AgentKind | null;
      readonly state: AgentState | null;
    };

/** A neutral confirmation cannot authorize interrupting work that became busy later. */
export interface StopPrimarySessionRequest {
  readonly projectId: number;
  readonly generation: string;
  readonly acknowledgedWorkRisk: boolean;
}

/** Only `stopped` means the inspected primary session was signalled for termination. */
export type StopPrimarySessionResult =
  | { readonly kind: 'stopped' }
  | { readonly kind: 'gone' }
  | { readonly kind: 'replaced' }
  | { readonly kind: 'escalated' };
