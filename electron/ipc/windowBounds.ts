import { app } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

/**
 * Global bounds of a captured window on macOS, read through the prebuilt
 * `window-bounds-helper` binary (`electron/native/macos/window-bounds-helper.swift`,
 * compiled by `scripts/build-native-macos-helper.mjs` and shipped under
 * `Contents/Resources/native/`). The helper used to be compiled at runtime from
 * Swift source written into `userData`; that put a compiler run inside
 * Capturia's TCC scope and silently failed on Macs without the Xcode command
 * line tools. Nothing here spawns `swiftc` any more: a missing binary is
 * reported once and `getWindowBoundsById` answers `null`, which the cursor
 * tracker treats as "use the heuristic mapping".
 */

export type WindowBounds = { x: number; y: number; width: number; height: number }

const execFileAsync = promisify(execFile)

export const WINDOW_BOUNDS_HELPER_NAME = 'window-bounds-helper'

let helperBinaryPathPromise: Promise<string | null> | null = null

/**
 * Where the packaged app and a dev checkout keep the helper. Same layout as the
 * other native helpers (`sckRecorder.ts`): `Resources/native/<name>` when
 * packaged, `electron/native/bin/<name>` in development.
 */
export function resolveWindowBoundsHelperPath(env: {
  isPackaged: boolean
  resourcesPath: string
  appPath: string
}): string {
  return env.isPackaged
    ? path.join(env.resourcesPath, 'native', WINDOW_BOUNDS_HELPER_NAME)
    : path.join(env.appPath, 'electron', 'native', 'bin', WINDOW_BOUNDS_HELPER_NAME)
}

/**
 * `{"x":..,"y":..,"width":..,"height":..}` from the helper's stdout, or `null`
 * for anything that is not a finite, positively sized rectangle.
 */
export function parseWindowBoundsOutput(stdout: string): WindowBounds | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const row = parsed as Partial<Record<keyof WindowBounds, unknown>>
  const x = Number(row.x)
  const y = Number(row.y)
  const width = Number(row.width)
  const height = Number(row.height)
  if (![x, y, width, height].every((value) => Number.isFinite(value))) return null
  if (width <= 0 || height <= 0) return null
  return { x, y, width: Math.max(1, width), height: Math.max(1, height) }
}

async function ensureWindowBoundsHelperBinary(): Promise<string | null> {
  if (process.platform !== 'darwin') {
    return null
  }
  if (helperBinaryPathPromise) {
    return helperBinaryPathPromise
  }

  helperBinaryPathPromise = (async () => {
    const binaryPath = resolveWindowBoundsHelperPath({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
    })
    try {
      await fs.access(binaryPath, fs.constants.X_OK)
      return binaryPath
    } catch {
      console.warn(
        `[window-bounds] helper missing at ${binaryPath}; window cursor mapping falls back to the heuristic. ` +
          (app.isPackaged
            ? 'The packaged app is incomplete (extraResources).'
            : 'Run `npm run build:native` on a Mac with the Xcode command line tools.'),
      )
      return null
    }
  })()

  return helperBinaryPathPromise
}

/** Test seam: forget the cached helper lookup. */
export function resetWindowBoundsHelperCacheForTests(): void {
  helperBinaryPathPromise = null
}

export function parseWindowIdFromSourceId(sourceId?: string | null): number | undefined {
  if (!sourceId || !sourceId.startsWith('window:')) return undefined
  const match = sourceId.match(/^window:(\d+):/)
  if (!match) return undefined
  const value = Number(match[1])
  if (!Number.isFinite(value) || value <= 0) return undefined
  return Math.floor(value)
}

export async function getWindowBoundsById(windowId: number): Promise<WindowBounds | null> {
  if (process.platform !== 'darwin') return null
  if (!Number.isFinite(windowId) || windowId <= 0) return null

  const binaryPath = await ensureWindowBoundsHelperBinary()
  if (!binaryPath) return null

  try {
    const { stdout } = await execFileAsync(binaryPath, [String(Math.floor(windowId))], {
      timeout: 1_200,
      maxBuffer: 64 * 1024,
    })
    return parseWindowBoundsOutput(String(stdout))
  } catch {
    return null
  }
}
