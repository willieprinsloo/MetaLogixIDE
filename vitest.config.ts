import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@main': resolve(__dirname, 'src/main'),
      '@shared': resolve(__dirname, 'src/shared'),
      '@renderer': resolve(__dirname, 'src/renderer'),
    },
  },
  test: {
    environment: 'node',
    // .claude/ holds mutation-test copies of the tree; never collect them.
    exclude: ['tests/e2e/**', 'node_modules/**', '.claude/**'],
  },
});
