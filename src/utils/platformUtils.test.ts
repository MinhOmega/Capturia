// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  formatShortcut,
  getPlatform,
  getPlatformSync,
  guessPlatformFromNavigator,
  isMac,
  isMacSync,
  resetPlatformCacheForTests,
} from './platformUtils'

type BridgeShape = { platform?: string; getPlatform?: () => Promise<string> }

function setBridge(bridge: BridgeShape | undefined) {
  Object.defineProperty(window, 'electronAPI', {
    value: bridge,
    configurable: true,
    writable: true,
  })
}

describe('platformUtils', () => {
  beforeEach(() => {
    resetPlatformCacheForTests()
  })

  afterEach(() => {
    setBridge(undefined)
    vi.restoreAllMocks()
  })

  it('getPlatformSync reads the preload snapshot without any IPC', () => {
    const getPlatformIpc = vi.fn(async () => 'linux')
    setBridge({ platform: 'darwin', getPlatform: getPlatformIpc })
    expect(getPlatformSync()).toBe('darwin')
    expect(isMacSync()).toBe(true)
    expect(getPlatformIpc).not.toHaveBeenCalled()
  })

  it('getPlatform resolves from the snapshot and never invokes get-platform', async () => {
    const getPlatformIpc = vi.fn(async () => 'linux')
    setBridge({ platform: 'win32', getPlatform: getPlatformIpc })
    await expect(getPlatform()).resolves.toBe('win32')
    await expect(isMac()).resolves.toBe(false)
    expect(getPlatformIpc).not.toHaveBeenCalled()
  })

  it('falls back to the get-platform IPC when the preload has no snapshot', async () => {
    const getPlatformIpc = vi.fn(async () => 'darwin')
    setBridge({ getPlatform: getPlatformIpc })
    await expect(getPlatform()).resolves.toBe('darwin')
    expect(getPlatformIpc).toHaveBeenCalledTimes(1)
    // The IPC answer is cached for the sync reader and later async calls.
    expect(getPlatformSync()).toBe('darwin')
    await getPlatform()
    expect(getPlatformIpc).toHaveBeenCalledTimes(1)
  })

  it('guesses from navigator when there is no bridge at all', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    setBridge(undefined)
    const guess = guessPlatformFromNavigator()
    expect(getPlatformSync()).toBe(guess)
    await expect(getPlatform()).resolves.toBe(guess)
  })

  it('guessPlatformFromNavigator maps common hints', () => {
    expect(guessPlatformFromNavigator({ platform: 'MacIntel' })).toBe('darwin')
    expect(guessPlatformFromNavigator({ platform: 'Linux x86_64' })).toBe('linux')
    expect(guessPlatformFromNavigator({ platform: 'Win32' })).toBe('win32')
    expect(guessPlatformFromNavigator({ platform: '', userAgent: 'X11; Linux' })).toBe('linux')
    expect(guessPlatformFromNavigator(undefined)).toBe('win32')
  })

  it('formatShortcut uses platform glyphs from the snapshot', async () => {
    setBridge({ platform: 'darwin' })
    await expect(formatShortcut(['mod', 'shift', 'D'])).resolves.toBe('⌘ + ⇧ + D')
    setBridge({ platform: 'linux' })
    await expect(formatShortcut(['mod', 'shift', 'D'])).resolves.toBe('Ctrl + Shift + D')
  })
})
