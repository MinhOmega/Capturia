import type {
	AxcutBlurTrack as BlurTrack,
	AxcutBlurTrackKeyframe as BlurTrackKeyframe,
} from "@/lib/ai-edition/schema";
import { simplifyKeyframes } from "./keyframes";
import { BLUR_TRACKER_TUNING, type SourceRectPx, type TrackerSample } from "./trackerCore";

/**
 * The decisions a track makes that are not about pixels: which instants to
 * analyse, when a gap between two of them is too large to interpolate, and how
 * the analysed samples become the keyframe list that gets persisted.
 *
 * Kept apart from the worker and the decoder so the node lane can check the
 * grid, the densification rule and the keyframe construction without a browser.
 * See `docs/specs/tracked-blur-regions.md` §1.8 and §2.
 */

/** Displacement, in source px, above which the samples either side need filling in. */
export const DENSIFY_THRESHOLD_PX = 6;
/** Two analysed samples further apart than this in time bound an interval the tracker did not see. */
export const UNION_GAP_MS = 40;

export interface SampleGrid {
	/** Instants before the anchor, in the order they are analysed: descending. */
	backward: number[];
	/** Instants after the anchor, ascending. */
	forward: number[];
}

/**
 * The fixed analysis grid `t_k = anchorMs + k * interval`, clamped to the
 * region's span.
 *
 * Fixed rather than adaptive because the whole feature has to be
 * deterministic: the same file must produce the same keyframes, and an
 * adaptive rate would make the answer depend on how fast the machine decoded.
 */
export function buildSampleGrid(
	anchorMs: number,
	startMs: number,
	endMs: number,
	intervalMs: number = BLUR_TRACKER_TUNING.sampleIntervalMs,
): SampleGrid {
	const backward: number[] = [];
	const forward: number[] = [];
	if (!(intervalMs > 0)) return { backward, forward };

	for (let k = 1; ; k++) {
		const time = anchorMs + k * intervalMs;
		if (time > endMs) break;
		forward.push(time);
	}
	for (let k = 1; ; k++) {
		const time = anchorMs - k * intervalMs;
		if (time < startMs) break;
		backward.push(time);
	}
	return { backward, forward };
}

/**
 * Whether the frames between two analysed samples have to be analysed too.
 *
 * At ten samples a second a flick scroll moves the content past a hundred
 * source pixels between them, and interpolating across that leaves the blur
 * tens of pixels off its content for a few frames. For a redaction that is a
 * leak, so motion is analysed at the source frame rate for as long as it lasts.
 */
export function shouldDensify(previous: TrackerSample, current: TrackerSample): boolean {
	if (previous.state !== current.state) return true;
	return Math.hypot(current.x - previous.x, current.y - previous.y) > DENSIFY_THRESHOLD_PX;
}

/** Chunk boundaries for the backward pass, which has to be decoded forwards. */
export function planBackwardChunks(times: number[], chunkSize: number): number[][] {
	if (chunkSize <= 0) return times.length > 0 ? [times.slice()] : [];
	const chunks: number[][] = [];
	for (let i = 0; i < times.length; i += chunkSize) chunks.push(times.slice(i, i + chunkSize));
	return chunks;
}

function toKeyframe(
	sample: { timeMs: number; x: number; y: number; w: number; h: number },
	sourceSize: { width: number; height: number },
): BlurTrackKeyframe {
	return {
		timeMs: sample.timeMs,
		x: sample.x / sourceSize.width,
		y: sample.y / sourceSize.height,
		w: sample.w / sourceSize.width,
		h: sample.h / sourceSize.height,
	};
}

export interface BuildTrackOptions {
	sourceSize: { width: number; height: number };
	anchorMs: number;
	sampleIntervalMs?: number;
	/** Keyframes the user placed by hand; never moved, never dropped. */
	pins?: BlurTrackKeyframe[];
}

/**
 * Turns analysed samples into the persisted keyframe list.
 *
 * Three rules carry meaning beyond copying numbers across:
 *
 * - a **tentative** sample emits nothing. The rect is held where it was until
 *   the content is clearly visible again, which is what stops a cursor passing
 *   over a patch from nudging the blur;
 * - a run of **lost** samples collapses to the one keyframe that starts it,
 *   carrying the last known rect for the fade-out and the hidden span;
 * - a **found** sample that ends a lost span is stamped one grid interval
 *   early. Redaction is asymmetric: a blur that appears slightly before the
 *   content could have come back costs nothing, and one that appears late is
 *   the leak this feature exists to prevent.
 */
export function buildBlurTrack(
	samples: readonly TrackerSample[],
	options: BuildTrackOptions,
): BlurTrack {
	const { sourceSize, anchorMs } = options;
	const sampleIntervalMs = options.sampleIntervalMs ?? BLUR_TRACKER_TUNING.sampleIntervalMs;
	const ordered = [...samples].sort((a, b) => a.timeMs - b.timeMs);

	const keyframes: BlurTrackKeyframe[] = [];
	let previousState: TrackerSample["state"] | null = null;
	let scoreTotal = 0;
	let scoreCount = 0;
	let lostMs = 0;
	let trackedMs = 0;

	for (const sample of ordered) {
		if (sample.state === "found") {
			scoreTotal += sample.score;
			scoreCount++;
			trackedMs += sampleIntervalMs;
		} else if (sample.state === "lost") {
			lostMs += sampleIntervalMs;
		}

		if (sample.state === "tentative") {
			previousState = sample.state;
			continue;
		}

		if (sample.state === "lost") {
			// Only the first sample of a lost run becomes a keyframe; the rest say
			// the same thing.
			if (previousState !== "lost") {
				keyframes.push({ ...toKeyframe(sample, sourceSize), lost: true });
			}
			previousState = sample.state;
			continue;
		}

		const keyframe = toKeyframe(sample, sourceSize);
		if (sample.reacquired) {
			const preRolled = sample.timeMs - sampleIntervalMs;
			const previous = keyframes[keyframes.length - 1];
			// Never behind the keyframe that opened the lost span, or the list would
			// stop being sorted.
			keyframe.timeMs = previous ? Math.max(previous.timeMs + 1, preRolled) : preRolled;
		}
		keyframes.push(keyframe);
		previousState = sample.state;
	}

	keyframes.sort((a, b) => a.timeMs - b.timeMs);

	// Mark the intervals the tracker never saw at frame rate. Densification
	// fills in a fast movement wherever the decode path can offer the frames; on
	// the seek path it cannot, and the renderer has to cover both ends rather
	// than interpolate across an interval where the content could have been
	// anywhere (§1.8 rule 2). Done on the analysed samples, before simplification
	// collapses the smooth stretches, because afterwards the two are
	// indistinguishable by time alone.
	const emitted = ordered.filter((sample) => sample.state !== "tentative");
	for (let i = 0; i < emitted.length - 1; i++) {
		const current = emitted[i];
		const next = emitted[i + 1];
		if (current.state === "lost" || next.state === "lost") continue;
		const gapMs = next.timeMs - current.timeMs;
		if (gapMs <= UNION_GAP_MS) continue;
		if (Math.hypot(next.x - current.x, next.y - current.y) <= DENSIFY_THRESHOLD_PX) continue;
		const keyframe = keyframes.find((entry) => entry.timeMs === current.timeMs);
		if (keyframe) keyframe.gap = true;
	}

	// The anchor instant is analysed by both passes, so it arrives twice.
	// Collapse equal instants keeping the first: two keyframes at the same time
	// leave the renderer resolving a zero-length interval, which reads as a
	// four-pixel jump at the seam between the two passes.
	const deduped: BlurTrackKeyframe[] = [];
	for (const keyframe of keyframes) {
		const last = deduped[deduped.length - 1];
		if (last && last.timeMs === keyframe.timeMs) continue;
		deduped.push(keyframe);
	}
	keyframes.length = 0;
	keyframes.push(...deduped);

	for (const pin of options.pins ?? []) {
		const index = keyframes.findIndex((keyframe) => keyframe.timeMs === pin.timeMs);
		if (index >= 0) keyframes[index] = { ...pin, origin: "user" };
		else keyframes.push({ ...pin, origin: "user" });
	}
	keyframes.sort((a, b) => a.timeMs - b.timeMs);

	const simplified = simplifyKeyframes(keyframes, sourceSize);
	return {
		version: 1,
		space: "source",
		keyframes: simplified.length > 0 ? simplified : keyframes,
		sourceSize,
		sampleIntervalMs,
		anchorMs,
		quality: {
			meanScore: scoreCount > 0 ? scoreTotal / scoreCount : 0,
			lostMs,
			trackedMs,
		},
	};
}

/** The anchor rectangle in source pixels, from a source-normalised rect. */
export function normRectToSourcePx(
	rect: { x: number; y: number; w: number; h: number },
	sourceSize: { width: number; height: number },
): SourceRectPx {
	return {
		x: rect.x * sourceSize.width,
		y: rect.y * sourceSize.height,
		w: rect.w * sourceSize.width,
		h: rect.h * sourceSize.height,
	};
}
