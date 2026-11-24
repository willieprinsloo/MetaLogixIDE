/**
 * `<projectRoot>/.metaide/` project convention. A folder each repo can
 * check into git so the IDE knows how to run it without any per-user setup.
 *
 * Files:
 *   .metaide/env                — dotenv-formatted env vars layered into
 *                                 every shell spawn (below user settings).
 *   .metaide/cli-profiles.json  — JSON array of CliProfile added to the
 *                                 "+ new shell" menu for this project.
 *
 * Read-only from the IDE's side: this module never writes these files —
 * humans edit them in the editor like any other project file.
 *
 * Writable `.metaide/` siblings (activity.jsonl) live next to these but
 * are owned by their own modules.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CliProfile } from '@shared/types';
import { envNameProblem, envValueProblem } from '@shared/project-env';

const ENV_FILE = '.metaide/env';
const PROFILES_FILE = '.metaide/cli-profiles.json';

/** Parsed contents of the two convention files; both are optional. */
export interface MetaIdeConf {
  /** Env overlay from `.metaide/env`, validated through the same rules settings use. */
  env: Record<string, string>;
  /** CLI profiles from `.metaide/cli-profiles.json`. */
  cliProfiles: CliProfile[];
}

export function readMetaIdeConf(projectPath: string): MetaIdeConf {
  return {
    env: readMetaIdeEnv(projectPath),
    cliProfiles: readMetaIdeCliProfiles(projectPath),
  };
}

export function readMetaIdeEnv(projectPath: string): Record<string, string> {
  const path = join(projectPath, ENV_FILE);
  if (!existsSync(path)) return {};
  try {
    return parseDotenv(readFileSync(path, 'utf8'));
  } catch (err) {
    console.warn('[metaide-conf] env read failed', { path, err });
    return {};
  }
}

export function readMetaIdeCliProfiles(projectPath: string): CliProfile[] {
  const path = join(projectPath, PROFILES_FILE);
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(raw)) return [];
    const out: CliProfile[] = [];
    for (const item of raw) {
      if (!isCliProfile(item)) continue;
      out.push({
        name: item.name,
        argv: [...item.argv],
        ...(item.env ? { env: { ...item.env } } : {}),
        ...(item.icon ? { icon: item.icon } : {}),
      });
    }
    return out;
  } catch (err) {
    console.warn('[metaide-conf] cli-profiles read failed', { path, err });
    return [];
  }
}

function isCliProfile(v: unknown): v is CliProfile {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  if (typeof r.name !== 'string' || r.name.length === 0) return false;
  if (!Array.isArray(r.argv) || r.argv.length === 0) return false;
  if (!r.argv.every((a) => typeof a === 'string')) return false;
  if (r.env !== undefined) {
    if (!r.env || typeof r.env !== 'object' || Array.isArray(r.env)) return false;
    for (const [k, val] of Object.entries(r.env as Record<string, unknown>)) {
      if (typeof val !== 'string') return false;
      if (typeof k !== 'string' || k.length === 0) return false;
    }
  }
  if (r.icon !== undefined && typeof r.icon !== 'string') return false;
  return true;
}

/**
 * Minimal dotenv parser: `KEY=VALUE` per line, `#` comments, quoted values.
 * Deliberately NOT a full dotenv replica — no variable expansion, no multi-
 * line values. If someone needs that, they can use the user-settings env.
 */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const name = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (envNameProblem(name) !== null || envValueProblem(value) !== null) continue;
    out[name] = value;
  }
  return out;
}
