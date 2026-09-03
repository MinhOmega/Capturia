// @vitest-environment jsdom
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createBrowserBridge,
  installBrowserBridge,
  UNIMPLEMENTED_BRIDGE_METHODS,
} from './browserBridge'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const PRELOAD = path.join(ROOT, 'electron', 'preload.ts')

/**
 * Top-level keys of the object the preload hands to
 * `contextBridge.exposeInMainWorld`. The preload writes one key per line at two
 * spaces of indentation, so the block boundaries plus that indentation identify
 * them without a parser.
 */
function readPreloadBridgeKeys(): string[] {
  const source = fs.readFileSync(PRELOAD, 'utf8')
  const start = source.indexOf('const electronAPI: ElectronAPI = {')
  expect(start).toBeGreaterThanOrEqual(0)
  const body = source.slice(start).split('\n}')[0]
  const keys = new Set<string>()
  for (const line of body.split('\n')) {
    const match = /^ {2}([A-Za-z_][A-Za-z0-9_]*)\s*[:,(]/.exec(line)
    if (match?.[1]) keys.add(match[1])
  }
  return [...keys].sort()
}

describe('browser harness bridge', () => {
  beforeEach(() => {
    window.localStorage.clear()
    delete (window as { electronAPI?: unknown }).electronAPI
    delete window.__capturiaBrowserHarness
  })

  it('covers every method the preload exposes, with no invented ones', () => {
    const preloadKeys = readPreloadBridgeKeys()
    // Sanity check on the extraction itself: the preload is a large object and
    // a silently-empty match would make this whole test vacuous.
    expect(preloadKeys.length).toBeGreaterThan(50)
    expect(preloadKeys).toContain('getCurrentVideoPath')

    const shimKeys = Object.keys(createBrowserBridge().bridge).sort()
    const missing = preloadKeys.filter((key) => !shimKeys.includes(key))
    const extra = shimKeys.filter((key) => !preloadKeys.includes(key))

    expect(
      missing,
      'electron/preload.ts exposes these but src/dev/browserBridge.ts does not implement them',
    ).toEqual([])
    expect(
      extra,
      'src/dev/browserBridge.ts exposes these but electron/preload.ts does not',
    ).toEqual([])
  })

  it('lists only real bridge methods as unimplemented', () => {
    const bridge = createBrowserBridge().bridge as unknown as Record<string, unknown>
    for (const method of UNIMPLEMENTED_BRIDGE_METHODS) {
      expect(
        Object.keys(bridge),
        `${method} is listed as unimplemented but is not a bridge method`,
      ).toContain(method)
      expect(typeof bridge[method]).toBe('function')
    }
  })

  it('names the method in the console when an unimplemented one is called', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {
      // swallow the harness warning; the assertion below inspects the call
    })
    try {
      await createBrowserBridge().bridge.startNativeScreenRecording()
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]?.[0])).toContain('startNativeScreenRecording')
    } finally {
      warn.mockRestore()
    }
  })

  it('opens the fixture recording with a cursor track by default', async () => {
    const result = await createBrowserBridge().bridge.getCurrentVideoPath()
    expect(result.success).toBe(true)
    expect(result.path).toContain('/dev-fixtures/sample.webm')
    // Absolute, so `VideoEditor.toFileUrl` hands it to `<video>` untouched
    // instead of rewriting it to `local-media://`.
    expect(result.path?.startsWith('http')).toBe(true)
    expect(result.metadata?.frameRate).toBe(15)
    expect(result.metadata?.cursorTrack?.samples.length).toBeGreaterThan(10)
  })

  it('round-trips project state and the current recording through localStorage', async () => {
    const bridge = createBrowserBridge().bridge
    expect(await bridge.loadProjectState('/rec.webm')).toEqual({ success: true, notFound: true })

    await bridge.saveProjectState('/rec.webm', { version: 1, wallpaper: '#101820' })
    const loaded = await bridge.loadProjectState('/rec.webm')
    expect(loaded.success).toBe(true)
    expect(loaded.state).toEqual({ version: 1, wallpaper: '#101820' })

    await bridge.setCurrentVideoPath('/other.webm')
    // A second bridge stands in for a page reload: the choice survives it.
    expect((await createBrowserBridge().bridge.getCurrentVideoPath()).path).toBe('/other.webm')
  })

  it('captures exported bytes in memory instead of writing a file', async () => {
    const harness = createBrowserBridge()
    harness.autoDownload = false
    const result = await harness.bridge.saveExportedVideo(new ArrayBuffer(9), 'export.gif')
    expect(result.success).toBe(true)
    expect(result.path).toContain('export.gif')
    expect(harness.exports).toHaveLength(1)
    expect(harness.exports[0]?.byteLength).toBe(9)
  })

  it('delivers main-process pushes to the matching subscriber', () => {
    const harness = createBrowserBridge()
    const seen: string[] = []
    const dispose = harness.bridge.onEditorMenuAction((action) => seen.push(action))

    expect(harness.emit('menu-export')).toBe(1)
    expect(seen).toEqual(['menu-export'])

    dispose()
    expect(harness.emit('menu-export')).toBe(0)
  })

  it('installs on a bare window and stands aside for a real preload bridge', () => {
    expect(installBrowserBridge()).not.toBeNull()
    expect(window.electronAPI.platform).toBe('linux')
    expect(window.__capturiaBrowserHarness?.fixtureUrl).toContain('/dev-fixtures/sample.webm')

    expect(installBrowserBridge()).toBeNull()
  })
})
