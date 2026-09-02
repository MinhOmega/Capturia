import type { AnnotationRegion } from '@/components/video-editor/types'

/** Offset applied to a duplicate so it does not sit exactly on the source (% of the frame). */
export const DUPLICATE_ANNOTATION_OFFSET_PERCENT = 4

/**
 * Deep-copies an annotation under a new id and z-index, nudged by
 * DUPLICATE_ANNOTATION_OFFSET_PERCENT and clamped so the box stays inside
 * the frame. Same time span, so the copy is visible right where the user is.
 */
export function duplicateAnnotationRegion(
  source: AnnotationRegion,
  params: { id: string; zIndex: number },
): AnnotationRegion {
  const maxX = Math.max(0, 100 - source.size.width)
  const maxY = Math.max(0, 100 - source.size.height)
  return {
    ...source,
    id: params.id,
    zIndex: params.zIndex,
    position: {
      x: Math.min(maxX, source.position.x + DUPLICATE_ANNOTATION_OFFSET_PERCENT),
      y: Math.min(maxY, source.position.y + DUPLICATE_ANNOTATION_OFFSET_PERCENT),
    },
    size: { ...source.size },
    style: { ...source.style },
    figureData: source.figureData ? { ...source.figureData } : undefined,
  }
}
