import { defineConfig } from '@playwright/test'

/**
 * Electron end-to-end specs (`e2e/*.spec.ts`). They boot the built app through
 * `_electron.launch` with `HEADLESS=1`, so no window is ever shown; Linux still
 * needs a display server (`xvfb-run --auto-servernum npm run test:e2e`). Run
 * nightly / on dispatch (`.github/workflows/e2e.yml`), never as a PR gate:
 * booting a real Electron app on a hosted runner is too flaky to block a merge
 * on.
 *
 * `globalSetup` rebuilds `dist/` + `dist-electron/` whenever they are behind
 * `src/` or `electron/`, so no run can quietly test yesterday's app. Fresh, it
 * costs a directory walk; stale, it costs one `npm run build:vite`.
 */
export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/globalSetup.ts',
  timeout: 120_000,
  retries: 0,
  // One Electron instance at a time: they share the userData dir.
  workers: 1,
  fullyParallel: false,
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : 'list',
  outputDir: 'test-results',
})
