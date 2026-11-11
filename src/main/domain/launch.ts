import type { Project, LaunchCmd, LaunchVariant, CliProfile } from '@shared/types';
import type { SettingsRepo } from '@main/repos/settings-repo';
import { interpolateArgv, interpolateEnv } from '@shared/interpolate';
import { resolveSpawnEnv } from '@main/domain/spawn-env';
import { readMetaIdeEnv, readMetaIdeCliProfiles } from '@main/domain/metaide-conf';
import { basename } from 'node:path';
import { harnessOf, resumeArgv, type AgentHarness } from '@shared/agent-harness';

export interface ResolvedLaunch { argv: string[]; env: Record<string, string>; cwd: string; variant: LaunchVariant }

export interface LaunchOptions {
  /** True when a live shell in the project already runs `harness`, so its session must not be resumed. */
  readonly resumeBlocked?: (harness: AgentHarness) => boolean;
}

/**
 * The argv for launching a CLI profile: its resume form (`claude --continue`, `codex resume --last`,
 * `opencode --continue`) once that harness has run in the project and no live shell is using it,
 * otherwise the profile's own argv.
 */
export function profileLaunchArgv(
  project: Project,
  argv: string[],
  variant: LaunchVariant,
  resumeBlocked: (harness: AgentHarness) => boolean,
): string[] {
  const harness = harnessOf(argv);
  if (variant !== 'subsequent' || !harness) return argv;
  if (!(project.config.resumableAgents ?? []).includes(harness) || resumeBlocked(harness)) return argv;
  return resumeArgv(argv) ?? argv;
}

/**
 * Look up a CLI profile by name across project + global scopes. Project
 * overrides shadow same-name globals, matching the merge semantics the
 * "+ new shell" menu uses. Returns null when the name doesn't resolve.
 */
export function findCliProfile(project: Project, settings: Pick<SettingsRepo, 'get'>, name: string): CliProfile | null {
  const projectHit = (project.config.cliProfiles ?? []).find((p) => p.name === name);
  if (projectHit) return projectHit;
  // `.metaide/cli-profiles.json` sits between per-user project config (above)
  // and global defaults (below): checked into the repo, per-project, shared.
  const metaIdeHit = readMetaIdeCliProfiles(project.path).find((p) => p.name === name);
  if (metaIdeHit) return metaIdeHit;
  const globalHit  = settings.get('default_cli_profiles').find((p) => p.name === name);
  return globalHit ?? null;
}

/**
 * Resolves the primary launch for a project. Template env values keep their
 * legacy interpolation (raw project env ⊕ template env, no inherited or
 * app-wide env); app-wide and the project's own variables are layered on top
 * by `resolveSpawnEnv`, and template argv `${env.NAME}` resolves against that
 * final environment. `inherited` is the main process env at spawn time.
 * Untouched custom variants precede named profiles and global commands;
 * an explicit default choice clears both custom variants before resolution.
 */
export function resolveLaunch(
  project: Project,
  settings: SettingsRepo,
  homeDir: string,
  inherited: Readonly<Record<string, string | undefined>>,
  options: LaunchOptions = {},
): ResolvedLaunch {
  const resumeBlocked = options.resumeBlocked ?? (() => false);
  let variant: LaunchVariant = project.firstLaunchedAt ? 'subsequent' : 'first';
  // Another live shell already runs this harness here: resuming would attach a second
  // process to the same conversation, so start a new one instead.
  if (variant === 'subsequent') {
    const sub = project.config.launchCmd?.subsequent ?? (project.config.defaultCliName ? null : settings.get('default_launch_cmd.subsequent'));
    const harness = sub ? harnessOf(sub.argv) : null;
    if (harness && resumeBlocked(harness)) variant = 'first';
  }

  let template: LaunchCmd;
  if (project.config.launchCmd?.[variant]) {
    template = project.config.launchCmd[variant]!;
  } else if (project.config.defaultCliName) {
    const profile = findCliProfile(project, settings, project.config.defaultCliName);
    if (profile) {
      template = { argv: profileLaunchArgv(project, profile.argv, variant, resumeBlocked), env: profile.env ?? {} };
    } else {
      // Name resolved to nothing (profile was renamed/deleted after being
      // pinned). Fall through to the global default rather than crash.
      template = settings.get(variant === 'first' ? 'default_launch_cmd.first' : 'default_launch_cmd.subsequent');
    }
  } else {
    template = settings.get(variant === 'first' ? 'default_launch_cmd.first' : 'default_launch_cmd.subsequent');
  }

  const paths = { home: homeDir, projectPath: project.path, projectName: basename(project.path) };
  const templateEnv = interpolateEnv(template.env ?? {}, {
    ...paths,
    env: { ...(project.config.env ?? {}), ...(template.env ?? {}) },
  });
  const appEnv = settings.get('app_env');
  const metaIdeEnv = readMetaIdeEnv(project.path);
  const { env, lookup } = resolveSpawnEnv({ project, templateEnv, inherited, homeDir, appEnv, metaIdeEnv });

  return {
    argv: interpolateArgv(template.argv, { ...paths, env: lookup }),
    env,
    cwd: project.config.cwdOverride ?? project.path,
    variant,
  };
}
