import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  main:     {
    build: {
      rollupOptions: {
        external: [
          'better-sqlite3', 'node-pty', 'keytar', 'chokidar',
          // Optional native peers of the `ws` package (pulled in by
          // socket.io-client). Not installed by default; treat as
          // external so rollup doesn't try to bundle them.
          'bufferutil', 'utf-8-validate',
        ],
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
