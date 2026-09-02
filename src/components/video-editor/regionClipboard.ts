import type {
  AnnotationPosition,
  AnnotationRegion,
  AnnotationSize,
  AnnotationTextStyle,
  AnnotationType,
  BlurData,
  FigureData,
  PlaybackSpeed,
  Rotation3DPreset,
  VideoSegment,
  ZoomDepth,
  ZoomFocus,
  ZoomRegion,
} from './types'

/**
 * The copyable attributes of each region, tagged with its `kind` so paste can
 * discriminate. Capturia has no speed regions: a segment's speed is the
 * copyable attribute instead (`segmentSpeed`), pasted onto another segment.
 */
export type CopiedZoom = {
  kind: 'zoom'
  depth: ZoomDepth
  customScale?: number
  focus: ZoomFocus
  rotationPreset?: Rotation3DPreset
}

export type CopiedSegmentSpeed = { kind: 'segmentSpeed'; speed: PlaybackSpeed }

/** Annotation copy captures everything; paste then uses only the styling for an existing
 * region, or the full set for a brand-new one. */
export type CopiedAnnotation = {
  kind: 'annotation'
  // Styling - applied both when pasting onto an existing region and onto a new one.
  style: AnnotationTextStyle
  size: AnnotationSize
  figureData?: FigureData
  blurData?: BlurData
  // Content & placement - used only when pasting as a brand-new region.
  type: AnnotationType
  content: string
  textContent?: string
  imageContent?: string
  position: AnnotationPosition
}

export type CopiedRegion = CopiedZoom | CopiedSegmentSpeed | CopiedAnnotation

export type CopiedRegionKind = CopiedRegion['kind']

/** Session clipboard for "copy/paste region attributes" (not undoable, not persisted).
 * Module-level so it's shared regardless of which editor instance copied. */
let clipboard: CopiedRegion | null = null

export function getCopiedRegion(): CopiedRegion | null {
  return clipboard
}

export function setCopiedRegion(region: CopiedRegion): void {
  clipboard = region
}

/** Empties the session clipboard (tests and editor teardown). */
export function clearCopiedRegion(): void {
  clipboard = null
}

export function extractZoomAttributes(region: ZoomRegion): CopiedZoom {
  const copied: CopiedZoom = {
    kind: 'zoom',
    depth: region.depth,
    focus: { ...region.focus },
  }
  if (region.customScale !== undefined) copied.customScale = region.customScale
  if (region.rotationPreset !== undefined) copied.rotationPreset = region.rotationPreset
  return copied
}

export function extractSegmentSpeedAttributes(segment: VideoSegment): CopiedSegmentSpeed {
  return { kind: 'segmentSpeed', speed: segment.speed }
}

export function extractAnnotationAttributes(region: AnnotationRegion): CopiedAnnotation {
  return {
    kind: 'annotation',
    style: { ...region.style },
    size: { ...region.size },
    figureData: region.figureData ? { ...region.figureData } : undefined,
    blurData: region.blurData ? { ...region.blurData } : undefined,
    type: region.type,
    content: region.content,
    textContent: region.textContent,
    imageContent: region.imageContent,
    position: { ...region.position },
  }
}

/**
 * Returns a zoom region carrying the copied attributes. Identity and timing come
 * from `base` (so a full region keeps its own); every attribute comes from the
 * copy, with nested objects deep-copied. Passing a stub `base` builds a
 * brand-new region; passing an existing region overwrites ALL its attributes
 * (e.g. a preset-only copy clears the target's customScale). Either way the
 * result is a hand-edited region, so it is tagged `source: 'manual'` and the
 * auto-zoom wand toggle leaves it alone.
 */
export function buildZoomRegion(
  base: Pick<ZoomRegion, 'id' | 'startMs' | 'endMs'>,
  attrs: CopiedZoom,
): ZoomRegion {
  const region: ZoomRegion = {
    id: base.id,
    startMs: base.startMs,
    endMs: base.endMs,
    depth: attrs.depth,
    focus: { ...attrs.focus },
    source: 'manual',
  }
  if (attrs.customScale !== undefined) region.customScale = attrs.customScale
  if (attrs.rotationPreset !== undefined) region.rotationPreset = attrs.rotationPreset
  return region
}

/** Pastes a copied speed onto a segment: timing, deletion state and id are kept. */
export function applySegmentSpeed(segment: VideoSegment, attrs: CopiedSegmentSpeed): VideoSegment {
  return { ...segment, speed: attrs.speed }
}

/** Pastes onto an EXISTING annotation: only the styling is overwritten - the target keeps
 * its own type, text/image content, position, timing, and stacking order. */
export function replaceAnnotationAttributes(
  region: AnnotationRegion,
  attrs: CopiedAnnotation,
): AnnotationRegion {
  return {
    ...region,
    style: { ...attrs.style },
    size: { ...attrs.size },
    // Only carry figure data onto a figure target; never attach it to a non-figure
    // (e.g. pasting a figure's attributes onto a text annotation keeps the text figure-less).
    figureData:
      region.type === 'figure' && attrs.figureData ? { ...attrs.figureData } : region.figureData,
    // Same rule for blur settings: only a blur target takes them.
    blurData: region.type === 'blur' && attrs.blurData ? { ...attrs.blurData } : region.blurData,
  }
}

/**
 * Builds a BRAND-NEW annotation from a full copy: clones type, content, styling,
 * size, figure data, and position. Identity, timing, and stacking order come from
 * `base`. `positionOffsetPercent` nudges the clone (clamped so the box stays
 * inside the frame) so it does not sit exactly on the original.
 */
export function buildPastedAnnotation(
  base: Pick<AnnotationRegion, 'id' | 'startMs' | 'endMs' | 'zIndex'>,
  attrs: CopiedAnnotation,
  positionOffsetPercent = 0,
): AnnotationRegion {
  const position =
    positionOffsetPercent > 0
      ? {
          x: Math.min(
            Math.max(0, 100 - attrs.size.width),
            attrs.position.x + positionOffsetPercent,
          ),
          y: Math.min(
            Math.max(0, 100 - attrs.size.height),
            attrs.position.y + positionOffsetPercent,
          ),
        }
      : { ...attrs.position }
  return {
    ...base,
    type: attrs.type,
    content: attrs.content,
    textContent: attrs.textContent,
    imageContent: attrs.imageContent,
    position,
    size: { ...attrs.size },
    style: { ...attrs.style },
    figureData: attrs.figureData ? { ...attrs.figureData } : undefined,
    blurData: attrs.blurData ? { ...attrs.blurData } : undefined,
  }
}
