import type { CursorSample, CursorTrack } from '@/lib/cursor/types';
import type { ZoomFocus } from '../types';

/**
 * A cursor position usable as a zoom focus (stage-normalised 0..1), sorted by
 * time. Built once per CursorTrack (see buildCursorTelemetry); the zoom camera
 * reads it independently of the cursor *render* smoothing so the follow target
 * is never affected by cursor style settings.
 */
export interface CursorTelemetryPoint {
  timeMs: number;
  cx: number;
  cy: number;
}

const telemetryCache = new WeakMap<CursorTrack, CursorTelemetryPoint[]>();

/**
 * Adapt Capturia's CursorTrack to the telemetry the auto-follow camera reads.
 * Samples flagged `visible: false` are dropped, so the camera drifts smoothly
 * across a hidden span instead of holding and then jumping. Non-finite
 * samples are dropped too; the result is sorted by time. Memoised per track
 * identity so the per-frame callers never rebuild it.
 */
export function buildCursorTelemetry(track: CursorTrack | null | undefined): CursorTelemetryPoint[] {
  if (!track || !Array.isArray(track.samples) || track.samples.length === 0) return [];
  const cached = telemetryCache.get(track);
  if (cached) return cached;

  const points: CursorTelemetryPoint[] = [];
  for (const sample of track.samples as CursorSample[]) {
    if (!sample || sample.visible === false) continue;
    if (!Number.isFinite(sample.timeMs) || !Number.isFinite(sample.x) || !Number.isFinite(sample.y)) continue;
    points.push({ timeMs: sample.timeMs, cx: sample.x, cy: sample.y });
  }
  points.sort((a, b) => a.timeMs - b.timeMs);
  telemetryCache.set(track, points);
  return points;
}

/** Binary-search the sorted telemetry and lerp the cursor position at the given content time. */
export function interpolateCursorAt(
  telemetry: CursorTelemetryPoint[],
  timeMs: number,
): ZoomFocus | null {
  if (telemetry.length === 0) return null;

  if (timeMs <= telemetry[0].timeMs) {
    return { cx: telemetry[0].cx, cy: telemetry[0].cy };
  }

  const last = telemetry[telemetry.length - 1];
  if (timeMs >= last.timeMs) {
    return { cx: last.cx, cy: last.cy };
  }

  let lo = 0;
  let hi = telemetry.length - 1;

  while (lo < hi - 1) {
    const mid = (lo + hi) >>> 1;
    if (telemetry[mid].timeMs <= timeMs) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  const before = telemetry[lo];
  const after = telemetry[hi];
  const span = after.timeMs - before.timeMs;
  const t = span > 0 ? (timeMs - before.timeMs) / span : 0;

  return {
    cx: before.cx + (after.cx - before.cx) * t,
    cy: before.cy + (after.cy - before.cy) * t,
  };
}

/**
 * Exponential smoothing to reduce jitter from high-frequency cursor data.
 * Lower factor = smoother / more lag, higher = more responsive.
 */
export function smoothCursorFocus(raw: ZoomFocus, prev: ZoomFocus, factor: number): ZoomFocus {
  return {
    cx: prev.cx + (raw.cx - prev.cx) * factor,
    cy: prev.cy + (raw.cy - prev.cy) * factor,
  };
}

export interface FollowParams {
  minFactor: number;
  maxFactor: number;
  rampDistance: number;
  referenceMs: number;
}

/**
 * Advance the auto-follow focus from `prev` toward `raw` over `dtMs` of
 * content time. The distance-adaptive factor is reframed against
 * `referenceMs` so convergence is content-time based and matches between
 * preview (variable fps) and export (fixed fps). Returns `prev` unchanged for
 * a non-positive dt so a paused camera holds still.
 */
export function advanceFollowFocus(
  prev: ZoomFocus,
  raw: ZoomFocus,
  dtMs: number,
  params: FollowParams,
): ZoomFocus {
  if (!(dtMs > 0)) return prev;
  const base = adaptiveSmoothFactor(raw, prev, params.minFactor, params.maxFactor, params.rampDistance);
  const factor = timeCorrectedFollowFactor(base, dtMs, params.referenceMs);
  return smoothCursorFocus(raw, prev, factor);
}

/**
 * Make a per-frame smoothing `baseFactor` frame-rate independent by reframing
 * it in content time: the remaining distance decays as
 * `(1 - baseFactor)^(dtMs / referenceMs)` regardless of frame chunking.
 * Returns 0 for a non-positive dt so the camera holds still.
 */
export function timeCorrectedFollowFactor(baseFactor: number, dtMs: number, referenceMs: number): number {
  if (!(dtMs > 0) || !(referenceMs > 0)) return 0;
  return 1 - (1 - baseFactor) ** (dtMs / referenceMs);
}

/**
 * Adaptive smoothing factor that scales with distance: far from the target =
 * faster (maxFactor), close = slower (minFactor). A natural deceleration curve
 * instead of a hard dead-zone.
 */
export function adaptiveSmoothFactor(
  raw: ZoomFocus,
  prev: ZoomFocus,
  minFactor: number,
  maxFactor: number,
  rampDistance: number,
): number {
  const dx = raw.cx - prev.cx;
  const dy = raw.cy - prev.cy;
  const distance = Math.sqrt(dx * dx + dy * dy);
  const t = rampDistance > 0 ? Math.min(1, distance / rampDistance) : 1;
  return minFactor + (maxFactor - minFactor) * t;
}
