// The properties the whole "a moving region is a run of static ones" idea rests on.
// If one of these breaks, tracked blur is wrong on BOTH preview and export at once —
// they read the same scene — so they are pinned here rather than left to a render check.

import { describe, expect, it } from "vitest";
import type { AxcutAnnotationRegion, AxcutBlurTrack, AxcutClip } from "@/lib/ai-edition/schema";
import { resolveTrackedBlurRect } from "./keyframes";
import { expandTrackedBlurAnnotations, sourceRectToAnnotationBox } from "./sceneSteps";

const SOURCE = { width: 1920, height: 1080 };

function clip(overrides: Partial<AxcutClip> = {}): AxcutClip {
	return {
		id: "c1",
		assetId: "a1",
		sourceStartSec: 0,
		sourceEndSec: 60,
		timelineStartSec: 0,
		timelineEndSec: 60,
		...overrides,
	} as AxcutClip;
}

/** A track that scrolls the box down at a constant rate, one keyframe a second. */
function scrollingTrack(durationSec: number, sampleIntervalMs = 100): AxcutBlurTrack {
	const keyframes = [];
	for (let timeMs = 0; timeMs <= durationSec * 1000; timeMs += 1000) {
		keyframes.push({ timeMs, x: 0.2, y: 0.1 + timeMs / 100_000, w: 0.2, h: 0.1 });
	}
	return {
		version: 1,
		space: "source",
		keyframes,
		sourceSize: SOURCE,
		sampleIntervalMs,
		anchorMs: 0,
	};
}

function blurRegion(overrides: Partial<AxcutAnnotationRegion> = {}): AxcutAnnotationRegion {
	return {
		id: "ann1",
		startMs: 0,
		endMs: 4000,
		clipId: "c1",
		sourceStartSec: 0,
		sourceEndSec: 4,
		type: "blur",
		content: "",
		position: { x: 20, y: 10 },
		size: { width: 20, height: 10 },
		style: {} as AxcutAnnotationRegion["style"],
		zIndex: 3,
		blurData: {
			type: "mosaic",
			shape: "rectangle",
			color: "white",
			intensity: 12,
			blockSize: 12,
		},
		...overrides,
	} as AxcutAnnotationRegion;
}

describe("expandTrackedBlurAnnotations", () => {
	it("leaves an annotation without a track exactly as it was", () => {
		const regions = [blurRegion(), blurRegion({ id: "t", type: "text" })];
		expect(expandTrackedBlurAnnotations(regions, [clip()], () => "x")).toEqual(regions);
	});

	it("refuses to read a track against a region with no clip anchor", () => {
		// The keyframes are the CLIP's source time; without the anchor there is no
		// source time to read them against, so the static box is the honest answer.
		const region = blurRegion({
			clipId: undefined,
			sourceStartSec: undefined,
			sourceEndSec: undefined,
			blurTrack: scrollingTrack(4),
		});
		const out = expandTrackedBlurAnnotations([region], [clip()], () => "x");
		expect(out).toHaveLength(1);
		expect(out[0].position).toEqual({ x: 20, y: 10 });
	});

	it("tiles the region's span with touching, non-overlapping spans", () => {
		// The compositor's window is half-open in all three backends
		// (`t >= startSec && t < endSec`), so touching spans mean exactly one
		// annotation is live at every instant: no seam frame, no double blur.
		let n = 0;
		const out = expandTrackedBlurAnnotations(
			[blurRegion({ blurTrack: scrollingTrack(4) })],
			[clip()],
			() => `gen${n++}`,
		);
		expect(out.length).toBe(40);
		expect(out[0].sourceStartSec).toBe(0);
		expect(out.at(-1)?.sourceEndSec).toBe(4);
		for (let i = 0; i < out.length - 1; i++) {
			expect(out[i].sourceEndSec).toBe(out[i + 1].sourceStartSec);
		}
		// Whole-millisecond boundaries, because `projectRegionsToSource` rounds
		// `sourceStartSec * 1000` — a fractional one would round two neighbours onto the
		// same millisecond and drop a step to zero length.
		for (const fragment of out) {
			expect(Number.isInteger((fragment.sourceStartSec ?? 0) * 1000)).toBe(true);
		}
	});

	it("keeps the region's id on the first fragment and its zIndex on all of them", () => {
		// The scene sorts by zIndex and the sort is stable, so one zIndex for the whole
		// run keeps it contiguous and in emission order however long it is.
		let n = 0;
		const out = expandTrackedBlurAnnotations(
			[blurRegion({ blurTrack: scrollingTrack(4) })],
			[clip()],
			() => `gen${n++}`,
		);
		expect(out[0].id).toBe("ann1");
		expect(new Set(out.map((f) => f.id)).size).toBe(out.length);
		expect(new Set(out.map((f) => f.zIndex))).toEqual(new Set([3]));
		// Style survives verbatim; only the box and the span are rewritten.
		expect(out.every((f) => f.blurData?.type === "mosaic")).toBe(true);
		expect(out.every((f) => f.blurTrack === undefined)).toBe(true);
	});

	it("covers the tracked rect at every instant inside a step, not just at its ends", () => {
		// This is what makes the stepping an artefact rather than a leak: each step is
		// the UNION of its two ends, so the interpolated content never pokes out.
		const track = scrollingTrack(4);
		const out = expandTrackedBlurAnnotations(
			[blurRegion({ blurTrack: track })],
			[clip()],
			() => "x",
		);
		for (const fragment of out) {
			const from = (fragment.sourceStartSec ?? 0) * 1000;
			const to = (fragment.sourceEndSec ?? 0) * 1000;
			for (let t = from; t <= to; t += (to - from) / 8) {
				const truth = resolveTrackedBlurRect(track, t);
				if (!truth) continue;
				expect(truth.rect.x * 100).toBeGreaterThanOrEqual(fragment.position.x - 1e-9);
				expect(truth.rect.y * 100).toBeGreaterThanOrEqual(fragment.position.y - 1e-9);
				expect((truth.rect.x + truth.rect.w) * 100).toBeLessThanOrEqual(
					fragment.position.x + fragment.size.width + 1e-9,
				);
				expect((truth.rect.y + truth.rect.h) * 100).toBeLessThanOrEqual(
					fragment.position.y + fragment.size.height + 1e-9,
				);
			}
		}
	});

	it("emits a keyframe instant as its own boundary, so a densified stretch steps finely", () => {
		// Density is the track's, not a constant: a keyframe off the regular grid splits
		// the step it falls in rather than being averaged across it.
		const track: AxcutBlurTrack = {
			...scrollingTrack(1),
			keyframes: [
				{ timeMs: 0, x: 0.2, y: 0.1, w: 0.2, h: 0.1 },
				{ timeMs: 137, x: 0.2, y: 0.4, w: 0.2, h: 0.1 },
				{ timeMs: 1000, x: 0.2, y: 0.5, w: 0.2, h: 0.1 },
			],
		};
		const out = expandTrackedBlurAnnotations(
			[blurRegion({ blurTrack: track, endMs: 1000, sourceEndSec: 1 })],
			[clip()],
			() => "x",
		);
		const bounds = out.map((f) => (f.sourceStartSec ?? 0) * 1000);
		expect(bounds).toContain(137);
	});

	it("stops drawing while the content is out of sight", () => {
		const track: AxcutBlurTrack = {
			...scrollingTrack(1),
			keyframes: [
				{ timeMs: 0, x: 0.2, y: 0.1, w: 0.2, h: 0.1 },
				{ timeMs: 200, x: 0.2, y: 0.1, w: 0.2, h: 0.1, lost: true },
				{ timeMs: 800, x: 0.2, y: 0.6, w: 0.2, h: 0.1 },
			],
		};
		const out = expandTrackedBlurAnnotations(
			[blurRegion({ blurTrack: track, endMs: 1000, sourceEndSec: 1 })],
			[clip()],
			() => "x",
		);
		const covered = (ms: number) =>
			out.some((f) => ms >= (f.sourceStartSec ?? 0) * 1000 && ms < (f.sourceEndSec ?? 0) * 1000);
		expect(covered(100)).toBe(true);
		// The fade is a hard cut here (no alpha in the scene contract), so the hole opens
		// one fade-length after the lost keyframe and closes when the content is back.
		expect(covered(500)).toBe(false);
		expect(covered(900)).toBe(true);
	});

	it("keeps a region that is tracked but never visible, rather than dropping it", () => {
		const track: AxcutBlurTrack = {
			...scrollingTrack(1),
			keyframes: [{ timeMs: 0, x: 5, y: 5, w: 0.2, h: 0.1 }],
		};
		const out = expandTrackedBlurAnnotations(
			[blurRegion({ blurTrack: track, endMs: 1000, sourceEndSec: 1 })],
			[clip()],
			() => "x",
		);
		expect(out).toHaveLength(1);
		expect(out[0].position).toEqual({ x: 20, y: 10 });
	});

	it("stays a sane payload over a minute-long region", () => {
		// Measured 2026-09-09: 600 annotations, ~138 KiB of scene JSON for a full minute
		// at the tracker's own 10 Hz grid. The compositor scans the list once per frame
		// with a float compare and skips everything invisible before any GPU work, and
		// `Scene::for_clip_window` clones it on a scene/clip change, not per frame — so
		// the payload, not the per-frame loop, is the thing to watch.
		//
		// ponytail: rebuilt on every document change, which includes each tick of a
		// slider drag. If that ever shows up in a profile, memoise the expansion on the
		// region's identity before reaching for a coarser grid — coarsening trades size
		// for a bigger union, i.e. a visibly fatter blur.
		const out = expandTrackedBlurAnnotations(
			[blurRegion({ blurTrack: scrollingTrack(60), endMs: 60_000, sourceEndSec: 60 })],
			[clip()],
			() => "x",
		);
		expect(out.length).toBe(600);
		expect(JSON.stringify(out).length).toBeLessThan(400_000);
	});
});

describe("sourceRectToAnnotationBox", () => {
	it("is the identity, in percent, without a crop", () => {
		expect(sourceRectToAnnotationBox({ x: 0.25, y: 0.5, w: 0.1, h: 0.2 })).toEqual({
			position: { x: 25, y: 50 },
			size: { width: 10, height: 20 },
		});
	});

	it("re-normalises against the crop, because the screen rect shows the CROPPED source", () => {
		const crop = { x: 0.25, y: 0, width: 0.5, height: 1 };
		expect(sourceRectToAnnotationBox({ x: 0.5, y: 0.5, w: 0.1, h: 0.2 }, crop)).toEqual({
			position: { x: 50, y: 50 },
			size: { width: 20, height: 20 },
		});
	});

	it("clips to the screen rect so a scrolled-away blur cannot paint the wallpaper", () => {
		const crop = { x: 0.25, y: 0, width: 0.5, height: 1 };
		const box = sourceRectToAnnotationBox({ x: 0.7, y: 0.5, w: 0.2, h: 0.2 }, crop);
		expect(box?.position.x).toBeCloseTo(90, 9);
		expect(box?.size.width).toBeCloseTo(10, 9);
		// Entirely past the crop's right edge: nothing to draw, rather than a sliver
		// pinned to the edge or a box over the wallpaper beside the footage.
		expect(sourceRectToAnnotationBox({ x: 0.8, y: 0.5, w: 0.1, h: 0.2 }, crop)).toBeNull();
	});
});
