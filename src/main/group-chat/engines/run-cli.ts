/**
 * Runs one headless CLI turn: spawn the CLI without a shell in the project folder, write the
 * message to stdin, feed stdout lines to the engine's progress reader, and parse the result when
 * the process ends. Never throws: a CLI that can't start, crashes, or is stopped resolves
 * `{ ok: false, error }`, so a group round always gets an answer.
 */
import { spawn, spawnSync } from 'node:child_process';
import type { Progress, TurnResult } from './types';

const STDERR_KEEP = 2048;

export function runCliTurn(o: {
  cmd: string[];
  args: string[];
  cwd: string;
  text: string;
  progress: Progress;
  parse: (p: Progress, code: number | null) => TurnResult;
  signal: AbortSignal;
  /** Extra environment for the child, on top of this process's. */
  env?: Record<string, string>;
}): Promise<TurnResult> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: TurnResult) => { if (!settled) { settled = true; resolve(r); } };
    if (o.signal.aborted) { done({ ok: false, reply: '', error: 'stopped' }); return; }

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(o.cmd[0]!, [...o.cmd.slice(1), ...o.args], {
        cwd: o.cwd,
        env: { ...process.env, ...o.env },
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        // Put the child in its own process group (POSIX) / own job
        // (Windows) so onAbort below can kill the WHOLE tree, not just
        // the direct child. A CLI that spawns helpers (wrappers, git
        // hooks, subshells) leaves grandchildren behind otherwise.
        detached: process.platform !== 'win32',
      });
    } catch (e) {
      done({ ok: false, reply: '', error: `couldn’t start ${o.cmd[0]}: ${(e as Error).message}` });
      return;
    }

    let pending = '';
    let stderr = '';
    const onAbort = () => { killTree(child.pid); done({ ok: false, reply: '', error: 'stopped' }); };
    o.signal.addEventListener('abort', onAbort, { once: true });

    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      const lines = (pending + chunk).split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const l of lines) if (l.trim()) o.progress.feed(l);
    });
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-STDERR_KEEP); });
    child.stdin!.on('error', () => { /* the CLI exited before reading its input; its exit says why */ });

    child.on('error', (e) => {
      o.signal.removeEventListener('abort', onAbort);
      done({ ok: false, reply: '', error: `couldn’t start ${o.cmd[0]}: ${e.message}` });
    });
    child.on('close', (code) => {
      o.signal.removeEventListener('abort', onAbort);
      if (pending.trim()) o.progress.feed(pending);
      const r = o.parse(o.progress, code);
      // a CLI that failed before printing any events usually said why on stderr
      if (!r.ok && /exited without an answer/.test(r.error ?? '') && stderr.trim()) {
        done({ ...r, error: stderr.trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 300) });
        return;
      }
      done(r);
    });

    child.stdin!.end(o.text);
  });
}

/**
 * Kill the child and every process it spawned. On POSIX the child was
 * started with `detached: true` so it's the leader of its own process
 * group; signalling the negative pid hits the whole group. On Windows
 * `taskkill /T /F` walks the tree by PID. We send SIGTERM first (so a
 * CLI that catches signals can clean up) then SIGKILL after a short
 * grace window so a stuck child can't outlive the abort.
 *
 * Any failure (process gone already, EPERM in a sandbox) is swallowed —
 * the abort path's job is to STOP work, and a best-effort kill does
 * that without crashing the main process.
 */
function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    try { spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }); } catch { /* best-effort */ }
    return;
  }
  try { process.kill(-pid, 'SIGTERM'); } catch { /* group gone */ }
  // Grace window before SIGKILL — short enough that an abort still
  // feels snappy to the human, long enough for a well-behaved CLI to
  // flush and exit on SIGTERM.
  setTimeout(() => {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* group gone */ }
  }, 250).unref();
}
