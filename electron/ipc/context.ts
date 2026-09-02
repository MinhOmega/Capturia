import type { BrowserWindow, IpcMain } from 'electron'
import type { CurrentVideoMetadata } from './cursorTrack'

/**
 * Shared shape for the `register*Handlers(ctx)` modules that `handlers.ts`
 * assembles. One context object is built per app run; every domain module
 * takes the same object and reads only what it needs.
 *
 * Nothing in here calls into Electron at import time, so each module (and this
 * file) is loadable under vitest with a stubbed `ipcMain`.
 */

export type SelectedSource = {
  id?: string
  name?: string
  display_id?: string | number | null
  width?: number
  height?: number
}

/**
 * Per-run mutable state that more than one domain reads or writes: the source
 * the user picked, and the video currently open in the editor. Modules mutate
 * the fields in place; the object identity never changes.
 */
export type IpcSession = {
  selectedSource: SelectedSource | null
  currentVideoPath: string | null
  currentVideoMetadata: CurrentVideoMetadata | null
}

export function createIpcSession(): IpcSession {
  return {
    selectedSource: null,
    currentVideoPath: null,
    currentVideoMetadata: null,
  }
}

export type IpcContext = {
  ipcMain: Pick<IpcMain, 'handle'>
  session: IpcSession
  /** `<userData>/recordings`; the read/write policy in `./paths` is keyed on it. */
  recordingsDir: string
  /** `<userData>`; project state, shortcuts and caption models live below it. */
  userDataDir: string
  createEditorWindow: () => void
  createSourceSelectorWindow: () => BrowserWindow
  createPermissionCheckerWindow: () => BrowserWindow
  getMainWindow: () => BrowserWindow | null
  getSourceSelectorWindow: () => BrowserWindow | null
  getPermissionCheckerWindow: () => BrowserWindow | null
  onRecordingStateChange?: (recording: boolean, sourceName: string) => void
  onSourceSelectionChange?: (source: SelectedSource | null) => void
}
