import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { metaprojectPlatform } from '@main/metaproject/platform';

const secure = vi.hoisted(() => ({
  getPassword: vi.fn(async () => 'fixture-value'),
  setPassword: vi.fn(async () => undefined),
  deletePassword: vi.fn(async () => true),
}));
vi.mock('keytar', () => secure);

afterEach(() => { vi.clearAllMocks(); });

it('routes the non-fixture platform to the injected OS launcher and the native-store adapter', async () => {
  const open = vi.fn(async () => undefined);
  const { keyring, openExternal } = metaprojectPlatform(null, open);
  await expect(keyring.getPassword('service', 'slot')).resolves.toBe('fixture-value');
  await expect(keyring.setPassword('service', 'slot', 'value')).resolves.toBeUndefined();
  await expect(keyring.deletePassword('service', 'slot')).resolves.toBe(true);
  await expect(openExternal('https://fixture.invalid/projects/2')).resolves.toBeUndefined();
  expect(secure.getPassword).toHaveBeenCalledWith('service', 'slot');
  expect(secure.setPassword).toHaveBeenCalledWith('service', 'slot', 'value');
  expect(secure.deletePassword).toHaveBeenCalledWith('service', 'slot');
  expect(open).toHaveBeenCalledWith('https://fixture.invalid/projects/2');
});

it('keeps fixture slots local, does not overwrite them, and records browser intent without opening it', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'metaproject-platform-'));
  try {
    const open = vi.fn(async () => undefined);
    const { keyring, openExternal } = metaprojectPlatform(profile, open);
    await expect(keyring.getPassword('service', 'grant')).resolves.toBeNull();
    await keyring.setPassword('service', 'grant', 'fixture-record');
    await expect(keyring.setPassword('service', 'grant', 'replacement')).rejects.toMatchObject({ code: 'EEXIST' });
    await expect(keyring.getPassword('service', 'grant')).resolves.toBe('fixture-record');
    await expect(keyring.getPassword('other', 'grant')).resolves.toBeNull();
    await expect(keyring.deletePassword('service', 'grant')).resolves.toBe(true);
    await expect(keyring.getPassword('service', 'grant')).resolves.toBeNull();
    const url = 'http://127.0.0.1:8080/projects/11';
    await openExternal(url);
    await expect(readFile(join(profile, 'metaproject-fixture', 'opened.jsonl'), 'utf8')).resolves.toBe(`${JSON.stringify(url)}\n`);
    expect(open).not.toHaveBeenCalled();
    expect(secure.getPassword).not.toHaveBeenCalled();
    expect(secure.setPassword).not.toHaveBeenCalled();
    expect(secure.deletePassword).not.toHaveBeenCalled();
  } finally { await rm(profile, { recursive: true, force: true }); }
});

it('does not mistake an unreadable fixture slot for a missing grant', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'metaproject-platform-'));
  try {
    const { keyring } = metaprojectPlatform(profile, async () => undefined);
    const id = createHash('sha256').update(JSON.stringify(['service', 'grant'])).digest('hex');
    await mkdir(join(profile, 'metaproject-fixture', id), { recursive: true });
    await expect(keyring.getPassword('service', 'grant')).rejects.toThrow();
    expect(secure.getPassword).not.toHaveBeenCalled();
  } finally { await rm(profile, { recursive: true, force: true }); }
});
