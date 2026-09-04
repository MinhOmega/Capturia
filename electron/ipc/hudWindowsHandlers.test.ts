import type { BrowserWindow } from 'electron'
import { screen } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HudOverlayResult } from '../../src/hooks/useHudLayout'
import { type FakeIpcMain, fakeIpcMain, fakeWindow } from './__tests__/ipcTestKit'
import { getHideHudFromRecording, resetHideHudFromRecording } from '../recordingPrivacy'
import {
  HUD_CURSOR_POLL_MS,
  type HudRecordingPrivacyResult,
  registerHudWindowsHandlers,
} from './hudWindowsHandlers'

vi.mock('electron', async () => (await import('./__tests__/ipcTestKit')).createElectronMock())

const REAL_PLATFORM = process.platform
const REAL_SESSION_TYPE = process.env['XDG_SESSION_TYPE']
function setPlatform(platform: NodeJS.Platform, sessionType = '') {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  process.env['XDG_SESSION_TYPE'] = sessionType
}

type HudWindowState = { bounds: { x: number; y: number; width: number; height: number } }

/** A HUD window whose `webContents` is the sender `ipc.invoke` uses. */
function fakeHudWindow(ipc: FakeIpcMain, bounds = { x: 660, y: 900, width: 600, height: 160 }) {
  const state: HudWindowState = { bounds: { ...bounds } }
  const win = {
    isDestroyed: () => false,
    webContents: ipc.event.sender,
    getBounds: () => ({ ...state.bounds }),
    setBounds: vi.fn((next: Partial<HudWindowState['bounds']>) => {
      state.bounds = { ...state.bounds, ...next }
    }),
    setPosition: vi.fn((x: number, y: number) => {
      state.bounds.x = x
      state.bounds.y = y
    }),
    setIgnoreMouseEvents: vi.fn(),
  }
  return { win: win as unknown as BrowserWindow, mock: win, state }
}

function fakeCountdownWindow(): BrowserWindow {
  return {
    ...fakeWindow(),
    webContents: { send: vi.fn(), isLoading: () => false },
    isVisible: () => true,
    showInactive: vi.fn(),
    hide: vi.fn(),
  } as unknown as BrowserWindow
}

function register(
  ipc: FakeIpcMain,
  hud: BrowserWindow | null,
  countdown?: BrowserWindow,
  extra: Partial<Parameters<typeof registerHudWindowsHandlers>[0]> = {},
) {
  registerHudWindowsHandlers({
    ipcMain: ipc.ipcMain as never,
    createCountdownOverlayWindow: () => countdown ?? fakeCountdownWindow(),
    getCountdownOverlayWindow: () => countdown ?? null,
    createNotesWindow: () => fakeWindow(),
    getNotesWindow: () => null,
    ...(hud !== undefined && { getHudOverlayWindow: () => hud }),
    ...extra,
  })
}

const GEOMETRY_CHANNELS = [
  'hud-overlay-ignore-mouse-events',
  'hud-overlay-move-by',
  'hud-overlay-set-size',
] as const

describe('HUD window IPC handlers', () => {
  beforeEach(() => {
    setPlatform('darwin')
    vi.mocked(screen.getCursorScreenPoint).mockReturnValue({ x: 10, y: 10 })
  })

  afterEach(() => {
    setPlatform(REAL_PLATFORM, REAL_SESSION_TYPE ?? '')
    vi.useRealTimers()
  })

  it('registers the geometry, countdown, Notes and recording-privacy channels', () => {
    const ipc = fakeIpcMain()
    register(ipc, null)
    expect(ipc.registered).toEqual([
      ...GEOMETRY_CHANNELS,
      'countdown-overlay-show',
      'countdown-overlay-set-value',
      'countdown-overlay-hide',
      'open-notes',
      'hud-hide-from-recording-get',
      'hud-hide-from-recording-set',
      'hud-hide-from-recording-reassert',
    ])
  })

  it.each(GEOMETRY_CHANNELS)(
    '%s rejects a sender that is not the HUD renderer',
    async (channel) => {
      const ipc = fakeIpcMain()
      const hud = fakeHudWindow(ipc)
      register(ipc, hud.win)
      const foreignSender = { isDestroyed: () => false, send: vi.fn() }
      const result = await ipc.invokeFrom<HudOverlayResult>(foreignSender, channel, 10, 10)
      expect(result).toEqual({ applied: false, reason: 'wrong-sender' })
      expect(hud.mock.setIgnoreMouseEvents).not.toHaveBeenCalled()
      expect(hud.mock.setPosition).not.toHaveBeenCalled()
      expect(hud.mock.setBounds).not.toHaveBeenCalled()
    },
  )

  it.each(GEOMETRY_CHANNELS)('%s is a no-op without a HUD window', async (channel) => {
    const ipc = fakeIpcMain()
    register(ipc, null)
    expect(await ipc.invoke<HudOverlayResult>(channel, true, 10)).toEqual({
      applied: false,
      reason: 'no-window',
    })
  })

  describe('hud-overlay-ignore-mouse-events', () => {
    it('forwards mouse moves on macOS and re-enables input when the cursor enters a box', async () => {
      vi.useFakeTimers()
      const ipc = fakeIpcMain()
      const hud = fakeHudWindow(ipc)
      register(ipc, hud.win)

      const rects = [{ x: 100, y: 100, width: 400, height: 50 }]
      expect(await ipc.invoke('hud-overlay-ignore-mouse-events', true, rects)).toEqual({
        applied: true,
      })
      expect(hud.mock.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true })

      // Cursor outside every box: still ignoring.
      vi.advanceTimersByTime(HUD_CURSOR_POLL_MS * 3)
      expect(hud.mock.setIgnoreMouseEvents).toHaveBeenCalledTimes(1)

      // Window at (660, 900): box spans screen x 760..1160, y 1000..1050.
      vi.mocked(screen.getCursorScreenPoint).mockReturnValue({ x: 800, y: 1020 })
      vi.advanceTimersByTime(HUD_CURSOR_POLL_MS)
      expect(hud.mock.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false)

      // The poll stops once input is back.
      vi.advanceTimersByTime(HUD_CURSOR_POLL_MS * 5)
      expect(hud.mock.setIgnoreMouseEvents).toHaveBeenCalledTimes(2)
    })

    it('does not forward on Linux X11 and refuses to ignore without boxes to poll', async () => {
      setPlatform('linux', 'x11')
      const ipc = fakeIpcMain()
      const hud = fakeHudWindow(ipc)
      register(ipc, hud.win)

      expect(await ipc.invoke('hud-overlay-ignore-mouse-events', true)).toEqual({
        applied: false,
        reason: 'no-rects',
      })
      expect(hud.mock.setIgnoreMouseEvents).not.toHaveBeenCalled()

      const rects = [{ x: 0, y: 0, width: 10, height: 10 }]
      expect(await ipc.invoke('hud-overlay-ignore-mouse-events', true, rects)).toEqual({
        applied: true,
      })
      expect(hud.mock.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true)
    })

    it('never ignores input on Wayland', async () => {
      setPlatform('linux', 'wayland')
      const ipc = fakeIpcMain()
      const hud = fakeHudWindow(ipc)
      register(ipc, hud.win)
      const rects = [{ x: 0, y: 0, width: 10, height: 10 }]
      expect(await ipc.invoke('hud-overlay-ignore-mouse-events', true, rects)).toEqual({
        applied: false,
        reason: 'wayland',
      })
      expect(hud.mock.setIgnoreMouseEvents).not.toHaveBeenCalled()
    })

    it('re-enables input immediately when asked and rejects non-boolean flags', async () => {
      vi.useFakeTimers()
      const ipc = fakeIpcMain()
      const hud = fakeHudWindow(ipc)
      register(ipc, hud.win)
      await ipc.invoke('hud-overlay-ignore-mouse-events', true, [
        { x: 0, y: 0, width: 10, height: 10 },
      ])
      expect(await ipc.invoke('hud-overlay-ignore-mouse-events', false)).toEqual({
        applied: true,
      })
      expect(hud.mock.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false)
      vi.mocked(screen.getCursorScreenPoint).mockReturnValue({ x: 665, y: 905 })
      vi.advanceTimersByTime(HUD_CURSOR_POLL_MS * 3)
      expect(hud.mock.setIgnoreMouseEvents).toHaveBeenCalledTimes(2)

      expect(await ipc.invoke('hud-overlay-ignore-mouse-events', 'yes')).toEqual({
        applied: false,
        reason: 'bad-args',
      })
    })
  })

  describe('hud-overlay-move-by', () => {
    it('moves by the delta and clamps to the work area of the display under the cursor', async () => {
      const ipc = fakeIpcMain()
      const hud = fakeHudWindow(ipc)
      register(ipc, hud.win)

      expect(await ipc.invoke<HudOverlayResult>('hud-overlay-move-by', -20.4, 10)).toMatchObject({
        applied: true,
        bounds: { x: 640, y: 910 },
      })
      expect(hud.mock.setPosition).toHaveBeenLastCalledWith(640, 910, false)

      // Far past the right/bottom edge of the 1920x1080 work area.
      expect(await ipc.invoke<HudOverlayResult>('hud-overlay-move-by', 5000, 5000)).toMatchObject({
        applied: true,
        bounds: { x: 1320, y: 920 },
      })
      expect(hud.state.bounds).toEqual({ x: 1320, y: 920, width: 600, height: 160 })
      expect(screen.getDisplayNearestPoint).toHaveBeenCalledWith({ x: 10, y: 10 })
    })

    it('rejects non-finite deltas and Wayland sessions', async () => {
      const ipc = fakeIpcMain()
      const hud = fakeHudWindow(ipc)
      register(ipc, hud.win)
      expect(await ipc.invoke('hud-overlay-move-by', Number.NaN, 0)).toEqual({
        applied: false,
        reason: 'bad-args',
      })
      expect(await ipc.invoke('hud-overlay-move-by', 1, '2')).toEqual({
        applied: false,
        reason: 'bad-args',
      })
      setPlatform('linux', 'wayland')
      expect(await ipc.invoke('hud-overlay-move-by', 1, 2)).toEqual({
        applied: false,
        reason: 'wayland',
      })
      expect(hud.mock.setPosition).not.toHaveBeenCalled()
    })
  })

  describe('hud-overlay-set-size', () => {
    it('resizes around the bottom-centre anchor and skips a no-op', async () => {
      const ipc = fakeIpcMain()
      const hud = fakeHudWindow(ipc)
      register(ipc, hud.win)

      expect(await ipc.invoke<HudOverlayResult>('hud-overlay-set-size', 800, 300)).toEqual({
        applied: true,
        bounds: { x: 560, y: 760, width: 800, height: 300 },
      })
      expect(hud.mock.setBounds).toHaveBeenLastCalledWith(
        { x: 560, y: 760, width: 800, height: 300 },
        false,
      )
      expect(await ipc.invoke<HudOverlayResult>('hud-overlay-set-size', 800, 300)).toEqual({
        applied: true,
        bounds: { x: 560, y: 760, width: 800, height: 300 },
      })
      expect(hud.mock.setBounds).toHaveBeenCalledTimes(1)
    })

    it('is ignored while a countdown is running', async () => {
      const ipc = fakeIpcMain()
      const hud = fakeHudWindow(ipc)
      register(ipc, hud.win, fakeCountdownWindow())

      await ipc.invoke('countdown-overlay-show', 3, 42)
      expect(await ipc.invoke('hud-overlay-set-size', 800, 300)).toEqual({
        applied: false,
        reason: 'countdown',
      })
      await ipc.invoke('countdown-overlay-hide', 42)
      expect(await ipc.invoke<HudOverlayResult>('hud-overlay-set-size', 800, 300)).toMatchObject({
        applied: true,
      })
    })

    it('rejects bad sizes and Wayland sessions', async () => {
      const ipc = fakeIpcMain()
      const hud = fakeHudWindow(ipc)
      register(ipc, hud.win)
      expect(await ipc.invoke('hud-overlay-set-size', 100, undefined)).toEqual({
        applied: false,
        reason: 'bad-args',
      })
      setPlatform('linux', 'wayland')
      expect(await ipc.invoke('hud-overlay-set-size', 100, 100)).toEqual({
        applied: false,
        reason: 'wayland',
      })
      expect(hud.mock.setBounds).not.toHaveBeenCalled()
    })
  })

  describe('hideHudFromRecording (D1)', () => {
    afterEach(() => {
      resetHideHudFromRecording()
    })

    it('reports the default (on) without touching any window', async () => {
      const ipc = fakeIpcMain()
      const apply = vi.fn(() => true)
      register(ipc, fakeHudWindow(ipc).win, undefined, { applyHudContentProtection: apply })
      expect(await ipc.invoke<HudRecordingPrivacyResult>('hud-hide-from-recording-get')).toEqual({
        enabled: true,
        protected: [],
        unprotected: [],
      })
      expect(apply).not.toHaveBeenCalled()
    })

    it('applies the setting to the whole HUD family and remembers it', async () => {
      const ipc = fakeIpcMain()
      const hud = fakeHudWindow(ipc)
      const countdown = fakeCountdownWindow()
      const sourceSelector = fakeWindow()
      // Faithful stand-in for `applyHudContentProtection`: it clears protection
      // (and answers false) whenever the preference is off.
      const apply = vi.fn((_win: BrowserWindow, _label: string) => getHideHudFromRecording())
      register(ipc, hud.win, countdown, {
        getSourceSelectorWindow: () => sourceSelector,
        applyHudContentProtection: apply,
      })

      expect(
        await ipc.invoke<HudRecordingPrivacyResult>('hud-hide-from-recording-set', true),
      ).toEqual({
        enabled: true,
        protected: ['HUD', 'Countdown', 'Source selector'],
        unprotected: [],
      })
      expect(apply.mock.calls.map((call) => call[1])).toEqual([
        'HUD',
        'Countdown',
        'Source selector',
      ])
      expect(getHideHudFromRecording()).toBe(true)

      apply.mockClear()
      expect(
        await ipc.invoke<HudRecordingPrivacyResult>('hud-hide-from-recording-set', false),
      ).toEqual({ enabled: false, protected: [], unprotected: [] })
      expect(getHideHudFromRecording()).toBe(false)
      // Still visited: turning the setting off has to clear protection.
      expect(apply).toHaveBeenCalledTimes(3)
    })

    it('re-asserts protection on the windows that are alive at capture time', async () => {
      const ipc = fakeIpcMain()
      const hud = fakeHudWindow(ipc)
      const apply = vi.fn(() => true)
      register(ipc, hud.win, undefined, {
        getSourceSelectorWindow: () => null,
        applyHudContentProtection: apply,
      })

      expect(
        await ipc.invoke<HudRecordingPrivacyResult>('hud-hide-from-recording-reassert'),
      ).toEqual({ enabled: true, protected: ['HUD'], unprotected: [] })
      expect(apply).toHaveBeenCalledTimes(1)
    })

    it('reports the windows the OS refused to protect', async () => {
      const ipc = fakeIpcMain()
      const hud = fakeHudWindow(ipc)
      register(ipc, hud.win, undefined, { applyHudContentProtection: () => false })
      expect(
        await ipc.invoke<HudRecordingPrivacyResult>('hud-hide-from-recording-reassert'),
      ).toEqual({ enabled: true, protected: [], unprotected: ['HUD'] })
    })

    it('ignores a non-boolean value rather than turning the setting off', async () => {
      const ipc = fakeIpcMain()
      register(ipc, null, undefined, { applyHudContentProtection: () => true })
      await ipc.invoke('hud-hide-from-recording-set', 'yes')
      expect(getHideHudFromRecording()).toBe(true)
    })
  })
})
