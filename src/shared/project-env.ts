/**
 * Name and value rules for project and app-wide environment variables. One
 * source of truth for both editors (inline row reasons) and the
 * `projects:update-config` and `settings:set-app-env` IPC boundaries (reject
 * before write).
 */

/** Names with this prefix (case-insensitive) are reserved for the app's own variables. */
export const RESERVED_ENV_PREFIX = 'METAIDE_';
export const MAX_ENV_NAME_LENGTH = 255;
/** Exact-case name that plain-object assignment would silently swallow. */
const PROTO_NAME = '__proto__';

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type EnvNameProblem = 'invalid' | 'too-long' | 'reserved';
export type EnvValueProblem = 'nul';

/** Why `name` cannot be a project variable name, or null when it can. */
export function envNameProblem(name: string): EnvNameProblem | null {
  if (name.length > MAX_ENV_NAME_LENGTH) return 'too-long';
  if (!ENV_NAME.test(name)) return 'invalid';
  if (name === PROTO_NAME || name.toUpperCase().startsWith(RESERVED_ENV_PREFIX)) return 'reserved';
  return null;
}

/** Why `value` cannot be a project variable value, or null when it can. */
export function envValueProblem(value: string): EnvValueProblem | null {
  return value.includes('\0') ? 'nul' : null;
}

export type ProjectEnvParse =
  | { ok: true; env: Record<string, string> }
  /** `error` names the offending key, never a value. */
  | { ok: false; error: string };

/** Which env map is being validated; only drives the wording of a rejection message. */
export type EnvScope = 'project' | 'app';

const SCOPE_LABEL: Record<EnvScope, string> = { project: 'Project', app: 'App' };

/**
 * Validates an untrusted env map as received over IPC, for either the
 * per-project scope or the app-wide scope. Same name/value rules in both
 * scopes; only the error wording differs.
 */
export function parseEnvMap(input: unknown, scope: EnvScope): ProjectEnvParse {
  const label = SCOPE_LABEL[scope];
  if (!isPlainObject(input))
    return { ok: false, error: `${label} environment must be an object of name/value strings` };
  const entries = Object.entries(input);
  for (const [name, value] of entries) {
    const problem = entryProblem(name, value);
    if (problem)
      return {
        ok: false,
        error: `Invalid ${label.toLowerCase()} environment variable "${name}": ${problem}`,
      };
  }
  return { ok: true, env: Object.fromEntries(entries) as Record<string, string> };
}

/** Validates an untrusted project env map as received over IPC. */
export function parseProjectEnv(input: unknown): ProjectEnvParse {
  return parseEnvMap(input, 'project');
}

/** Validates an untrusted app-wide env map as received over IPC. */
export function parseAppEnv(input: unknown): ProjectEnvParse {
  return parseEnvMap(input, 'app');
}

function isPlainObject(input: unknown): input is Record<string, unknown> {
  if (typeof input !== 'object' || input === null) return false;
  const proto: unknown = Object.getPrototypeOf(input);
  return proto === Object.prototype || proto === null;
}

function entryProblem(name: string, value: unknown): string | null {
  if (typeof value !== 'string') return 'value must be a string';
  return envNameProblem(name) ?? envValueProblem(value);
}
