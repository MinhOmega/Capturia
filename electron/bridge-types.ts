/**
 * The contract between `electron/preload.ts` and the renderer.
 *
 * This is the single declaration of what `window.electronAPI` is. It used to
 * exist twice — once in `electron/electron-env.d.ts` and once in
 * `src/vite-env.d.ts` — where TypeScript merged the two `interface Window`
 * blocks and `skipLibCheck` hid the conflict, so the copies drifted: one had
 * `getAssetBasePath` and the other `saveExportedVideo`'s `targetFilePath`,
 * and callers reached the missing members through `window as any`.
 *
 * Drift cannot come back: `electron/preload.ts` annotates the object it hands
 * to `contextBridge.exposeInMainWorld` with this type, so a member the preload
 * stops exposing, adds, or gives a different parameter type is a compile
 * error, and `electron/bridge-types.test.ts` asserts the same parity at
 * runtime. `src/vite-env.d.ts` declares `Window.electronAPI` as this type and
 * nothing else declares it.
 *
 * The payload types below (`ProcessedDesktopSource`, `CursorTrackMetadata`, …)
 * stay ambient in `electron/electron-env.d.ts`; both processes use them well
 * beyond this bridge.
 *
 * Return types are the shapes the main-process handlers resolve with
 * (`electron/ipc/*.ts`). `ipcRenderer.invoke` is `Promise<any>`, so the
 * compiler cannot check them for us — when a handler's result changes, this
 * file has to change with it.
 */
export type HudRecordingPrivacy = {
  enabled: boolean
  protected: string[]
  unprotected: string[]
}

export interface ElectronAPI {
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
    /** `store-recorded-video` reports on both outcomes, so this is never absent. */
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
  /**
   * Resources directory of the packaged app, for callers that cannot use the
   * synchronous `assetBaseUrl` (older preload, or a base computed after boot).
   */
  getAssetBasePath: () => Promise<string | null>
  /** A5: free space on the recordings volume; `success: false` means "unknown", never "blocked". */
  getRecordingsDiskSpace: () => Promise<{
    success: boolean
    availableBytes?: number
    totalBytes?: number
    message?: string
  }>
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
    /** Capture system audio on the native path (mixed with the mic into one track). */
    systemAudio?: boolean
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
    hasSystemAudio?: boolean
    /** The running helper accepts `pause` / `resume`; false for an old binary. */
    canPause?: boolean
    /** The running helper honours `systemAudio`; false for an old binary. */
    canCaptureSystemAudio?: boolean
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
    /** `output_missing_moov`: the helper died before finalizing a playable MP4. */
    code?: 'no_session' | 'output_missing' | 'output_missing_moov'
    metadata?: {
      frameRate?: number
      width?: number
      height?: number
      mimeType?: string
      capturedAt?: number
      systemCursorMode?: 'always' | 'never'
      hasMicrophoneAudio?: boolean
      hasSystemAudio?: boolean
    }
  }>
  startCursorTracking: (options?: {
    source?: { id?: string; display_id?: string | number | null }
    captureSize?: { width?: number; height?: number }
  }) => Promise<{ success: boolean; warningCode?: string; warningMessage?: string }>
  stopCursorTracking: () => Promise<{ success: boolean; track?: CursorTrackMetadata }>
  pauseCursorTracking: () => Promise<{ success: boolean; changed?: boolean; message?: string }>
  resumeCursorTracking: () => Promise<{ success: boolean; changed?: boolean; message?: string }>
  /**
   * D2: flag the current moment. The same call the `markMoment` global shortcut
   * makes, so the HUD button and the shortcut write one kind of event.
   */
  addRecordingMarker: () => Promise<RecordingMarkerOutcome>
  /**
   * D2: main pushes the outcome of every flagged moment (from either surface)
   * so the HUD can confirm it. Returns an unsubscribe function.
   */
  onRecordingMarkerAdded: (callback: (result: RecordingMarkerOutcome) => void) => () => void
  /** A2: the native helper died mid-recording; returns an unsubscribe function. */
  onNativeRecorderExited: (callback: (info: NativeRecorderExitPayload) => void) => () => void
  onStopRecordingFromTray: (callback: () => void) => () => void
  onSelectedSourceChanged: (callback: (source: unknown) => void) => () => void
  onSourceSelectorClosed: (callback: () => void) => () => void
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
  revealInFolder: (
    filePath: string,
  ) => Promise<{ success: boolean; error?: string; message?: string }>
  pickSaveFilePath: (
    fileName: string,
    locale?: string,
    exportFolder?: string,
  ) => Promise<{ success: boolean; path?: string; message?: string; cancelled?: boolean }>
  pickExportDirectory: (
    locale?: string,
    exportFolder?: string,
  ) => Promise<{ success: boolean; path?: string; message?: string; cancelled?: boolean }>
  saveExportedVideo: (
    videoData: ArrayBuffer,
    fileName: string,
    locale?: string,
    options?: { directoryPath?: string | null; targetFilePath?: string | null },
  ) => Promise<{ success: boolean; path?: string; message?: string; cancelled?: boolean }>
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
  loadProjectState: (videoPath: string) => Promise<{
    success: boolean
    notFound?: boolean
    state?: unknown
    error?: string
    /** The recording was moved or renamed; its state was recovered by fingerprint. */
    relinked?: boolean
    relinkedFrom?: string
  }>
  /** `process.platform` snapshotted by the preload (`darwin` | `win32` | `linux`). */
  platform: string
  getPlatform: () => Promise<string>
  getShortcuts: () => Promise<Record<string, unknown> | null>
  saveShortcuts: (shortcuts: unknown) => Promise<{ success: boolean; error?: string }>
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
  /**
   * D1: `hideHudFromRecording`. The stored preference lives in the renderer
   * (`src/lib/userPreferences.ts`); these push it to main, which applies OS
   * content protection to the HUD, countdown and source-selector windows.
   * `unprotected` names the windows the OS refused (Linux has no equivalent
   * API, and macOS 26 never paints a content-protected window).
   */
  getHideHudFromRecording: () => Promise<HudRecordingPrivacy>
  setHideHudFromRecording: (enabled: boolean) => Promise<HudRecordingPrivacy>
  /** Re-assert content protection immediately before capture starts. */
  reassertHudRecordingPrivacy: () => Promise<HudRecordingPrivacy>
  hudOverlayHide: () => void
  hudOverlayClose: () => void
  hudOverlayResize: (width?: number, height?: number) => void
  hudOverlayRestore: () => void
  // A24: HUD click-through / drag / content-fit. `applied: false` carries a reason
  // ('wayland', 'countdown', 'no-window', 'wrong-sender', 'bad-args', 'no-rects').
  setHudOverlayIgnoreMouseEvents: (
    ignore: boolean,
    interactiveRects?: Array<{ x: number; y: number; width: number; height: number }>,
  ) => Promise<{ applied: boolean; reason?: string }>
  moveHudOverlayBy: (
    deltaX: number,
    deltaY: number,
  ) => Promise<{
    applied: boolean
    reason?: string
    bounds?: { x: number; y: number; width: number; height: number }
  }>
  setHudOverlaySize: (
    width: number,
    height: number,
  ) => Promise<{
    applied: boolean
    reason?: string
    bounds?: { x: number; y: number; width: number; height: number }
  }>
  setLocale: (locale: string) => Promise<void>
  // Auto-update (electron/auto-updater.ts): launch-check preference, manual
  // check and download/install progress events.
  getAutoUpdateCheck: () => Promise<{ success: boolean; enabled: boolean }>
  setAutoUpdateCheck: (
    enabled: boolean,
  ) => Promise<{ success: boolean; enabled?: boolean; error?: string }>
  checkForUpdates: () => Promise<{ success: boolean }>
  onUpdateProgress: (callback: (event: UpdateProgressEvent) => void) => () => void
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
  onCaptionModelProgress: (callback: (progress: CaptionModelProgressPayload) => void) => () => void
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
