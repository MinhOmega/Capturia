/// <reference types="vite-plugin-electron/electron-env" />

declare namespace NodeJS {
  interface ProcessEnv {
    /**
     * The built directory structure
     *
     * ```tree
     * ├─┬─┬ dist
     * │ │ └── index.html
     * │ │
     * │ ├─┬ dist-electron
     * │ │ ├── main.js
     * │ │ └── preload.js
     * │
     * ```
     */
    APP_ROOT: string
    /** /dist/ or /public/ */
    VITE_PUBLIC: string
  }
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
  /**
   * Pointer gestures the tracker folded out of the samples, plus (D2) the
   * moments the user flagged while recording. A marker is an instant with no
   * place on screen, which is why it is a separate member of the union; a
   * sidecar written before D2 simply has none.
   */
  events?: Array<
    | {
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
      }
    | { type: 'marker'; timeMs: number }
  >
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

/**
 * A2: the native macOS helper ended while a recording was still running and no
 * stop had been asked for. Pushed to the HUD on `native-recorder-exited`.
 */
type NativeRecorderExitPayload = {
  code: number | null
  signal: string | null
  /** `killed` when a signal ended it, `crashed` for a non-zero exit of its own. */
  reason: 'killed' | 'crashed'
  /** The partial recording left on disk. */
  outputPath: string
  /** The partial file has a top-level MP4 `moov` box, so the editor may open it. */
  outputPlayable: boolean
}

/**
 * D2: outcome of flagging a moment while recording, from the HUD button
 * (`cursor-tracker-marker`) or from the `markMoment` global shortcut, which
 * main pushes back on `recording-marker-added`.
 */
type RecordingMarkerOutcome =
  | { added: true; timeMs: number; count: number }
  | { added: false; reason: 'not-recording' | 'paused' | 'limit' }

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

type UpdateProgressEvent =
  | { phase: 'checking' }
  | { phase: 'current'; version: string }
  | { phase: 'available'; version: string }
  | {
      phase: 'downloading'
      version: string
      percent: number
      transferred: number
      total: number
      bytesPerSecond: number
    }
  | { phase: 'downloaded'; version: string }
  | { phase: 'error'; kind: 'offline' | 'no-release' | 'unsigned' | 'unknown'; message: string }

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

type GlobalShortcutActionName = 'openApp' | 'stopRecording' | 'markMoment'

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

interface ProcessedDesktopSource {
  id: string
  name: string
  display_id: string
  width?: number
  height?: number
  thumbnail: string | null
  appIcon: string | null
}
