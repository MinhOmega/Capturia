/**
 * Find the available gap at `startPos` in a list of regions.
 *
 * Looks at the span from `startPos` up to the start of the next region
 * (or up to `totalMs` if there is no later region) and reports its size,
 * along with whether placement at `startPos` is actually valid.
 *
 * Placement is valid as long as `startPos` does not fall inside an
 * existing region and there is some room before the next one. Landing
 * exactly on the end of an existing region is fine (adjacency is
 * allowed); landing on a region's start or strictly between its start
 * and end, or having zero space left before the next region, is not.
 */
export function findFreeGapAt(
  regions: ReadonlyArray<{ startMs: number; endMs: number }>,
  startPos: number,
  totalMs: number,
): { ok: boolean; gapMs: number } {
  const sorted = [...regions].sort((a, b) => a.startMs - b.startMs)
  const nextRegion = sorted.find((r) => r.startMs > startPos)
  const gapMs = nextRegion ? nextRegion.startMs - startPos : totalMs - startPos
  const overlapping = sorted.some((r) => startPos >= r.startMs && startPos < r.endMs)
  return { ok: !overlapping && gapMs > 0, gapMs }
}

/**
 * Where a duplicate of `region` goes: straight after it, the same length.
 *
 * The copy is clamped twice — to the end of the recording, and to the start of
 * whatever comes next in `siblings` — so a duplicate near the end of the
 * timeline, or in front of another region, comes out shorter instead of
 * overlapping or running past the end. Pass no siblings for the tracks where
 * overlap is allowed (annotations, blurs); pass the whole list for zooms, which
 * must not overlap. The original may stay in `siblings`: the copy starts
 * exactly where it ends, and touching at a boundary is not an overlap.
 *
 * Returns null when there is no room at all: the region already ends at the
 * duration, something starts immediately after it, or it has no length.
 */
export function planDuplicateSpan(
  region: { startMs: number; endMs: number },
  totalMs: number,
  siblings: ReadonlyArray<{ startMs: number; endMs: number }> = [],
): { startMs: number; endMs: number } | null {
  const lengthMs = Math.round(region.endMs - region.startMs)
  if (!(lengthMs > 0) || !Number.isFinite(totalMs)) return null

  const startMs = Math.round(region.endMs)
  if (startMs >= totalMs) return null

  const { ok, gapMs } = findFreeGapAt(siblings, startMs, totalMs)
  if (!ok) return null

  const endMs = Math.round(Math.min(startMs + lengthMs, startMs + gapMs, totalMs))
  return endMs > startMs ? { startMs, endMs } : null
}
