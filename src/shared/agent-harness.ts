/** The agent CLIs the IDE knows how to resume. Any other command launches as-is. */
export type AgentHarness = 'claude' | 'codex' | 'opencode';

export const AGENT_HARNESSES: readonly AgentHarness[] = ['claude', 'codex', 'opencode'];

/** Display names, used when a harness is detected running in a shell that was not launched as it. */
export const HARNESS_LABEL: Readonly<Record<AgentHarness, string>> = { claude: 'Claude', codex: 'Codex', opencode: 'opencode' };

/** Identifies the harness by the executable's base name (`/opt/bin/claude`, `codex.exe` → `codex`). */
export function harnessOf(argv: readonly string[]): AgentHarness | null {
  const bin = argv[0];
  if (!bin) return null;
  const base = bin.split(/[\\/]/).pop()!.replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
  return (AGENT_HARNESSES as readonly string[]).includes(base) ? (base as AgentHarness) : null;
}

const CLAUDE_RESUME_FLAGS = new Set(['--continue', '-c', '--resume', '-r']);
const OPENCODE_RESUME_FLAGS = new Set(['--continue', '-c', '--session', '-s']);

/**
 * Rewrites a harness launch so it continues the most recent session in the working directory:
 * `claude … --continue`, `codex resume --last …`, `opencode … --continue`. An argv that already
 * asks for a resume is returned unchanged; a non-harness argv yields null.
 */
export function resumeArgv(argv: readonly string[]): string[] | null {
  switch (harnessOf(argv)) {
    case 'claude':
      return argv.some((a) => CLAUDE_RESUME_FLAGS.has(a)) ? [...argv] : [...argv, '--continue'];
    case 'opencode':
      return argv.some((a) => OPENCODE_RESUME_FLAGS.has(a)) ? [...argv] : [...argv, '--continue'];
    case 'codex':
      if (argv[1] === 'resume') return [...argv];
      // Another subcommand (`codex exec …`) is not an interactive session to resume.
      if (argv[1] !== undefined && !argv[1].startsWith('-')) return null;
      return [argv[0]!, 'resume', '--last', ...argv.slice(1)];
    default:
      return null;
  }
}
