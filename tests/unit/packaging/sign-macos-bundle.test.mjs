import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
import signMacBundle from '../../../scripts/sign-macos-bundle.mjs';

const execFileSync = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFileSync }));

const context = (appOutDir, electronPlatformName = 'darwin') => ({
  appOutDir, electronPlatformName, packager: { appInfo: { productFilename: 'Test IDE' } },
});

function bundle(after) {
  const dir = mkdtempSync(join(tmpdir(), 'metaide-sign-fixture-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const app = join(dir, 'Test IDE.app');
  const contents = join(app, 'Contents');
  function put(name, data, mode) {
    const path = join(contents, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data, { mode });
    return path;
  }
  const mach = Buffer.from('cffaedfe', 'hex');
  const binary = put('Frameworks/Helper.app/Contents/MacOS/Helper', mach, 0o755);
  const native = put('Resources/plugins/native.node', mach, 0o644);
  const helper = join(contents, 'Frameworks/Helper.app');
  put('Resources/plain', mach, 0o644);
  put('Resources/short.node', 'x', 0o644);
  put('Resources/run', '#!/bin/sh\n', 0o755);
  symlinkSync('Frameworks/Helper.app', join(contents, 'linked.app'));
  return { dir, app, binary, native, helper };
}

beforeEach(() => execFileSync.mockReset());

it.each(['linux', 'win32'])('does not sign or inspect bundles on %s', (platform) => {
  signMacBundle(context('not-a-bundle', platform));
  expect(execFileSync).not.toHaveBeenCalled();
});

it.skipIf(process.platform === 'win32')('signs nested native code inside out, then verifies the app without signing the disk image', ({ onTestFinished }) => {
  const { dir, app, binary, native, helper } = bundle(onTestFinished);
  const sign = (file) => ['/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', file]];
  signMacBundle(context(dir));
  expect(execFileSync.mock.calls).toEqual([
    sign(binary), sign(native), sign(helper), sign(app),
    ['/usr/bin/codesign', ['--verify', '--deep', '--strict', app]],
  ]);
});

it.skipIf(process.platform === 'win32')('propagates a signing failure instead of verifying an incomplete bundle', ({ onTestFinished }) => {
  const { dir } = bundle(onTestFinished);
  execFileSync.mockImplementationOnce(() => { throw new Error('Could not sign'); });
  expect(() => signMacBundle(context(dir))).toThrow('Could not sign');
  expect(execFileSync).toHaveBeenCalledOnce();
});
