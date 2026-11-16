import { harnessOf, HARNESS_LABEL, type AgentHarness } from './agent-harness';

/**
 * Tab label for a shell from the command it was launched with: "Terminal" for a plain login shell
 * (the `$SHELL` sentinel or a known shell binary), otherwise the capitalised binary name
 * ("claude" → "Claude"). No command at all falls back to "Shell N".
 */
export function shellLaunchName(argv: readonly string[] | null | undefined, shellIndex: number): string {
  const base = (argv?.[0] ?? '').replace(/.*\//, '');
  if (base === '$SHELL' || /^(zsh|bash|sh|fish)$/.test(base)) return 'Terminal';
  return base ? base[0]!.toUpperCase() + base.slice(1) : `Shell ${shellIndex}`;
}

/**
 * The label a tab shows: an agent detected running in the shell takes over from the launch name when it
 * differs from what the shell was launched as (a terminal where the user started opencode reads "opencode").
 */
export function shellTabName(argv: readonly string[] | null | undefined, shellIndex: number, detected: AgentHarness | null | undefined): string {
  return detected && detected !== harnessOf(argv ?? []) ? HARNESS_LABEL[detected] : shellLaunchName(argv, shellIndex);
}
