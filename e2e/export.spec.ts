import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'

/**
 * Export end-to-end: the packaged-dev app opens the editor on a fixture
 * recording, a GIF export runs through the real pipeline, and a non-empty
 * GIF89a lands on disk.
 *
 * The pieces that make this runnable without a user:
 * - `CAPTURIA_E2E_VIDEO` (main, unpackaged builds only) approves the fixture
 *   for reading and boots straight into the editor;
 * - the save dialog is replaced in the main process before the export starts,
 *   because a native dialog would block forever in CI;
 * - the export format is set through the renderer's own preferences key, so
 *   no test-only branch is needed in the editor;
 * - the export is started on the same channel the application menu uses.
 *
 * The build is automatic: `e2e/globalSetup.ts` runs `npm run build:vite` when
 * `dist/` + `dist-electron/` are behind `src/` or `electron/`.
 * Linux: `xvfb-run --auto-servernum npm run test:e2e`.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const MAIN_JS = path.join(ROOT, 'dist-electron', 'main.js')
const FIXTURE = path.join(ROOT, 'src', '__fixtures__', 'sample.webm')

/** 2 s of source at 15 fps, plus GIF quantisation of 30 frames. */
const EXPORT_TIMEOUT_MS = 180_000

function skipReason(): string | null {
  if (process.platform === 'linux' && !process.env['DISPLAY'] && !process.env['WAYLAND_DISPLAY']) {
    return 'no display server (DISPLAY/WAYLAND_DISPLAY unset); run under xvfb-run'
  }
  if (!fs.existsSync(MAIN_JS)) {
    return `${path.relative(ROOT, MAIN_JS)} missing; e2e/globalSetup.ts builds it unless CAPTURIA_E2E_SKIP_BUILD=1`
  }
  if (!fs.existsSync(FIXTURE)) {
    return `${path.relative(ROOT, FIXTURE)} missing`
  }
  return null
}

function killApp(app: ElectronApplication): void {
  const child = app.process()
  if (!child.pid) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  } else if (!child.killed) {
    child.kill('SIGKILL')
  }
}

test('exports a GIF from the fixture recording', async () => {
  // Software rendering makes the render loop far slower than on a desktop GPU.
  test.setTimeout(EXPORT_TIMEOUT_MS + 120_000)
  const reason = skipReason()
  test.skip(reason !== null, reason ?? undefined)

  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capturia-e2e-export-'))
  const outputPath = path.join(outputDir, 'export.gif')

  const app = await electron.launch({
    args: [
      MAIN_JS,
      // Required in CI sandbox environments (GitHub Actions, Docker, etc.)
      '--no-sandbox',
      // Force software WebGL in headless CI: the exporter renders through Pixi.
      '--enable-unsafe-swiftshader',
    ],
    env: {
      ...process.env,
      HEADLESS: process.env['HEADLESS'] ?? '1',
      CAPTURIA_E2E_VIDEO: FIXTURE,
    },
  })
  const electronProcess = app.process()
  electronProcess.stdout?.on('data', (chunk) => process.stdout.write(`[electron] ${chunk}`))
  electronProcess.stderr?.on('data', (chunk) => process.stderr.write(`[electron] ${chunk}`))

  try {
    // The save dialog never opens on its own here; the export writes to the
    // path this stub returns, which `pick-save-file-path` then approves.
    await app.evaluate(async ({ dialog }, filePath) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath })) as never
    }, outputPath)

    const editor = await app.firstWindow({ timeout: 60_000 })
    await editor.waitForLoadState('domcontentloaded')
    expect(editor.url()).toContain('windowType=editor')

    // Hand the approved fixture to the renderer and seed a project that picks
    // GIF, then reload onto it — the same sequence the editor's own
    // "Import Video…" flow performs. The seeded background is a solid colour on
    // purpose: the bundled wallpaper images resolve through the packaged
    // resources directory, which an unpackaged run does not have, and that is
    // not what this spec covers.
    const applied = await editor.evaluate(async (videoPath) => {
      // Every spec shares one real userData profile, so anything an earlier run
      // wrote is still here. A leftover decode-path override would quietly
      // decide which decoder this export exercises.
      window.localStorage.removeItem('capturia.exportDecodePath')
      const bridge = (
        window as unknown as {
          electronAPI: {
            setCurrentVideoPath: (p: string) => Promise<{ success: boolean }>
            saveProjectState: (p: string, state: unknown) => Promise<unknown>
          }
        }
      ).electronAPI
      // A restored project wins over the cross-session preferences, so the
      // format belongs here rather than in `capturia.userPreferences`.
      await bridge.saveProjectState(videoPath, {
        version: 1,
        savedAt: Date.now(),
        videoFilePath: videoPath,
        wallpaper: '#101820',
        exportFormat: 'gif',
      })
      return bridge.setCurrentVideoPath(videoPath)
    }, FIXTURE)
    expect(applied.success).toBe(true)
    await editor.reload()
    await editor.waitForLoadState('domcontentloaded')

    // The editor has decoded enough of the fixture to export from it.
    await editor.waitForFunction(
      () => {
        const video = document.querySelector('video')
        return video !== null && video.readyState >= 2 && video.duration > 0
      },
      undefined,
      { timeout: 60_000 },
    )

    // Start the export on the channel the application menu uses.
    const dispatched = await app.evaluate(({ BrowserWindow }) => {
      const target = BrowserWindow.getAllWindows().find((win) =>
        win.webContents.getURL().includes('windowType=editor'),
      )
      if (!target) return false
      target.webContents.send('menu-export')
      return true
    })
    expect(dispatched).toBe(true)

    await expect(editor.getByTestId('export-dialog')).toBeVisible({ timeout: 30_000 })
    await expect(editor.getByTestId('export-error')).toHaveCount(0)
    try {
      await expect(editor.getByTestId('export-success')).toBeVisible({ timeout: EXPORT_TIMEOUT_MS })
    } catch (error) {
      // The dialog carries the phase and percentage; without them a timeout
      // here says nothing about where the pipeline stopped.
      const state = await editor.getByTestId('export-dialog').innerText()
      throw new Error(`export never reported success (${String(error)}). Dialog said:\n${state}`)
    }
    await expect(editor.getByTestId('export-saved-filename')).toHaveText('export.gif')

    expect(fs.existsSync(outputPath)).toBe(true)
    const bytes = fs.readFileSync(outputPath)
    expect(bytes.byteLength).toBeGreaterThan(1024)
    expect(bytes.subarray(0, 6).toString('latin1')).toMatch(/^GIF8[79]a$/)
  } finally {
    await app
      .evaluate(({ app: electronApp }) => {
        electronApp.exit(0)
      })
      .catch(() => {
        // The process may already be gone.
      })
    killApp(app)
    fs.rmSync(outputDir, { recursive: true, force: true })
  }
})
