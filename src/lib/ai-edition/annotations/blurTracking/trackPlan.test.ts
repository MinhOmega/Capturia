import { describe, expect, it } from "vitest";
import { resolveTrackedBlurRect } from "./keyframes";
import {
	buildBlurTrack,
	buildSampleGrid,
	DENSIFY_THRESHOLD_PX,
	normRectToSourcePx,
	planBackwardChunks,
	shouldDensify,
} from "./trackPlan";
import type { TrackerSample } from "./trackerCore";

const SOURCE = { width: 1280, height: 720 };

function sample(overrides: Partial<TrackerSample> & { timeMs: number }): TrackerSample {
	return {
		x: 100,
		y: 200,
		w: 220,
		h: 20,
		state: "found",
		score: 0.95,
		maxQuadrantScore: 0.95,
		reacquired: false,
		...overrides,
	};
}

describe("buildSampleGrid", () => {
	it("walks outwards from the anchor and stops at the span", () => {
		const grid = buildSampleGrid(1000, 700, 1350, 100);
		expect(grid.forward).toEqual([1100, 1200, 1300]);
		expect(grid.backward).toEqual([900, 800, 700]);
	});

	it("is empty on both sides when the span is one interval wide", () => {
		expect(buildSampleGrid(1000, 1000, 1000, 100)).toEqual({ forward: [], backward: [] });
	});

	it("refuses a non-positive interval rather than looping forever", () => {
		expect(buildSampleGrid(1000, 0, 5000, 0)).toEqual({ forward: [], backward: [] });
	});

	it("lands on the same instants regardless of where the span starts", () => {
		// Determinism: the grid is anchored to t0, not to the span.
		const a = buildSampleGrid(1000, 0, 2000, 100);
		const b = buildSampleGrid(1000, 500, 1500, 100);
		expect(b.forward.every((time) => a.forward.includes(time))).toBe(true);
		expect(b.backward.every((time) => a.backward.includes(time))).toBe(true);
	});
});

describe("shouldDensify", () => {
	it("fires on a displacement over the threshold", () => {
		const previous = sample({ timeMs: 0 });
		expect(
			shouldDensify(previous, sample({ timeMs: 100, y: 200 + DENSIFY_THRESHOLD_PX + 1 })),
		).toBe(true);
		expect(
			shouldDensify(previous, sample({ timeMs: 100, y: 200 + DENSIFY_THRESHOLD_PX - 1 })),
		).toBe(false);
	});

	it("fires on any state change, however small the move", () => {
		expect(shouldDensify(sample({ timeMs: 0 }), sample({ timeMs: 100, state: "lost" }))).toBe(true);
		expect(shouldDensify(sample({ timeMs: 0, state: "lost" }), sample({ timeMs: 100 }))).toBe(true);
	});

	it("measures the displacement diagonally, not per axis", () => {
		const previous = sample({ timeMs: 0, x: 0, y: 0 });
		expect(shouldDensify(previous, sample({ timeMs: 100, x: 5, y: 5 }))).toBe(true);
	});
});

describe("planBackwardChunks", () => {
	it("splits into chunks of the requested size, last one short", () => {
		expect(planBackwardChunks([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
	});

	it("returns one chunk when the size is not usable", () => {
		expect(planBackwardChunks([1, 2, 3], 0)).toEqual([[1, 2, 3]]);
		expect(planBackwardChunks([], 0)).toEqual([]);
	});
});

describe("buildBlurTrack", () => {
	it("normalises source pixels against the frame", () => {
		const track = buildBlurTrack([sample({ timeMs: 0 })], { sourceSize: SOURCE, anchorMs: 0 });
		expect(track.keyframes[0].x).toBeCloseTo(100 / 1280, 9);
		expect(track.keyframes[0].y).toBeCloseTo(200 / 720, 9);
		expect(track.keyframes[0].w).toBeCloseTo(220 / 1280, 9);
		expect(track.sourceSize).toEqual(SOURCE);
	});

	it("emits nothing for a tentative sample so the rect is held where it was", () => {
		const track = buildBlurTrack(
			[
				sample({ timeMs: 0, y: 200 }),
				sample({ timeMs: 100, state: "tentative", y: 200 }),
				sample({ timeMs: 200, y: 260 }),
			],
			{ sourceSize: SOURCE, anchorMs: 0 },
		);
		expect(track.keyframes.map((keyframe) => keyframe.timeMs)).toEqual([0, 200]);
	});

	it("collapses a run of lost samples into the keyframe that starts it", () => {
		const track = buildBlurTrack(
			[
				sample({ timeMs: 0 }),
				sample({ timeMs: 100, state: "lost" }),
				sample({ timeMs: 200, state: "lost" }),
				sample({ timeMs: 300, state: "lost" }),
			],
			{ sourceSize: SOURCE, anchorMs: 0 },
		);
		const lost = track.keyframes.filter((keyframe) => keyframe.lost);
		expect(lost).toHaveLength(1);
		expect(lost[0].timeMs).toBe(100);
	});

	it("pre-rolls a re-acquisition by one grid interval, because early is free and late is a leak", () => {
		const track = buildBlurTrack(
			[
				sample({ timeMs: 0 }),
				sample({ timeMs: 100, state: "lost" }),
				sample({ timeMs: 200, state: "lost" }),
				sample({ timeMs: 300, reacquired: true, y: 400 }),
			],
			{ sourceSize: SOURCE, anchorMs: 0, sampleIntervalMs: 100 },
		);
		const found = track.keyframes.filter((keyframe) => !keyframe.lost);
		expect(found.map((keyframe) => keyframe.timeMs)).toEqual([0, 200]);
	});

	it("never lets the pre-roll reorder the list", () => {
		// The lost keyframe and the re-acquisition are one interval apart, so the
		// pre-roll would land exactly on it.
		const track = buildBlurTrack(
			[
				sample({ timeMs: 0 }),
				sample({ timeMs: 100, state: "lost" }),
				sample({ timeMs: 200, reacquired: true, y: 400 }),
			],
			{ sourceSize: SOURCE, anchorMs: 0, sampleIntervalMs: 100 },
		);
		const times = track.keyframes.map((keyframe) => keyframe.timeMs);
		expect(times).toEqual([...times].sort((a, b) => a - b));
		expect(new Set(times).size).toBe(times.length);
	});

	it("reports how much of the span was tracked and how much was hidden", () => {
		const track = buildBlurTrack(
			[
				sample({ timeMs: 0, score: 1 }),
				sample({ timeMs: 100, score: 0.8 }),
				sample({ timeMs: 200, state: "lost" }),
			],
			{ sourceSize: SOURCE, anchorMs: 0, sampleIntervalMs: 100 },
		);
		expect(track.quality).toEqual({ meanScore: 0.9, lostMs: 100, trackedMs: 200 });
	});

	it("sorts samples that arrived out of order, as the backward pass produces them", () => {
		const track = buildBlurTrack(
			[sample({ timeMs: 300 }), sample({ timeMs: 100 }), sample({ timeMs: 200, y: 260 })],
			{ sourceSize: SOURCE, anchorMs: 300 },
		);
		expect(track.keyframes.map((keyframe) => keyframe.timeMs)).toEqual([100, 200, 300]);
	});

	it("keeps user pins and lets them replace the tracked keyframe at the same instant", () => {
		const pin = { timeMs: 100, x: 0.5, y: 0.5, w: 0.1, h: 0.05, origin: "user" as const };
		const track = buildBlurTrack([sample({ timeMs: 0 }), sample({ timeMs: 100 })], {
			sourceSize: SOURCE,
			anchorMs: 0,
			pins: [pin],
		});
		const merged = track.keyframes.find((keyframe) => keyframe.timeMs === 100);
		expect(merged).toMatchObject({ origin: "user", x: 0.5 });
	});

	it("produces a track the renderer can resolve at every analysed instant", () => {
		const samples = [0, 100, 200, 300].map((timeMs) => sample({ timeMs, y: 200 + timeMs / 100 }));
		const track = buildBlurTrack(samples, { sourceSize: SOURCE, anchorMs: 0 });
		for (const analysed of samples) {
			const resolved = resolveTrackedBlurRect(track, analysed.timeMs);
			expect(resolved).not.toBeNull();
			expect(resolved!.rect.y * SOURCE.height).toBeCloseTo(analysed.y, 6);
		}
	});
});

describe("normRectToSourcePx", () => {
	it("is the inverse of the normalisation buildBlurTrack applies", () => {
		const rect = { x: 0.1, y: 0.2, w: 0.3, h: 0.05 };
		const px = normRectToSourcePx(rect, SOURCE);
		expect(px).toEqual({ x: 128, y: 144, w: 384, h: 36 });
	});
});
