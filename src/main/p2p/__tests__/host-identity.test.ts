import { afterEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadHostIdentity, saveHostIdentity } from '../host-identity';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'hid-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('host-identity', () => {
  test('absent -> null', () => {
    expect(loadHostIdentity(join(tmp(), 'nope.json'))).toBeNull();
  });
  test('round trip, mode 0600, no tmp left behind', () => {
    const d = tmp();
    const f = join(d, 'sub', 'host-identity.json');
    saveHostIdentity({ code: '123456789', secret: 'abc' }, f);
    expect(loadHostIdentity(f)).toEqual({ code: '123456789', secret: 'abc' });
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(d, 'sub'))).toEqual(['host-identity.json']);
  });
  test('overwrite replaces atomically', () => {
    const f = join(tmp(), 'h.json');
    saveHostIdentity({ code: '1', secret: 'a' }, f);
    saveHostIdentity({ code: '2', secret: 'b' }, f);
    expect(loadHostIdentity(f)).toEqual({ code: '2', secret: 'b' });
  });
  test('corrupt file throws rather than being treated as absent', () => {
    const f = join(tmp(), 'h.json');
    writeFileSync(f, '{"code":1}', { mode: 0o600 });
    expect(() => loadHostIdentity(f)).toThrow(/corrupt/);
  });
});
