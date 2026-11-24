/** Async bounded POSIX process sampling for agent harnesses (Claude, Codex, opencode) started by hand in a shell. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { harnessOf, type AgentHarness } from '@shared/agent-harness';

const exec = promisify(execFile);
interface ProcessRow {
  readonly pid: number;
  readonly parent: number;
  readonly group: number;
  readonly foreground: number;
  readonly command: string;
  readonly args: string;
}

function parseRows(text: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of text.slice(0, 256_000).split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      parent: Number(match[2]),
      group: Number(match[3]),
      foreground: Number(match[4]),
      command: match[5] ?? '',
      args: match[6] ?? '',
    });
  }
  return rows;
}

/** The harness a foreground process runs, by its executable name or argv[0]. */
function rowHarness(row: ProcessRow): AgentHarness | null {
  return harnessOf([row.command]) ?? harnessOf([row.args.split(/\s/)[0] ?? '']);
}

function foregroundHarness(
  rows: readonly ProcessRow[],
  byPid: ReadonlyMap<number, ProcessRow>,
  ptyPid: number,
): AgentHarness | null {
  if (!byPid.has(ptyPid)) return null;
  for (const row of rows) {
    if (row.foreground <= 0 || row.group !== row.foreground || row.pid === ptyPid) continue;
    const harness = rowHarness(row);
    if (!harness) continue;
    const seen = new Set<number>();
    let parent = row.parent;
    while (parent !== ptyPid && !seen.has(parent)) {
      seen.add(parent);
      parent = byPid.get(parent)?.parent ?? 0;
      if (parent === 0) break;
    }
    if (parent === ptyPid) return harness;
  }
  return null;
}
/** Checks foreground process-group membership and ancestry beneath a current PTY leader. */
export function findForegroundHarness(snapshot: string, ptyPid: number): AgentHarness | null {
  const rows = parseRows(snapshot);
  return foregroundHarness(rows, new Map(rows.map((row) => [row.pid, row])), ptyPid);
}

/** True when the PTY's foreground job is Claude. */
export function findForegroundClaude(snapshot: string, ptyPid: number): boolean {
  return findForegroundHarness(snapshot, ptyPid) === 'claude';
}

/** Runs one bounded non-shell `ps` query per concurrent sampling interval. */
export class PosixForegroundObserver {
  private pending: Promise<{ rows: ProcessRow[]; byPid: Map<number, ProcessRow> }> | null = null;

  constructor(
    private readonly sample: () => Promise<string> = async () => {
      const { stdout } = await exec('ps', ['-axo', 'pid=,ppid=,pgid=,tpgid=,comm=,args='], {
        timeout: 750,
        maxBuffer: 256_000,
      });
      return stdout;
    },
  ) {}

  /** True when the foreground job is Claude; false if process evidence is unavailable. */
  async hasClaude(ptyPid: number): Promise<boolean> {
    return (await this.harness(ptyPid)) === 'claude';
  }

  /** The harness running as the PTY's foreground job, or null (also when evidence is unavailable); never blocks the event loop. */
  async harness(ptyPid: number): Promise<AgentHarness | null> {
    this.pending ??= this.sample()
      .then((text) => {
        const rows = parseRows(text);
        return { rows, byPid: new Map(rows.map((row) => [row.pid, row])) };
      })
      .finally(() => {
        this.pending = null;
      });
    try {
      const { rows, byPid } = await this.pending;
      return foregroundHarness(rows, byPid, ptyPid);
    } catch {
      return null;
    }
  }
}
