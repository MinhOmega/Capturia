import type {
	AxcutAnnotationRegion,
	AxcutBlurTrack,
	AxcutClip,
	AxcutClipCropRegion,
} from "@/lib/ai-edition/schema";
import { type NormRect, normalizeBlurTrack, resolveTrackedBlurRect, unionRect } from "./keyframes";

/**
 * A tracked blur region, expanded into the static blur annotations the scene
 * contract already understands.
 *
 * The compositor's `SceneAnnotation` carries ONE fixed rect for a span of time
 * — but it carries its own span, so a region that moves is expressible as a run
 * of short annotations, one per step of the track, with no schema change, no
 * Rust and no shader work. Every backend already draws blur / mosaic in
 * rectangle / oval / freehand; the only thing that was ours is *where the box
 * is at time t*, and that is answered here, in TypeScript, next to the tracker.
 *
 * Because this runs inside `buildSceneDescription`, live preview and MP4 export
 * get it from the same call: there is exactly one scene contract and no second
 * preview path to drift from it.
 *
 * ponytail: the region STEPS between emitted annotations instead of
 * interpolating inside one — the known ceiling of expressing motion in a
 * fixed-rect schema. Two things keep it cheap rather than wrong:
 *
 *   1. density is a parameter, not a constant: the grid is the track's own
 *      `sampleIntervalMs`, and every keyframe instant is a step boundary too,
 *      so a stretch the tracker densified to frame rate emits at frame rate
 *      while a still stretch stays at 10 Hz;
 *   2. each step covers the UNION of its two ends, so the content is inside the
 *      blur for the whole step at any density. The step is visible as a box
 *      that grows and shrinks, never as content escaping it — which is the
 *      failure that would matter for a redaction.
 *
 * The upgrade path, if the stepping ever reads as stepping: a native `path` /
 * keyframe array on `SceneAnnotation` that the three backends interpolate
 * per-frame. Nothing here has to move for that — this file becomes the thing
 * that writes the path instead of the run.
 */

/** Floor on a step, in ms. Spans are quantised to whole ms downstream (`projectRegionsToSource`
 *  rounds `sourceStartSec * 1000`), so a sub-millisecond step would collapse to a zero-length
 *  annotation, which is never visible: `startSec <= t < endSec` is empty. */
const MIN_STEP_MS = 1;

/** Identity crop, for a clip that has none. */
const FULL_FRAME: AxcutClipCropRegion = { x: 0, y: 0, width: 1, height: 1 };

/**
 * Source-normalised rect (fractions of the FULL source frame, what the tracker
 * measures) to the annotation's own box: percentages of the screen rect, which
 * shows the CROPPED source. Clipped to that rect, so a blur that has scrolled
 * out of the crop does not paint on the wallpaper beside the video; `null` when
 * none of it is left.
 */
export function sourceRectToAnnotationBox(
	rect: NormRect,
	crop: AxcutClipCropRegion = FULL_FRAME,
): { position: { x: number; y: number }; size: { width: number; height: number } } | null {
	const cw = crop.width > 0 ? crop.width : 1;
	const ch = crop.height > 0 ? crop.height : 1;
	const left = Math.max(0, ((rect.x - crop.x) / cw) * 100);
	const top = Math.max(0, ((rect.y - crop.y) / ch) * 100);
	const right = Math.min(100, ((rect.x + rect.w - crop.x) / cw) * 100);
	const bottom = Math.min(100, ((rect.y + rect.h - crop.y) / ch) * 100);
	if (!(right > left) || !(bottom > top)) return null;
	return { position: { x: left, y: top }, size: { width: right - left, height: bottom - top } };
}

/** The instants that bound the emitted annotations: a regular grid at the track's own sample
 *  interval, plus every keyframe inside the span, in whole ms and deduplicated. Injecting the
 *  keyframes is what makes a densified stretch emit densely without paying for it everywhere. */
function stepBoundariesMs(track: AxcutBlurTrack, startMs: number, endMs: number): number[] {
	const step = Math.max(MIN_STEP_MS, track.sampleIntervalMs);
	const first = Math.round(startMs);
	const last = Math.round(endMs);
	const marks = new Set<number>([first, last]);
	for (let t = first + step; t < last; t += step) marks.add(Math.round(t));
	for (const keyframe of track.keyframes) {
		const t = Math.round(keyframe.timeMs);
		if (t > first && t < last) marks.add(t);
	}
	return [...marks].sort((a, b) => a - b);
}

/**
 * Replaces every tracked blur region with its run of static ones, leaving every
 * other annotation untouched. Call BEFORE `projectRegionsToSource`: the
 * fragments are ordinary clip-anchored annotations from there on, so trims,
 * clip splitting and `clipIndex` all fall out of the existing projection.
 *
 * A region without a complete clip anchor is passed through as-is: the track's
 * instants are that clip's SOURCE time, and without the anchor there is no
 * source time to read them against. Nothing writes a track without an anchor
 * (both are v5-and-later), so this only guards a hand-edited document.
 */
export function expandTrackedBlurAnnotations(
	annotations: readonly AxcutAnnotationRegion[],
	clips: readonly AxcutClip[],
	makeId: () => string,
): AxcutAnnotationRegion[] {
	const out: AxcutAnnotationRegion[] = [];
	for (const region of annotations) {
		const track = region.type === "blur" ? normalizeBlurTrack(region.blurTrack) : undefined;
		if (
			!track ||
			!region.clipId ||
			region.sourceStartSec === undefined ||
			region.sourceEndSec === undefined
		) {
			out.push(region);
			continue;
		}

		const startMs = region.sourceStartSec * 1000;
		const endMs = region.sourceEndSec * 1000;
		const crop = clips.find((clip) => clip.id === region.clipId)?.cropRegion ?? FULL_FRAME;
		// Raw-virtual and source time differ by a constant inside one clip, so the
		// derived `startMs`/`endMs` cache follows by the same shift.
		const rawShiftMs = region.startMs - startMs;
		const marks = stepBoundariesMs(track, startMs, endMs);

		let emitted = 0;
		for (let i = 0; i < marks.length - 1; i++) {
			const from = marks[i];
			const to = marks[i + 1];
			const head = resolveTrackedBlurRect(track, from);
			const tail = resolveTrackedBlurRect(track, to);
			// Both ends hidden: the content is not visible anywhere in this step, so
			// nothing is drawn and the run simply has a hole. One end hidden still
			// draws the other — a blur that lingers costs nothing, one that leaves early leaks.
			const rect =
				head && tail ? unionRect(head.rect, tail.rect) : (head?.rect ?? tail?.rect ?? null);
			if (!rect) continue;
			// ponytail: `opacity` from the track's fade-out is dropped — `SceneAnnotation`
			// has no alpha, so the 100 ms fade after a lost keyframe is a hard cut. Erring
			// towards more blur, not less. Upgrade with the native keyframe field.
			const box = sourceRectToAnnotationBox(rect, crop);
			if (!box) continue;
			out.push({
				...region,
				id: emitted === 0 ? region.id : makeId(),
				// Touching spans, and the compositor's window is half-open (`t >= startSec &&
				// t < endSec`, identical in all three backends), so consecutive steps leave
				// neither a one-frame gap nor a frame drawn twice.
				sourceStartSec: from / 1000,
				sourceEndSec: to / 1000,
				startMs: Math.round(from + rawShiftMs),
				endMs: Math.round(to + rawShiftMs),
				position: box.position,
				size: box.size,
				// The run IS the track; carrying it on the fragments would invite a second expansion.
				blurTrack: undefined,
			});
			emitted += 1;
		}
		// Tracked, but never visible anywhere in its span (every keyframe lost, or the
		// whole path outside the crop). Keep the authored box so the region does not
		// silently vanish from a render it is present in.
		if (emitted === 0) out.push({ ...region, blurTrack: undefined });
	}
	return out;
}
