/** Async bounded POSIX process sampling for manually launched foreground Claude. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const CLAUDE = /(?:^|[/\\])claude(?:\.exe|\.cmd)?$/i;
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

function isForegroundClaude(
  rows: readonly ProcessRow[],
  byPid: ReadonlyMap<number, ProcessRow>,
  ptyPid: number,
): boolean {
  if (!byPid.has(ptyPid)) return false;
  for (const row of rows) {
    if (row.foreground <= 0 || row.group !== row.foreground || row.pid === ptyPid) continue;
    const argv0 = row.args.split(/\s/)[0] ?? '';
    if (!CLAUDE.test(row.command) && !CLAUDE.test(argv0)) continue;
    const seen = new Set<number>();
    let parent = row.parent;
    while (parent !== ptyPid && !seen.has(parent)) {
      seen.add(parent);
      parent = byPid.get(parent)?.parent ?? 0;
      if (parent === 0) break;
    }
    if (parent === ptyPid) return true;
  }
  return false;
}
/** Checks foreground process-group membership and ancestry beneath a current PTY leader. */
export function findForegroundClaude(snapshot: string, ptyPid: number): boolean {
  const rows = parseRows(snapshot);
  return isForegroundClaude(rows, new Map(rows.map((row) => [row.pid, row])), ptyPid);
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

  /** Returns false if process evidence is unavailable; never blocks the event loop. */
  async hasClaude(ptyPid: number): Promise<boolean> {
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
      return isForegroundClaude(rows, byPid, ptyPid);
    } catch {
      return false;
    }
  }
}
