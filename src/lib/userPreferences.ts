import {
  DEFAULT_EDITOR_LAYOUT_SETTINGS,
  DEFAULT_EXPORT_SETTINGS,
  DEFAULT_PLAYBACK_SETTINGS,
} from '@/components/video-editor/editorDefaults'
import {
  DEFAULT_HUD_ORIENTATION,
  type HudOrientation,
  isHudOrientation,
} from '@/hooks/useHudLayout'
import type { ExportFormat, ExportQuality } from '@/lib/exporter/types'
import {
  DEFAULT_NOTES_TELEPROMPTER_SETTINGS,
  type NotesTeleprompterSettings,
  normalizeNotesTeleprompterSettings,
} from '@/lib/notesTeleprompter'
import { ASPECT_RATIOS, type AspectRatio } from '@/utils/aspectRatioUtils'

export const USER_PREFERENCES_STORAGE_KEY = 'capturia.userPreferences'

const MIN_SEEK_STEP_SECONDS = 1
const MAX_SEEK_STEP_SECONDS = 30
const MIN_PREVIEW_PLAYBACK_RATE = 0.25
/** Chromium caps HTMLMediaElement.playbackRate at 16. */
const MAX_PREVIEW_PLAYBACK_RATE = 16

/**
 * Cross-session editor preferences. These seed a *new* project's editor state;
 * a restored project file always wins over them.
 */
export interface UserPreferences {
  /** Default padding % */
  padding: number
  /** Default aspect ratio */
  aspectRatio: AspectRatio
  /** Default export quality */
  exportQuality: ExportQuality
  /** Default export format */
  exportFormat: ExportFormat
  /** Folder used for the most recent successful export, if any */
  exportFolder: string | null
  /** Arrow-key seek step in seconds */
  seekStepSeconds: number
  /** Preview playback rate */
  previewPlaybackRate: number
  /** Launch HUD layout: controls in one row, or stacked in a tray column */
  hudOrientation: HudOrientation
  /** Notes window teleprompter: scroll speed (px/s) and font size (px) */
  notesTeleprompter: NotesTeleprompterSettings
}

export const DEFAULT_PREFS: UserPreferences = {
  padding: DEFAULT_EDITOR_LAYOUT_SETTINGS.padding,
  aspectRatio: DEFAULT_EDITOR_LAYOUT_SETTINGS.aspectRatio,
  exportQuality: DEFAULT_EXPORT_SETTINGS.quality,
  exportFormat: DEFAULT_EXPORT_SETTINGS.format,
  exportFolder: null,
  seekStepSeconds: DEFAULT_PLAYBACK_SETTINGS.seekStepSeconds,
  previewPlaybackRate: DEFAULT_PLAYBACK_SETTINGS.previewPlaybackRate,
  hudOrientation: DEFAULT_HUD_ORIENTATION,
  notesTeleprompter: { ...DEFAULT_NOTES_TELEPROMPTER_SETTINGS },
}

/** Parses stored preferences without throwing on malformed JSON. */
function safeJsonParse(text: string | null): Record<string, unknown> | null {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function isFiniteInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
}

/** Load preferences from localStorage, falling back to defaults for missing or invalid fields. */
export function loadUserPreferences(): UserPreferences {
  let raw: Record<string, unknown> | null = null
  try {
    raw = safeJsonParse(localStorage.getItem(USER_PREFERENCES_STORAGE_KEY))
  } catch {
    return { ...DEFAULT_PREFS }
  }
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_PREFS }

  return {
    padding: isFiniteInRange(raw.padding, 0, 100) ? raw.padding : DEFAULT_PREFS.padding,
    aspectRatio:
      typeof raw.aspectRatio === 'string' &&
      (ASPECT_RATIOS as readonly string[]).includes(raw.aspectRatio)
        ? (raw.aspectRatio as AspectRatio)
        : DEFAULT_PREFS.aspectRatio,
    exportQuality:
      raw.exportQuality === 'medium' ||
      raw.exportQuality === 'good' ||
      raw.exportQuality === 'source'
        ? raw.exportQuality
        : DEFAULT_PREFS.exportQuality,
    exportFormat:
      raw.exportFormat === 'gif' || raw.exportFormat === 'mp4'
        ? raw.exportFormat
        : DEFAULT_PREFS.exportFormat,
    exportFolder:
      typeof raw.exportFolder === 'string' && raw.exportFolder.length > 0
        ? raw.exportFolder
        : DEFAULT_PREFS.exportFolder,
    seekStepSeconds: isFiniteInRange(
      raw.seekStepSeconds,
      MIN_SEEK_STEP_SECONDS,
      MAX_SEEK_STEP_SECONDS,
    )
      ? raw.seekStepSeconds
      : DEFAULT_PREFS.seekStepSeconds,
    previewPlaybackRate: isFiniteInRange(
      raw.previewPlaybackRate,
      MIN_PREVIEW_PLAYBACK_RATE,
      MAX_PREVIEW_PLAYBACK_RATE,
    )
      ? raw.previewPlaybackRate
      : DEFAULT_PREFS.previewPlaybackRate,
    hudOrientation: isHudOrientation(raw.hudOrientation)
      ? raw.hudOrientation
      : DEFAULT_PREFS.hudOrientation,
    notesTeleprompter: normalizeNotesTeleprompterSettings(raw.notesTeleprompter),
  }
}

/**
 * Parent directory of a saved file path. Handles both POSIX and Windows
 * separators since the path comes from the OS save dialog. Root dirs keep their
 * trailing separator so the result stays a valid directory ("/video.mp4" -> "/",
 * "C:\\video.mp4" -> "C:\\"). Returns null if no separator is found.
 */
export function parentDirectoryOf(filePath: string): string | null {
  const lastSep = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  if (lastSep < 0) return null

  // POSIX root, e.g. "/video.mp4" -> "/"
  if (lastSep === 0) return filePath[0]

  // Windows drive root, e.g. "C:\\video.mp4" -> "C:\\"
  if (lastSep === 2 && /^[A-Za-z]:[/\\]/.test(filePath)) {
    return filePath.slice(0, lastSep + 1)
  }

  return filePath.slice(0, lastSep)
}

/** Remembered export folder as `string | undefined`, for IPC handlers that treat absence as "use the default". */
export function getExportFolder(): string | undefined {
  return loadUserPreferences().exportFolder ?? undefined
}

/** Persist preferences to localStorage; only the provided fields are updated. */
export function saveUserPreferences(partial: Partial<UserPreferences>): void {
  const current = loadUserPreferences()
  const merged = { ...current, ...partial }
  try {
    localStorage.setItem(USER_PREFERENCES_STORAGE_KEY, JSON.stringify(merged))
  } catch {
    // localStorage may be unavailable (e.g. private browsing, quota exceeded)
  }
}
