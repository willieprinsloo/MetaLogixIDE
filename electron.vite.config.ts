import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';

// Emits `out/main/package.json` = {"type":"commonjs"} so Node treats every
// .js file under out/main/ as CommonJS regardless of the parent
// package.json's `"type": "module"`. Required in the packaged app because
// rollup leaves `require('better-sqlite3')` etc. in the main bundle (they
// are external native modules), and CJS `require` isn't defined in ESM
// scope. `electron-vite dev` also loads main via its own runtime, so the
// override is production-only in practice.
function emitMainCjsPackageJson() {
  return {
    name: 'metaide:emit-main-cjs-manifest',
    apply: 'build' as const,
    writeBundle() {
      const outDir = resolve('out/main');
      mkdirSync(outDir, { recursive: true });
      writeFileSync(resolve(outDir, 'package.json'), JSON.stringify({ type: 'commonjs' }, null, 2) + '\n');
    },
  };
}

export default defineConfig({
  main:     {
    plugins: [emitMainCjsPackageJson()],
    build: {
      rollupOptions: {
        // Only NATIVE (.node) modules stay external — they can't be bundled
        // by rollup and must be loaded from disk. Pure-JS deps like chokidar
        // and socket.io-client get inlined, which sidesteps pnpm's symlink
        // layout (electron-builder mis-copies transitive deps like readdirp
        // when the packages are hoisted through .pnpm/).
        external: [
          'better-sqlite3', 'node-pty', 'keytar',
          // Optional native peers of the `ws` package (pulled in by
          // socket.io-client). Not installed by default; treat as
          // external so rollup doesn't try to bundle them.
          'bufferutil', 'utf-8-validate',
        ],
        // Force CommonJS output so the external `require()` calls above are
        // syntactically legal. Without this, electron-vite emits ESM and
        // the packaged app throws "require is not defined in ES module
        // scope" the moment it touches better-sqlite3 / node-pty / keytar.
        output: { format: 'cjs', entryFileNames: '[name].js' },
      },
    },
    resolve: { alias: { '@main': resolve('src/main'), '@shared': resolve('src/shared') } },
  },
  preload:  {
    build: {
      rollupOptions: {
        output: { format: 'cjs', entryFileNames: '[name].js' },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    build: { rollupOptions: { input: resolve('src/renderer/index.html') } },
    plugins: [react()],
    resolve: { alias: { '@shared': resolve('src/shared'), '@renderer': resolve('src/renderer') } }
  }
});
