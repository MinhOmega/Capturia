/// <reference types="vite/client" />
/// <reference types="../electron/electron-env" />

declare const __APP_VERSION__: string

interface ProcessedDesktopSource {
  id: string
  name: string
  display_id: string
  width?: number
  height?: number
  thumbnail: string | null
  appIcon: string | null
}

type CapturePermissionStatus =
  | 'granted'
  | 'denied'
  | 'restricted'
  | 'not-determined'
  | 'unknown'
  | 'manual-check'

type CapturePermissionKey =
  | 'screen'
  | 'camera'
  | 'microphone'
  | 'accessibility'
  | 'input-monitoring'

type PermissionSettingsTarget =
  | 'screen-capture'
  | 'camera'
  | 'microphone'
  | 'accessibility'
  | 'input-monitoring'

type CapturePermissionSnapshot = {
  platform: string
  checkedAtMs: number
  canOpenSystemSettings: boolean
  items: Array<{
    key: CapturePermissionKey
    status: CapturePermissionStatus
    requiredForRecording: boolean
    canOpenSettings: boolean
    settingsTarget?: PermissionSettingsTarget
  }>
}

type CapturePermissionActionResult = {
  success: boolean
  status?: CapturePermissionStatus
  openedSettings?: boolean
  message?: string
}

/** Keep in sync with `src/lib/cursor/cursorKinds.ts` (`CURSOR_KINDS`). */
type CursorTrackCursorKind =
  | 'arrow'
  | 'text'
  | 'pointer'
  | 'crosshair'
  | 'open-hand'
  | 'closed-hand'
  | 'resize-ew'
  | 'resize-ns'
  | 'resize-nesw'
  | 'resize-nwse'
  | 'move'
  | 'not-allowed'
  | 'wait'
  | 'app-starting'
  | 'help'
  | 'up-arrow'

type CursorTrackMetadata = {
  source?: 'recorded' | 'synthetic'
  samples: Array<{
    timeMs: number
    x: number
    y: number
    click?: boolean
    visible?: boolean
    cursorKind?: CursorTrackCursorKind
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
  space?: {
    mode?: 'source-display' | 'virtual-desktop'
    displayId?: string
    bounds?: { x: number; y: number; width: number; height: number }
  }
  stats?: {
    sampleCount?: number
    clickCount?: number
  }
  capture?: {
    sourceId?: string
    width?: number
    height?: number
  }
}

type SubtitleCueMetadata = {
  id: string
  startMs: number
  endMs: number
  text: string
  source: 'asr' | 'manual' | 'agent'
  confidence?: number
}

type TranscriptWordMetadata = {
  text: string
  startMs: number
  endMs: number
  confidence?: number
  synthetic?: boolean
  phraseIndex?: number
}

type RoughCutSuggestionMetadata = {
  id: string
  startMs: number
  endMs: number
  reason: 'silence' | 'filler'
  confidence: number
  label: string
}

type CaptionModelStatusPayload = {
  modelId: string
  present: boolean
  dir: string
  downloadedBytes: number
  totalBytes: number
  missingFiles: string[]
}

type CaptionModelProgressPayload = {
  modelId: string
  file: string
  fileIndex: number
  fileCount: number
  downloadedBytes: number
  totalBytes: number
}

type VideoAnalysisMetadata = {
  transcript: {
    locale: string
    text: string
    createdAtMs: number
    words: TranscriptWordMetadata[]
  }
  subtitleCues: SubtitleCueMetadata[]
  roughCutSuggestions: RoughCutSuggestionMetadata[]
}

interface Window {
  electronAPI: {
    getSources: (opts: Electron.SourcesOptions) => Promise<ProcessedDesktopSource[]>
    getScreenCaptureAccessStatus: () => Promise<{
      status: 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown'
      canOpenSystemSettings: boolean
    }>
    getCapturePermissionSnapshot: () => Promise<CapturePermissionSnapshot>
    requestCapturePermissionAccess: (
      target: CapturePermissionKey,
    ) => Promise<CapturePermissionActionResult>
    openScreenCaptureSettings: () => Promise<{ success: boolean; message?: string }>
    openPermissionSettings: (
      target: PermissionSettingsTarget,
    ) => Promise<{ success: boolean; message?: string }>
    openPermissionChecker: () => Promise<{ success: boolean }>
    switchToEditor: () => Promise<void>
    switchToLaunch: () => Promise<void>
    openSourceSelector: () => Promise<void>
    selectSource: (source: unknown) => Promise<unknown>
    getSelectedSource: () => Promise<unknown>
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
        cursorTrack?: CursorTrackMetadata
      },
    ) => Promise<{
      success: boolean
      path?: string
      message: string
      error?: string
      metadata?: {
        frameRate?: number
        width?: number
        height?: number
        mimeType?: string
        capturedAt?: number
        systemCursorMode?: 'always' | 'never'
        hasMicrophoneAudio?: boolean
        cursorTrack?: CursorTrackMetadata
      }
    }>
    openRecordingStream: (fileName: string) => Promise<{ success: boolean; error?: string }>
    appendRecordingChunk: (
      fileName: string,
      chunk: ArrayBuffer,
    ) => Promise<{ success: boolean; error?: string }>
    closeRecordingStream: (fileName: string) => Promise<{ success: boolean; error?: string }>
    getRecordedVideoPath: () => Promise<{
      success: boolean
      path?: string
      message?: string
      error?: string
    }>
    getAssetBasePath: () => Promise<string | null>
    setRecordingState: (recording: boolean) => Promise<void>
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
      /** Microphone chosen in the HUD picker (Chromium deviceId + label); helper matches by label. */
      microphoneDeviceId?: string
      microphoneDeviceName?: string
      frameRate?: number
      maxLongEdge?: number
      bitrateScale?: number
      width?: number
      height?: number
    }) => Promise<{
      success: boolean
      code?: string
      message?: string
      width?: number
      height?: number
      frameRate?: number
      sourceKind?: 'display' | 'window' | 'unknown'
      hasMicrophoneAudio?: boolean
      /** The running helper accepts `pause` / `resume`; false for an old binary. */
      canPause?: boolean
      /** Non-fatal helper warning codes, e.g. `mic_device_not_found`. */
      warnings?: string[]
    }>
    pauseNativeScreenRecording: () => Promise<{
      success: boolean
      supported: boolean
      message?: string
    }>
    resumeNativeScreenRecording: () => Promise<{
      success: boolean
      supported: boolean
      message?: string
    }>
    stopNativeScreenRecording: (options?: { discard?: boolean }) => Promise<{
      success: boolean
      path?: string
      message?: string
      discarded?: boolean
      metadata?: {
        frameRate?: number
        width?: number
        height?: number
        mimeType?: string
        capturedAt?: number
        systemCursorMode?: 'always' | 'never'
        hasMicrophoneAudio?: boolean
      }
    }>
    startCursorTracking: (options?: {
      source?: { id?: string; display_id?: string | number | null }
      captureSize?: { width?: number; height?: number }
    }) => Promise<{ success: boolean; warningCode?: string; warningMessage?: string }>
    stopCursorTracking: () => Promise<{ success: boolean; track?: CursorTrackMetadata }>
    pauseCursorTracking: () => Promise<{ success: boolean; changed?: boolean; message?: string }>
    resumeCursorTracking: () => Promise<{ success: boolean; changed?: boolean; message?: string }>
    onStopRecordingFromTray: (callback: () => void) => () => void
    showCountdownOverlay: (value: number, runId: number) => Promise<void>
    setCountdownOverlayValue: (value: number, runId: number) => Promise<void>
    hideCountdownOverlay: (runId: number) => Promise<void>
    onCountdownOverlayValue: (callback: (value: number | null, runId: number) => void) => () => void
    openNotes: () => Promise<{ success: boolean; focused?: boolean; message?: string }>
    onNotesWindowClosed: (callback: () => void) => () => void
    setStopRecordingShortcut: (
      accelerator: string,
    ) => Promise<{ success: boolean; accelerator: string; message?: string }>
    getStopRecordingShortcut: () => Promise<{
      success: boolean
      accelerator: string
      message?: string
    }>
    openExternalUrl: (url: string) => Promise<{ success: boolean; error?: string }>
    pickSaveFilePath: (
      fileName: string,
      locale?: string,
      exportFolder?: string,
    ) => Promise<{
      success: boolean
      path?: string
      message?: string
      cancelled?: boolean
    }>
    pickExportDirectory: (
      locale?: string,
      exportFolder?: string,
    ) => Promise<{
      success: boolean
      path?: string
      message?: string
      cancelled?: boolean
    }>
    saveExportedVideo: (
      videoData: ArrayBuffer,
      fileName: string,
      locale?: string,
      options?: { directoryPath?: string | null },
    ) => Promise<{
      success: boolean
      path?: string
      message?: string
      cancelled?: boolean
    }>
    openVideoFilePicker: (
      locale?: string,
    ) => Promise<{ success: boolean; path?: string; cancelled?: boolean }>
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
        cursorTrack?: CursorTrackMetadata
      },
    ) => Promise<{ success: boolean }>
    getCurrentVideoPath: () => Promise<{
      success: boolean
      path?: string
      metadata?: {
        frameRate?: number
        width?: number
        height?: number
        mimeType?: string
        capturedAt?: number
        systemCursorMode?: 'always' | 'never'
        hasMicrophoneAudio?: boolean
        cursorTrack?: CursorTrackMetadata
      }
    }>
    clearCurrentVideoPath: () => Promise<{ success: boolean }>
    saveProjectState: (
      videoPath: string,
      state: unknown,
    ) => Promise<{ success: boolean; error?: string }>
    loadProjectState: (
      videoPath: string,
    ) => Promise<{ success: boolean; notFound?: boolean; state?: unknown; error?: string }>
    getPlatform: () => Promise<string>
    startVideoAnalysis: (options?: {
      videoPath?: string
      locale?: string
      durationMs?: number
      videoWidth?: number
      subtitleWidthRatio?: number
    }) => Promise<{ success: boolean; jobId?: string; message?: string }>
    getVideoAnalysisStatus: (jobId: string) => Promise<{
      success: boolean
      message?: string
      status?: {
        id: string
        status: 'pending' | 'running' | 'completed' | 'failed'
        createdAt: number
        startedAt?: number
        finishedAt?: number
        error?: string
        /** Native transcriber failure code (e.g. `unsupported_platform`) when status is `failed`. */
        code?: string
      }
    }>
    getVideoAnalysisResult: (jobId: string) => Promise<{
      success: boolean
      message?: string
      status?: {
        id: string
        status: 'pending' | 'running' | 'completed' | 'failed'
        createdAt: number
        startedAt?: number
        finishedAt?: number
        error?: string
        /** Native transcriber failure code (e.g. `unsupported_platform`) when status is `failed`. */
        code?: string
      }
      result?: VideoAnalysisMetadata
    }>
    getCurrentVideoAnalysis: (videoPath?: string) => Promise<{
      success: boolean
      message?: string
      analysis?: VideoAnalysisMetadata
    }>
    hudOverlayHide: () => void
    hudOverlayClose: () => void
    hudOverlayResize: (width?: number, height?: number) => void
    hudOverlayRestore: () => void
    setLocale: (locale: string) => Promise<void>
    // W1-c: approved-file reads for the exporter (localSourceFile.ts)
    readBinaryFile: (filePath: string) => Promise<{
      success: boolean
      data?: ArrayBuffer
      path?: string | null
      message?: string
      error?: string
    }>
    getReadableFileInfo: (filePath: string) => Promise<{
      success: boolean
      size?: number
      mtimeMs?: number
      path?: string
      message?: string
      error?: string
    }>
    readFileChunk: (
      filePath: string,
      offset: number,
      length: number,
    ) => Promise<{
      success: boolean
      data?: ArrayBuffer
      bytesRead?: number
      message?: string
      error?: string
    }>
    // C-1: in-browser Whisper caption fallback (model cache in userData + sidecar write)
    /** `file://` URL (trailing slash) of the resources dir, from `--asset-base-url`. Empty outside the editor window. */
    assetBaseUrl: string
    /** `file://` URL (trailing slash) of `userData/caption-models/`, from `--caption-model-dir`. Empty outside the editor window. */
    captionModelDirUrl: string
    getCaptionModelDir: () => Promise<{ success: boolean; dir?: string; message?: string }>
    getCaptionModelStatus: (modelId?: string) => Promise<{
      success: boolean
      status?: CaptionModelStatusPayload
      message?: string
    }>
    downloadCaptionModel: (
      modelId?: string,
    ) => Promise<{ success: boolean; aborted?: boolean; message?: string }>
    cancelCaptionModelDownload: () => Promise<{ success: boolean }>
    onCaptionModelProgress: (
      callback: (progress: CaptionModelProgressPayload) => void,
    ) => () => void
    saveVideoAnalysisSidecar: (
      videoPath: string,
      analysis: VideoAnalysisMetadata,
    ) => Promise<{ success: boolean; path?: string; message?: string }>
    // W3-c: global shortcuts, application menu, lifecycle flush, diagnostics
    updateGlobalShortcut: (
      action: GlobalShortcutActionName,
      binding: { key: string; ctrl?: boolean; shift?: boolean; alt?: boolean },
    ) => Promise<GlobalShortcutUpdateResult>
    getGlobalShortcuts: () => Promise<Partial<Record<GlobalShortcutActionName, string>>>
    appQuit: () => void
    showAbout: () => Promise<void>
    onEditorMenuAction: (callback: (action: EditorMenuActionName) => void) => () => void
    onRequestSaveBeforeClose: (callback: () => void) => () => void
    saveBeforeCloseDone: () => void
    saveDiagnostic: (payload?: DiagnosticPayloadInput) => Promise<SaveDiagnosticResult>
    getMainLogTail: (lines?: number) => Promise<string[]>
  }
}

type GlobalShortcutActionName = 'openApp' | 'stopRecording'

type GlobalShortcutUpdateResult = {
  ok: boolean
  /** Accelerator now bound to the action (the previous one when `ok` is false). */
  accelerator: string
  error?: 'empty' | 'conflict' | 'unavailable' | 'invalid' | 'needsModifier'
}

type EditorMenuActionName =
  | 'menu-undo'
  | 'menu-redo'
  | 'menu-import-video'
  | 'menu-export'
  | 'menu-return-to-recorder'
  | 'menu-toggle-timeline'
  | 'menu-toggle-settings'
  | 'menu-open-shortcuts'

type DiagnosticPayloadInput = {
  error?: string
  stack?: string
  projectState?: unknown
  logs?: string[]
  locale?: string
}

type SaveDiagnosticResult = { success: boolean; path?: string; cancelled?: boolean; error?: string }
