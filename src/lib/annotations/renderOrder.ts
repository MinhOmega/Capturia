import type { AnnotationRegion } from '@/components/video-editor/types'

function getAnnotationZIndex(annotation: AnnotationRegion): number {
  return Number.isFinite(annotation.zIndex) ? annotation.zIndex : 0
}

function hasFiniteTimeRange(annotation: AnnotationRegion): boolean {
  return Number.isFinite(annotation.startMs) && Number.isFinite(annotation.endMs)
}

export function isAnnotationActiveAtTime(
  annotation: AnnotationRegion,
  currentTimeMs: number,
): boolean {
  if (!hasFiniteTimeRange(annotation)) return false
  return currentTimeMs >= annotation.startMs && currentTimeMs <= annotation.endMs
}

/**
 * Blur regions are excluded from click-through and Tab selection cycling:
 * they are picked from their own timeline row, so cycling through the
 * overlapping annotations at the playhead never lands on one.
 */
export function isSelectionCyclable(annotation: AnnotationRegion): boolean {
  return annotation.type !== 'blur'
}

/**
 * The annotations the click-through / Tab cycle walks at `currentTimeMs`:
 * `getRenderableAnnotations` minus blur regions, in the same paint order.
 */
export function getSelectionCycleAnnotations(
  annotations: AnnotationRegion[] | undefined,
  currentTimeMs: number,
): AnnotationRegion[] {
  return getRenderableAnnotations(annotations, currentTimeMs).filter(isSelectionCyclable)
}

export function getRenderableAnnotations(
  annotations: AnnotationRegion[] | undefined,
  currentTimeMs: number,
): AnnotationRegion[] {
  if (!annotations?.length) return []

  return annotations
    .map((annotation, index) => ({ annotation, index }))
    .filter(({ annotation }) => isAnnotationActiveAtTime(annotation, currentTimeMs))
    .sort((left, right) => {
      const zDelta = getAnnotationZIndex(left.annotation) - getAnnotationZIndex(right.annotation)
      if (zDelta !== 0) return zDelta
      return left.index - right.index
    })
    .map(({ annotation }) => annotation)
}
