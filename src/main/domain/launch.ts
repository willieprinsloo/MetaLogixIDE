import type { Project, LaunchCmd, LaunchVariant } from '@shared/types';
import type { SettingsRepo } from '@main/repos/settings-repo';
import { interpolateArgv, interpolateEnv } from '@shared/interpolate';
import { basename } from 'node:path';

export interface ResolvedLaunch { argv: string[]; env: Record<string, string>; cwd: string; variant: LaunchVariant }

export function resolveLaunch(project: Project, settings: SettingsRepo, homeDir: string): ResolvedLaunch {
  const variant: LaunchVariant = project.firstLaunchedAt ? 'subsequent' : 'first';
  const template: LaunchCmd =
    project.config.launchCmd?.[variant] ??
    settings.get(variant === 'first' ? 'default_launch_cmd.first' : 'default_launch_cmd.subsequent');

  const ctx = {
    home: homeDir,
    projectPath: project.path,
    projectName: basename(project.path),
    env: { ...(project.config.env ?? {}), ...(template.env ?? {}) },
  };

  return {
    argv: interpolateArgv(template.argv, ctx),
    env: interpolateEnv({ ...(template.env ?? {}), ...(project.config.env ?? {}) }, ctx),
    cwd: project.config.cwdOverride ?? project.path,
    variant,
  };
}
