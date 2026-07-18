import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  main:     { build: { rollupOptions: { external: ['better-sqlite3', 'node-pty', 'keytar', 'chokidar'] } } },
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
