import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  // 60 s was snug on Electron 32 and left ~15 s for the test body once
  // launch setup (45 s budget) finished. The Electron 32 → 43 upgrade
  // pushes launch past 45 s on loaded workstations, so we bumped
  // LAUNCH_BUDGET_MS to 55 s — the test timeout needs to follow. 120 s
  // leaves 65 s for the test body itself, which comfortably covers the
  // longest existing spec.
  timeout: 120_000,
  // Cap the worker pool at four: the default uses every core, in every session
  // sharing this machine. Each worker launches its own Electron instance.
  workers: 4,
  use: { trace: 'retain-on-failure' },
  reporter: [['list']],
});
