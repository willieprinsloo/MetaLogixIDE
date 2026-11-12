import { describe, it, expect, vi } from 'vitest';
import { PtyManager } from '@main/pty/manager';
import type { ResolvedLaunch } from '@main/domain/launch';
import { resolve } from 'node:path';

const MOCK = resolve(__dirname, '../../../../scripts/mock-claude.mjs');

function launch(extraArgs: string[] = []) {
  return { argv: ['node', MOCK, ...extraArgs], env: {}, cwd: process.cwd(), variant: 'first' as const };
}

const PRINT_SIZE = 'process.stdout.write(`SIZE=${process.stdout.columns}x${process.stdout.rows}\\n`); setTimeout(() => {}, 500)';

function sizeLaunch() {
  return { argv: ['node', '-e', PRINT_SIZE], env: {}, cwd: process.cwd(), variant: 'first' as const };
}

async function untilData(mgr: PtyManager, projectId: number, match: string, timeoutMs = 3000): Promise<string> {
  let buf = '';
  return new Promise((resolveP, rejectP) => {
    const timer = setTimeout(() => rejectP(new Error(`timeout waiting for ${match}; got ${buf}`)), timeoutMs);
    mgr.on('data', ({ projectId: pid, data }) => {
      if (pid !== projectId) return;
      buf += data;
      if (buf.includes(match)) { clearTimeout(timer); resolveP(buf); }
    });
  });
}

describe('PtyManager', () => {
  it('spawns a PTY and receives initial banner', async () => {
    const mgr = new PtyManager();
    const p = untilData(mgr, 1, 'mock-claude ready');
    await mgr.spawn(1, 0, launch());
    await p;
    expect(mgr.isAlive(1, 0)).toBe(true);
    await mgr.kill(1, 0);
  });

  it('write echoes back through data event', async () => {
    const mgr = new PtyManager();
    await mgr.spawn(2, 0, launch());
    // Wait for initial banner.
    await untilData(mgr, 2, '> ');
    const p = untilData(mgr, 2, 'echo: hello');
    mgr.write(2, 0, 'hello\n');
    await p;
    await mgr.kill(2, 0);
  });

  it('write emits input with the shell identity and the exact data, after writing it to the PTY', async () => {
    const mgr = new PtyManager();
    await mgr.spawn(20, 1, launch());
    await untilData(mgr, 20, '> ');
    const inputs: unknown[] = [];
    mgr.on('input', (ev) => inputs.push(ev));
    const echoed = untilData(mgr, 20, 'echo: yes');
    mgr.write(20, 1, 'yes\r');
    mgr.write(20, 1, '\x1b[A');
    expect(inputs).toEqual([
      { projectId: 20, shellIndex: 1, data: 'yes\r' },
      { projectId: 20, shellIndex: 1, data: '\x1b[A' },
    ]);
    await echoed;
    await mgr.kill(20, 1);
  });

  it('write to a shell that is not alive emits no input', async () => {
    const mgr = new PtyManager();
    await mgr.spawn(21, 0, launch());
    await mgr.kill(21, 0);
    const inputs: unknown[] = [];
    mgr.on('input', (ev) => inputs.push(ev));
    mgr.write(21, 0, '\r');
    mgr.write(99, 0, '\r');
    expect(inputs).toEqual([]);
  });

  it('kill removes the entry from list', async () => {
    const mgr = new PtyManager();
    await mgr.spawn(3, 0, launch());
    await mgr.kill(3, 0);
    expect(mgr.list().find(s => s.projectId === 3)).toBeUndefined();
  });

  it('stops only the inspected generation and never signals a replacement', async () => {
    const mgr = new PtyManager();
    await mgr.spawn(35, 0, launch());
    const oldGeneration = mgr.liveShell(35, 0)?.generation;
    expect(oldGeneration).toEqual(expect.any(String));
    await mgr.kill(35, 0);
    expect(mgr.stopIfGeneration(35, oldGeneration ?? '')).toBe('gone');
    await mgr.spawn(35, 0, launch());
    const replacement = mgr.liveShell(35, 0)?.generation;
    expect(replacement).not.toBe(oldGeneration);
    expect(mgr.stopIfGeneration(35, oldGeneration ?? '')).toBe('replaced');
    expect(mgr.liveShell(35, 0)?.generation).toBe(replacement);
    await mgr.spawn(36, 0, launch());
    expect(mgr.stopIfGeneration(35, replacement ?? '')).toBe('stopped');
    expect(mgr.liveShell(35, 0)).toBeNull();
    expect(mgr.liveShell(36, 0)).not.toBeNull();
    await mgr.kill(36, 0);
  });

  it('preserves a replacement spawned during synchronous stop signalling', async () => {
    const mgr = new PtyManager();
    await mgr.spawn(37, 0, launch());
    await untilData(mgr, 37, '> ');
    const inspected = mgr.liveShell(37, 0)?.generation;
    const entry = mgr['entries'].get('37:0');
    expect(entry).toBeDefined();
    const oldExit = new Promise<void>((resolveExit) => entry?.pty.onExit(() => resolveExit()));
    const exitEvents: unknown[] = [];
    mgr.on('exit', (event) => exitEvents.push(event));
    entry?.pending.push('replacement-during-stop');
    const replacementSpawns: Array<Promise<{ pid: number }>> = [];
    mgr.on('data', ({ projectId, data }) => {
      if (projectId !== 37 || !data.includes('replacement-during-stop')) return;
      void mgr.kill(37, 0);
      replacementSpawns.push(mgr.spawn(37, 0, launch()));
    });
    expect(mgr.stopIfGeneration(37, inspected ?? '')).toBe('replaced');
    expect(replacementSpawns).toHaveLength(1);
    await Promise.all(replacementSpawns);
    const replacement = mgr.liveShell(37, 0)?.generation;
    expect(replacement).not.toBe(inspected);
    expect(mgr.stopIfGeneration(37, inspected ?? '')).toBe('replaced');
    expect(mgr.liveShell(37, 0)?.generation).toBe(replacement);
    await oldExit;
    expect(exitEvents).toEqual([
      expect.objectContaining({ projectId: 37, shellIndex: 0, generation: inspected }),
    ]);
    expect(mgr.liveShell(37, 0)?.generation).toBe(replacement);
    await mgr.kill(37, 0);
  });

  it('does not report a successful stop when the old PTY exits during flushing', async () => {
    const mgr = new PtyManager();
    await mgr.spawn(38, 0, launch());
    await untilData(mgr, 38, '> ');
    const generation = mgr.liveShell(38, 0)?.generation;
    const entry = mgr['entries'].get('38:0');
    expect(entry).toBeDefined();
    entry?.pending.push('old-exits-during-stop');
    mgr.on('data', ({ projectId, data }) => {
      if (projectId === 38 && data.includes('old-exits-during-stop'))
        void mgr.kill(38, 0);
    });
    expect(mgr.stopIfGeneration(38, generation ?? '')).toBe('gone');
    expect(mgr.liveShell(38, 0)).toBeNull();
  });

  it('retains the primary PTY for retry if neither termination signal can be delivered', async () => {
    const mgr = new PtyManager();
    await mgr.spawn(39, 0, launch());
    const generation = mgr.liveShell(39, 0)?.generation;
    const entry = mgr['entries'].get('39:0');
    if (!entry) throw new Error('missing test PTY');
    const groupKill = vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('group denied'); });
    const ptyKill = vi.spyOn(entry.pty, 'kill').mockImplementation(() => { throw new Error('pty denied'); });
    try {
      expect(() => mgr.stopIfGeneration(39, generation ?? '')).toThrow('unable to signal primary shell');
      expect(mgr.liveShell(39, 0)?.generation).toBe(generation);
    } finally {
      groupKill.mockRestore();
      ptyKill.mockRestore();
      await mgr.kill(39, 0);
    }
  });

  it('clears announced ports when the process exits', async () => {
    const mgr = new PtyManager();
    const events: Array<{ projectId: number; shellIndex: number; ports: number[] }> = [];
    mgr.on('ports', (event) => events.push(event));
    const exited = new Promise<void>((resolveExit) => mgr.once('exit', () => resolveExit()));

    await mgr.spawn(30, 2, {
      argv: ['node', '-e', 'process.stdout.write("http://localhost:4321\\n")'],
      env: {},
      cwd: process.cwd(),
      variant: 'first',
    });
    await exited;

    expect(events).toEqual([
      { projectId: 30, shellIndex: 2, ports: [4321] },
      { projectId: 30, shellIndex: 2, ports: [] },
    ]);
  });

  it('clears announced ports when Ctrl+C ends a server but leaves the shell alive', async () => {
    const mgr = new PtyManager();
    const announced = new Promise<void>((resolveAnnounced) => {
      mgr.on('ports', ({ ports }: { ports: number[] }) => {
        if (ports.includes(4322)) resolveAnnounced();
      });
    });

    await mgr.spawn(31, 0, {
      argv: [
        'node',
        '-e',
        'process.on("SIGINT",()=>{});process.stdin.resume();process.stdout.write("http://localhost:4322\\n")',
      ],
      env: {},
      cwd: process.cwd(),
      variant: 'first',
    });
    await announced;
    const cleared = new Promise<void>((resolveCleared) => {
      mgr.on('ports', ({ ports }: { ports: number[] }) => {
        if (ports.length === 0) resolveCleared();
      });
    });

    mgr.write(31, 0, '\x03');
    await cleared;

    expect(mgr.isAlive(31, 0)).toBe(true);
    await mgr.kill(31, 0);
  });

  it('rejects duplicate spawn for same (project, index)', async () => {
    const mgr = new PtyManager();
    await mgr.spawn(4, 0, launch());
    await expect(mgr.spawn(4, 0, launch())).rejects.toThrow();
    await mgr.kill(4, 0);
  });
  it('spawns at the size requested by a resize that arrived before the PTY existed', async () => {
    const mgr = new PtyManager();
    mgr.resize(5, 0, 180, 50);
    const p = untilData(mgr, 5, '\n');
    await mgr.spawn(5, 0, sizeLaunch());
    const out = await p;
    await mgr.kill(5, 0);
    expect(out).toContain('SIZE=180x50');
    expect(out).not.toContain('SIZE=100x30');
  });

  it('respawns at the last requested size after the previous PTY was killed', async () => {
    const mgr = new PtyManager();
    await mgr.spawn(6, 0, launch());
    mgr.resize(6, 0, 150, 40);
    await mgr.kill(6, 0);
    const p = untilData(mgr, 6, '\n');
    await mgr.spawn(6, 0, sizeLaunch());
    const out = await p;
    await mgr.kill(6, 0);
    expect(out).toContain('SIZE=150x40');
  });

  it('keeps sizes per shell so one shell\'s resize does not size another', async () => {
    const mgr = new PtyManager();
    mgr.resize(7, 1, 180, 50);
    const p = untilData(mgr, 7, '\n');
    await mgr.spawn(7, 0, sizeLaunch());
    const out = await p;
    await mgr.kill(7, 0);
    expect(out).toContain('SIZE=100x30');
  });
});

describe('PtyManager live status port', () => {
  it('returns generation-scoped spawn identity and a live status sample only while shell lives', async () => {
    const mgr = new PtyManager();
    expect(mgr.liveShell(72, 0)).toBeNull();
    expect(await mgr.liveStatus(72, 0)).toEqual({ rows: [], title: '' });
    const arrived = untilData(mgr, 72, 'SIZE=');
    const spawned = await mgr.spawn(72, 0, sizeLaunch(), 80, 6);
    await arrived;
    const live = mgr.liveShell(72, 0);
    expect(live).toMatchObject({ pid: spawned.pid, agent: null });
    expect(live?.generation).toEqual(expect.any(String));
    await vi.waitFor(async () => {
      expect((await mgr.liveStatus(72, 0)).rows.join('\n')).toContain('SIZE=');
    }, { timeout: 400, interval: 10 });
    await mgr.kill(72, 0);
    expect(mgr.liveShell(72, 0)).toBeNull();
    expect(await mgr.liveStatus(72, 0)).toEqual({ rows: [], title: '' });
  });
});

const PRINT_PROBE = 'process.stdout.write(`PROBE=${process.env.HOOK_PROBE ?? "unset"} ARG=${process.argv[1] ?? "none"}\\n`); setTimeout(() => {}, 500)';

function probeLaunch(env: Record<string, string> = {}) {
  return { argv: ['node', '-e', PRINT_PROBE], env, cwd: process.cwd(), variant: 'first' as const };
}

describe('PtyManager — spawnDecorator (AC8)', () => {
  it('spawns what the decorator returns, called with the shell identity, without touching the caller launch', async () => {
    const decorator = vi.fn((_p: number, _s: number, l: ResolvedLaunch) => ({ ...l, argv: [...l.argv, 'injected-arg'], env: { ...l.env, HOOK_PROBE: 'injected' } }));
    const mgr = new PtyManager({ spawnDecorator: decorator });
    const launch = probeLaunch({ OTHER: '1' });
    const before = structuredClone(launch);
    const p = untilData(mgr, 20, '\n');
    await mgr.spawn(20, 3, launch);
    const out = await p;
    await mgr.kill(20, 3);
    expect(out).toContain('PROBE=injected ARG=injected-arg');
    expect(decorator).toHaveBeenCalledWith(20, 3, launch);
    expect(launch).toEqual(before);
  });

  it('without a decorator the launch env spawns as given', async () => {
    const mgr = new PtyManager();
    const p = untilData(mgr, 21, '\n');
    await mgr.spawn(21, 0, probeLaunch({ HOOK_PROBE: 'plain' }));
    const out = await p;
    await mgr.kill(21, 0);
    expect(out).toContain('PROBE=plain ARG=none');
  });

  it('does not decorate a duplicate spawn it rejects', async () => {
    const decorator = vi.fn((_p: number, _s: number, l: ResolvedLaunch) => l);
    const mgr = new PtyManager({ spawnDecorator: decorator });
    await mgr.spawn(22, 0, launch());
    await expect(mgr.spawn(22, 0, launch())).rejects.toThrow();
    await mgr.kill(22, 0);
    expect(decorator).toHaveBeenCalledTimes(1);
  });
});
