import { type BrowserWindow, app, ipcMain } from 'electron'
import { getRecordingsDir } from '../paths'
import { registerAnalysisHandlers } from './analysis'
import { registerCaptionHandlers } from './captionHandlers'
import { createIpcSession, type IpcContext, type SelectedSource } from './context'
import { registerCursorTrackerHandlers, type RecordingMarkerResult } from './cursorTracker'
import { registerExportFilesHandlers } from './exportFiles'
import { registerFileReadHandlers } from './fileReadHandlers'
import { type HudWindowsContext, registerHudWindowsHandlers } from './hudWindowsHandlers'
import { registerPermissionHandlers } from './permissions'
import { registerProjectStateHandlers } from './projectState'
import { registerRecordingFilesHandlers } from './recordingFiles'

export type { CurrentVideoMetadata } from './cursorTrack'
export type { IpcContext, IpcSession, SelectedSource } from './context'

export type IpcRuntime = {
  /** Stops the cursor tracker and any native recorder; called from `before-quit`. */
  shutdown: () => Promise<void>
  /**
   * D2: flag the current moment in the cursor sidecar. Exposed so the global
   * shortcut registered in `main.ts` writes the same event as the HUD button.
   */
  addRecordingMarker: () => RecordingMarkerResult
}

/**
 * Composition root for the main-process IPC surface. Builds one `IpcContext`
 * and hands it to each domain module (`register*Handlers(ctx)`); the modules
 * own their channels, this file owns nothing but the wiring. Channel names,
 * preload and the renderer `.d.ts` are unchanged by the split.
 */
export function registerIpcHandlers(
  createEditorWindow: () => void,
  createSourceSelectorWindow: () => BrowserWindow,
  createPermissionCheckerWindow: () => BrowserWindow,
  getMainWindow: () => BrowserWindow | null,
  getSourceSelectorWindow: () => BrowserWindow | null,
  getPermissionCheckerWindow: () => BrowserWindow | null,
  onRecordingStateChange?: (recording: boolean, sourceName: string) => void,
  onSourceSelectionChange?: (source: SelectedSource | null) => void,
  hudWindows?: Omit<HudWindowsContext, 'ipcMain'>,
  overrides: Partial<Pick<IpcContext, 'ipcMain' | 'recordingsDir' | 'userDataDir'>> = {},
): IpcRuntime {
  const ctx: IpcContext = {
    ipcMain: overrides.ipcMain ?? ipcMain,
    session: createIpcSession(),
    recordingsDir: overrides.recordingsDir ?? getRecordingsDir(),
    userDataDir: overrides.userDataDir ?? app.getPath('userData'),
    createEditorWindow,
    createSourceSelectorWindow,
    createPermissionCheckerWindow,
    getMainWindow,
    getSourceSelectorWindow,
    getPermissionCheckerWindow,
    onRecordingStateChange,
    onSourceSelectionChange,
  }

  registerFileReadHandlers({ ipcMain: ctx.ipcMain, recordingsDir: ctx.recordingsDir })
  registerCaptionHandlers({
    ipcMain: ctx.ipcMain,
    recordingsDir: ctx.recordingsDir,
    userDataDir: ctx.userDataDir,
  })
  if (hudWindows)
    registerHudWindowsHandlers({
      ipcMain: ctx.ipcMain as HudWindowsContext['ipcMain'],
      ...hudWindows,
    })

  const cursorTracker = registerCursorTrackerHandlers(ctx)
  registerPermissionHandlers(ctx)
  const recordingFiles = registerRecordingFilesHandlers(ctx)
  registerExportFilesHandlers(ctx)
  registerProjectStateHandlers(ctx)
  registerAnalysisHandlers(ctx)

  const shutdown = async (): Promise<void> => {
    try {
      cursorTracker.stopCursorTracker()
    } catch (error) {
      console.warn('[ipc] failed to stop cursor tracker during shutdown:', error)
    }
    await recordingFiles.shutdownNativeRecorder()
  }

  return { shutdown, addRecordingMarker: () => cursorTracker.addRecordingMarker() }
}
