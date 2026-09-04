import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import { screen } from 'electron'
import { getHideHudFromRecording, setHideHudFromRecording } from '../recordingPrivacy'
import {
  anchorPreservingResize,
  clampToWorkArea,
  type HudOverlayResult,
  type HudRect,
  pointInHudRects,
  sanitizeHudRects,
  translateBounds,
} from '../../src/hooks/useHudLayout'

/**
 * IPC for the HUD window family: the launch HUD's own geometry channels
 * (click-through, drag, content-fit resize) and the auxiliary windows
 * (countdown overlay, Notes). Kept out of `handlers.ts` so the window plumbing
 * stays small and readable in isolation.
 */
export type HudWindowsContext = {
  ipcMain: IpcMain
  createCountdownOverlayWindow: () => BrowserWindow
  getCountdownOverlayWindow: () => BrowserWindow | null
  createNotesWindow: () => BrowserWindow
  getNotesWindow: () => BrowserWindow | null
  /**
   * The launch HUD itself. Optional so the geometry channels degrade to a
   * no-op (`reason: 'no-window'`) when the composition root does not wire it.
   */
  getHudOverlayWindow?: () => BrowserWindow | null
  /**
   * D1: the source selector is part of the HUD family for the
   * `hideHudFromRecording` setting, but has no other business here.
   */
  getSourceSelectorWindow?: () => BrowserWindow | null
  /**
   * `applyHudContentProtection` from `electron/windows.ts`, injected so this
   * module stays free of the window layer (and testable). Absent means the
   * composition root did not wire it and the setting reports no windows.
   */
  applyHudContentProtection?: (win: BrowserWindow, label: string) => boolean
}

/** Result of turning `hideHudFromRecording` on or off, or of re-asserting it. */
export type HudRecordingPrivacyResult = {
  /** The preference now in effect in the main process. */
  enabled: boolean
  /** Labels of the windows the OS is now keeping out of captures. */
  protected: string[]
  /**
   * Windows the setting covers whose protection could not be applied - Linux
   * has no equivalent API, and macOS 26 never paints a protected window - so
   * the HUD can warn instead of silently promising privacy it cannot deliver.
   */
  unprotected: string[]
}

/** How often the main process checks whether the cursor re-entered the HUD while it ignores mouse input. */
export const HUD_CURSOR_POLL_MS = 80

/** Wayland compositors ignore client-side positioning and input-shape changes. */
export function isWaylandSession(): boolean {
  return (
    process.platform === 'linux' &&
    (process.env['XDG_SESSION_TYPE'] || '').toLowerCase() === 'wayland'
  )
}

/**
 * `setIgnoreMouseEvents(true, { forward: true })` keeps mouse-move events
 * flowing to the renderer while clicks fall through, so the page can re-enable
 * input the moment the pointer is back over a control. Only macOS honours the
 * option reliably; elsewhere the cursor poll below does that job.
 */
function supportsForwardedMouseMove(): boolean {
  return process.platform === 'darwin'
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Countdown runs are identified by a renderer-chosen token. The overlay only
 * honours `set-value`/`hide` for the run that most recently called `show`, so a
 * late tick from a cancelled countdown can never resurrect the overlay after a
 * newer run (or a cancel) has hidden it.
 */
export function registerHudWindowsHandlers(ctx: HudWindowsContext): void {
  const { ipcMain } = ctx
  let activeCountdownRunId: number | null = null

  const liveWindow = (win: BrowserWindow | null): BrowserWindow | null =>
    win && !win.isDestroyed() ? win : null

  /**
   * D1: apply (or clear) content protection across every window the
   * `hideHudFromRecording` setting covers. Called when the HUD pushes the
   * stored preference on mount, when the user toggles it, and once more right
   * before capture starts - a window that was hidden and restored around the
   * previous take can come back without the flag on some window managers.
   */
  const applyRecordingPrivacy = (): HudRecordingPrivacyResult => {
    const enabled = getHideHudFromRecording()
    const applied: string[] = []
    const failed: string[] = []
    const apply = ctx.applyHudContentProtection
    if (!apply) return { enabled, protected: applied, unprotected: failed }

    const targets: Array<[string, BrowserWindow | null]> = [
      ['HUD', liveWindow(ctx.getHudOverlayWindow?.() ?? null)],
      ['Countdown', liveWindow(ctx.getCountdownOverlayWindow())],
      ['Source selector', liveWindow(ctx.getSourceSelectorWindow?.() ?? null)],
    ]
    for (const [label, win] of targets) {
      if (!win) continue
      if (apply(win, label)) applied.push(label)
      else if (enabled) failed.push(label)
    }
    return { enabled, protected: applied, unprotected: failed }
  }

  /**
   * The geometry channels act on the HUD window only, and only for the HUD's
   * own renderer: any other window asking to move or resize the HUD is refused.
   */
  const hudForSender = (
    event: IpcMainInvokeEvent,
  ): { win: BrowserWindow; result?: undefined } | { win?: undefined; result: HudOverlayResult } => {
    const win = liveWindow(ctx.getHudOverlayWindow?.() ?? null)
    if (!win) return { result: { applied: false, reason: 'no-window' } }
    if (event.sender !== win.webContents) {
      return { result: { applied: false, reason: 'wrong-sender' } }
    }
    return { win }
  }

  // While the HUD ignores mouse input, the renderer may never see the pointer
  // come back (no forwarded moves outside macOS), so main watches the cursor
  // against the interactive boxes the renderer reported and re-enables input
  // when it enters one. The renderer then takes over again on its next
  // pointer event.
  let interactiveRects: HudRect[] = []
  let cursorPoll: NodeJS.Timeout | null = null
  const stopCursorPoll = () => {
    if (cursorPoll) {
      clearInterval(cursorPoll)
      cursorPoll = null
    }
  }
  const startCursorPoll = (win: BrowserWindow) => {
    stopCursorPoll()
    cursorPoll = setInterval(() => {
      if (win.isDestroyed()) {
        stopCursorPoll()
        return
      }
      const cursor = screen.getCursorScreenPoint()
      if (pointInHudRects(cursor, interactiveRects, win.getBounds())) {
        win.setIgnoreMouseEvents(false)
        stopCursorPoll()
      }
    }, HUD_CURSOR_POLL_MS)
    cursorPoll.unref?.()
  }

  ipcMain.handle(
    'hud-overlay-ignore-mouse-events',
    (event, ignore: unknown, rects?: unknown): HudOverlayResult => {
      const target = hudForSender(event)
      if (target.result) return target.result
      const { win } = target
      if (typeof ignore !== 'boolean') return { applied: false, reason: 'bad-args' }

      if (!ignore) {
        stopCursorPoll()
        win.setIgnoreMouseEvents(false)
        return { applied: true }
      }
      if (isWaylandSession()) return { applied: false, reason: 'wayland' }

      interactiveRects = sanitizeHudRects(rects)
      const forward = supportsForwardedMouseMove()
      // Without forwarded moves and without boxes to poll, nothing could ever
      // bring input back: refuse rather than strand the window.
      if (!forward && interactiveRects.length === 0) {
        return { applied: false, reason: 'no-rects' }
      }
      if (forward) {
        win.setIgnoreMouseEvents(true, { forward: true })
      } else {
        win.setIgnoreMouseEvents(true)
      }
      if (interactiveRects.length > 0) startCursorPoll(win)
      return { applied: true }
    },
  )

  ipcMain.handle(
    'hud-overlay-move-by',
    (event, deltaX: unknown, deltaY: unknown): HudOverlayResult => {
      const target = hudForSender(event)
      if (target.result) return target.result
      const { win } = target
      if (!isFiniteNumber(deltaX) || !isFiniteNumber(deltaY)) {
        return { applied: false, reason: 'bad-args' }
      }
      if (isWaylandSession()) return { applied: false, reason: 'wayland' }

      const bounds = win.getBounds()
      const moved = translateBounds(bounds, deltaX, deltaY)
      // Clamp to the display under the cursor (the hand doing the dragging), so
      // the HUD can cross into another display and still never leave a screen.
      const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
      const next = clampToWorkArea(moved, workArea)
      if (next.x !== bounds.x || next.y !== bounds.y) {
        win.setPosition(next.x, next.y, false)
      }
      return { applied: true, bounds: next }
    },
  )

  ipcMain.handle(
    'hud-overlay-set-size',
    (event, width: unknown, height: unknown): HudOverlayResult => {
      const target = hudForSender(event)
      if (target.result) return target.result
      const { win } = target
      if (!isFiniteNumber(width) || !isFiniteNumber(height)) {
        return { applied: false, reason: 'bad-args' }
      }
      // The countdown overlay is centred on the display and the HUD is about to
      // switch to its compact bar; resizing mid-countdown only makes the bar hop.
      if (activeCountdownRunId !== null) return { applied: false, reason: 'countdown' }
      if (isWaylandSession()) return { applied: false, reason: 'wayland' }

      const bounds = win.getBounds()
      const { workArea } = screen.getDisplayMatching(bounds)
      const next = anchorPreservingResize(bounds, { width, height }, workArea)
      if (
        next.x === bounds.x &&
        next.y === bounds.y &&
        next.width === bounds.width &&
        next.height === bounds.height
      ) {
        return { applied: true, bounds }
      }
      win.setBounds(next, false)
      return { applied: true, bounds: next }
    },
  )

  ipcMain.handle('countdown-overlay-show', async (_, value: number, runId: number) => {
    activeCountdownRunId = runId
    const overlayWindow =
      liveWindow(ctx.getCountdownOverlayWindow()) ?? ctx.createCountdownOverlayWindow()
    if (overlayWindow.isDestroyed()) return

    // Wait for the first frame before showing, else Chromium flashes a black
    // rectangle because it hasn't rendered any pixels yet.
    if (overlayWindow.webContents.isLoading()) {
      await new Promise<void>((resolve) => {
        overlayWindow.once('ready-to-show', () => resolve())
      })
    }
    // The countdown may have been cancelled while the overlay was still loading.
    if (activeCountdownRunId !== runId || overlayWindow.isDestroyed()) return

    if (!overlayWindow.isVisible()) {
      overlayWindow.showInactive()
    }
    overlayWindow.webContents.send('countdown-overlay-value', value, runId)
  })

  ipcMain.handle('countdown-overlay-set-value', (_, value: number, runId: number) => {
    if (activeCountdownRunId !== runId) return
    const overlayWindow = liveWindow(ctx.getCountdownOverlayWindow())
    if (!overlayWindow) return
    overlayWindow.webContents.send('countdown-overlay-value', value, runId)
  })

  ipcMain.handle('countdown-overlay-hide', (_, runId: number) => {
    if (activeCountdownRunId !== runId) return
    activeCountdownRunId = null
    const overlayWindow = liveWindow(ctx.getCountdownOverlayWindow())
    if (!overlayWindow) return
    overlayWindow.webContents.send('countdown-overlay-value', null, runId)
    overlayWindow.hide()
  })

  // One Notes window at a time: a second request focuses the existing one.
  ipcMain.handle('open-notes', () => {
    if (process.platform === 'linux') {
      // No content protection on Linux: the window would end up in the recording.
      return { success: false, message: 'Notes window is not supported on Linux.' }
    }
    const existing = liveWindow(ctx.getNotesWindow())
    if (existing) {
      if (existing.isMinimized()) existing.restore()
      existing.show()
      existing.focus()
      return { success: true, focused: true }
    }
    ctx.createNotesWindow()
    return { success: true, focused: false }
  })

  // D1: `hideHudFromRecording`. The HUD owns the stored preference and pushes
  // it here; main owns applying it to the windows.
  ipcMain.handle('hud-hide-from-recording-get', (): HudRecordingPrivacyResult => {
    return { enabled: getHideHudFromRecording(), protected: [], unprotected: [] }
  })

  ipcMain.handle('hud-hide-from-recording-set', (_, enabled: unknown) => {
    setHideHudFromRecording(enabled)
    return applyRecordingPrivacy()
  })

  // Re-assert right before `getDisplayMedia` / the native helper starts.
  ipcMain.handle('hud-hide-from-recording-reassert', () => applyRecordingPrivacy())
}
