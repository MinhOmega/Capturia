import type { ZoomDepth, ZoomRegion } from '@/components/video-editor/types'
import type { AspectRatio } from '@/utils/aspectRatioUtils'

export type ZoomRegionsByAspect = Partial<Record<AspectRatio, ZoomRegion[]>>
export type SelectedZoomIdByAspect = Partial<Record<AspectRatio, string | null>>

const EMPTY_ZOOM_REGIONS: ZoomRegion[] = []

export function getZoomRegionsForAspect(
  regionsByAspect: ZoomRegionsByAspect,
  aspectRatio: AspectRatio,
): ZoomRegion[] {
  return regionsByAspect[aspectRatio] ?? EMPTY_ZOOM_REGIONS
}

export function setZoomRegionsForAspect(
  regionsByAspect: ZoomRegionsByAspect,
  aspectRatio: AspectRatio,
  zoomRegions: ZoomRegion[],
): ZoomRegionsByAspect {
  const previous = regionsByAspect[aspectRatio]
  if (previous === zoomRegions) {
    return regionsByAspect
  }
  return {
    ...regionsByAspect,
    [aspectRatio]: zoomRegions,
  }
}

/** The level of one zoom region: its depth preset plus the custom scale, if it has one. */
export interface ZoomLevel {
  depth: ZoomDepth
  /** Absent means the region follows the depth preset. */
  customScale?: number
}

/** The level a region currently resolves to, in the shape applyZoomLevelToAllAspects takes. */
export function getZoomLevel(region: Pick<ZoomRegion, 'depth' | 'customScale'>): ZoomLevel {
  return region.customScale == null
    ? { depth: region.depth }
    : { depth: region.depth, customScale: region.customScale }
}

function regionHasLevel(region: ZoomRegion, level: ZoomLevel): boolean {
  return (
    region.depth === level.depth && (region.customScale ?? null) === (level.customScale ?? null)
  )
}

/**
 * Give every zoom region of every aspect the same level.
 *
 * The zoom regions are stored per aspect ratio, and "apply to all zooms" means
 * all of them, not only the ones of the aspect currently on screen — otherwise
 * exporting a second aspect would silently use the old levels. Regions that
 * already have the level are returned untouched, and an aspect whose regions
 * all match keeps its original array; when nothing at all changes the input
 * object itself comes back, so a no-op cannot create a history entry.
 */
export function applyZoomLevelToAllAspects(
  regionsByAspect: ZoomRegionsByAspect,
  level: ZoomLevel,
): ZoomRegionsByAspect {
  let changed = false
  const next: ZoomRegionsByAspect = {}

  for (const [aspect, regions] of Object.entries(regionsByAspect) as Array<
    [AspectRatio, ZoomRegion[] | undefined]
  >) {
    if (!regions) continue
    if (regions.every((region) => regionHasLevel(region, level))) {
      next[aspect] = regions
      continue
    }
    changed = true
    next[aspect] = regions.map((region) => {
      if (regionHasLevel(region, level)) return region
      // A region edited by hand is no longer an auto-zoom suggestion.
      const { customScale: _dropped, ...rest } = region
      return {
        ...rest,
        depth: level.depth,
        ...(level.customScale == null ? {} : { customScale: level.customScale }),
        source: 'manual' as const,
      }
    })
  }

  return changed ? next : regionsByAspect
}

export function getSelectedZoomIdForAspect(
  selectedByAspect: SelectedZoomIdByAspect,
  aspectRatio: AspectRatio,
): string | null {
  return selectedByAspect[aspectRatio] ?? null
}

export function setSelectedZoomIdForAspect(
  selectedByAspect: SelectedZoomIdByAspect,
  aspectRatio: AspectRatio,
  selectedZoomId: string | null,
): SelectedZoomIdByAspect {
  const previous = selectedByAspect[aspectRatio] ?? null
  if (previous === selectedZoomId) {
    return selectedByAspect
  }
  return {
    ...selectedByAspect,
    [aspectRatio]: selectedZoomId,
  }
}

export function clearStaleSelectedZoomIdForAspect(
  selectedByAspect: SelectedZoomIdByAspect,
  regionsByAspect: ZoomRegionsByAspect,
  aspectRatio: AspectRatio,
): SelectedZoomIdByAspect {
  const selectedZoomId = selectedByAspect[aspectRatio] ?? null
  if (!selectedZoomId) {
    return selectedByAspect
  }

  const regions = getZoomRegionsForAspect(regionsByAspect, aspectRatio)
  if (regions.some((region) => region.id === selectedZoomId)) {
    return selectedByAspect
  }

  return setSelectedZoomIdForAspect(selectedByAspect, aspectRatio, null)
}
