import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60000,
  // Electron tests cannot run in parallel — each launches a separate process
  // and the two instances contend for resources on the CI machine.
  workers: 1,
  use: { trace: 'retain-on-failure' },
  reporter: [['list']],
});
