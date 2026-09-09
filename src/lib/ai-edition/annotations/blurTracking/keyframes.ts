import type {
	AxcutBlurTrack as BlurTrack,
	AxcutBlurTrackKeyframe as BlurTrackKeyframe,
} from "@/lib/ai-edition/schema";

/**
 * The keyframe list is the whole persisted truth of a tracked blur region: the
 * preview, the export and the timeline all read it and nothing re-tracks.
 * These helpers are the only code allowed to interpret it — normalisation on
 * load, the rect at a given time, simplification after a track, and merging a
 * user pin — so preview and export cannot drift apart on a rounding rule.
 *
 * All rectangles here are **source-normalised**: `x`/`y` is the top-left and
 * `w`/`h` the size, each a fraction of the full source frame before any crop
 * or camera. See `docs/specs/tracked-blur-regions.md` §2.
 */

/** A rectangle in source-normalised units (0..1 of the full source frame). */
export interface NormRect {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** How long a lost blur takes to fade out, ms. Long enough to not pop, short enough to not leak. */
export const BLUR_TRACK_FADE_OUT_MS = 100;
/** Two keyframes further apart than this in time *and* space render as their union. */
export const BLUR_TRACK_UNION_GAP_MS = 40;
/** Displacement, in source px, above which the union rule replaces the lerp. */
export const BLUR_TRACK_UNION_PX = 6;
/** Default simplification tolerance: half a source pixel is below what a mosaic block can show. */
export const BLUR_TRACK_SIMPLIFY_PX = 0.5;

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function rectOf(keyframe: BlurTrackKeyframe): NormRect {
	return { x: keyframe.x, y: keyframe.y, w: keyframe.w, h: keyframe.h };
}

function lerpRect(a: NormRect, b: NormRect, u: number): NormRect {
	return {
		x: a.x + (b.x - a.x) * u,
		y: a.y + (b.y - a.y) * u,
		w: a.w + (b.w - a.w) * u,
		h: a.h + (b.h - a.h) * u,
	};
}

/** Smallest rectangle containing both. A blur that is too large is harmless; too small is the leak. */
export function unionRect(a: NormRect, b: NormRect): NormRect {
	const x = Math.min(a.x, b.x);
	const y = Math.min(a.y, b.y);
	const right = Math.max(a.x + a.w, b.x + b.w);
	const bottom = Math.max(a.y + a.h, b.y + b.h);
	return { x, y, w: right - x, h: bottom - y };
}

/**
 * Index of the last keyframe at or before `timeMs`, or `-1` when `timeMs` is
 * before the first. Binary search; the caller may pass its previous result as
 * `hint` (playback walks forward, so the answer is usually the same index or
 * the next one).
 */
export function findKeyframeIndex(
	keyframes: readonly BlurTrackKeyframe[],
	timeMs: number,
	hint = 0,
): number {
	if (keyframes.length === 0) return -1;
	if (timeMs < keyframes[0].timeMs) return -1;

	if (hint >= 0 && hint < keyframes.length && keyframes[hint].timeMs <= timeMs) {
		const next = hint + 1;
		if (next >= keyframes.length || keyframes[next].timeMs > timeMs) return hint;
		if (next + 1 >= keyframes.length || keyframes[next + 1].timeMs > timeMs) return next;
	}

	let lo = 0;
	let hi = keyframes.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (keyframes[mid].timeMs <= timeMs) lo = mid;
		else hi = mid - 1;
	}
	return lo;
}

export interface ResolvedTrackedRect {
	rect: NormRect;
	/** 1 while tracked, ramping to 0 across the fade after a lost keyframe. */
	opacity: number;
}

/**
 * The rectangle a tracked blur covers at `timeMs`, or `null` when nothing is
 * drawn (the content is not visible and the fade has finished).
 *
 * Shared by the preview overlay and the exporter so the two cannot disagree
 * about where the mosaic goes. `hint` is the index this returned last time.
 */
export function resolveTrackedBlurRect(
	track: BlurTrack,
	timeMs: number,
	hint = 0,
): ResolvedTrackedRect | null {
	const keyframes = track.keyframes;
	if (keyframes.length === 0) return null;

	const index = findKeyframeIndex(keyframes, timeMs, hint);
	if (index < 0) {
		// Before the first keyframe. A track reaches the region's start, but be
		// tolerant of a span the user widened after tracking.
		const first = keyframes[0];
		return first.lost ? null : { rect: rectOf(first), opacity: 1 };
	}

	const current = keyframes[index];
	if (current.lost) {
		const elapsed = timeMs - current.timeMs;
		const opacity = 1 - elapsed / BLUR_TRACK_FADE_OUT_MS;
		if (opacity <= 0) return null;
		return { rect: rectOf(current), opacity: Math.min(1, opacity) };
	}

	const next = keyframes[index + 1];
	if (!next) return { rect: rectOf(current), opacity: 1 };
	// Hold the last known rect until the lost instant rather than sliding towards it.
	if (next.lost) return { rect: rectOf(current), opacity: 1 };

	const span = next.timeMs - current.timeMs;
	if (span <= 0) return { rect: rectOf(current), opacity: 1 };

	const a = rectOf(current);
	const b = rectOf(next);
	// Union safety: only across an interval the tracker never saw at frame rate.
	// A long gap on its own is not enough - simplification leaves those behind
	// precisely because it checked that a straight line reproduces every sample
	// it dropped, and unioning there would freeze the blur at the corner of a
	// smooth scroll instead of following it.
	if (current.gap) {
		const sourceHeight = Math.max(1, track.sourceSize.height);
		const sourceWidth = Math.max(1, track.sourceSize.width);
		const displacementPx = Math.hypot((b.x - a.x) * sourceWidth, (b.y - a.y) * sourceHeight);
		if (span > BLUR_TRACK_UNION_GAP_MS && displacementPx > BLUR_TRACK_UNION_PX) {
			return { rect: unionRect(a, b), opacity: 1 };
		}
	}

	const u = (timeMs - current.timeMs) / span;
	return { rect: lerpRect(a, b, u), opacity: 1 };
}

/**
 * Drops keyframes a straight line between their neighbours already predicts to
 * within `tolerancePx` source pixels. Transitions (any `lost` change), user
 * pins and the endpoints are always kept: they carry meaning a lerp cannot.
 */
export function simplifyKeyframes(
	keyframes: readonly BlurTrackKeyframe[],
	sourceSize: { width: number; height: number },
	tolerancePx = BLUR_TRACK_SIMPLIFY_PX,
): BlurTrackKeyframe[] {
	if (keyframes.length <= 2) return keyframes.slice();
	const width = Math.max(1, sourceSize.width);
	const height = Math.max(1, sourceSize.height);

	const kept: BlurTrackKeyframe[] = [keyframes[0]];
	for (let i = 1; i < keyframes.length - 1; i++) {
		const previous = kept[kept.length - 1];
		const current = keyframes[i];
		const next = keyframes[i + 1];

		const isTransition =
			Boolean(current.lost) !== Boolean(previous.lost) ||
			Boolean(current.lost) !== Boolean(next.lost);
		// A keyframe that opens an unobserved interval, and the one that closes
		// it, both carry information no lerp can recover.
		if (isTransition || current.origin === "user" || previous.lost || current.gap || previous.gap) {
			kept.push(current);
			continue;
		}

		const span = next.timeMs - previous.timeMs;
		const u = span > 0 ? (current.timeMs - previous.timeMs) / span : 0;
		const predicted = lerpRect(rectOf(previous), rectOf(next), u);
		const errorPx = Math.max(
			Math.abs(predicted.x - current.x) * width,
			Math.abs(predicted.y - current.y) * height,
			Math.abs(predicted.w - current.w) * width,
			Math.abs(predicted.h - current.h) * height,
		);
		if (errorPx > tolerancePx) kept.push(current);
	}
	kept.push(keyframes[keyframes.length - 1]);
	return kept;
}

function normalizeKeyframe(value: unknown): BlurTrackKeyframe | null {
	if (!value || typeof value !== "object") return null;
	const raw = value as Record<string, unknown>;
	if (
		!isFiniteNumber(raw.timeMs) ||
		!isFiniteNumber(raw.x) ||
		!isFiniteNumber(raw.y) ||
		!isFiniteNumber(raw.w) ||
		!isFiniteNumber(raw.h)
	) {
		return null;
	}
	// A rect with no area covers nothing; a track full of them would render an
	// invisible blur that the user cannot find. Treat it as corrupt.
	if (raw.w <= 0 || raw.h <= 0) return null;
	if (raw.timeMs < 0) return null;

	const keyframe: BlurTrackKeyframe = {
		timeMs: raw.timeMs,
		x: raw.x,
		y: raw.y,
		w: raw.w,
		h: raw.h,
	};
	if (raw.lost === true) keyframe.lost = true;
	if (raw.gap === true) keyframe.gap = true;
	if (raw.origin === "user") keyframe.origin = "user";
	return keyframe;
}

/**
 * Coerces a persisted `blurTrack` into a usable track, or `undefined` when it
 * cannot be trusted. `undefined` is a safe answer everywhere: the region falls
 * back to the untracked, static box it was before tracking existed, which is
 * what an older project already is.
 *
 * Keyframes are sorted by time and duplicates collapse to the last one, so a
 * hand-edited or partially merged file still renders deterministically.
 */
export function normalizeBlurTrack(value: unknown): BlurTrack | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const raw = value as Record<string, unknown>;
	if (raw.space !== "source") return undefined;
	if (!Array.isArray(raw.keyframes) || raw.keyframes.length === 0) return undefined;

	const size = raw.sourceSize;
	if (!size || typeof size !== "object") return undefined;
	const rawSize = size as Record<string, unknown>;
	if (!isFiniteNumber(rawSize.width) || !isFiniteNumber(rawSize.height)) return undefined;
	if (rawSize.width <= 0 || rawSize.height <= 0) return undefined;

	const normalized: BlurTrackKeyframe[] = [];
	for (const entry of raw.keyframes) {
		const keyframe = normalizeKeyframe(entry);
		if (keyframe) normalized.push(keyframe);
	}
	if (normalized.length === 0) return undefined;

	// Stable sort by time, then collapse duplicate times keeping the last, so a
	// user pin written over a tracked sample wins.
	normalized.sort((a, b) => a.timeMs - b.timeMs);
	const keyframes: BlurTrackKeyframe[] = [];
	for (const keyframe of normalized) {
		const last = keyframes[keyframes.length - 1];
		if (last && last.timeMs === keyframe.timeMs) keyframes[keyframes.length - 1] = keyframe;
		else keyframes.push(keyframe);
	}

	const sampleIntervalMs =
		isFiniteNumber(raw.sampleIntervalMs) && raw.sampleIntervalMs > 0 ? raw.sampleIntervalMs : 100;
	const anchorMs =
		isFiniteNumber(raw.anchorMs) && raw.anchorMs >= 0 ? raw.anchorMs : keyframes[0].timeMs;

	const track: BlurTrack = {
		version: 1,
		space: "source",
		keyframes,
		sourceSize: { width: rawSize.width, height: rawSize.height },
		sampleIntervalMs,
		anchorMs,
	};

	const quality = raw.quality;
	if (quality && typeof quality === "object") {
		const q = quality as Record<string, unknown>;
		if (isFiniteNumber(q.meanScore) && isFiniteNumber(q.lostMs) && isFiniteNumber(q.trackedMs)) {
			track.quality = { meanScore: q.meanScore, lostMs: q.lostMs, trackedMs: q.trackedMs };
		}
	}
	return track;
}

/**
 * Writes a user-placed keyframe into a track, replacing tracked keyframes
 * within `±sampleIntervalMs` of it. Pins are the user's word about where the
 * content is; nothing else in the track may move them.
 *
 * Phase 3 drives this from the preview drag; the shape is fixed now so the
 * persisted model does not change again.
 */
export function mergeUserPin(track: BlurTrack, pin: BlurTrackKeyframe): BlurTrack {
	const window = track.sampleIntervalMs;
	const pinned: BlurTrackKeyframe = { ...pin, origin: "user" };
	delete pinned.lost;
	const kept = track.keyframes.filter((keyframe) => {
		if (keyframe.origin === "user") return keyframe.timeMs !== pinned.timeMs;
		return Math.abs(keyframe.timeMs - pinned.timeMs) > window;
	});
	kept.push(pinned);
	kept.sort((a, b) => a.timeMs - b.timeMs);
	return { ...track, keyframes: kept };
}
