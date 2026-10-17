/** Public per-shell status sent by main; no terminal content or credentials cross IPC. */
export type AgentKind = 'claude' | 'omp';
export type AgentState = 'idle' | 'busy' | 'blocked';

/** `agent` is null only when no recognized live agent owns the shell. */
export interface AgentShellStateEntry {
  readonly projectId: number;
  readonly shellIndex: number;
  readonly agent: AgentKind | null;
  readonly state: AgentState;
}

/** Labels for an individual shell; aggregate labels intentionally omit agent identity. */
export const AGENT_STATE_LABEL: Readonly<Record<AgentKind, Readonly<Record<AgentState, string>>>> =
  {
    claude: {
      idle: 'Claude is idle',
      busy: 'Claude is working',
      blocked: 'Claude needs your input',
    },
    omp: { idle: 'OMP is idle', busy: 'OMP is working', blocked: 'OMP needs your input' },
  };

export const AGGREGATE_STATE_LABEL: Readonly<Record<AgentState, string>> = {
  idle: 'Idle',
  busy: 'Working',
  blocked: 'Needs input',
};

/** Existing dot hooks remain stable for current layouts and E2E selectors. */
export const AGENT_DOT = { testId: 'claude-dot', stateAttr: 'data-claude-state' } as const;
export const SHELL_TAB_TEST_ID = 'shell-tab-button';
