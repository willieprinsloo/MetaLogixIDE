import { describe, it, expect } from 'vitest';
import { PtyManager } from '@main/pty/manager';
import { resolve } from 'node:path';

const MOCK = resolve(__dirname, '../../../../scripts/mock-claude.mjs');

function launch(extra: string[] = []) {
  return { argv: ['node', MOCK, ...extra], env: {}, cwd: process.cwd(), variant: 'first' as const };
}

async function waitForExit(mgr: PtyManager, projectId: number, timeoutMs = 5000): Promise<{ code: number | null; uptimeMs: number; earlyOutput: string }> {
  return new Promise((resolveP, rejectP) => {
    const timer = setTimeout(() => rejectP(new Error(`no exit within ${timeoutMs}ms`)), timeoutMs);
    mgr.on('exit', (ev: { projectId: number; code: number | null; uptimeMs?: number; earlyOutput?: string }) => {
      if (ev.projectId !== projectId) return;
      clearTimeout(timer);
      resolveP({ code: ev.code, uptimeMs: ev.uptimeMs ?? 0, earlyOutput: ev.earlyOutput ?? '' });
    });
  });
}

async function waitForOutput(mgr: PtyManager, projectId: number, needle: string, timeoutMs = 3000): Promise<void> {
  return new Promise((resolveP, rejectP) => {
    let buf = '';
    const timer = setTimeout(() => rejectP(new Error(`didn't see "${needle}" in ${timeoutMs}ms; got: ${buf}`)), timeoutMs);
    mgr.on('data', (ev: { projectId: number; data: string }) => {
      if (ev.projectId !== projectId) return;
      buf += ev.data;
      if (buf.includes(needle)) { clearTimeout(timer); resolveP(); }
    });
  });
}

describe('PtyManager earlyBuffer', () => {
  it('captures initial output into earlyBuffer', async () => {
    const mgr = new PtyManager();
    await mgr.spawn(101, 0, launch());
    await waitForOutput(mgr, 101, 'mock-claude ready');
    // Buffer should contain the banner while still within the 3s window.
    expect(mgr.getEarlyBuffer(101, 0)).toContain('mock-claude ready');
    await mgr.kill(101, 0);
  });

  it('emits uptimeMs and earlyOutput on exit', async () => {
    const mgr = new PtyManager();
    const exitP = waitForExit(mgr, 102);
    await mgr.spawn(102, 0, launch());
    await waitForOutput(mgr, 102, 'mock-claude ready');
    mgr.write(102, 0, '/quit\n');
    const ev = await exitP;
    expect(ev.uptimeMs).toBeGreaterThan(0);
    expect(ev.uptimeMs).toBeLessThan(5000);
    expect(ev.earlyOutput).toContain('mock-claude');
  });

  it('getEarlyBuffer is empty for unknown shells', () => {
    const mgr = new PtyManager();
    expect(mgr.getEarlyBuffer(999, 0)).toBe('');
  });

  it('scrollback accumulates and is queryable', async () => {
    const mgr = new PtyManager();
    await mgr.spawn(201, 0, launch());
    await waitForOutput(mgr, 201, 'mock-claude ready');
    expect(mgr.getScrollback(201, 0)).toContain('mock-claude ready');
    mgr.write(201, 0, 'first\n');
    await waitForOutput(mgr, 201, 'echo: first');
    mgr.write(201, 0, 'second\n');
    await waitForOutput(mgr, 201, 'echo: second');
    const sb = mgr.getScrollback(201, 0);
    expect(sb).toContain('echo: first');
    expect(sb).toContain('echo: second');
    await mgr.kill(201, 0);
  });

  it('getScrollback is empty for unknown shells', () => {
    const mgr = new PtyManager();
    expect(mgr.getScrollback(999, 0)).toBe('');
  });
});

describe('--continue fallback detection', () => {
  const PATTERN = /no conversation found to continue|no previous session|--continue.*(?:no|not)/i;

  it('matches the exact Claude Code error message', () => {
    expect(PATTERN.test('Error: No conversation found to continue.')).toBe(true);
    expect(PATTERN.test('No conversation found to continue')).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(PATTERN.test('NO CONVERSATION FOUND TO CONTINUE')).toBe(true);
    expect(PATTERN.test('no conversation FOUND to continue')).toBe(true);
  });

  it('matches variant "no previous session"', () => {
    expect(PATTERN.test('there is no previous session in this project')).toBe(true);
  });

  it('does not match normal Claude output', () => {
    expect(PATTERN.test('Welcome to Claude Code v2.1.112')).toBe(false);
    expect(PATTERN.test('Continuing conversation from earlier')).toBe(false);
    expect(PATTERN.test('mock-claude ready\n> ')).toBe(false);
  });
});
