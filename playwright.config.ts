import { defineConfig } from '@playwright/test'

/**
 * Electron end-to-end specs (`e2e/*.spec.ts`). They boot the built app
 * (`npm run build:vite` first) through `_electron.launch` with `HEADLESS=1`,
 * so no window is ever shown; Linux still needs a display server
 * (`xvfb-run --auto-servernum npm run test:e2e`). Run nightly / on dispatch
 * (`.github/workflows/e2e.yml`), never as a PR gate: upstream dropped the
 * same job from PR CI as flaky (d4c50c9a).
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  retries: 0,
  // One Electron instance at a time: they share the userData dir.
  workers: 1,
  fullyParallel: false,
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : 'list',
  outputDir: 'test-results',
})
