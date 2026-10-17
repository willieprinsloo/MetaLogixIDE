/**
 * Guard: every IPC handler that spawns, kills, removes or records a shell
 * must list 'alive-shells:changed' in CHANNEL_EMITS, or tab strips and the
 * alive-shells list go stale (tasks:run shipped without it, fixed 7dc1668).
 * The handler set is discovered by scanning register.ts, so a handler added
 * later is covered without editing this file.
 */
import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { CHANNEL_EMITS } from '@main/ipc/register';
import { readSource, scanHandlerMap, srcResolver, type ModuleResolver } from './shell-mutation-scan';

const srcRoot = resolve(__dirname, '../../../../src');
const registerFile = resolve(srcRoot, 'main/ipc/register.ts');

function scanSynthetic(files: Record<string, string>, resolveModule: ModuleResolver = (s) => s) {
  const read = (f: string): string => {
    const text = files[f];
    if (text === undefined) throw new Error(`no synthetic file ${f}`);
    return text;
  };
  return scanHandlerMap('main.ts', 'handlers', read, resolveModule);
}

describe('shell mutation scanner', () => {
  it('flags each direct shell mutation and nothing else', () => {
    const scan = scanSynthetic({
      'main.ts': `
        const handlers = {
          'a:spawn': async (s) => { await s.ptyManager.spawn(1, 0, {}); },
          'a:kill': async (s) => { await s.ptyManager.kill(1, 0); },
          'a:upsert': async (s) => { s.shells.upsert({}); },
          'a:remove': async (s) => { s.shells?.remove(1, 0); },
          'a:write': async (s) => { s.ptyManager.write(1, 0, 'x'); s.shells.touch(1, 0); },
          'a:other-upsert': async (s) => { s.projects.upsert(1); s.projects.remove(1); },
        };`,
    });
    expect(scan.channels).toEqual(['a:spawn', 'a:kill', 'a:upsert', 'a:remove', 'a:write', 'a:other-upsert']);
    expect(scan.mutating).toEqual(['a:spawn', 'a:kill', 'a:upsert', 'a:remove']);
  });

  it('follows same-file helpers transitively, including function references', () => {
    const scan = scanSynthetic({
      'main.ts': `
        function evict(s) { s.shells.remove(1, 0); }
        const makeRoom = (s) => evict(s);
        function harmless() { return 1; }
        const handlers = {
          'b:indirect': async (s) => { makeRoom(s); },
          'b:callback': async (s, r) => { r.list.forEach(evict); },
          'b:pure': async () => harmless(),
        };`,
    });
    expect(scan.mutating).toEqual(['b:indirect', 'b:callback']);
  });

  it('follows spreads into same-file constants and imported modules', () => {
    const scan = scanSynthetic({
      'main.ts': `
        import { moreHandlers } from 'other.ts';
        const local = { 'c:local': async (s) => { await s.ptyManager.kill(1, 0); } };
        const handlers = { ...local, ...moreHandlers };`,
      'other.ts': `
        function start(s) { return s.ptyManager.spawn(1, 0, {}); }
        export const moreHandlers = {
          'c:imported': async (s) => start(s),
          'c:quiet': async () => ({}),
        } satisfies object;`,
    });
    expect(scan.channels).toEqual(['c:local', 'c:imported', 'c:quiet']);
    expect(scan.mutating).toEqual(['c:local', 'c:imported']);
  });

  it('throws on a spread it cannot follow rather than skipping it', () => {
    const files = { 'main.ts': `import { pkg } from 'some-package'; const handlers = { ...pkg };` };
    expect(() => scanSynthetic(files, () => null)).toThrow(/cannot follow spread pkg/);
  });

  it('throws on a computed handler key', () => {
    const files = { 'main.ts': `const k = 'x'; const handlers = { [k]: async () => ({}) };` };
    expect(() => scanSynthetic(files)).toThrow(/unreadable handler key/);
  });
});

describe('CHANNEL_EMITS guard', () => {
  const scan = scanHandlerMap(registerFile, 'handlers', readSource, srcResolver(srcRoot));

  it('reads the real handler map, including spread-in handlers', () => {
    expect(scan.channels.length).toBeGreaterThan(50);
    expect(scan.channels).toEqual(expect.arrayContaining(Object.keys(CHANNEL_EMITS)));
    expect(scan.channels).toContain('drops:stage-file');
    expect(scan.mutating).toEqual(expect.arrayContaining(['shells:kill', 'shells:launch', 'tasks:run']));
  });

  it("lists 'alive-shells:changed' for every handler that changes the alive-shell set", () => {
    const emits = CHANNEL_EMITS as Partial<Record<string, readonly string[]>>;
    const missing = scan.mutating.filter((channel) => !(emits[channel] ?? []).includes('alive-shells:changed'));
    expect(missing).toEqual([]);
  });
});
