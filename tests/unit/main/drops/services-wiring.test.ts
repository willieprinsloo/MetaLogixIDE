import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildServices } from '@main/services';

const migrationsDir = resolve(__dirname, '../../../../migrations');
const temps: string[] = [];

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('buildServices — drop staging wiring', () => {
  it('defaults the drop directory to the uid-scoped OS temp location', () => {
    const services = buildServices({ dbPath: join(temp('svc-drops-'), 'db'), migrationsDir });
    const expected =
      process.platform === 'win32'
        ? join(tmpdir(), 'metaide-drops')
        : join(tmpdir(), `metaide-drops-${process.getuid!()}`);
    expect(services.dropStaging.dir).toBe(resolve(expected));
  });

  it('honours a dropDir override and stages into it', async () => {
    const dropDir = join(temp('svc-dropdir-'), 'drops');
    const services = buildServices({
      dbPath: join(temp('svc-drops-'), 'db'),
      migrationsDir,
      dropDir,
    });
    const result = await services.dropStaging.stage('a.txt', 'text/plain', new Uint8Array([1]));
    expect(result).toEqual({ kind: 'staged', path: join(dropDir, 'a.txt') });
  });

  it('constructs the drop directory lazily, never at build time', () => {
    const dropDir = join(temp('svc-dropdir-'), 'drops');
    buildServices({ dbPath: join(temp('svc-drops-'), 'db'), migrationsDir, dropDir });
    expect(existsSync(dropDir)).toBe(false);
  });

  it('exposes a clipboard image reader', () => {
    const services = buildServices({ dbPath: join(temp('svc-drops-'), 'db'), migrationsDir });
    expect(typeof services.clipboardImage.readPng).toBe('function');
  });
});
