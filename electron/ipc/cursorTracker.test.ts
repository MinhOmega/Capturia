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
      'cursor-tracker-marker',
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

  it('keeps the whole track of a long recording instead of dropping its oldest samples', async () => {
    setPlatform('linux')
    process.env['XDG_SESSION_TYPE'] = 'x11'
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    vi.useFakeTimers()
    try {
      const { screen } = await import('electron')
      // A cursor that actually moves, so every tick stores a sample (~60 Hz),
      // which is what a real recording does and what used to overflow the buffer.
      let step = 0
      vi.mocked(screen.getCursorScreenPoint).mockImplementation(() => {
        step += 1
        return { x: 100 + (step % 800), y: 100 + (step % 600) }
      })

      const ipc = fakeIpcMain()
      const ctx = buildContext(ipc)
      ctx.session.selectedSource = { id: 'screen:1:0', display_id: '1' }
      registerCursorTrackerHandlers(ctx)
      await ipc.invoke('cursor-tracker-start', { captureSize: { width: 1920, height: 1080 } })

      const durationMs = 10 * 60 * 1_000
      vi.advanceTimersByTime(durationMs)

      const stopped = await ipc.invoke<{
        track?: { samples: Array<{ timeMs: number }> }
      }>('cursor-tracker-stop')
      const times = stopped.track?.samples.map((sample) => sample.timeMs) ?? []

      // The old 12 000-sample buffer dropped its head, so a 10-minute recording
      // started somewhere around minute 7. It now starts at zero...
      expect(times[0]).toBeLessThanOrEqual(50)
      // ... and still reaches the end.
      expect(times[times.length - 1]).toBeGreaterThan(durationMs - 100)
      // Decimated to ~30 Hz on the way out, not stored raw.
      expect(times.length).toBeGreaterThan(10_000)
      expect(times.length).toBeLessThan(durationMs / 25)
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

describe('recording markers (D2)', () => {
  afterEach(() => {
    setPlatform(REAL_PLATFORM)
    if (REAL_SESSION_TYPE === undefined) delete process.env['XDG_SESSION_TYPE']
    else process.env['XDG_SESSION_TYPE'] = REAL_SESSION_TYPE
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  async function startTracker() {
    setPlatform('linux')
    process.env['XDG_SESSION_TYPE'] = 'x11'
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.useFakeTimers()
    const ipc = fakeIpcMain()
    const ctx = buildContext(ipc)
    ctx.session.selectedSource = { id: 'screen:1:0', display_id: '1' }
    const registration = registerCursorTrackerHandlers(ctx)
    await ipc.invoke('cursor-tracker-start', { captureSize: { width: 1920, height: 1080 } })
    return { ipc, registration }
  }

  it('refuses a marker when nothing is recording', async () => {
    const ipc = fakeIpcMain()
    const registration = registerCursorTrackerHandlers(buildContext(ipc))
    expect(registration.addRecordingMarker()).toEqual({ added: false, reason: 'not-recording' })
    await expect(ipc.invoke('cursor-tracker-marker')).resolves.toEqual({
      added: false,
      reason: 'not-recording',
    })
  })

  it('writes a marker at the recording-relative time and counts it', async () => {
    const { ipc } = await startTracker()
    vi.advanceTimersByTime(1_500)
    await expect(ipc.invoke('cursor-tracker-marker')).resolves.toEqual({
      added: true,
      timeMs: 1_500,
      count: 1,
    })
    vi.advanceTimersByTime(500)
    await expect(ipc.invoke('cursor-tracker-marker')).resolves.toMatchObject({ count: 2 })

    const stopped = await ipc.invoke<{ track?: { events?: Array<{ type: string }> } }>(
      'cursor-tracker-stop',
    )
    expect(stopped.track?.events?.filter((event) => event.type === 'marker')).toEqual([
      { type: 'marker', timeMs: 1_500 },
      { type: 'marker', timeMs: 2_000 },
    ])
  })

  it('refuses a marker while the recording is paused', async () => {
    const { ipc } = await startTracker()
    vi.advanceTimersByTime(300)
    await ipc.invoke('cursor-tracker-pause')
    await expect(ipc.invoke('cursor-tracker-marker')).resolves.toEqual({
      added: false,
      reason: 'paused',
    })
    await ipc.invoke('cursor-tracker-resume')
    await expect(ipc.invoke('cursor-tracker-marker')).resolves.toMatchObject({ added: true })
  })

  it('the shortcut path and the channel write the same event', async () => {
    const { ipc, registration } = await startTracker()
    vi.advanceTimersByTime(700)
    expect(registration.addRecordingMarker()).toEqual({ added: true, timeMs: 700, count: 1 })

    const stopped = await ipc.invoke<{ track?: { events?: Array<{ type: string }> } }>(
      'cursor-tracker-stop',
    )
    expect(stopped.track?.events).toEqual([{ type: 'marker', timeMs: 700 }])
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
