/**
 * Browser-hosted stand-in for the preload bridge (`electron/preload.ts`).
 *
 * The editor normally runs inside an Electron window where the preload script
 * exposes `window.electronAPI`. A plain Chrome tab has no preload, so nothing
 * boots: the editor asks for the current recording on mount and every panel
 * reads the bridge. This module installs a faithful, in-memory stand-in so the
 * renderer can be driven from a real Chrome (DevTools, MCP, a hand check)
 * before an Electron end-to-end spec is written for the same flow.
 *
 * What it is:
 * - a *dev-server-only* module. `src/main.tsx` imports it dynamically behind
 *   `import.meta.env.DEV && import.meta.env.VITE_BROWSER_HARNESS === '1'`, so
 *   the branch is statically false in a production build and rollup drops both
 *   the branch and this module.
 * - backed by the dev server: the "recording" is the repository fixture
 *   `src/__fixtures__/sample.webm`, served at `/dev-fixtures/sample.webm` by
 *   the harness middleware in `vite.config.ts`. Paths handed to the renderer
 *   are absolute `http://` URLs, which `VideoEditor.toFileUrl` passes through
 *   untouched, so `<video>`, the waveform fetch and the exporter's file reads
 *   all resolve against the dev server.
 * - backed by `localStorage` for anything the real app persists to disk
 *   (project state, shortcuts), so a reload behaves like a second session.
 *
 * What it is not: there is no capture, no native helper, no transcription and
 * no filesystem. Those methods keep the bridge's shape but log a warning
 * naming themselves (see `UNIMPLEMENTED_BRIDGE_METHODS`) instead of throwing,
 * so a gap shows up in the DevTools console rather than as a blank screen.
 *
 * Every method the preload exposes is present here; `browserBridge.test.ts`
 * parses `electron/preload.ts` and fails when the two drift apart.
 */

const LOG_PREFIX = '[capturia-browser-harness]'

/** Served by the harness middleware in `vite.config.ts` from `src/__fixtures__`. */
export const FIXTURE_URL_PATH = '/dev-fixtures/sample.webm'
const FIXTURE_WIDTH = 320
const FIXTURE_HEIGHT = 240
const FIXTURE_FRAME_RATE = 15
const FIXTURE_DURATION_MS = 2008

const STORAGE_PREFIX = 'capturia.browserHarness.'
const CURRENT_VIDEO_KEY = `${STORAGE_PREFIX}currentVideo`
const PROJECT_STATE_PREFIX = `${STORAGE_PREFIX}projectState:`
const SHORTCUTS_KEY = `${STORAGE_PREFIX}shortcuts`
const STOP_SHORTCUT_KEY = `${STORAGE_PREFIX}stopRecordingAccelerator`
const DEFAULT_STOP_SHORTCUT = 'CommandOrControl+Shift+2'
/** Fake directory reported by the save dialogs; nothing is ever written there. */
const EXPORT_DIR = '/capturia-harness/exports'

/**
 * Bridge methods the preload exposes that this harness cannot honour in a
 * browser tab. Each one keeps the real signature, warns on call and returns a
 * benign failure. Kept as an exported list so the drift test can assert that
 * implemented + unimplemented covers the preload exactly.
 */
export const UNIMPLEMENTED_BRIDGE_METHODS = [
  'appendRecordingChunk',
  'cancelCaptionModelDownload',
  'checkForUpdates',
  'closeRecordingStream',
  'downloadCaptionModel',
  'getCaptionModelDir',
  'getCaptionModelStatus',
  'getRecordedVideoPath',
  'getVideoAnalysisResult',
  'getVideoAnalysisStatus',
  'openPermissionSettings',
  'openRecordingStream',
  'openScreenCaptureSettings',
  'openVideoFilePicker',
  'pauseCursorTracking',
  'pauseNativeScreenRecording',
  'resumeCursorTracking',
  'resumeNativeScreenRecording',
  'startCursorTracking',
  'startNativeScreenRecording',
  'startVideoAnalysis',
  'stopCursorTracking',
  'stopNativeScreenRecording',
  'storeRecordedVideo',
] as const

/**
 * The shim answers exactly what the preload exposes: `Window['electronAPI']`
 * is `electron/bridge-types.ts`, the same type the preload's exposed object is
 * annotated with, so a signature that changes on one side stops compiling on
 * the other.
 */
export type HarnessBridge = Window['electronAPI']

/** One `saveExportedVideo` call, kept in memory instead of written to disk. */
export interface HarnessExport {
  fileName: string
  byteLength: number
  data: ArrayBuffer
  savedAtMs: number
  path: string
}

export interface BrowserHarness {
  /**
   * Deliver a main-process push to whoever subscribed through the matching
   * `on*` bridge method, e.g.
   * `__capturiaBrowserHarness.emit('menu-export')` starts an export the same
   * way the application menu does. Returns the number of listeners called.
   */
  emit: (channel: string, ...args: unknown[]) => number
  /** Everything `saveExportedVideo` was handed, newest last. */
  exports: HarnessExport[]
  /** Offer each captured export as a browser download. Defaults to `true`. */
  autoDownload: boolean
  /** Download a captured export by index (default: the newest). */
  downloadExport: (index?: number) => boolean
  /** Absolute URL of the fixture recording the editor opens by default. */
  fixtureUrl: string
  /** Forget project state, shortcuts and the current recording, then reload. */
  reset: () => void
  bridge: HarnessBridge
}

declare global {
  interface Window {
    __capturiaBrowserHarness?: BrowserHarness
  }
}

function warnUnimplemented(method: string, reason: string): void {
  console.warn(`${LOG_PREFIX} electronAPI.${method}() is not implemented here: ${reason}`)
}

function note(message: string, ...rest: unknown[]): void {
  console.info(`${LOG_PREFIX} ${message}`, ...rest)
}

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Private mode / quota: the harness degrades to session-only state.
  }
}

function removeStorage(key: string): void {
  try {
    window.localStorage.removeItem(key)
  } catch {
    // ignore
  }
}

function readJson<T>(key: string): T | null {
  const raw = readStorage(key)
  if (raw === null) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

type RecordingMetadata = {
  frameRate?: number
  width?: number
  height?: number
  mimeType?: string
  capturedAt?: number
  systemCursorMode?: 'always' | 'never'
  hasMicrophoneAudio?: boolean
  cursorTrack?: CursorTrackMetadata
}

/**
 * A slow diagonal sweep with one click near the middle. The editor stores
 * cursor samples normalised to 0..1 of the capture surface, so this needs no
 * knowledge of the fixture's pixel size; it is only here so the cursor overlay
 * and the auto-zoom wand have something to chew on.
 */
function buildFixtureCursorTrack(): CursorTrackMetadata {
  const samples: CursorTrackMetadata['samples'] = []
  const stepMs = 50
  for (let timeMs = 0; timeMs <= FIXTURE_DURATION_MS; timeMs += stepMs) {
    const progress = timeMs / FIXTURE_DURATION_MS
    samples.push({
      timeMs,
      x: 0.15 + 0.7 * progress,
      y: 0.75 - 0.5 * progress,
      click: false,
      visible: true,
      cursorKind: 'arrow',
    })
  }
  const clickIndex = Math.floor(samples.length / 2)
  const clicked = samples[clickIndex]
  if (clicked) clicked.click = true
  return {
    source: 'synthetic',
    samples,
    events: clicked
      ? [
          {
            type: 'click',
            startMs: clicked.timeMs,
            endMs: clicked.timeMs + 120,
            point: { x: clicked.x, y: clicked.y },
          },
        ]
      : [],
    space: {
      mode: 'source-display',
      displayId: 'harness-display',
      bounds: { x: 0, y: 0, width: FIXTURE_WIDTH, height: FIXTURE_HEIGHT },
    },
    stats: { sampleCount: samples.length, clickCount: clicked ? 1 : 0 },
    capture: { sourceId: 'harness:0', width: FIXTURE_WIDTH, height: FIXTURE_HEIGHT },
  }
}

function fixtureMetadata(): RecordingMetadata {
  return {
    frameRate: FIXTURE_FRAME_RATE,
    width: FIXTURE_WIDTH,
    height: FIXTURE_HEIGHT,
    mimeType: 'video/webm',
    capturedAt: Date.now(),
    systemCursorMode: 'never',
    hasMicrophoneAudio: true,
    cursorTrack: buildFixtureCursorTrack(),
  }
}

/** `{ key: 'r', ctrl: true }` -> `CommandOrControl+R`, as `electron/globalShortcut.ts` does. */
function bindingToAccelerator(binding: {
  key: string
  ctrl?: boolean
  shift?: boolean
  alt?: boolean
}): string {
  const parts: string[] = []
  if (binding.ctrl) parts.push('CommandOrControl')
  if (binding.alt) parts.push('Alt')
  if (binding.shift) parts.push('Shift')
  parts.push(binding.key.length === 1 ? binding.key.toUpperCase() : binding.key)
  return parts.join('+')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Builds the bridge without touching `window.electronAPI`. Exported for the
 * unit tests; `installBrowserBridge` is what the renderer calls.
 */
export function createBrowserBridge(): BrowserHarness {
  const fixtureUrl = new URL(FIXTURE_URL_PATH, window.location.origin).toString()
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const exports: HarnessExport[] = []
  const sidecars = new Map<string, unknown>()
  let selectedSource: unknown = null
  // D1: the harness keeps the preference in memory; there is no OS content protection in a tab.
  let hideHudFromRecording = true

  function subscribe(channel: string, callback: (...args: unknown[]) => void): () => void {
    const set = listeners.get(channel) ?? new Set()
    set.add(callback)
    listeners.set(channel, set)
    return () => {
      set.delete(callback)
    }
  }

  function emit(channel: string, ...args: unknown[]): number {
    const set = listeners.get(channel)
    if (!set || set.size === 0) {
      note(`no listener for "${channel}"`)
      return 0
    }
    for (const callback of [...set]) callback(...args)
    return set.size
  }

  function downloadExport(index?: number): boolean {
    const entry = exports[index ?? exports.length - 1]
    if (!entry) return false
    try {
      const url = URL.createObjectURL(new Blob([entry.data]))
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = entry.fileName
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      // The download reads from the object URL asynchronously; revoking on the
      // next macrotask is late enough for Chrome to have taken a reference.
      setTimeout(() => {
        URL.revokeObjectURL(url)
      }, 0)
      return true
    } catch (error) {
      console.warn(`${LOG_PREFIX} could not offer the export as a download:`, error)
      return false
    }
  }

  function currentRecording(): { path: string; metadata: RecordingMetadata } {
    const stored = readJson<{ path: string; metadata?: RecordingMetadata }>(CURRENT_VIDEO_KEY)
    if (stored?.path) {
      return { path: stored.path, metadata: stored.metadata ?? fixtureMetadata() }
    }
    return { path: fixtureUrl, metadata: fixtureMetadata() }
  }

  const bridge: HarnessBridge = {
    // ---- Window / process facts ------------------------------------------
    /** The harness reports Linux so modifier glyphs and menu placement match this box. */
    platform: 'linux',
    getPlatform: async () => 'linux',
    /** Empty: on http(s) `getAssetPath` serves bundled assets from `public/`. */
    assetBaseUrl: '',
    captionModelDirUrl: '',
    getAssetBasePath: async () => null,
    setLocale: async (locale) => {
      note(`setLocale(${locale})`)
    },
    showAbout: async () => {
      note('showAbout()')
    },
    appQuit: () => {
      note('appQuit() - ignored in a browser tab')
    },
    saveBeforeCloseDone: () => {
      note('saveBeforeCloseDone()')
    },
    getMainLogTail: async () => [],
    saveDiagnostic: async (payload) => {
      note('saveDiagnostic()', payload)
      return { success: true, path: `${EXPORT_DIR}/diagnostic.json` }
    },

    // ---- Window switching -------------------------------------------------
    // The Electron app owns several windows; in one tab the equivalent is a
    // navigation, which keeps "Return to recorder" and the editor entry point
    // working from the same URL space the e2e specs assert on.
    switchToEditor: async () => {
      window.location.search = '?windowType=editor'
    },
    switchToLaunch: async () => {
      window.location.search = '?windowType=hud-overlay'
    },
    openSourceSelector: async () => {
      if (!window.open('?windowType=source-selector', '_blank')) {
        console.warn(`${LOG_PREFIX} the source selector popup was blocked by the browser`)
      }
    },
    // D1: the harness has no OS content protection; report the preference back
    // unchanged so the HUD toggle still round-trips.
    getHideHudFromRecording: async () => ({
      enabled: hideHudFromRecording,
      protected: [],
      unprotected: [],
    }),
    setHideHudFromRecording: async (enabled: boolean) => {
      hideHudFromRecording = enabled
      return { enabled, protected: [], unprotected: enabled ? ['HUD'] : [] }
    },
    reassertHudRecordingPrivacy: async () => ({
      enabled: hideHudFromRecording,
      protected: [],
      unprotected: hideHudFromRecording ? ['HUD'] : [],
    }),
    openNotes: async () => {
      const opened = window.open('?showNotes=true', '_blank')
      if (!opened) return { success: false, message: 'popup blocked' }
      return { success: true, focused: false }
    },
    openPermissionChecker: async () => {
      return { success: Boolean(window.open('?windowType=permission-checker', '_blank')) }
    },

    // ---- Capture sources and permissions ----------------------------------
    getSources: async () => [
      {
        id: 'harness:0',
        name: 'Browser harness display',
        display_id: 'harness-display',
        width: FIXTURE_WIDTH,
        height: FIXTURE_HEIGHT,
        thumbnail: null,
        appIcon: null,
      },
    ],
    selectSource: async (source) => {
      selectedSource = source
      emit('selected-source-changed', source)
      return source
    },
    getSelectedSource: async () => selectedSource,
    getScreenCaptureAccessStatus: async () => ({
      status: 'granted',
      canOpenSystemSettings: false,
    }),
    getCapturePermissionSnapshot: async () => ({
      platform: 'linux',
      checkedAtMs: Date.now(),
      canOpenSystemSettings: false,
      items: (['screen', 'camera', 'microphone', 'accessibility', 'input-monitoring'] as const).map(
        (key) => ({
          key,
          status: 'granted' as const,
          requiredForRecording: key === 'screen',
          canOpenSettings: false,
        }),
      ),
    }),
    requestCapturePermissionAccess: async () => ({ success: true, status: 'granted' }),

    // ---- The current recording -------------------------------------------
    getCurrentVideoPath: async () => {
      const current = currentRecording()
      return { success: true, path: current.path, metadata: current.metadata }
    },
    setCurrentVideoPath: async (path, metadata) => {
      writeStorage(
        CURRENT_VIDEO_KEY,
        JSON.stringify({ path, metadata: metadata ?? fixtureMetadata() }),
      )
      note(`setCurrentVideoPath(${path})`)
      return { success: true }
    },
    clearCurrentVideoPath: async () => {
      removeStorage(CURRENT_VIDEO_KEY)
      return { success: true }
    },
    setRecordingState: async () => {
      // No tray, no dock badge and no window state to flip in a browser tab.
    },
    // A5: a browser tab cannot `statfs` anything. `success: false` is the
    // "unknown" answer, which `assessRecordingDiskSpace` reads as "do not
    // block" — the harness must never refuse a recording the app would allow.
    getRecordingsDiskSpace: async () => ({
      success: false,
      message: 'Free disk space is not observable in the browser harness.',
    }),

    // ---- Project state ----------------------------------------------------
    saveProjectState: async (videoPath, state) => {
      try {
        writeStorage(`${PROJECT_STATE_PREFIX}${videoPath}`, JSON.stringify(state))
        return { success: true }
      } catch (error) {
        return { success: false, error: errorMessage(error) }
      }
    },
    loadProjectState: async (videoPath) => {
      const state = readJson<unknown>(`${PROJECT_STATE_PREFIX}${videoPath}`)
      if (state === null) return { success: true, notFound: true }
      return { success: true, state }
    },

    // ---- File reads (the exporter and the waveform) -----------------------
    // Paths here are dev-server URLs, so an approved-file read is a fetch.
    readBinaryFile: async (filePath) => {
      try {
        const response = await fetch(filePath)
        if (!response.ok) {
          return { success: false, message: `HTTP ${response.status}`, error: 'http_error' }
        }
        return { success: true, data: await response.arrayBuffer(), path: filePath }
      } catch (error) {
        return { success: false, message: errorMessage(error), error: 'fetch_failed' }
      }
    },
    getReadableFileInfo: async (filePath) => {
      try {
        const head = await fetch(filePath, { method: 'HEAD' })
        const length = head.ok ? Number(head.headers.get('content-length')) : Number.NaN
        if (Number.isFinite(length) && length > 0) {
          return { success: true, size: length, mtimeMs: 0, path: filePath }
        }
        const full = await fetch(filePath)
        if (!full.ok) {
          return { success: false, message: `HTTP ${full.status}`, error: 'http_error' }
        }
        return {
          success: true,
          size: (await full.arrayBuffer()).byteLength,
          mtimeMs: 0,
          path: filePath,
        }
      } catch (error) {
        return { success: false, message: errorMessage(error), error: 'fetch_failed' }
      }
    },
    readFileChunk: async (filePath, offset, length) => {
      try {
        const response = await fetch(filePath, {
          headers: { Range: `bytes=${offset}-${offset + length - 1}` },
        })
        if (!response.ok) {
          return { success: false, message: `HTTP ${response.status}`, error: 'http_error' }
        }
        const buffer = await response.arrayBuffer()
        // A dev server that ignores `Range` answers 200 with the whole file.
        const data = response.status === 206 ? buffer : buffer.slice(offset, offset + length)
        return { success: true, data, bytesRead: data.byteLength }
      } catch (error) {
        return { success: false, message: errorMessage(error), error: 'fetch_failed' }
      }
    },

    // ---- Export sinks -----------------------------------------------------
    pickSaveFilePath: async (fileName) => ({ success: true, path: `${EXPORT_DIR}/${fileName}` }),
    pickExportDirectory: async () => ({ success: true, path: EXPORT_DIR }),
    saveExportedVideo: async (videoData, fileName) => {
      const path = `${EXPORT_DIR}/${fileName}`
      const entry: HarnessExport = {
        fileName,
        byteLength: videoData.byteLength,
        data: videoData,
        savedAtMs: Date.now(),
        path,
      }
      exports.push(entry)
      note(`saveExportedVideo(${fileName}) captured ${videoData.byteLength} bytes in memory`)
      if (harness.autoDownload) downloadExport()
      return { success: true, path }
    },
    revealInFolder: async (filePath) => {
      note(`revealInFolder(${filePath}) - no file manager in a browser tab`)
      return { success: true }
    },
    openExternalUrl: async (url) => {
      note(`openExternalUrl(${url}) - not opened`)
      return { success: true }
    },

    // ---- Analysis / captions ---------------------------------------------
    getCurrentVideoAnalysis: async () => ({ success: true }),
    saveVideoAnalysisSidecar: async (videoPath, analysis) => {
      sidecars.set(videoPath, analysis)
      return { success: true, path: `${videoPath}.analysis.json` }
    },

    // ---- Shortcuts --------------------------------------------------------
    getShortcuts: async () => readJson<Record<string, unknown>>(SHORTCUTS_KEY),
    saveShortcuts: async (shortcuts) => {
      writeStorage(SHORTCUTS_KEY, JSON.stringify(shortcuts))
      return { success: true }
    },
    getStopRecordingShortcut: async () => ({
      success: true,
      accelerator: readStorage(STOP_SHORTCUT_KEY) ?? DEFAULT_STOP_SHORTCUT,
    }),
    setStopRecordingShortcut: async (accelerator) => {
      writeStorage(STOP_SHORTCUT_KEY, accelerator)
      return { success: true, accelerator }
    },
    getGlobalShortcuts: async () => ({}),
    updateGlobalShortcut: async (_action, binding) => ({
      ok: true,
      accelerator: bindingToAccelerator(binding),
    }),

    // ---- HUD overlay geometry --------------------------------------------
    // One tab has no separate always-on-top window, so these report that they
    // did nothing rather than pretending to have moved something.
    hudOverlayHide: () => {
      // no separate HUD window
    },
    hudOverlayClose: () => {
      // no separate HUD window
    },
    hudOverlayResize: () => {
      // the tab is sized by the browser
    },
    hudOverlayRestore: () => {
      // no separate HUD window
    },
    setHudOverlayIgnoreMouseEvents: async () => ({ applied: false, reason: 'browser-harness' }),
    moveHudOverlayBy: async () => ({ applied: false, reason: 'browser-harness' }),
    setHudOverlaySize: async () => ({ applied: false, reason: 'browser-harness' }),

    // ---- Countdown overlay ------------------------------------------------
    showCountdownOverlay: async (value, runId) => {
      emit('countdown-overlay-value', value, runId)
    },
    setCountdownOverlayValue: async (value, runId) => {
      emit('countdown-overlay-value', value, runId)
    },
    hideCountdownOverlay: async (runId) => {
      emit('countdown-overlay-value', null, runId)
    },

    // ---- Auto-update ------------------------------------------------------
    getAutoUpdateCheck: async () => ({ success: true, enabled: false }),
    setAutoUpdateCheck: async (enabled) => ({ success: true, enabled }),

    // ---- Main-process pushes ---------------------------------------------
    // Drive any of these from DevTools, e.g.
    //   __capturiaBrowserHarness.emit('menu-export')
    onStopRecordingFromTray: (callback) => subscribe('stop-recording-from-tray', () => callback()),
    // A2: `__capturiaBrowserHarness.emit('native-recorder-exited', { ... })`
    // walks the HUD through a helper that died mid-recording.
    onNativeRecorderExited: (callback) =>
      subscribe('native-recorder-exited', (info) => callback(info as NativeRecorderExitPayload)),
    onSelectedSourceChanged: (callback) =>
      subscribe('selected-source-changed', (source) => callback(source)),
    onSourceSelectorClosed: (callback) => subscribe('source-selector-closed', () => callback()),
    onCountdownOverlayValue: (callback) =>
      subscribe('countdown-overlay-value', (value, runId) =>
        callback(value as number | null, runId as number),
      ),
    onNotesWindowClosed: (callback) => subscribe('notes-window-closed', () => callback()),
    onUpdateProgress: (callback) =>
      subscribe('update-progress', (event) => callback(event as UpdateProgressEvent)),
    onCaptionModelProgress: (callback) =>
      subscribe('caption-model-progress', (progress) =>
        callback(progress as CaptionModelProgressPayload),
      ),
    onRequestSaveBeforeClose: (callback) =>
      subscribe('request-save-before-close', () => callback()),
    onEditorMenuAction: (callback) => {
      const disposers = (
        [
          'menu-undo',
          'menu-redo',
          'menu-import-video',
          'menu-export',
          'menu-return-to-recorder',
          'menu-toggle-timeline',
          'menu-toggle-settings',
          'menu-open-shortcuts',
        ] as const
      ).map((action) => subscribe(action, () => callback(action)))
      return () => {
        for (const dispose of disposers) dispose()
      }
    },

    // ---- No capture, no native helper, no transcription -------------------
    storeRecordedVideo: async () => {
      warnUnimplemented('storeRecordedVideo', 'the harness has no recordings directory')
      return { success: false, message: 'not available in the browser harness' }
    },
    openRecordingStream: async () => {
      warnUnimplemented('openRecordingStream', 'the harness has no recordings directory')
      return { success: false, error: 'not available in the browser harness' }
    },
    appendRecordingChunk: async () => {
      warnUnimplemented('appendRecordingChunk', 'the harness has no recordings directory')
      return { success: false, error: 'not available in the browser harness' }
    },
    closeRecordingStream: async () => {
      warnUnimplemented('closeRecordingStream', 'the harness has no recordings directory')
      return { success: false, error: 'not available in the browser harness' }
    },
    getRecordedVideoPath: async () => {
      warnUnimplemented('getRecordedVideoPath', 'nothing is recorded in the browser harness')
      return { success: false, message: 'not available in the browser harness' }
    },
    startNativeScreenRecording: async () => {
      warnUnimplemented('startNativeScreenRecording', 'there is no native capture helper')
      return { success: false, code: 'harness', message: 'not available in the browser harness' }
    },
    stopNativeScreenRecording: async () => {
      warnUnimplemented('stopNativeScreenRecording', 'there is no native capture helper')
      return { success: false, message: 'not available in the browser harness' }
    },
    pauseNativeScreenRecording: async () => {
      warnUnimplemented('pauseNativeScreenRecording', 'there is no native capture helper')
      return { success: false, supported: false }
    },
    resumeNativeScreenRecording: async () => {
      warnUnimplemented('resumeNativeScreenRecording', 'there is no native capture helper')
      return { success: false, supported: false }
    },
    startCursorTracking: async () => {
      warnUnimplemented('startCursorTracking', 'the fixture ships a synthetic cursor track instead')
      return { success: false }
    },
    stopCursorTracking: async () => {
      warnUnimplemented('stopCursorTracking', 'the fixture ships a synthetic cursor track instead')
      return { success: false }
    },
    pauseCursorTracking: async () => {
      warnUnimplemented('pauseCursorTracking', 'the fixture ships a synthetic cursor track instead')
      return { success: false }
    },
    resumeCursorTracking: async () => {
      warnUnimplemented(
        'resumeCursorTracking',
        'the fixture ships a synthetic cursor track instead',
      )
      return { success: false }
    },
    openVideoFilePicker: async () => {
      warnUnimplemented('openVideoFilePicker', 'a browser file input yields no filesystem path')
      return { success: false, cancelled: true }
    },
    openScreenCaptureSettings: async () => {
      warnUnimplemented('openScreenCaptureSettings', 'there are no OS settings to open')
      return { success: false, message: 'not available in the browser harness' }
    },
    openPermissionSettings: async () => {
      warnUnimplemented('openPermissionSettings', 'there are no OS settings to open')
      return { success: false, message: 'not available in the browser harness' }
    },
    startVideoAnalysis: async () => {
      warnUnimplemented('startVideoAnalysis', 'there is no native transcriber')
      return { success: false, message: 'not available in the browser harness' }
    },
    getVideoAnalysisStatus: async () => {
      warnUnimplemented('getVideoAnalysisStatus', 'there is no native transcriber')
      return { success: false, message: 'not available in the browser harness' }
    },
    getVideoAnalysisResult: async () => {
      warnUnimplemented('getVideoAnalysisResult', 'there is no native transcriber')
      return { success: false, message: 'not available in the browser harness' }
    },
    getCaptionModelDir: async () => {
      warnUnimplemented('getCaptionModelDir', 'there is no caption model cache')
      return { success: false, message: 'not available in the browser harness' }
    },
    getCaptionModelStatus: async () => {
      warnUnimplemented('getCaptionModelStatus', 'there is no caption model cache')
      return { success: false, message: 'not available in the browser harness' }
    },
    downloadCaptionModel: async () => {
      warnUnimplemented('downloadCaptionModel', 'there is no caption model cache')
      return { success: false, message: 'not available in the browser harness' }
    },
    cancelCaptionModelDownload: async () => {
      warnUnimplemented('cancelCaptionModelDownload', 'there is no caption model cache')
      return { success: false }
    },
    checkForUpdates: async () => {
      warnUnimplemented('checkForUpdates', 'there is no updater in a browser tab')
      return { success: false }
    },
  }

  const harness: BrowserHarness = {
    emit,
    exports,
    autoDownload: true,
    downloadExport,
    fixtureUrl,
    reset: () => {
      try {
        for (const key of Object.keys(window.localStorage)) {
          if (key.startsWith(STORAGE_PREFIX)) window.localStorage.removeItem(key)
        }
      } catch {
        // ignore
      }
      window.location.reload()
    },
    bridge,
  }

  return harness
}

/**
 * Installs the shim on `window` unless a real preload bridge is already there.
 * Returns the harness handle, or `null` when it declined to install.
 */
export function installBrowserBridge(): BrowserHarness | null {
  if (window.electronAPI) {
    note('a real preload bridge is present; the browser harness stays out of the way')
    return null
  }
  const harness = createBrowserBridge()
  window.electronAPI = harness.bridge
  window.__capturiaBrowserHarness = harness
  note(
    `installed. Fixture: ${harness.fixtureUrl}. ` +
      'Use __capturiaBrowserHarness.emit("menu-export") to drive the menu, ' +
      '__capturiaBrowserHarness.exports for captured exports, ' +
      '__capturiaBrowserHarness.reset() to clear saved state.',
  )
  return harness
}
