import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, expect, test } from '@playwright/test'

/**
 * Launch smoke: the packaged-dev app boots, the HUD window appears, and the
 * source selector opens from it. Adapted from OpenScreen's `gif-export.spec.ts`
 * launch scaffolding (F10 / B14); export coverage comes later once the editor
 * export UI carries test ids.
 *
 * Prerequisite: `npm run build:vite` (writes `dist/` + `dist-electron/`).
 * Linux: `xvfb-run --auto-servernum npm run test:e2e`.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const MAIN_JS = path.join(ROOT, 'dist-electron', 'main.js')

function skipReason(): string | null {
  if (process.platform === 'linux' && !process.env['DISPLAY'] && !process.env['WAYLAND_DISPLAY']) {
    return 'no display server (DISPLAY/WAYLAND_DISPLAY unset); run under xvfb-run'
  }
  if (!fs.existsSync(MAIN_JS)) {
    return `${path.relative(ROOT, MAIN_JS)} missing; run "npm run build:vite" first`
  }
  return null
}

test('boots the HUD and opens the source selector', async () => {
  const reason = skipReason()
  test.skip(reason !== null, reason ?? undefined)

  const app = await electron.launch({
    args: [
      MAIN_JS,
      // Required in CI sandbox environments (GitHub Actions, Docker, etc.)
      '--no-sandbox',
      // Force software WebGL in headless CI to avoid GPU framebuffer errors.
      '--enable-unsafe-swiftshader',
    ],
    env: {
      ...process.env,
      // Set HEADLESS=0 to watch the windows while debugging.
      HEADLESS: process.env['HEADLESS'] ?? '1',
    },
  })
  const electronProcess = app.process()
  electronProcess.stdout?.on('data', (chunk) => process.stdout.write(`[electron] ${chunk}`))
  electronProcess.stderr?.on('data', (chunk) => process.stderr.write(`[electron] ${chunk}`))

  try {
    const hud = await app.firstWindow({ timeout: 60_000 })
    await hud.waitForLoadState('domcontentloaded')
    expect(hud.url()).toContain('windowType=hud-overlay')

    // The HUD rendered its controls (React mounted, preload bridge present).
    await expect(hud.getByTestId('launch-record-button')).toBeVisible({ timeout: 30_000 })
    await expect(hud.getByTestId('launch-source-button')).toBeVisible()

    const selectorPromise = app.waitForEvent('window', {
      predicate: (page) => page.url().includes('windowType=source-selector'),
      timeout: 30_000,
    })
    await hud.evaluate(() => {
      const bridge = (window as unknown as { electronAPI: { openSourceSelector: () => void } })
        .electronAPI
      bridge.openSourceSelector()
    })
    const selector = await selectorPromise
    await selector.waitForLoadState('domcontentloaded')
    expect(selector.url()).toContain('windowType=source-selector')

    // `get-sources` may legitimately return nothing under xvfb; the window
    // existing and having rendered is the contract here.
    await expect(selector.locator('body')).not.toBeEmpty()

    const windowCount = await app.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
    )
    expect(windowCount).toBeGreaterThanOrEqual(2)
  } finally {
    await app
      .evaluate(({ app: electronApp }) => {
        electronApp.exit(0)
      })
      .catch(() => {
        // The process may already be gone.
      })
    if (electronProcess.pid) {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(electronProcess.pid), '/T', '/F'], {
          stdio: 'ignore',
        })
      } else if (!electronProcess.killed) {
        electronProcess.kill('SIGKILL')
      }
    }
  }
})
