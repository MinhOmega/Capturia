/**
 * HUD window geometry and layout helpers.
 *
 * Pure, dependency-free on purpose: the main process imports the geometry
 * functions to clamp `hud-overlay-move-by` / `hud-overlay-set-size`, and the
 * launch window imports the measurement and orientation helpers. Keep React
 * (and any `@/` alias) out of this file so the main bundle stays lean.
 *
 * Coordinates are device-independent pixels; a `HudRect` is `{ x, y, width,
 * height }` (the shape of Electron's `Rectangle`).
 */

export type HudRect = { x: number; y: number; width: number; height: number }
export type HudSize = { width: number; height: number }
export type HudPoint = { x: number; y: number }

export type HudOrientation = 'horizontal' | 'vertical'
export const HUD_ORIENTATIONS: readonly HudOrientation[] = ['horizontal', 'vertical']
export const DEFAULT_HUD_ORIENTATION: HudOrientation = 'horizontal'

/** Smallest window the HUD can shrink to; also the `BrowserWindow` min size. */
export const HUD_MIN_WINDOW_SIZE: HudSize = { width: 120, height: 80 }

/**
 * Result of the three HUD window channels. `applied: false` carries a reason so
 * the renderer can pick a fallback (e.g. native drag when the compositor does
 * not allow client-side positioning).
 */
export type HudOverlayResult = {
  applied: boolean
  reason?: 'no-window' | 'wrong-sender' | 'bad-args' | 'wayland' | 'countdown' | 'no-rects'
}

export function isHudOrientation(value: unknown): value is HudOrientation {
  return typeof value === 'string' && (HUD_ORIENTATIONS as readonly string[]).includes(value)
}

export function nextHudOrientation(current: HudOrientation): HudOrientation {
  return current === 'horizontal' ? 'vertical' : 'horizontal'
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function isHudRect(value: unknown): value is HudRect {
  if (!value || typeof value !== 'object') return false
  const rect = value as Record<string, unknown>
  return (
    isFiniteNumber(rect.x) &&
    isFiniteNumber(rect.y) &&
    isFiniteNumber(rect.width) &&
    isFiniteNumber(rect.height) &&
    rect.width >= 0 &&
    rect.height >= 0
  )
}

/** Keeps only well-formed rects from an untrusted IPC payload. */
export function sanitizeHudRects(value: unknown): HudRect[] {
  if (!Array.isArray(value)) return []
  return value.filter(isHudRect).map((rect) => ({
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  }))
}

/**
 * Moves `bounds` (size untouched) so it lies inside `workArea`. A window wider
 * or taller than the work area is aligned to the work area's left/top edge so
 * its first row of controls is always reachable.
 */
export function clampToWorkArea(bounds: HudRect, workArea: HudRect): HudRect {
  const maxX = workArea.x + workArea.width - bounds.width
  const maxY = workArea.y + workArea.height - bounds.height
  const x = maxX < workArea.x ? workArea.x : Math.min(Math.max(bounds.x, workArea.x), maxX)
  const y = maxY < workArea.y ? workArea.y : Math.min(Math.max(bounds.y, workArea.y), maxY)
  return { x: Math.round(x), y: Math.round(y), width: bounds.width, height: bounds.height }
}

/** Rounds and bounds a requested size to `[min, workArea]`. */
export function clampSizeToWorkArea(
  size: HudSize,
  workArea: HudRect,
  min: HudSize = HUD_MIN_WINDOW_SIZE,
): HudSize {
  const width = Math.min(workArea.width, Math.max(min.width, Math.round(size.width)))
  const height = Math.min(workArea.height, Math.max(min.height, Math.round(size.height)))
  return { width, height }
}

/**
 * Resizes `bounds` to `next` while keeping its bottom-centre point where it is,
 * then keeps the result on screen. The HUD bar hangs from the bottom-centre of
 * its window, so growing (device popover, vertical tray) or shrinking the window
 * around that point leaves the bar visually still.
 */
export function anchorPreservingResize(bounds: HudRect, next: HudSize, workArea: HudRect): HudRect {
  const size = clampSizeToWorkArea(next, workArea)
  const centerX = bounds.x + bounds.width / 2
  const bottomY = bounds.y + bounds.height
  return clampToWorkArea(
    {
      x: Math.round(centerX - size.width / 2),
      y: Math.round(bottomY - size.height),
      width: size.width,
      height: size.height,
    },
    workArea,
  )
}

/** Bottom-centre point of a window: the anchor persisted across launches. */
export function hudAnchorOf(bounds: HudRect): HudPoint {
  return { x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + bounds.height) }
}

/** Places a window of `size` so its bottom-centre sits at `anchor`, inside `workArea`. */
export function boundsFromHudAnchor(anchor: HudPoint, size: HudSize, workArea: HudRect): HudRect {
  return clampToWorkArea(
    {
      x: Math.round(anchor.x - size.width / 2),
      y: Math.round(anchor.y - size.height),
      width: size.width,
      height: size.height,
    },
    workArea,
  )
}

/** `bounds` shifted by a drag delta, rounded to whole pixels. */
export function translateBounds(bounds: HudRect, deltaX: number, deltaY: number): HudRect {
  return {
    x: Math.round(bounds.x + deltaX),
    y: Math.round(bounds.y + deltaY),
    width: bounds.width,
    height: bounds.height,
  }
}

export function rectCenter(rect: HudRect): HudPoint {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
}

/** True when `point` (screen coordinates) lies in any `rects` (window-relative). */
export function pointInHudRects(
  point: HudPoint,
  rects: readonly HudRect[],
  origin: HudPoint,
): boolean {
  return rects.some((rect) => {
    const left = origin.x + rect.x
    const top = origin.y + rect.y
    return (
      point.x >= left &&
      point.x < left + rect.width &&
      point.y >= top &&
      point.y < top + rect.height
    )
  })
}

export type HudContentMeasure = {
  viewportWidth: number
  viewportHeight: number
  /** Viewport-relative boxes of everything that must stay inside the window. */
  rects: readonly HudRect[]
  /** Slack on each side, and above the tallest box, so shadows/outlines are not clipped. */
  sideMargin?: number
  topMargin?: number
  min?: HudSize
}

/**
 * Window size that fits every measured box when the window is anchored by its
 * bottom-centre: the width is symmetric around the viewport's horizontal centre
 * and the height reaches from the viewport bottom up to the highest box.
 * Measuring from the anchor rather than from the boxes' own left/top keeps the
 * result stable while the main process re-centres the window on every resize.
 */
export function measureHudWindowSize({
  viewportWidth,
  viewportHeight,
  rects,
  sideMargin = 16,
  topMargin = 16,
  min = HUD_MIN_WINDOW_SIZE,
}: HudContentMeasure): HudSize {
  const centerX = viewportWidth / 2
  let halfWidth = 0
  let topFromBottom = 0
  for (const rect of rects) {
    if (rect.width <= 0 && rect.height <= 0) continue
    halfWidth = Math.max(halfWidth, centerX - rect.x, rect.x + rect.width - centerX)
    topFromBottom = Math.max(topFromBottom, viewportHeight - rect.y)
  }
  return {
    width: Math.max(min.width, Math.ceil(halfWidth * 2) + sideMargin * 2),
    height: Math.max(min.height, Math.ceil(topFromBottom) + topMargin),
  }
}

/** Selector for DOM regions that must receive mouse input (bar, popovers, portals). */
export const HUD_INTERACTIVE_SELECTOR =
  '[data-hud-interactive="true"], [data-radix-popper-content-wrapper], [role="dialog"], [role="menu"]'

/**
 * Whether a pointer target sits on something the user can interact with. Any
 * other target is the transparent reserve of the HUD window, where clicks
 * should fall through to the desktop.
 */
export function isHudInteractiveTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).closest !== 'function') return false
  return (target as Element).closest(HUD_INTERACTIVE_SELECTOR) !== null
}
