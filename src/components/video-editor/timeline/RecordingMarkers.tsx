import { useTimelineContext } from 'dnd-timeline'
import type React from 'react'
import { useI18n } from '@/i18n'

/**
 * D2: the moments the user flagged while recording, drawn on the timeline ruler.
 *
 * Deliberately read-only, which is what separates these from `KeyframeMarkers`:
 * a keyframe is an edit the user can drag and delete, a flagged moment is a
 * record of what happened during the take. Clicking one seeks there; nothing
 * moves it. The glyph is a flag pennant rather than the keyframe diamond so the
 * two are never confused on the same ruler.
 */
interface RecordingMarkersProps {
  /** Marker times in effective (timeline) ms, ordered. */
  markersMs: number[]
  videoDurationMs: number
  /** Seconds, matching the timeline's other seek callbacks. */
  onSeek?: (timeSeconds: number) => void
}

const RecordingMarkers: React.FC<RecordingMarkersProps> = ({
  markersMs,
  videoDurationMs,
  onSeek,
}) => {
  const { sidebarWidth, range, valueToPixels } = useTimelineContext()
  const { t } = useI18n()

  if (markersMs.length === 0 || videoDurationMs <= 0) return null

  return (
    <>
      {markersMs.map((timeMs) => {
        if (timeMs < range.start || timeMs > range.end) return null
        const offset = valueToPixels(timeMs - range.start)
        const seconds = timeMs / 1000
        const label = t('timeline.recordingMarkerAt', {
          time: `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60)
            .toString()
            .padStart(2, '0')}`,
        })

        return (
          <button
            key={timeMs}
            type="button"
            className="absolute top-0 h-5 w-3 flex items-start justify-center cursor-pointer bg-transparent border-0 p-0"
            style={{ left: `${sidebarWidth + offset - 6}px`, zIndex: 45 }}
            title={label}
            aria-label={label}
            data-testid="timeline-recording-marker"
            data-marker-ms={timeMs}
            onClick={(event) => {
              event.stopPropagation()
              onSeek?.(seconds)
            }}
          >
            {/* Pennant on a short staff: reads as a flag at 12 px and cannot be
                mistaken for the keyframe diamond next to it. */}
            <svg width="12" height="16" viewBox="0 0 12 16" aria-hidden="true" focusable="false">
              <title>{label}</title>
              <path d="M3 0 v16" stroke="#38bdf8" strokeWidth="1.5" fill="none" />
              <path d="M3.75 1 L11 4 L3.75 7 Z" fill="#38bdf8" />
            </svg>
          </button>
        )
      })}
    </>
  )
}

export default RecordingMarkers
