import { contextBridge, ipcRenderer } from 'electron'

// C-1: the caption worker cannot call IPC, so the main process hands the editor
// window two file:// URLs through webPreferences.additionalArguments (see
// electron/windows.ts). Absent in the other windows -> empty string.
function readArgUrl(prefix: string): string {
  const arg = process.argv.find((entry) => entry.startsWith(prefix))
  return arg ? arg.slice(prefix.length) : ''
}
const assetBaseUrl = readArgUrl('--asset-base-url=')
const captionModelDirUrl = readArgUrl('--caption-model-dir=')

contextBridge.exposeInMainWorld('electronAPI', {
  hudOverlayHide: () => {
    ipcRenderer.send('hud-overlay-hide')
  },
  hudOverlayClose: () => {
    ipcRenderer.send('hud-overlay-close')
  },
  hudOverlayResize: (_width?: number, _height?: number) => {
    ipcRenderer.send('hud-overlay-resize')
  },
  hudOverlayRestore: () => {
    ipcRenderer.send('hud-overlay-restore')
  },
  setLocale: (locale: string) => {
    return ipcRenderer.invoke('set-locale', locale)
  },
  getAssetBasePath: async () => {
    // ask main process for the correct base path (production vs dev)
    return await ipcRenderer.invoke('get-asset-base-path')
  },
  getSources: async (opts: Electron.SourcesOptions) => {
    return await ipcRenderer.invoke('get-sources', opts)
  },
  getScreenCaptureAccessStatus: async () => {
    return await ipcRenderer.invoke('get-screen-capture-access-status')
  },
  getCapturePermissionSnapshot: async () => {
    return await ipcRenderer.invoke('get-capture-permission-snapshot')
  },
  requestCapturePermissionAccess: async (
    target: 'screen' | 'camera' | 'microphone' | 'accessibility' | 'input-monitoring',
  ) => {
    return await ipcRenderer.invoke('request-capture-permission-access', target)
  },
  openScreenCaptureSettings: async () => {
    return await ipcRenderer.invoke('open-screen-capture-settings')
  },
  openPermissionSettings: async (
    target: 'screen-capture' | 'camera' | 'microphone' | 'accessibility' | 'input-monitoring',
  ) => {
    return await ipcRenderer.invoke('open-permission-settings', target)
  },
  openPermissionChecker: async () => {
    return await ipcRenderer.invoke('open-permission-checker')
  },
  switchToEditor: () => {
    return ipcRenderer.invoke('switch-to-editor')
  },
  switchToLaunch: () => {
    return ipcRenderer.invoke('switch-to-launch')
  },
  openSourceSelector: () => {
    return ipcRenderer.invoke('open-source-selector')
  },
  selectSource: (source: unknown) => {
    return ipcRenderer.invoke('select-source', source)
  },
  getSelectedSource: () => {
    return ipcRenderer.invoke('get-selected-source')
  },

  storeRecordedVideo: (
    videoData: ArrayBuffer,
    fileName: string,
    metadata?: {
      frameRate?: number
      width?: number
      height?: number
      mimeType?: string
      capturedAt?: number
      systemCursorMode?: 'always' | 'never'
      hasMicrophoneAudio?: boolean
      durationMs?: number
      cursorTrack?: {
        source?: 'recorded' | 'synthetic'
        samples: Array<{
          timeMs: number
          x: number
          y: number
          click?: boolean
          visible?: boolean
          cursorKind?: 'arrow' | 'ibeam'
        }>
        events?: Array<{
          type: 'click' | 'selection'
          startMs: number
          endMs: number
          point: { x: number; y: number }
          startPoint?: { x: number; y: number }
          endPoint?: { x: number; y: number }
          bounds?: {
            minX: number
            minY: number
            maxX: number
            maxY: number
            width: number
            height: number
          }
        }>
      }
    },
  ) => {
    return ipcRenderer.invoke('store-recorded-video', videoData, fileName, metadata)
  },
  // Streaming recordings: chunks are appended to the recordings dir as they arrive so
  // the renderer never has to hold a long recording in memory.
  openRecordingStream: (fileName: string) => {
    return ipcRenderer.invoke('open-recording-stream', fileName)
  },
  appendRecordingChunk: (fileName: string, chunk: ArrayBuffer) => {
    return ipcRenderer.invoke('append-recording-chunk', fileName, chunk)
  },
  closeRecordingStream: (fileName: string) => {
    return ipcRenderer.invoke('close-recording-stream', fileName)
  },

  getRecordedVideoPath: () => {
    return ipcRenderer.invoke('get-recorded-video-path')
  },
  setRecordingState: (recording: boolean) => {
    return ipcRenderer.invoke('set-recording-state', recording)
  },
  startNativeScreenRecording: (options?: {
    source?: { id?: string; display_id?: string | number | null }
    cursorMode?: 'always' | 'never'
    microphoneEnabled?: boolean
    microphoneGain?: number
    cameraEnabled?: boolean
    cameraShape?: 'rounded' | 'square' | 'circle'
    cameraSizePercent?: number
    cameraDeviceId?: string
    cameraDeviceName?: string
    microphoneDeviceId?: string
    microphoneDeviceName?: string
    frameRate?: number
    maxLongEdge?: number
    bitrateScale?: number
    width?: number
    height?: number
  }) => {
    return ipcRenderer.invoke('native-screen-recorder-start', options)
  },
  stopNativeScreenRecording: (options?: { discard?: boolean }) => {
    return ipcRenderer.invoke('native-screen-recorder-stop', options)
  },
  // A5: native pause/resume over the helper's stdin. `supported: false` = old helper.
  pauseNativeScreenRecording: () => {
    return ipcRenderer.invoke('pause-native-recording')
  },
  resumeNativeScreenRecording: () => {
    return ipcRenderer.invoke('resume-native-recording')
  },
  startCursorTracking: (options?: {
    source?: { id?: string; display_id?: string | number | null }
    captureSize?: { width?: number; height?: number }
  }) => {
    return ipcRenderer.invoke('cursor-tracker-start', options)
  },
  stopCursorTracking: () => {
    return ipcRenderer.invoke('cursor-tracker-stop')
  },
  // Pause ranges are compacted out of the cursor track on stop (both recorder paths).
  pauseCursorTracking: () => {
    return ipcRenderer.invoke('cursor-tracker-pause')
  },
  resumeCursorTracking: () => {
    return ipcRenderer.invoke('cursor-tracker-resume')
  },
  onStopRecordingFromTray: (callback: () => void) => {
    const listener = () => callback()
    ipcRenderer.on('stop-recording-from-tray', listener)
    return () => ipcRenderer.removeListener('stop-recording-from-tray', listener)
  },
  // Source selection events (W3-a): `select-source` pushes the new source to the
  // HUD; the selector window's `closed` event fires whether or not one was picked.
  onSelectedSourceChanged: (callback: (source: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, source: unknown) => callback(source)
    ipcRenderer.on('selected-source-changed', listener)
    return () => ipcRenderer.removeListener('selected-source-changed', listener)
  },
  onSourceSelectorClosed: (callback: () => void) => {
    const listener = () => callback()
    ipcRenderer.on('source-selector-closed', listener)
    return () => ipcRenderer.removeListener('source-selector-closed', listener)
  },
  // Countdown overlay window (W3-e): driven by the HUD's countdown timer. `runId`
  // identifies one countdown so stale ticks after a cancel are ignored.
  showCountdownOverlay: (value: number, runId: number) => {
    return ipcRenderer.invoke('countdown-overlay-show', value, runId)
  },
  setCountdownOverlayValue: (value: number, runId: number) => {
    return ipcRenderer.invoke('countdown-overlay-set-value', value, runId)
  },
  hideCountdownOverlay: (runId: number) => {
    return ipcRenderer.invoke('countdown-overlay-hide', runId)
  },
  onCountdownOverlayValue: (callback: (value: number | null, runId: number) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, value: number | null, runId: number) =>
      callback(value, runId)
    ipcRenderer.on('countdown-overlay-value', listener)
    return () => ipcRenderer.removeListener('countdown-overlay-value', listener)
  },
  // Notes window (W3-e): opens once, focuses on repeat; `closed` is echoed to the HUD.
  openNotes: () => {
    return ipcRenderer.invoke('open-notes')
  },
  onNotesWindowClosed: (callback: () => void) => {
    const listener = () => callback()
    ipcRenderer.on('notes-window-closed', listener)
    return () => ipcRenderer.removeListener('notes-window-closed', listener)
  },
  setStopRecordingShortcut: (accelerator: string) => {
    return ipcRenderer.invoke('set-stop-recording-shortcut', accelerator)
  },
  getStopRecordingShortcut: () => {
    return ipcRenderer.invoke('get-stop-recording-shortcut')
  },
  openExternalUrl: (url: string) => {
    return ipcRenderer.invoke('open-external-url', url)
  },
  revealInFolder: (filePath: string) => {
    return ipcRenderer.invoke('reveal-in-folder', filePath)
  },
  pickSaveFilePath: (fileName: string, locale?: string, exportFolder?: string) => {
    return ipcRenderer.invoke('pick-save-file-path', fileName, locale, exportFolder)
  },
  pickExportDirectory: (locale?: string, exportFolder?: string) => {
    return ipcRenderer.invoke('pick-export-directory', locale, exportFolder)
  },
  saveExportedVideo: (
    videoData: ArrayBuffer,
    fileName: string,
    locale?: string,
    options?: { directoryPath?: string | null },
  ) => {
    return ipcRenderer.invoke('save-exported-video', videoData, fileName, locale, options)
  },
  openVideoFilePicker: (locale?: string) => {
    return ipcRenderer.invoke('open-video-file-picker', locale)
  },
  setCurrentVideoPath: (
    path: string,
    metadata?: {
      frameRate?: number
      width?: number
      height?: number
      mimeType?: string
      capturedAt?: number
      systemCursorMode?: 'always' | 'never'
      hasMicrophoneAudio?: boolean
      cursorTrack?: {
        source?: 'recorded' | 'synthetic'
        samples: Array<{
          timeMs: number
          x: number
          y: number
          click?: boolean
          visible?: boolean
          cursorKind?: 'arrow' | 'ibeam'
        }>
        events?: Array<{
          type: 'click' | 'selection'
          startMs: number
          endMs: number
          point: { x: number; y: number }
          startPoint?: { x: number; y: number }
          endPoint?: { x: number; y: number }
          bounds?: {
            minX: number
            minY: number
            maxX: number
            maxY: number
            width: number
            height: number
          }
        }>
      }
    },
  ) => {
    return ipcRenderer.invoke('set-current-video-path', path, metadata)
  },
  getCurrentVideoPath: () => {
    return ipcRenderer.invoke('get-current-video-path')
  },
  clearCurrentVideoPath: () => {
    return ipcRenderer.invoke('clear-current-video-path')
  },
  saveProjectState: (videoPath: string, state: unknown) => {
    return ipcRenderer.invoke('save-project-state', videoPath, state)
  },
  loadProjectState: (videoPath: string) => {
    return ipcRenderer.invoke('load-project-state', videoPath)
  },
  getPlatform: () => {
    return ipcRenderer.invoke('get-platform')
  },
  getShortcuts: () => {
    return ipcRenderer.invoke('get-shortcuts')
  },
  saveShortcuts: (shortcuts: unknown) => {
    return ipcRenderer.invoke('save-shortcuts', shortcuts)
  },
  startVideoAnalysis: (options?: {
    videoPath?: string
    locale?: string
    durationMs?: number
    videoWidth?: number
    subtitleWidthRatio?: number
  }) => {
    return ipcRenderer.invoke('analysis-start', options)
  },
  getVideoAnalysisStatus: (jobId: string) => {
    return ipcRenderer.invoke('analysis-status', jobId)
  },
  getVideoAnalysisResult: (jobId: string) => {
    return ipcRenderer.invoke('analysis-result', jobId)
  },
  getCurrentVideoAnalysis: (videoPath?: string) => {
    return ipcRenderer.invoke('analysis-get-current', videoPath)
  },
  // W1-c: approved-file reads for the exporter (localSourceFile.ts)
  readBinaryFile: (filePath: string) => {
    return ipcRenderer.invoke('read-binary-file', filePath)
  },
  getReadableFileInfo: (filePath: string) => {
    return ipcRenderer.invoke('get-readable-file-info', filePath)
  },
  readFileChunk: (filePath: string, offset: number, length: number) => {
    return ipcRenderer.invoke('read-file-chunk', filePath, offset, length)
  },
  // C-1: in-browser Whisper caption fallback (model cache + sidecar write)
  assetBaseUrl,
  captionModelDirUrl,
  getCaptionModelDir: () => {
    return ipcRenderer.invoke('caption-model-dir')
  },
  getCaptionModelStatus: (modelId?: string) => {
    return ipcRenderer.invoke('caption-model-status', modelId)
  },
  downloadCaptionModel: (modelId?: string) => {
    return ipcRenderer.invoke('caption-model-download', modelId)
  },
  cancelCaptionModelDownload: () => {
    return ipcRenderer.invoke('caption-model-download-cancel')
  },
  onCaptionModelProgress: (callback: (progress: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: unknown) => callback(progress)
    ipcRenderer.on('caption-model-progress', listener)
    return () => {
      ipcRenderer.removeListener('caption-model-progress', listener)
    }
  },
  saveVideoAnalysisSidecar: (videoPath: string, analysis: unknown) => {
    return ipcRenderer.invoke('analysis-save-sidecar', videoPath, analysis)
  },

  // W3-c: global shortcuts, application menu, lifecycle flush, diagnostics
  updateGlobalShortcut: (
    action: 'openApp' | 'stopRecording',
    binding: { key: string; ctrl?: boolean; shift?: boolean; alt?: boolean },
  ) => {
    return ipcRenderer.invoke('update-global-shortcut', action, binding)
  },
  getGlobalShortcuts: () => {
    return ipcRenderer.invoke('get-global-shortcuts')
  },
  appQuit: () => {
    ipcRenderer.send('app-quit')
  },
  showAbout: () => {
    return ipcRenderer.invoke('show-about')
  },
  /** Native menu actions forwarded to the editor renderer (see main.ts `sendEditorMenuAction`). */
  onEditorMenuAction: (callback: (action: EditorMenuAction) => void) => {
    const listeners = EDITOR_MENU_ACTIONS.map((action) => {
      const listener = () => callback(action)
      ipcRenderer.on(action, listener)
      return () => ipcRenderer.removeListener(action, listener)
    })
    return () => {
      for (const dispose of listeners) dispose()
    }
  },
  /** Main asks the editor to write its pending auto-save before the window closes / the app quits. */
  onRequestSaveBeforeClose: (callback: () => void) => {
    const listener = () => callback()
    ipcRenderer.on('request-save-before-close', listener)
    return () => ipcRenderer.removeListener('request-save-before-close', listener)
  },
  saveBeforeCloseDone: () => {
    ipcRenderer.send('save-before-close-done')
  },
  saveDiagnostic: (payload?: {
    error?: string
    stack?: string
    projectState?: unknown
    logs?: string[]
    locale?: string
  }) => {
    return ipcRenderer.invoke('save-diagnostic', payload)
  },
  getMainLogTail: (lines?: number) => {
    return ipcRenderer.invoke('get-main-log-tail', lines)
  },
})

const EDITOR_MENU_ACTIONS = [
  'menu-undo',
  'menu-redo',
  'menu-import-video',
  'menu-export',
  'menu-return-to-recorder',
  'menu-toggle-timeline',
  'menu-toggle-settings',
  'menu-open-shortcuts',
] as const

type EditorMenuAction = (typeof EDITOR_MENU_ACTIONS)[number]
