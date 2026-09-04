import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetHideHudFromRecording, setHideHudFromRecording } from './recordingPrivacy'
import { applyHudContentProtection } from './windows'

vi.mock('electron', async () => (await import('./ipc/__tests__/ipcTestKit')).createElectronMock())

const REAL_PLATFORM = process.platform
function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

/** Minimal window: the only thing under test is what lands on `setContentProtection`. */
function fakeWindow(destroyed = false) {
  const setContentProtection = vi.fn()
  return {
    win: { isDestroyed: () => destroyed, setContentProtection } as unknown as Parameters<
      typeof applyHudContentProtection
    >[0],
    setContentProtection,
  }
}

describe('applyHudContentProtection (D1)', () => {
  afterEach(() => {
    setPlatform(REAL_PLATFORM)
    resetHideHudFromRecording()
    vi.restoreAllMocks()
  })

  it('turns protection on for the HUD family when the setting is on', () => {
    setPlatform('darwin')
    const { win, setContentProtection } = fakeWindow()
    expect(applyHudContentProtection(win, 'HUD')).toBe(true)
    expect(setContentProtection).toHaveBeenCalledWith(true)
  })

  it('clears protection when the user turns the setting off', () => {
    setPlatform('darwin')
    setHideHudFromRecording(false)
    const { win, setContentProtection } = fakeWindow()
    expect(applyHudContentProtection(win, 'HUD')).toBe(false)
    expect(setContentProtection).toHaveBeenCalledWith(false)
  })

  it('reports failure on Linux, which has no way to hide a window from capture', () => {
    setPlatform('linux')
    const { win, setContentProtection } = fakeWindow()
    expect(applyHudContentProtection(win, 'HUD')).toBe(false)
    // Not called at all: Electron accepts the flag on Linux and does nothing,
    // so calling it would only make the result look like a promise was kept.
    expect(setContentProtection).not.toHaveBeenCalled()
  })

  it('never touches a destroyed window', () => {
    setPlatform('darwin')
    const { win, setContentProtection } = fakeWindow(true)
    expect(applyHudContentProtection(win, 'HUD')).toBe(false)
    expect(setContentProtection).not.toHaveBeenCalled()
  })
})
