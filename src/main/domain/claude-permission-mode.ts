import type { CliProfile, LaunchCmd, SettingsMap } from '@shared/types';
import type { SettingsRepo } from '@main/repos/settings-repo';
import { type ClaudePermissionMode } from '@shared/claude-permission-mode';

const CLAUDE_BASENAMES = new Set(['claude', 'claude.exe', 'claude.cmd']);

/** The three managed global Claude commands a permission-mode choice rewrites. */
export interface ManagedCommands {
  first: LaunchCmd;
  subsequent: LaunchCmd;
  profiles: CliProfile[];
}

function permissionFlagTokens(mode: ClaudePermissionMode): string[] {
  return mode === 'auto' ? ['--permission-mode', 'auto'] : ['--dangerously-skip-permissions'];
}

/**
 * True when argv's first element's basename (after the last `/` or `\`),
 * compared case-insensitively, is `claude`, `claude.exe`, or `claude.cmd` —
 * the spec's definition of a "Claude argv". Only such argvs are eligible
 * for permission-flag rewriting; everything else (wrapper scripts, `node
 * mock-claude.js`, renamed binaries) is left alone.
 */
export function isClaudeArgv(argv: readonly string[]): boolean {
  const bin = argv[0];
  if (!bin) return false;
  const base = bin.split(/[/\\]/).pop() ?? '';
  return CLAUDE_BASENAMES.has(base.toLowerCase());
}

/**
 * Finds every permission-flag occurrence in argv — `--dangerously-skip-permissions`,
 * `--permission-mode=<v>`, or a bare `--permission-mode` that consumes the
 * next token as its value only when a next token exists and does not start
 * with `-`. Returns each occurrence's start index and token span (1 or 2),
 * in ascending index order, so a caller can remove every occurrence and
 * reinsert a single replacement at the first one's position.
 */
function scanPermissionFlags(argv: readonly string[]): Array<{ index: number; length: number }> {
  const flags: Array<{ index: number; length: number }> = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (tok === '--dangerously-skip-permissions' || tok.startsWith('--permission-mode=')) {
      flags.push({ index: i, length: 1 });
    } else if (tok === '--permission-mode') {
      const next = argv[i + 1];
      const consumesNext = next !== undefined && !next.startsWith('-');
      flags.push({ index: i, length: consumesNext ? 2 : 1 });
      if (consumesNext) i++;
    }
  }
  return flags;
}

/**
 * Rewrites a single argv to carry exactly one permission flag for `mode`,
 * leaving every other token and their order untouched. Non-Claude argv
 * (per `isClaudeArgv`) is returned unchanged. With no existing flag, the
 * chosen flag is inserted directly after the binary (argv[0]); with one or
 * more existing flags, all are removed and the chosen flag is inserted at
 * the first one's original position.
 */
export function withPermissionMode(argv: readonly string[], mode: ClaudePermissionMode): string[] {
  // Returns the original reference (never a copy) for a non-Claude argv, so
  // callers doing reference-equality "did this change" checks see no change.
  if (!isClaudeArgv(argv)) return argv as string[];
  const flags = scanPermissionFlags(argv);
  const replacement = permissionFlagTokens(mode);
  if (flags.length === 0) {
    return [argv[0]!, ...replacement, ...argv.slice(1)];
  }
  const removeIndices = new Set<number>();
  for (const flag of flags) {
    for (let j = 0; j < flag.length; j++) removeIndices.add(flag.index + j);
  }
  const insertAt = flags[0]!.index;
  const kept = argv.filter((_, i) => !removeIndices.has(i));
  kept.splice(insertAt, 0, ...replacement);
  return kept;
}

/**
 * Applies `withPermissionMode` to the two global launch commands and to the
 * CLI profile named exactly `Claude` (per spec AC12, a missing or renamed
 * profile is left as-is — never recreated, never matched by rename). Env
 * and every other profile are untouched.
 */
export function rewriteManagedCommands(cmds: ManagedCommands, mode: ClaudePermissionMode): ManagedCommands {
  return {
    first: { ...cmds.first, argv: withPermissionMode(cmds.first.argv, mode) },
    subsequent: { ...cmds.subsequent, argv: withPermissionMode(cmds.subsequent.argv, mode) },
    profiles: cmds.profiles.map((profile) =>
      profile.name === 'Claude' ? { ...profile, argv: withPermissionMode(profile.argv, mode) } : profile,
    ),
  };
}

/**
 * Reads the three managed settings, rewrites them for `mode`, and persists
 * the mode plus every managed key whose value actually changed through one
 * `SettingsRepo.setMany` transaction (spec AC14 — all or nothing). Returns
 * exactly the keys whose stored value changed, so the IPC handler can emit
 * `settings:changed` once per changed key and no more.
 */
export function applyClaudePermissionMode(settings: SettingsRepo, mode: ClaudePermissionMode): Array<keyof SettingsMap> {
  const previousMode = settings.get('claude_permission_mode');
  const current: ManagedCommands = {
    first: settings.get('default_launch_cmd.first'),
    subsequent: settings.get('default_launch_cmd.subsequent'),
    profiles: settings.get('default_cli_profiles'),
  };
  const rewritten = rewriteManagedCommands(current, mode);

  const entries: Partial<SettingsMap> = { claude_permission_mode: mode };
  const changed: Array<keyof SettingsMap> = [];
  if (previousMode !== mode) changed.push('claude_permission_mode');
  if (JSON.stringify(rewritten.first) !== JSON.stringify(current.first)) {
    entries['default_launch_cmd.first'] = rewritten.first;
    changed.push('default_launch_cmd.first');
  }
  if (JSON.stringify(rewritten.subsequent) !== JSON.stringify(current.subsequent)) {
    entries['default_launch_cmd.subsequent'] = rewritten.subsequent;
    changed.push('default_launch_cmd.subsequent');
  }
  if (JSON.stringify(rewritten.profiles) !== JSON.stringify(current.profiles)) {
    entries['default_cli_profiles'] = rewritten.profiles;
    changed.push('default_cli_profiles');
  }

  settings.setMany(entries);
  return changed;
}
