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

  it('recognises non-null assertions and parentheses around the receiver', () => {
    const scan = scanSynthetic({
      'main.ts': `
        const handlers = {
          'd:bang': async (s) => { await s.ptyManager!.spawn(1, 0, {}); },
          'd:paren': async (s) => { (s.shells as Shells)!.upsert({}); },
          'd:bang-quiet': async (s) => { s.ptyManager!.write(1, 0, 'x'); },
        };`,
    });
    expect(scan.mutating).toEqual(['d:bang', 'd:paren']);
  });

  it('recognises string-literal element access on the receiver and on the method', () => {
    const scan = scanSynthetic({
      'main.ts': `
        const handlers = {
          'e:receiver': async (s) => { await s['ptyManager'].kill(1, 0); },
          'e:method': async (s) => { s.shells['remove'](1, 0); },
          'e:template': async (s) => { s[\`ptyManager\`]?.[\`spawn\`](1, 0, {}); },
          'e:quiet': async (s) => { s['shells'].list(); },
        };`,
    });
    expect(scan.mutating).toEqual(['e:receiver', 'e:method', 'e:template']);
  });

  it('recognises a mutating method referenced without being called', () => {
    const scan = scanSynthetic({
      'main.ts': `const handlers = { 'f:ref': async (s, r) => { r.ids.forEach(s.ptyManager.kill); } };`,
    });
    expect(scan.mutating).toEqual(['f:ref']);
  });

  it.each([
    ['a computed method key', `s.ptyManager[method](1, 0)`],
    ['a computed receiver key', `s[key].spawn(1, 0, {})`],
    ['an aliased receiver', `const pm = s.ptyManager; pm.spawn(1, 0, {})`],
    ['an aliased receiver behind a non-null assertion', `const sh = s.shells!; sh.remove(1, 0)`],
    ['a receiver passed to a function', `stopAll(s.ptyManager)`],
    ['a receiver stored in an object', `const deps = { pty: s['ptyManager'] }; deps.pty.kill(1, 0)`],
    ['a destructured receiver', `const { ptyManager } = s; ptyManager.spawn(1, 0, {})`],
    ['a renamed destructured receiver', `const { ptyManager: pty } = s; pty.spawn(1, 0, {})`],
    ['a destructured method', `const { kill } = s.ptyManager; kill(1, 0)`],
    ['a destructuring assignment', `let pty; ({ ptyManager: pty } = s); pty.kill(1, 0)`],
    ['a string-literal computed destructuring key', `const { ['ptyManager']: p } = s; p.spawn(1, 0, {})`],
    ['a template-literal computed destructuring key', `const { [\`shells\`]: sh } = s; sh.remove(1, 0)`],
    ['a non-literal computed destructuring key', `const { [key]: p } = s; p.spawn(1, 0, {})`],
    ['a computed key in a destructuring assignment', `let p; ({ ['ptyManager']: p } = s); p.kill(1, 0)`],
    ['a non-literal computed key in a destructuring assignment', `let p; ({ [key]: p } = s); p.kill(1, 0)`],
    ['a computed key in the handler parameter destructuring', `(({ ['shells']: sh }) => sh.upsert({}))(s)`],
    ['a numeric index followed by a mutating method on any object', `r.procs[0]?.kill()`],
  ])('throws on %s instead of passing the handler', (_label, body) => {
    const files = { 'main.ts': `const handlers = { 'g:hidden': async (s, { method, key }) => { ${body}; } };` };
    expect(() => scanSynthetic(files)).toThrow(/g:hidden: cannot analyse/);
  });

  it('throws on a destructured receiver in the handler parameter', () => {
    const files = { 'main.ts': `const handlers = { 'g:param': async ({ shells: sh }) => { sh.upsert({}); } };` };
    expect(() => scanSynthetic(files)).toThrow(/g:param: cannot analyse/);
  });

  it('throws when a handler reaches an unanalysable helper, but not for helpers no handler reaches', () => {
    const helper = `function evict(s) { const pm = s.ptyManager; pm.kill(1, 0); }`;
    const boot = `function boot(services) { if (services.ptyManager) return evict(services); }`;
    expect(() => scanSynthetic({ 'main.ts': `${helper} const run = (s) => evict(s); const handlers = { 'h:via': async (s) => run(s) };` }))
      .toThrow(/h:via: cannot analyse helper run/);
    const scan = scanSynthetic({ 'main.ts': `${helper} ${boot} const handlers = { 'h:clean': async (s) => s.shells.list() };` });
    expect(scan.mutating).toEqual([]);
  });

  it('passes an indexed element bound to a local first, and literal computed keys naming other services', () => {
    const scan = scanSynthetic({
      'main.ts': `const handlers = { 'j:bound': async (s, r) => { const p = r.procs[0]; p?.kill(); const { ['projects']: pr } = s; pr.remove(1); } };`,
    });
    expect(scan.mutating).toEqual([]);
  });

  it('does not mistake look-alike names for an escaping receiver', () => {
    const scan = scanSynthetic({
      'main.ts': `
        const handlers = {
          'i:keys': async (s) => { const shells = s.shells.list(); return { shells, ptyManager: 1 }; },
          'i:nested': async (s, r) => { r.result.shells.map((x) => x); child.kill(); },
        };`,
    });
    expect(scan.channels).toEqual(['i:keys', 'i:nested']);
    expect(scan.mutating).toEqual([]);
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
    expect(scan.mutating).toEqual(expect.arrayContaining(['shells:kill', 'shells:stop-primary', 'shells:launch', 'tasks:run']));
  });

  it("lists 'alive-shells:changed' for every handler that changes the alive-shell set", () => {
    const emits = CHANNEL_EMITS as Partial<Record<string, readonly string[]>>;
    const missing = scan.mutating.filter((channel) => !(emits[channel] ?? []).includes('alive-shells:changed'));
    expect(missing).toEqual([]);
  });
});
