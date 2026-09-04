/**
 * The scroll programme baked into `scrolling-table.webm`.
 *
 * `scripts/make-scrolling-fixture.mjs` inlines this file's numbers into the
 * page it records, and the blur tracker's browser test reads them back as
 * ground truth. Keeping them in one place is the whole point: a test that
 * measured the fixture instead of knowing it would only ever agree with
 * itself.
 */

/** Height of one table row in the fixture, source px. */
export const FIXTURE_ROW_HEIGHT = 18

export interface ScrollKeyframe {
  timeMs: number
  scrollY: number
}

export const SCROLLING_TABLE_FIXTURE = {
  width: 480,
  height: 270,
  frameRate: 30,
  durationMs: 6000,
  rowHeight: FIXTURE_ROW_HEIGHT,
  /** The pane the table scrolls inside, source px. */
  pane: { x: 96, y: 34, w: 480 - 108, h: 270 - 44 },
  /**
   * Scroll breakpoints, linear in between: down for two seconds at 40 px/s,
   * hold, a jump of 110 px in 200 ms (which no interpolation across a 100 ms
   * grid can follow), hold, then back up. The offsets are chosen so
   * {@link TRACKED_ROW} stays fully inside the pane the whole time: whether the
   * tracker follows content is a different question from whether it notices
   * content leaving, and the browser test asks them separately.
   */
  keyframes: [
    { timeMs: 0, scrollY: 20 },
    { timeMs: 2000, scrollY: 100 },
    { timeMs: 3000, scrollY: 100 },
    { timeMs: 3200, scrollY: 210 },
    { timeMs: 4500, scrollY: 210 },
    { timeMs: 6000, scrollY: 60 },
  ] as ScrollKeyframe[],
} as const

/**
 * An 8-bit timecode drawn into every frame, so a test can tell which instant of
 * the scroll programme a decoded frame actually shows.
 *
 * `MediaRecorder` stamps frames with the wall clock, and neither `setTimeout`
 * nor `requestAnimationFrame` delivers on an exact cadence, so the frame at
 * video time t does not show the content drawn for programme time t. Without
 * this, every ground-truth assertion downstream would be measuring the
 * recorder's drift and calling it tracker error. The cells sit at the right of
 * the toolbar, clear of the columns the tracker profiles.
 */
export const FIXTURE_TIMECODE = {
  x: 384,
  y: 4,
  cellWidth: 10,
  cellHeight: 8,
  bits: 8,
  /** One code step, ms. 8 bits x 25 ms covers the six-second clip. */
  stepMs: 25,
} as const

/** The code drawn into the frame showing programme time `timeMs`. */
export function encodeTimecode(timeMs: number): number {
  return Math.min(255, Math.max(0, Math.round(timeMs / FIXTURE_TIMECODE.stepMs)))
}

/** The programme time a decoded code stands for, ms. */
export function decodeTimecode(code: number): number {
  return code * FIXTURE_TIMECODE.stepMs
}

/** How far the table has scrolled at `timeMs`, source px. */
export function scrollYAt(timeMs: number): number {
  const points = SCROLLING_TABLE_FIXTURE.keyframes
  if (timeMs <= points[0].timeMs) return points[0].scrollY
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]
    const b = points[i + 1]
    if (timeMs <= b.timeMs) {
      const u = (timeMs - a.timeMs) / (b.timeMs - a.timeMs)
      return a.scrollY + (b.scrollY - a.scrollY) * u
    }
  }
  return points[points.length - 1].scrollY
}

/**
 * The row the browser test tracks. Stays inside the pane across the whole
 * programme, so recall is measured on following content rather than on losing
 * it.
 */
export const TRACKED_ROW = 12

/**
 * The rectangle of table row `index` at `timeMs`, source px.
 *
 * Deliberately tight around the row's text. A box that also covers the blank
 * half of the row is mostly flat background shared by every row, and NCC then
 * scores a neighbouring row about as well as the right one - measured, and the
 * reason this is 110 px wide rather than the row's full width.
 */
export function rowRectAt(
  index: number,
  timeMs: number,
): { x: number; y: number; w: number; h: number } {
  const { pane, rowHeight } = SCROLLING_TABLE_FIXTURE
  return {
    x: pane.x + 6,
    y: pane.y + index * rowHeight - scrollYAt(timeMs),
    w: 110,
    h: rowHeight,
  }
}
