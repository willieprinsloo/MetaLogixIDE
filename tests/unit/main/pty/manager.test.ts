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
