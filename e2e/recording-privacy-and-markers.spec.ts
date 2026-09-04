import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, expect, test } from '@playwright/test'

/**
 * P2-D: the two features that only exist once main, the preload bridge and the
 * HUD renderer are all real.
 *
 * D1 - `hideHudFromRecording` round-trips through the preload bridge and main
 * applies it to the whole HUD family. The assertion is deliberately about the
 * *reported* outcome rather than about pixels: Electron exposes no getter for
 * content protection, and on Linux the OS cannot honour it at all, so what the
 * feature owes the user is an honest answer about which windows it managed to
 * protect. A run that claimed success on Linux would be the bug.
 *
 * D2 - the `markMoment` global shortcut is registered at startup, and flagging
 * a moment with no recording running is refused rather than silently dropped.
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

type PrivacyResult = { enabled: boolean; protected: string[]; unprotected: string[] }
type MarkerResult = { added: boolean; reason?: string; timeMs?: number }

test('keeps the HUD out of the recording and flags moments from the bridge', async () => {
  const reason = skipReason()
  test.skip(reason !== null, reason ?? undefined)

  const app = await electron.launch({
    args: [MAIN_JS, '--no-sandbox', '--enable-unsafe-swiftshader'],
    env: {
      ...process.env,
      HEADLESS: process.env['HEADLESS'] ?? '1',
      // The HUD family is content-protected by default now; on a macOS that
      // never paints a protected window the HUD would be invisible to the
      // spec. Leave the shipped default alone and read the reported outcome.
    },
  })
  const electronProcess = app.process()
  electronProcess.stdout?.on('data', (chunk) => process.stdout.write(`[electron] ${chunk}`))
  electronProcess.stderr?.on('data', (chunk) => process.stderr.write(`[electron] ${chunk}`))

  try {
    const hud = await app.firstWindow({ timeout: 60_000 })
    await hud.waitForLoadState('domcontentloaded')
    expect(hud.url()).toContain('windowType=hud-overlay')
    await expect(hud.getByTestId('launch-record-button')).toBeVisible({ timeout: 30_000 })

    // ---- D1: the setting round-trips and main applies it ------------------
    const toggle = hud.getByTestId('launch-hide-hud-from-recording')
    await expect(toggle).toBeVisible()
    // On by default, and the HUD has already pushed that to main on mount.
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')

    const readPrivacy = async (): Promise<PrivacyResult> =>
      (await hud.evaluate(async () => {
        const bridge = (
          window as unknown as {
            electronAPI: { getHideHudFromRecording: () => Promise<unknown> }
          }
        ).electronAPI
        return await bridge.getHideHudFromRecording()
      })) as PrivacyResult

    expect((await readPrivacy()).enabled).toBe(true)

    const reasserted = await hud.evaluate(async () => {
      const bridge = (
        window as unknown as {
          electronAPI: { reassertHudRecordingPrivacy: () => Promise<unknown> }
        }
      ).electronAPI
      return (await bridge.reassertHudRecordingPrivacy()) as unknown
    })
    const privacy = reasserted as PrivacyResult
    expect(privacy.enabled).toBe(true)
    // The HUD window exists, so main must have reported on it one way or the
    // other; which list it lands in is the platform's answer, not ours.
    expect([...privacy.protected, ...privacy.unprotected]).toContain('HUD')
    if (process.platform === 'linux') {
      // Linux has no content-protection API: the honest answer is "could not".
      expect(privacy.protected).not.toContain('HUD')
      expect(privacy.unprotected).toContain('HUD')
    }

    // Turning it off must reach main, not just the renderer's own state.
    // `dispatchEvent` rather than `click`: the HUD is a frameless always-on-top
    // window that main keeps re-fitting to its content, so Playwright's
    // "stable" actionability check never settles on it under HEADLESS=1.
    await toggle.dispatchEvent('click')
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await expect.poll(async () => (await readPrivacy()).enabled).toBe(false)

    await toggle.dispatchEvent('click')
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(async () => (await readPrivacy()).enabled).toBe(true)

    // ---- D2: the global shortcut is registered, and markers need a take ----
    const accelerators = await hud.evaluate(async () => {
      const bridge = (
        window as unknown as { electronAPI: { getGlobalShortcuts: () => Promise<unknown> } }
      ).electronAPI
      return (await bridge.getGlobalShortcuts()) as Record<string, string>
    })
    // Whether the OS grants the grab is not ours to assert - under xvfb even
    // the long-standing stopRecording accelerator is refused - but if the
    // window manager did hand it over it has to be the documented default, and
    // no two global actions may end up on the same accelerator.
    if (accelerators.markMoment !== undefined) {
      expect(accelerators.markMoment).toBe('CommandOrControl+Alt+F')
    }
    const bound = Object.values(accelerators)
    expect(new Set(bound).size).toBe(bound.length)

    const marker = (await hud.evaluate(async () => {
      const bridge = (
        window as unknown as { electronAPI: { addRecordingMarker: () => Promise<unknown> } }
      ).electronAPI
      return (await bridge.addRecordingMarker()) as unknown
    })) as MarkerResult
    expect(marker).toEqual({ added: false, reason: 'not-recording' })
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
