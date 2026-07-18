import { EventEmitter } from 'node:events';
import type { IPty } from 'node-pty';
import { spawn as ptySpawn } from 'node-pty';
import type { ResolvedLaunch } from '@main/domain/launch';

interface Entry {
  projectId: number; shellIndex: number;
  pty: IPty; pid: number;
  cols: number; rows: number;
  startedAt: number;
}

const key = (p: number, s: number) => `${p}:${s}`;

export class PtyManager extends EventEmitter {
  private entries = new Map<string, Entry>();

  async spawn(projectId: number, shellIndex: number, launch: ResolvedLaunch, cols = 100, rows = 30): Promise<{ pid: number }> {
    const k = key(projectId, shellIndex);
    if (this.entries.has(k)) throw new Error(`already spawned: ${k}`);
    const [command, ...args] = launch.argv;
    if (!command) throw new Error('empty argv');
    const pty = ptySpawn(command, args, {
      name: 'xterm-256color',
      cols, rows,
      cwd: launch.cwd,
      env: { ...process.env, ...launch.env } as { [k: string]: string },
    });
    const entry: Entry = { projectId, shellIndex, pty, pid: pty.pid, cols, rows, startedAt: Date.now() };
    this.entries.set(k, entry);
    pty.onData((data: string) => this.emit('data', { projectId, shellIndex, data }));
    pty.onExit(({ exitCode }: { exitCode: number }) => {
      this.entries.delete(k);
      this.emit('exit', { projectId, shellIndex, code: exitCode });
    });
    return { pid: pty.pid };
  }

  write(projectId: number, shellIndex: number, data: string): void {
    const e = this.entries.get(key(projectId, shellIndex));
    if (!e) return;
    e.pty.write(data);
  }

  resize(projectId: number, shellIndex: number, cols: number, rows: number): void {
    const e = this.entries.get(key(projectId, shellIndex));
    if (!e) return;
    e.pty.resize(cols, rows);
    e.cols = cols; e.rows = rows;
  }

  async kill(projectId: number, shellIndex: number): Promise<void> {
    const e = this.entries.get(key(projectId, shellIndex));
    if (!e) return;
    e.pty.kill();
    this.entries.delete(key(projectId, shellIndex));
  }

  isAlive(projectId: number, shellIndex: number): boolean {
    return this.entries.has(key(projectId, shellIndex));
  }

  list(): Array<{ projectId: number; shellIndex: number; pid: number; cols: number; rows: number; startedAt: number }> {
    return [...this.entries.values()].map(e => ({
      projectId: e.projectId, shellIndex: e.shellIndex, pid: e.pid, cols: e.cols, rows: e.rows, startedAt: e.startedAt,
    }));
  }
}
