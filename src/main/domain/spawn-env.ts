import { basename } from 'node:path';
import type { Project } from '@shared/types';
import { interpolateEnv } from '@shared/interpolate';
import { envNameProblem, envValueProblem } from '@shared/project-env';

/**
 * Inputs for computing a spawn's environment. Precedence, lowest to highest:
 * inherited < app-wide variables < template env < project variables; hook
 * variables are layered on later by the Claude launch decorator.
 */
export interface SpawnEnvInput {
  project: Pick<Project, 'path' | 'config'>;
  /** Final form; not interpolated here. */
  templateEnv: Record<string, string>;
  /** The main process environment at spawn time; never read from `process.env` inside the domain. */
  inherited: Readonly<Record<string, string | undefined>>;
  homeDir: string;
  /** Stored app-wide variables, before validation or interpolation. Required so the compiler finds every caller. */
  appEnv: Record<string, string>;
}

export interface SpawnEnv {
  /** Overlay for `PtyManager.spawn`: interpolated app-wide variables ⊕ template env ⊕ interpolated project variables. */
  env: Record<string, string>;
  /** inherited ⊕ env — the lookup for `${env.NAME}` in template argv (AC13). */
  lookup: Record<string, string>;
}

/**
 * Computes the overlay env and the argv lookup for one spawn. Precedence is
 * app-wide < template < project. App values are interpolated against the
 * inherited env only (an app value cannot reference another app value);
 * project values are interpolated in a single pass against inherited ⊕
 * interpolated app ⊕ template, so `${env.PATH}` extends the inherited PATH
 * and one project var never sees another. Stored entries that fail the
 * shared name/value rules are dropped, in both the app and project maps.
 */
export function resolveSpawnEnv(input: SpawnEnvInput): SpawnEnv {
  const inherited = definedOnly(input.inherited);
  const paths = {
    home: input.homeDir,
    projectPath: input.project.path,
    projectName: basename(input.project.path),
  };
  const app = interpolateEnv(validVars(input.appEnv), { ...paths, env: inherited });
  const project = interpolateEnv(validVars(input.project.config.env), {
    ...paths,
    env: { ...inherited, ...app, ...input.templateEnv },
  });
  const env = { ...app, ...input.templateEnv, ...project };
  return { env, lookup: { ...inherited, ...env } };
}

function definedOnly(source: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) if (value !== undefined) out[name] = value;
  return out;
}

function validVars(stored: Record<string, string> | undefined): Record<string, string> {
  const entries = Object.entries(stored ?? {}).filter(([name, value]) => isValidEntry(name, value));
  return Object.fromEntries(entries);
}

function isValidEntry(name: string, value: unknown): boolean {
  return (
    typeof value === 'string' && envNameProblem(name) === null && envValueProblem(value) === null
  );
}
