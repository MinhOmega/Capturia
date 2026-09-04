import fs from 'node:fs'
import os from 'node:os'
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

/**
 * Every `node_modules` at or above this config, so Vite will serve files out of
 * them.
 *
 * A git worktree (`.claude/worktrees/<name>`) has no installed packages of its
 * own: everything resolves from the main checkout's `node_modules`, which sits
 * outside the worktree and so outside Vite's default `fs.allow` (the project
 * root). gif.js loads its encoder worker from that path at runtime; the request
 * is refused with "outside of Vite serving allow list", the worker never
 * starts, `render()` never finishes, and the GIF export spec times out with no
 * hint of why. Allowing the real dependency roots makes the browser lane run
 * from a worktree exactly as it does from the main checkout.
 */
function dependencyRoots(from: string): string[] {
  const roots: string[] = []
  let dir = from
  for (;;) {
    const candidate = path.join(dir, 'node_modules')
    if (fs.existsSync(candidate)) roots.push(candidate)
    const parent = path.dirname(dir)
    if (parent === dir) return roots
    dir = parent
  }
}

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
      commands: {
        /**
         * Hands a string from the page to the node side and writes it next to
         * the OS temp dir. Browser-mode `console.log` is not forwarded to the
         * terminal by the default reporter, so a long-running measurement
         * (`src/lib/redaction/ocrSpike.browser.test.ts`) would otherwise have
         * nowhere to put its results. `CAPTURIA_SPIKE_OUT` overrides the path.
         */
        writeSpikeArtifact: async (_ctx: unknown, name: string, content: string) => {
          const file =
            process.env['CAPTURIA_SPIKE_OUT'] ??
            path.join(os.tmpdir(), `capturia-${path.basename(name)}`)
          fs.mkdirSync(path.dirname(file), { recursive: true })
          fs.appendFileSync(file, content)
          return file
        },
      },
    },
    testTimeout: 120_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    fs: { allow: [__dirname, ...dependencyRoots(__dirname)] },
  },
  // `CAPTURIA_*` reaches the page as `import.meta.env.*`, which is how the
  // redaction OCR spike stays skipped unless it is asked for explicitly
  // (`CAPTURIA_REDACTION_SPIKE=1`). Vite only forwards prefixed variables.
  envPrefix: ['VITE_', 'CAPTURIA_'],
  // gif.js spawns its encoder workers from a URL built with `import.meta.url`.
  worker: {
    format: 'es',
  },
  assetsInclude: ['**/*.webm'],
})
