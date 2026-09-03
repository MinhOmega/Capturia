import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildContext, fakeIpcMain } from './__tests__/ipcTestKit'
import { normalizeSourceRef, registerCursorTrackerHandlers } from './cursorTracker'

vi.mock('electron', async () => (await import('./__tests__/ipcTestKit')).createElectronMock())
vi.mock('../native/cursorKindMonitor', () => ({
  getNativeCursorKind: () => 'arrow',
  startNativeCursorKindMonitor: vi.fn(async () => undefined),
  stopNativeCursorKindMonitor: vi.fn(),
}))
vi.mock('../native/mouseButtonMonitor', () => ({
  drainNativeMouseButtonTransitions: () => [],
  startNativeMouseButtonMonitor: vi.fn(async () => false),
  stopNativeMouseButtonMonitor: vi.fn(),
}))
vi.mock('./windowBounds', () => ({
  getWindowBoundsById: vi.fn(async () => null),
  parseWindowIdFromSourceId: () => undefined,
}))

const REAL_PLATFORM = process.platform
const REAL_SESSION_TYPE = process.env['XDG_SESSION_TYPE']
function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

describe('cursor tracker IPC handlers', () => {
  afterEach(() => {
    setPlatform(REAL_PLATFORM)
    if (REAL_SESSION_TYPE === undefined) delete process.env['XDG_SESSION_TYPE']
    else process.env['XDG_SESSION_TYPE'] = REAL_SESSION_TYPE
    vi.restoreAllMocks()
  })

  it('registers the tracker channels', () => {
    const ipc = fakeIpcMain()
    registerCursorTrackerHandlers(buildContext(ipc))
    expect(ipc.registered).toEqual([
      'cursor-tracker-start',
      'cursor-tracker-pause',
      'cursor-tracker-resume',
      'cursor-tracker-stop',
    ])
  })

  it('pause / resume without a tracker report failure', async () => {
    const ipc = fakeIpcMain()
    registerCursorTrackerHandlers(buildContext(ipc))
    await expect(ipc.invoke('cursor-tracker-pause')).resolves.toMatchObject({ success: false })
    await expect(ipc.invoke('cursor-tracker-resume')).resolves.toMatchObject({ success: false })
  })

  it('compacts paused time out of the track: no sample inside the pause, later ones shifted back', async () => {
    setPlatform('linux')
    process.env['XDG_SESSION_TYPE'] = 'x11'
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.useFakeTimers()
    try {
      const ipc = fakeIpcMain()
      const ctx = buildContext(ipc)
      ctx.session.selectedSource = { id: 'screen:1:0', display_id: '1' }
      registerCursorTrackerHandlers(ctx)
      await ipc.invoke('cursor-tracker-start', { captureSize: { width: 1920, height: 1080 } })

      vi.advanceTimersByTime(200)
      await expect(ipc.invoke('cursor-tracker-pause')).resolves.toEqual({
        success: true,
        changed: true,
      })
      // Second pause is a no-op, not a second range.
      await expect(ipc.invoke('cursor-tracker-pause')).resolves.toEqual({
        success: true,
        changed: false,
      })
      vi.advanceTimersByTime(1_000)
      await expect(ipc.invoke('cursor-tracker-resume')).resolves.toEqual({
        success: true,
        changed: true,
      })
      vi.advanceTimersByTime(200)

      const stopped = await ipc.invoke<{
        track?: { samples: Array<{ timeMs: number }>; stats?: { sampleCount?: number } }
      }>('cursor-tracker-stop')
      const times = stopped.track?.samples.map((sample) => sample.timeMs) ?? []
      expect(times.length).toBeGreaterThan(0)
      // The recording lasted 1400 ms of wall clock but only 400 ms of timeline.
      expect(Math.max(...times)).toBeLessThanOrEqual(400)
      // Samples taken after the resume were shifted back into 200..400.
      expect(times.some((timeMs) => timeMs > 200)).toBe(true)
      expect(stopped.track?.stats?.sampleCount).toBe(times.length)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stop without start returns no track', async () => {
    const ipc = fakeIpcMain()
    const registration = registerCursorTrackerHandlers(buildContext(ipc))
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await expect(ipc.invoke('cursor-tracker-stop')).resolves.toEqual({
      success: true,
      track: undefined,
    })
    expect(registration.stopCursorTracker()).toBeUndefined()
  })

  it('refuses to track on Wayland with a warning code', async () => {
    setPlatform('linux')
    process.env['XDG_SESSION_TYPE'] = 'wayland'
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const ipc = fakeIpcMain()
    registerCursorTrackerHandlers(buildContext(ipc))
    await expect(ipc.invoke('cursor-tracker-start', {})).resolves.toMatchObject({
      success: false,
      warningCode: 'WAYLAND_UNSUPPORTED',
    })
  })

  it('starts, samples the cursor and returns a sanitized track on stop', async () => {
    setPlatform('linux')
    process.env['XDG_SESSION_TYPE'] = 'x11'
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.useFakeTimers()
    try {
      const ipc = fakeIpcMain()
      const ctx = buildContext(ipc)
      ctx.session.selectedSource = { id: 'screen:1:0', display_id: '1' }
      registerCursorTrackerHandlers(ctx)

      const started = await ipc.invoke<{ success: boolean; warningCode?: string }>(
        'cursor-tracker-start',
        {
          captureSize: { width: 1920, height: 1080 },
        },
      )
      expect(started.success).toBe(true)
      // No native mouse monitor in the test: the tracker says so.
      expect(started.warningCode).toBe('mouse_button_fallback')

      vi.advanceTimersByTime(100)
      const stopped = await ipc.invoke<{
        success: boolean
        track?: { samples: unknown[]; space?: { mode?: string } }
      }>('cursor-tracker-stop')
      expect(stopped.success).toBe(true)
      expect(stopped.track?.samples.length).toBeGreaterThan(0)
      expect(stopped.track?.space?.mode).toBe('source-display')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('normalizeSourceRef', () => {
  it('keeps id and stringifies display_id, else undefined', () => {
    expect(normalizeSourceRef(null)).toBeUndefined()
    expect(normalizeSourceRef({})).toBeUndefined()
    expect(normalizeSourceRef({ id: 'screen:1:0', display_id: 1 })).toEqual({
      id: 'screen:1:0',
      display_id: '1',
    })
    expect(normalizeSourceRef({ display_id: 2 })).toEqual({ id: undefined, display_id: '2' })
  })
})
