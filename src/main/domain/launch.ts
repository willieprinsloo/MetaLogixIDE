import type { Project, LaunchCmd, LaunchVariant, CliProfile } from '@shared/types';
import type { SettingsRepo } from '@main/repos/settings-repo';
import { interpolateArgv, interpolateEnv } from '@shared/interpolate';
import { resolveSpawnEnv } from '@main/domain/spawn-env';
import { readMetaIdeEnv, readMetaIdeCliProfiles } from '@main/domain/metaide-conf';
import { basename } from 'node:path';

export interface ResolvedLaunch { argv: string[]; env: Record<string, string>; cwd: string; variant: LaunchVariant }

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
): ResolvedLaunch {
  const variant: LaunchVariant = project.firstLaunchedAt ? 'subsequent' : 'first';

  let template: LaunchCmd;
  if (project.config.launchCmd?.[variant]) {
    template = project.config.launchCmd[variant]!;
  } else if (project.config.defaultCliName) {
    const profile = findCliProfile(project, settings, project.config.defaultCliName);
    if (profile) {
      template = { argv: profile.argv, env: profile.env ?? {} };
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
