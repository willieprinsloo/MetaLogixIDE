import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { desktopGhosttyAssets } from '../../../scripts/desktop-ghostty-assets';
import { ghosttyCorePolicy } from '../../../scripts/desktop-ghostty-core-policy';
import { GHOSTTY_HOST_SELECTOR } from '@shared/terminal-engine';

const native = vi.hoisted(() => ({ realpath: vi.fn<(file: string) => string>() }));
vi.mock('node:fs', async (original) => ({
  ...(await original<typeof import('node:fs')>()),
  realpathSync: (file: string) => native.realpath(file),
}));

const core = 'C:/workspace/node_modules/@gespenst/core';
const wrapper = 'C:/workspace/node_modules/@gespenst/xterm';
const resolvePackage = createRequire(import.meta.url).resolve;

describe('Windows file paths in the Ghostty build policy', () => {
  it('matches Vite IDs to the filesystem paths before verifying or substituting vendor references', () => {
    native.realpath.mockReturnValueOnce('C:\\workspace\\node_modules\\@gespenst\\xterm\\dist\\index.js')
      .mockReturnValueOnce('C:\\workspace\\node_modules\\@gespenst\\core\\dist\\index.js')
      .mockReturnValueOnce('C:\\workspace\\node_modules\\@gespenst\\core\\dist\\chunks\\core-DxIkt0Aw.js');
    const policy = ghosttyCorePolicy();
    const coreRoot = dirname(resolvePackage('@gespenst/core/package.json'));
    const transform = (file: string) => policy.transform(readFileSync(join(coreRoot, file), 'utf8'), `${core}/${file}`)?.code;
    expect(() => policy.transform('unexpected bytes', `${wrapper}/dist/index.js`)).toThrow('Unexpected Ghostty JavaScript digest');
    const index = transform('dist/index.js');
    expect(index).toContain('Ghostty workers are disabled');
    expect(index).not.toContain('terminal-worker-CfcHI8XP.js');
    const chunk = transform('dist/chunks/core-DxIkt0Aw.js');
    expect(chunk).toContain('new URL("about:blank")');
    expect(chunk).not.toMatch(/new URL\(`\.\.\/ghostty-(?:vt|callbacks)\.wasm`/u);
    expect(() => policy.generateBundle({}, { 'assets/ghostty-vt-test.wasm': {} })).toThrow('Unexpected loose Ghostty WASM or worker');
  });

  it('returns a Vite-normalized stylesheet ID and validates and scopes CSS at that ID', () => {
    native.realpath.mockReturnValueOnce('C:\\workspace\\node_modules\\@gespenst\\xterm\\css\\xterm.css');
    const policy = desktopGhosttyAssets();
    const entry = '@gespenst/xterm/css/xterm.css';
    const id = `${wrapper}/css/xterm.css`;
    const css = readFileSync(resolvePackage(entry), 'utf8');
    expect(policy.resolveId(entry)).toBe(id);
    expect(policy.transform(css, id)?.code).toContain(`${GHOSTTY_HOST_SELECTOR} .xterm`);
    expect(() => policy.transform('.xterm {}', id)).toThrow('Ghostty stylesheet changed');
  });
});
