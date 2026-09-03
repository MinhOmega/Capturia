import path from 'node:path'
import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'

/**
 * Browser-mode vitest: `src/**\/*.browser.test.ts` run inside a real headless
 * Chromium (Playwright) so the exporter, the GIF encoder and the audio
 * time-stretch are exercised against real `<video>`, WebCodecs, WebGL and
 * `AudioContext` implementations instead of jsdom stubs.
 *
 *   npm run test:browser            # needs `npx playwright install chromium` once
 *   CAPTURIA_BROWSER_CHANNEL=chrome npm run test:browser
 *
 * `CAPTURIA_BROWSER_CHANNEL` picks an installed Playwright channel (`chrome`,
 * `msedge`, ...). The MP4 exporter encodes H.264, which the plain Chromium
 * build may not ship; the exporter spec skips itself when
 * `VideoEncoder.isConfigSupported` says no, and the Chrome channel is the way
 * to run it for real.
 *
 * Kept apart from `vitest.config.ts` (node/jsdom) so the unit lane never boots
 * a browser; that config excludes `*.browser.test.*`.
 */
const channel = process.env['CAPTURIA_BROWSER_CHANNEL'] || undefined

export default defineConfig({
  test: {
    include: ['src/**/*.browser.test.{ts,tsx}'],
    browser: {
      enabled: true,
      provider: playwright({
        launchOptions: {
          channel,
          args: [
            // Software WebGL so Pixi.js initialises without a GPU (CI, xvfb-less boxes).
            '--enable-unsafe-swiftshader',
            '--use-gl=angle',
            '--use-angle=swiftshader',
            // `AudioContext` may start without a user gesture in the harness.
            '--autoplay-policy=no-user-gesture-required',
          ],
        },
      }),
      headless: true,
      instances: [{ browser: 'chromium' }],
      screenshotFailures: false,
    },
    testTimeout: 120_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  // gif.js spawns its encoder workers from a URL built with `import.meta.url`.
  worker: {
    format: 'es',
  },
  assetsInclude: ['**/*.webm'],
})
