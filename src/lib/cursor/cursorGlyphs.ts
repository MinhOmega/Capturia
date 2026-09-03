import appStartingSvg from '@/assets/cursors/app-starting.svg?raw'
import closedHandSvg from '@/assets/cursors/closed-hand.svg?raw'
import crosshairSvg from '@/assets/cursors/crosshair.svg?raw'
import helpSvg from '@/assets/cursors/help.svg?raw'
import moveSvg from '@/assets/cursors/move.svg?raw'
import notAllowedSvg from '@/assets/cursors/not-allowed.svg?raw'
import openHandSvg from '@/assets/cursors/open-hand.svg?raw'
import pointerSvg from '@/assets/cursors/pointer.svg?raw'
import resizeEwSvg from '@/assets/cursors/resize-ew.svg?raw'
import resizeNeswSvg from '@/assets/cursors/resize-nesw.svg?raw'
import resizeNsSvg from '@/assets/cursors/resize-ns.svg?raw'
import resizeNwseSvg from '@/assets/cursors/resize-nwse.svg?raw'
import textSvg from '@/assets/cursors/text.svg?raw'
import upArrowSvg from '@/assets/cursors/up-arrow.svg?raw'
import waitSvg from '@/assets/cursors/wait.svg?raw'
import type { CursorKind } from './cursorKinds'

/**
 * Bundled cursor glyphs for every kind except `arrow` (which keeps the
 * hand-tuned Path2D in `cursorComposer.ts`). The SVGs are Capturia originals
 * (MIT like the rest of the repository); the third-party `Cursor=*.svg` set
 * they replace was deliberately not reused, because its provenance is a Figma
 * export with no licence of its own, see docs/native-helper.md.
 *
 * The files are imported as raw text and turned into Path2D at draw time, so
 * preview and export draw exactly the same paths synchronously: no image
 * preload, no first-frame flash, identical output on both renderers.
 */

/** Every bundled glyph is authored on this square viewBox. */
export const CURSOR_GLYPH_VIEWBOX = 32

/**
 * Glyph units are the composer's: the arrow is ~28 units tall on the
 * reference canvas, so a 32-unit SVG scales by 28/32 to match its height.
 */
export const CURSOR_GLYPH_SCALE = 28 / CURSOR_GLYPH_VIEWBOX

export interface CursorGlyphAsset {
  svg: string
  /** Hotspot in viewBox units: the pixel the OS reports as the cursor position. */
  hotspot: { x: number; y: number }
}

export const CURSOR_GLYPH_ASSETS: Readonly<Partial<Record<CursorKind, CursorGlyphAsset>>> = {
  text: { svg: textSvg, hotspot: { x: 16, y: 16 } },
  pointer: { svg: pointerSvg, hotspot: { x: 12, y: 3 } },
  crosshair: { svg: crosshairSvg, hotspot: { x: 16, y: 16 } },
  'open-hand': { svg: openHandSvg, hotspot: { x: 16, y: 10 } },
  'closed-hand': { svg: closedHandSvg, hotspot: { x: 16, y: 12 } },
  'resize-ew': { svg: resizeEwSvg, hotspot: { x: 16, y: 16 } },
  'resize-ns': { svg: resizeNsSvg, hotspot: { x: 16, y: 16 } },
  'resize-nesw': { svg: resizeNeswSvg, hotspot: { x: 16, y: 16 } },
  'resize-nwse': { svg: resizeNwseSvg, hotspot: { x: 16, y: 16 } },
  move: { svg: moveSvg, hotspot: { x: 16, y: 16 } },
  'not-allowed': { svg: notAllowedSvg, hotspot: { x: 16, y: 16 } },
  wait: { svg: waitSvg, hotspot: { x: 16, y: 16 } },
  'app-starting': { svg: appStartingSvg, hotspot: { x: 5, y: 4 } },
  help: { svg: helpSvg, hotspot: { x: 5, y: 4 } },
  'up-arrow': { svg: upArrowSvg, hotspot: { x: 16, y: 3 } },
}

export interface CursorGlyphShape {
  d: string
  fill: string | null
  fillRule: CanvasFillRule
  stroke: string | null
  strokeWidth: number
  lineCap: CanvasLineCap
  lineJoin: CanvasLineJoin
}

export interface ParsedCursorGlyph {
  viewBox: { width: number; height: number }
  shapes: CursorGlyphShape[]
}

const PATH_TAG_RE = /<path\b([^>]*?)\/?>/g
const ATTRIBUTE_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*"([^"]*)"/g

function readAttributes(fragment: string): Record<string, string> {
  const attributes: Record<string, string> = {}
  for (const match of fragment.matchAll(ATTRIBUTE_RE)) {
    attributes[match[1]] = match[2]
  }
  return attributes
}

function parsePaint(value: string | undefined, fallback: string | null): string | null {
  if (value === undefined) return fallback
  const trimmed = value.trim()
  if (!trimmed || trimmed === 'none') return null
  return trimmed
}

/**
 * Minimal SVG reader for the bundled glyphs: `<path>` elements with `d`,
 * `fill`, `fill-rule`, `stroke`, `stroke-width`, `stroke-linecap` and
 * `stroke-linejoin`. Anything else in the file is ignored, which is all the
 * hand-authored assets use. Not a general SVG parser.
 */
export function parseCursorGlyphSvg(rawSvg: string): ParsedCursorGlyph {
  // Assets carry a licence comment; never let markup inside a comment count.
  const raw = rawSvg.replace(/<!--[\s\S]*?-->/g, '')
  const viewBoxMatch = /viewBox\s*=\s*"\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*"/.exec(
    raw,
  )
  const viewBoxWidth = viewBoxMatch ? Number(viewBoxMatch[3]) : CURSOR_GLYPH_VIEWBOX
  const viewBoxHeight = viewBoxMatch ? Number(viewBoxMatch[4]) : CURSOR_GLYPH_VIEWBOX

  const shapes: CursorGlyphShape[] = []
  for (const match of raw.matchAll(PATH_TAG_RE)) {
    const attributes = readAttributes(match[1])
    const d = attributes['d']?.trim()
    if (!d) continue
    const strokeWidth = Number(attributes['stroke-width'])
    shapes.push({
      d,
      // SVG default fill is black; an explicit fill="none" means stroke only.
      fill: parsePaint(attributes['fill'], '#000000'),
      fillRule: attributes['fill-rule'] === 'evenodd' ? 'evenodd' : 'nonzero',
      stroke: parsePaint(attributes['stroke'], null),
      strokeWidth: Number.isFinite(strokeWidth) && strokeWidth > 0 ? strokeWidth : 1,
      lineCap:
        attributes['stroke-linecap'] === 'round'
          ? 'round'
          : attributes['stroke-linecap'] === 'square'
            ? 'square'
            : 'butt',
      lineJoin:
        attributes['stroke-linejoin'] === 'round'
          ? 'round'
          : attributes['stroke-linejoin'] === 'bevel'
            ? 'bevel'
            : 'miter',
    })
  }

  return {
    viewBox: {
      width:
        Number.isFinite(viewBoxWidth) && viewBoxWidth > 0 ? viewBoxWidth : CURSOR_GLYPH_VIEWBOX,
      height:
        Number.isFinite(viewBoxHeight) && viewBoxHeight > 0 ? viewBoxHeight : CURSOR_GLYPH_VIEWBOX,
    },
    shapes,
  }
}

export interface CursorGlyphDrawPlan {
  kind: CursorKind
  shapes: CursorGlyphShape[]
  /** viewBox units -> glyph units. */
  scale: number
  /** Hotspot in viewBox units; the glyph is translated so it sits at the origin. */
  hotspot: { x: number; y: number }
}

const DRAW_PLAN_CACHE = new Map<CursorKind, CursorGlyphDrawPlan | null>()

/**
 * Parsed, cached draw plan for a kind, or `null` for kinds without a bundled
 * SVG (`arrow`) so the caller can fall back to its own drawing.
 */
export function resolveCursorGlyphDrawPlan(kind: CursorKind): CursorGlyphDrawPlan | null {
  const cached = DRAW_PLAN_CACHE.get(kind)
  if (cached !== undefined) return cached

  const asset = CURSOR_GLYPH_ASSETS[kind]
  if (!asset) {
    DRAW_PLAN_CACHE.set(kind, null)
    return null
  }
  const parsed = parseCursorGlyphSvg(asset.svg)
  const plan: CursorGlyphDrawPlan | null =
    parsed.shapes.length > 0
      ? {
          kind,
          shapes: parsed.shapes,
          scale: CURSOR_GLYPH_SCALE * (CURSOR_GLYPH_VIEWBOX / parsed.viewBox.height),
          hotspot: { ...asset.hotspot },
        }
      : null
  DRAW_PLAN_CACHE.set(kind, plan)
  return plan
}

/** Hotspot of a kind in glyph units (what `drawCompositedCursor` offsets by). */
export function resolveCursorGlyphHotspot(kind: CursorKind): { x: number; y: number } {
  const plan = resolveCursorGlyphDrawPlan(kind)
  if (!plan) return { x: 0, y: 0 }
  return { x: plan.hotspot.x * plan.scale, y: plan.hotspot.y * plan.scale }
}

const PATH_CACHE = new WeakMap<CursorGlyphShape, Path2D>()

function getPath(shape: CursorGlyphShape): Path2D {
  const cached = PATH_CACHE.get(shape)
  if (cached) return cached
  const path = new Path2D(shape.d)
  PATH_CACHE.set(shape, path)
  return path
}

/** True when the runtime can build `Path2D` (browsers / Electron; not plain Node). */
export function canDrawCursorGlyphPaths(): boolean {
  return typeof Path2D !== 'undefined'
}

/**
 * Draw a plan with the glyph origin (0,0) at the cursor hotspot, in glyph units.
 * The caller has already applied the cursor scale; this only maps viewBox
 * units onto glyph units and centres the hotspot.
 */
export function drawCursorGlyphPlan(
  ctx: CanvasRenderingContext2D,
  plan: CursorGlyphDrawPlan,
): void {
  ctx.save()
  ctx.scale(plan.scale, plan.scale)
  ctx.translate(-plan.hotspot.x, -plan.hotspot.y)
  for (const shape of plan.shapes) {
    const path = getPath(shape)
    if (shape.fill) {
      ctx.fillStyle = shape.fill
      ctx.fill(path, shape.fillRule)
    }
    if (shape.stroke) {
      ctx.strokeStyle = shape.stroke
      ctx.lineWidth = shape.strokeWidth
      ctx.lineCap = shape.lineCap
      ctx.lineJoin = shape.lineJoin
      ctx.stroke(path)
    }
  }
  ctx.restore()
}
