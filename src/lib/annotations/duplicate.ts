import type { AnnotationRegion } from '@/components/video-editor/types'

/** Offset applied to a duplicate so it does not sit exactly on the source (% of the frame). */
export const DUPLICATE_ANNOTATION_OFFSET_PERCENT = 4

/**
 * Deep-copies an annotation under a new id and z-index.
 *
 * Without a `span` the copy keeps the source's time span, so it is visible
 * right where the user is; because it then sits exactly on top of the source it
 * is nudged by DUPLICATE_ANNOTATION_OFFSET_PERCENT, clamped so the box stays
 * inside the frame. With a `span` (Ctrl/Cmd+D, which places the copy after the
 * original in time) the two never share a frame, so the position is kept: a
 * nudge there would just move the annotation for no reason.
 */
export function duplicateAnnotationRegion(
  source: AnnotationRegion,
  params: { id: string; zIndex: number; span?: { startMs: number; endMs: number } },
): AnnotationRegion {
  const maxX = Math.max(0, 100 - source.size.width)
  const maxY = Math.max(0, 100 - source.size.height)
  return {
    ...source,
    id: params.id,
    zIndex: params.zIndex,
    startMs: params.span ? params.span.startMs : source.startMs,
    endMs: params.span ? params.span.endMs : source.endMs,
    position: params.span
      ? { ...source.position }
      : {
          x: Math.min(maxX, source.position.x + DUPLICATE_ANNOTATION_OFFSET_PERCENT),
          y: Math.min(maxY, source.position.y + DUPLICATE_ANNOTATION_OFFSET_PERCENT),
        },
    size: { ...source.size },
    style: { ...source.style },
    figureData: source.figureData ? { ...source.figureData } : undefined,
    blurData: source.blurData ? { ...source.blurData } : undefined,
  }
}
