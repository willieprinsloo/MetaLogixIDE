import type { CliProfile } from './types';

/**
 * Built-in default agent that opens the user's login shell instead of an agent CLI. A CLI
 * profile with the same name takes precedence, so an existing profile keeps working.
 */
export const TERMINAL_AGENT_NAME = 'Terminal';

/** Explicit project default choice; null restores the application launch commands. */
export interface ProjectDefaultAgentRequest {
  readonly projectId: number;
  readonly name: string | null;
}

/** One project-over-global deduplicated CLI profile offered by both default selectors. */
export interface ScopedCliProfile extends CliProfile {
  scope: 'project' | 'global';
}
