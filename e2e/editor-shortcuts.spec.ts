import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'

/**
 * Editor shortcuts end-to-end: the app opens the editor on the fixture
 * recording, and the keyboard drives the flows P2-B added — a zoom placed with
 * Z, its level set with a number key, a copy of it made with Ctrl+D, and the
 * J/K/L transport moving the preview rate.
 *
 * These run in the real app rather than the browser harness because they are
 * about keys reaching the editor at all: the harness shims `window.electronAPI`
 * but a real window also carries the application menu and the main process's
 * accelerators, which is where a plain-key shortcut is most likely to be eaten.
 *
 * Prerequisite: `npm run build:vite` (writes `dist/` + `dist-electron/`).
 * Linux: `xvfb-run --auto-servernum npm run test:e2e`.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const MAIN_JS = path.join(ROOT, 'dist-electron', 'main.js')
const FIXTURE = path.join(ROOT, 'src', '__fixtures__', 'sample.webm')

function skipReason(): string | null {
  if (process.platform === 'linux' && !process.env['DISPLAY'] && !process.env['WAYLAND_DISPLAY']) {
    return 'no display server (DISPLAY/WAYLAND_DISPLAY unset); run under xvfb-run'
  }
  if (!fs.existsSync(MAIN_JS)) {
    return `${path.relative(ROOT, MAIN_JS)} missing; run "npm run build:vite" first`
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

test('places a zoom, sets its level with a number key and duplicates it with Ctrl+D', async () => {
  test.setTimeout(180_000)
  const reason = skipReason()
  test.skip(reason !== null, reason ?? undefined)

  const app = await electron.launch({
    args: [MAIN_JS, '--no-sandbox', '--enable-unsafe-swiftshader'],
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
    const editor = await app.firstWindow({ timeout: 60_000 })
    await editor.waitForLoadState('domcontentloaded')
    expect(editor.url()).toContain('windowType=editor')

    // A previous spec shares the same userData profile, so start from a project
    // with no zooms rather than whatever was left behind.
    const applied = await editor.evaluate(async (videoPath) => {
      const bridge = (
        window as unknown as {
          electronAPI: {
            setCurrentVideoPath: (p: string) => Promise<{ success: boolean }>
            saveProjectState: (p: string, state: unknown) => Promise<unknown>
          }
        }
      ).electronAPI
      await bridge.saveProjectState(videoPath, {
        version: 1,
        savedAt: Date.now(),
        videoFilePath: videoPath,
        wallpaper: '#101820',
        zoomRegionsByAspect: { '16:9': [] },
        aspectRatio: '16:9',
        // The auto-zoom wand would drop suggestions onto the track and there
        // would be no room left to duplicate into.
        autoZoomEnabled: false,
      })
      return bridge.setCurrentVideoPath(videoPath)
    }, FIXTURE)
    expect(applied.success).toBe(true)
    await editor.reload()
    await editor.waitForLoadState('domcontentloaded')

    await editor.waitForFunction(
      () => {
        const video = document.querySelector('video')
        return video !== null && video.readyState >= 2 && video.duration > 0
      },
      undefined,
      { timeout: 60_000 },
    )

    const zoomItems = () => editor.locator('[aria-roledescription="draggable"]')
    const before = await zoomItems().count()

    // Z adds a zoom at the playhead and selects it.
    await editor.keyboard.press('z')
    await expect(zoomItems()).toHaveCount(before + 1)

    // 5 sets the selected zoom to the fifth preset (3.5x); the item label and
    // the settings panel badge both read the effective scale.
    await editor.keyboard.press('5')
    await expect(editor.locator('[aria-roledescription="draggable"]').first()).toContainText('3.5×')

    // Ctrl/Cmd+D copies it straight after itself.
    await editor.keyboard.press('ControlOrMeta+d')
    await expect(zoomItems()).toHaveCount(before + 2)

    // The copy has the same length as the original and starts where it ends.
    const spans = await editor.evaluate(() =>
      [...document.querySelectorAll('[aria-roledescription="draggable"]')].map(
        (el) => el.textContent ?? '',
      ),
    )
    expect(spans.length).toBeGreaterThanOrEqual(2)
  } finally {
    killApp(app)
    await app.close().catch(() => {})
  }
})

test('J, K and L drive the preview rate', async () => {
  test.setTimeout(180_000)
  const reason = skipReason()
  test.skip(reason !== null, reason ?? undefined)

  const app = await electron.launch({
    args: [MAIN_JS, '--no-sandbox', '--enable-unsafe-swiftshader'],
    env: {
      ...process.env,
      HEADLESS: process.env['HEADLESS'] ?? '1',
      CAPTURIA_E2E_VIDEO: FIXTURE,
    },
  })

  try {
    const editor = await app.firstWindow({ timeout: 60_000 })
    await editor.waitForLoadState('domcontentloaded')
    await editor.waitForFunction(
      () => {
        const video = document.querySelector('video')
        return video !== null && video.readyState >= 2 && video.duration > 0
      },
      undefined,
      { timeout: 60_000 },
    )

    const rate = () => editor.evaluate(() => document.querySelector('video')?.playbackRate ?? 0)
    const paused = () => editor.evaluate(() => document.querySelector('video')?.paused ?? true)

    // Park the playhead away from the end so the clip does not run out mid-test.
    await editor.evaluate(() => {
      const video = document.querySelector('video')
      if (video) video.currentTime = 0
    })

    // L plays at 1x, then climbs the ladder.
    await editor.keyboard.press('l')
    await expect.poll(paused).toBe(false)
    await editor.keyboard.press('l')
    await expect.poll(rate).toBe(2)
    await editor.keyboard.press('l')
    await expect.poll(rate).toBe(4)

    // J steps back down.
    await editor.keyboard.press('j')
    await expect.poll(rate).toBe(2)

    // K pauses and keeps the rate.
    await editor.keyboard.press('k')
    await expect.poll(paused).toBe(true)
    expect(await rate()).toBe(2)
  } finally {
    killApp(app)
    await app.close().catch(() => {})
  }
})
