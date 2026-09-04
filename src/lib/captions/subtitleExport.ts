import type { SubtitleCue } from '@/lib/analysis/types'
import type { VideoSegment } from '@/components/video-editor/types'
import {
  normalizeTrimRanges,
  sourceToEffectiveMs,
  sourceToEffectiveMsWithSegments,
} from '@/lib/trim/timeMapping'

/**
 * SRT and WebVTT sidecars for an export.
 *
 * Cues are stored in *source* time — the timeline of the raw recording. The
 * exported video is in *effective* time: deleted segments are gone and the rest
 * may be sped up. A sidecar written from the raw times would drift the moment a
 * project has a single trim in it, so `mapCuesToExportTime` puts every cue
 * through the same mapping the exporter uses before anything is serialised.
 */

export const SUBTITLE_SIDECAR_FORMATS = ['srt', 'vtt'] as const
export type SubtitleSidecarFormat = (typeof SUBTITLE_SIDECAR_FORMATS)[number]

export function isSubtitleSidecarFormat(value: unknown): value is SubtitleSidecarFormat {
  return (
    typeof value === 'string' && (SUBTITLE_SIDECAR_FORMATS as readonly string[]).includes(value)
  )
}

/** Shortest cue worth writing; anything below is a rounding artefact of the mapping. */
const MIN_EXPORTED_CUE_MS = 1

function pad(value: number, length: number): string {
  return String(Math.max(0, Math.floor(value))).padStart(length, '0')
}

function splitTimestamp(msInput: number): {
  hours: number
  minutes: number
  seconds: number
  millis: number
} {
  const total = Math.max(0, Math.round(Number.isFinite(msInput) ? msInput : 0))
  return {
    hours: Math.floor(total / 3_600_000),
    minutes: Math.floor(total / 60_000) % 60,
    seconds: Math.floor(total / 1000) % 60,
    millis: total % 1000,
  }
}

/** `HH:MM:SS,mmm` — SRT separates the milliseconds with a comma. */
export function formatSrtTimestamp(ms: number): string {
  const { hours, minutes, seconds, millis } = splitTimestamp(ms)
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)},${pad(millis, 3)}`
}

/** `HH:MM:SS.mmm` — WebVTT separates the milliseconds with a dot. */
export function formatVttTimestamp(ms: number): string {
  const { hours, minutes, seconds, millis } = splitTimestamp(ms)
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}.${pad(millis, 3)}`
}

/** Payload lines: CRLF normalised, blank lines dropped (they would end the cue). */
function payloadLines(text: string): string[] {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/**
 * WebVTT payloads are parsed as a small markup: an unescaped `&`, `<` or `>`
 * would start an entity or a cue-span tag. Escaping `>` also takes care of a
 * literal `-->`, which a payload line may not contain.
 */
export function escapeVttText(text: string): string {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export interface SubtitleExportTimeline {
  /** Preferred: covers deletion and per-segment speed. */
  segments?: readonly VideoSegment[]
  /** Fallback for projects that never got segments. */
  trimRegions?: readonly { startMs: number; endMs: number }[]
  /** Needed to normalise the trim ranges; ignored when `segments` is given. */
  totalDurationMs?: number
}

/**
 * Move cues from source time into the exported video's timeline. Cues that fall
 * entirely inside a removed stretch collapse to zero length and are dropped;
 * a cue that straddles one is shortened to the part that survives.
 */
export function mapCuesToExportTime(
  cues: readonly SubtitleCue[],
  timeline: SubtitleExportTimeline = {},
): SubtitleCue[] {
  const segments = timeline.segments ?? []
  const trims =
    segments.length > 0
      ? []
      : normalizeTrimRanges(
          [...(timeline.trimRegions ?? [])],
          Math.max(0, Number(timeline.totalDurationMs ?? Number.MAX_SAFE_INTEGER)),
        )

  const toExport = (sourceMs: number): number => {
    if (segments.length > 0) return sourceToEffectiveMsWithSegments(sourceMs, [...segments])
    if (trims.length > 0) return sourceToEffectiveMs(sourceMs, trims)
    return sourceMs
  }

  return cues
    .map((cue) => ({
      ...cue,
      startMs: Math.round(toExport(cue.startMs)),
      endMs: Math.round(toExport(cue.endMs)),
    }))
    .filter((cue) => cue.text.trim().length > 0 && cue.endMs - cue.startMs >= MIN_EXPORTED_CUE_MS)
    .sort((left, right) => left.startMs - right.startMs)
}

/** Cues that survive serialisation: non-blank text and a positive duration. */
function serialisableCues(cues: readonly SubtitleCue[]): SubtitleCue[] {
  return cues.filter(
    (cue) =>
      Number.isFinite(cue.startMs) &&
      Number.isFinite(cue.endMs) &&
      cue.endMs - cue.startMs >= MIN_EXPORTED_CUE_MS &&
      payloadLines(cue.text).length > 0,
  )
}

/** SubRip. Cue numbers are 1-based and consecutive over the cues actually written. */
export function cuesToSrt(cues: readonly SubtitleCue[]): string {
  const usable = serialisableCues(cues)
  if (usable.length === 0) return ''
  return `${usable
    .map((cue, index) =>
      [
        String(index + 1),
        `${formatSrtTimestamp(cue.startMs)} --> ${formatSrtTimestamp(cue.endMs)}`,
        ...payloadLines(cue.text),
      ].join('\n'),
    )
    .join('\n\n')}\n`
}

/** WebVTT, with the mandatory `WEBVTT` signature and escaped payloads. */
export function cuesToVtt(cues: readonly SubtitleCue[]): string {
  const usable = serialisableCues(cues)
  const blocks = usable.map((cue, index) =>
    [
      String(index + 1),
      `${formatVttTimestamp(cue.startMs)} --> ${formatVttTimestamp(cue.endMs)}`,
      ...payloadLines(cue.text).map(escapeVttText),
    ].join('\n'),
  )
  return `WEBVTT\n\n${blocks.length > 0 ? `${blocks.join('\n\n')}\n` : ''}`
}

/**
 * Serialise a caption track for a finished export: map the times, then write the
 * requested format. Returns null when nothing would be written, so the caller
 * can skip the file rather than leave an empty one behind.
 */
export function buildSubtitleSidecar(
  cues: readonly SubtitleCue[],
  format: SubtitleSidecarFormat,
  timeline: SubtitleExportTimeline = {},
): string | null {
  const mapped = mapCuesToExportTime(cues, timeline)
  if (mapped.length === 0) return null
  const content = format === 'srt' ? cuesToSrt(mapped) : cuesToVtt(mapped)
  return content.trim().length > 0 && content !== 'WEBVTT\n\n' ? content : null
}
