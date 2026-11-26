import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { build, type Plugin } from 'vite';
import { desktopGhosttyAssets, readVerifiedGhosttyAsset, scopeGhosttyStyles } from '../../../scripts/desktop-ghostty-assets';
import { ghosttyCorePolicy } from '../../../scripts/desktop-ghostty-core-policy';
import { GHOSTTY_HOST_SELECTOR } from '@shared/terminal-engine';

describe('Ghostty build inputs', () => {
  it.each(['vt', 'callbacks', 'stylesheet'] as const)('reads only the pinned %s bytes from disk', (asset) => {
    const data = readVerifiedGhosttyAsset(asset);
    expect(data.length).toBeGreaterThan(0);
    expect(() => readVerifiedGhosttyAsset(asset, () => Buffer.from('unverified'))).toThrow(`Ghostty ${asset} digest`);
    expect(() => readVerifiedGhosttyAsset(asset, () => { throw new Error('ENOENT'); })).toThrow(`Missing Ghostty ${asset}`);
  });

  it('binds exactly two virtual WASM modules, and never falls back to an unknown file', () => {
    const assets = desktopGhosttyAssets();
    for (const name of ['vt', 'callbacks'] as const) {
      const id = `virtual:metaide-ghostty-${name}`;
      const resolved = assets.resolveId(id);
      expect(resolved).toBe(`\0${id}`);
      const module = assets.load(`\0${id}`) ?? '';
      const encoded = module.match(/atob\("([a-zA-Z0-9+/=]+)"\)/u)?.[1];
      expect(encoded, name).toBeDefined();
      expect(Buffer.from(encoded ?? '', 'base64').equals(readVerifiedGhosttyAsset(name))).toBe(true);
      expect(module).not.toContain('fetch(');
    }
    expect(assets.resolveId('virtual:metaide-ghostty-unknown')).toBeUndefined();
    expect(assets.load('\0virtual:metaide-ghostty-unknown')).toBeUndefined();
  });

  it('scopes every selector in the reviewed stylesheet and leaves unrelated CSS alone', () => {
    const asset = desktopGhosttyAssets();
    const css = readVerifiedGhosttyAsset('stylesheet').toString('utf8');
    expect(asset.transform(css, '/app/style.css')).toBeUndefined();
    expect(scopeGhosttyStyles('.xterm, .xterm-viewport { color: red; }')).toBe(
      `${GHOSTTY_HOST_SELECTOR} .xterm, ${GHOSTTY_HOST_SELECTOR} .xterm-viewport { color: red; }`,
    );
    expect(scopeGhosttyStyles(css)).toContain(`${GHOSTTY_HOST_SELECTOR} .xterm .xterm-screen`);
    const stylesheet = asset.resolveId('@gespenst/xterm/css/xterm.css') ?? '';
    expect(stylesheet).toMatch(/xterm\.css$/u);
    expect(asset.transform(css, stylesheet)?.code).toBe(scopeGhosttyStyles(css));
    expect(() => asset.transform('.xterm {}', stylesheet)).toThrow('Ghostty stylesheet changed');
    expect(() => scopeGhosttyStyles('@import "elsewhere.css";')).toThrow('Unexpected Ghostty CSS at-rule');
  });

  it('puts both verified modules in a lazy chunk and emits no vendor worker or extra WASM', async () => {
    const engine = fileURLToPath(new URL('../../../src/renderer/terminal/ghostty-view-engine.ts', import.meta.url));
    const shared = fileURLToPath(new URL('../../../src/shared', import.meta.url));
    const fixture: Plugin = {
      name: 'ghostty-artifact-fixture',
      resolveId(id) { if (id === 'fixture-entry') return '\0fixture-entry'; },
      load(id) {
        if (id === '\0fixture-entry') return `export const open = () => import(${JSON.stringify(engine)});`;
      },
    };
    const result = await build({ configFile: false, base: './', logLevel: 'silent', plugins: [fixture, desktopGhosttyAssets(), ghosttyCorePolicy()],
      resolve: { alias: { '@shared': shared } },
      build: { write: false, minify: false, rollupOptions: { input: 'fixture-entry', preserveEntrySignatures: 'strict' } } });
    if (Array.isArray(result) || !('output' in result)) throw new Error('Expected one renderer bundle');
    const output = result.output;
    const entry = output.find(chunk => chunk.type === 'chunk' && chunk.facadeModuleId === '\0fixture-entry');
    if (!entry || entry.type !== 'chunk') throw new Error('Missing cold entry');
    const coldChunks = new Set<string>();
    const lazyChunks = new Set<string>();
    function checkCold(fileName: string): void {
      if (coldChunks.has(fileName)) return;
      coldChunks.add(fileName);
      const chunk = output.find(file => file.fileName === fileName);
      if (!chunk || chunk.type !== 'chunk') throw new Error(`Missing startup JS: ${fileName}`);
      expect(chunk.code).not.toContain('AGFzbQ');
      expect(Object.keys(chunk.modules).some(id => id.includes('/@gespenst/') || id.includes('metaide-ghostty-') || id === engine)).toBe(false);
      chunk.dynamicImports.forEach(name => lazyChunks.add(name));
      chunk.imports.forEach(checkCold);
    }
    checkCold(entry.fileName);
    expect(lazyChunks.size).toBe(1);
    const candidate = output.find(chunk => lazyChunks.has(chunk.fileName));
    if (!candidate || candidate.type !== 'chunk') throw new Error('Missing lazy Ghostty chunk');
    const embedded = Array.from(candidate.code.matchAll(/atob\("(AGFzbQ[A-Za-z0-9+/=]+)"\)/gu), match => match[1] ?? '');
    expect(embedded).toHaveLength(2);
    for (const key of ['vt', 'callbacks'] as const) expect(embedded).toContain(readVerifiedGhosttyAsset(key).toString('base64'));
    expect(output.map(file => file.fileName).filter(name => /\.wasm$|terminal-worker/u.test(name))).toEqual([]);
  });
});
