import { describe, it, expect } from 'vitest';
import { PtyManager } from '@main/pty/manager';
import { resolve } from 'node:path';

const MOCK = resolve(__dirname, '../../../../scripts/mock-claude.mjs');

function launch(extraArgs: string[] = []) {
  return { argv: ['node', MOCK, ...extraArgs], env: {}, cwd: process.cwd(), variant: 'first' as const };
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
});
