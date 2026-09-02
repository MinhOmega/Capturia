import type { BrowserWindow, IpcMain } from 'electron'

/**
 * IPC for the auxiliary HUD windows (countdown overlay, Notes). Kept out of
 * `handlers.ts` so the window plumbing stays small and readable in isolation.
 */
export type HudWindowsContext = {
  ipcMain: IpcMain
  createCountdownOverlayWindow: () => BrowserWindow
  getCountdownOverlayWindow: () => BrowserWindow | null
  createNotesWindow: () => BrowserWindow
  getNotesWindow: () => BrowserWindow | null
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
}
