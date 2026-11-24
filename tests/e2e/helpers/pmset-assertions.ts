/**
 * Read-only view of `pmset -g assertions` for the keep-awake E2E.
 * Only ever runs `/usr/bin/pmset -g assertions`; never `displaysleepnow` or any state-changing verb.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface PmsetAssertion {
  pid: number;
  /** Process name in parentheses, e.g. `Electron`. */
  process: string;
  /** Assertion type token, e.g. `NoIdleSleepAssertion`. */
  type: string;
  /** Text between the quotes after `named:`, '' when absent. */
  name: string;
}

/** Types that keep the system from idle sleep (the keep-awake assertion; AC4). */
export const IDLE_SYSTEM_SLEEP_TYPES: readonly string[] = ['NoIdleSleepAssertion', 'PreventUserIdleSystemSleep'];
/** Types that would keep the display awake; keep-awake must never hold one (AC4). */
export const DISPLAY_SLEEP_TYPES: readonly string[] = ['PreventUserIdleDisplaySleep', 'NoDisplaySleepAssertion'];

// `   pid 123(Electron): [0x0001] 00:00:05 NoIdleSleepAssertion named: "Electron"`
// Tolerant: the id/duration tokens between `:` and the type are skipped, `named:` is optional.
const LINE = /^\s*pid\s+(\d+)\(([^)]*)\):\s+(?:\[[^\]]*\]\s+)?(?:\d+:\d+(?::\d+)?\s+)?(\w+)(?:\s+named:\s*"(.*)")?/;

/** Parses the "Listed by owning process" section; ignores the system-wide summary and detail lines. */
export function parsePmsetAssertions(output: string): PmsetAssertion[] {
  const out: PmsetAssertion[] = [];
  for (const line of output.split('\n')) {
    const m = LINE.exec(line);
    if (m) out.push({ pid: Number(m[1]), process: m[2]!, type: m[3]!, name: m[4] ?? '' });
  }
  return out;
}

export async function readAssertions(): Promise<PmsetAssertion[]> {
  const { stdout } = await execFileAsync('/usr/bin/pmset', ['-g', 'assertions'], { timeout: 5000 });
  return parsePmsetAssertions(stdout);
}

export async function assertionsFor(pid: number): Promise<PmsetAssertion[]> {
  return (await readAssertions()).filter((a) => a.pid === pid);
}

export async function idleSleepCount(pid: number): Promise<number> {
  return (await assertionsFor(pid)).filter((a) => IDLE_SYSTEM_SLEEP_TYPES.includes(a.type)).length;
}

export async function displaySleepCount(pid: number): Promise<number> {
  return (await assertionsFor(pid)).filter((a) => DISPLAY_SLEEP_TYPES.includes(a.type)).length;
}
