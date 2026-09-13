import { describe, expect, it } from "vitest";
import type { AxcutClip, AxcutTrimRange, AxcutWord } from "../schema";
import { buildIdleSpeedups } from "./idle-speedups";
import type { ZoomSuggestionSample } from "./zoom-suggestions";

/** A parked pointer: samples 200ms apart at one spot, which is what the dwell walk
 *  reads as "nothing happened here". */
function park(startMs: number, endMs: number, cx: number): ZoomSuggestionSample[] {
	const samples: ZoomSuggestionSample[] = [];
	for (let timeMs = startMs; timeMs <= endMs; timeMs += 200) samples.push({ timeMs, cx, cy: 0.5 });
	return samples;
}

/** Busy for a second at one spot, then parked somewhere else from 1.2s to 5s. */
const oneIdleStretch = [...park(0, 1000, 0.2), ...park(1200, 5000, 0.8)];

const clip: AxcutClip = {
	id: "clip_a",
	assetId: "asset_1",
	sourceStartSec: 0,
	sourceEndSec: 60,
	timelineStartSec: 0,
	timelineEndSec: 60,
	wordRefs: [],
	origin: "user",
	reason: "",
};

let counter = 0;
function word(startSec: number, endSec: number): AxcutWord {
	return { id: `w_${++counter}`, segmentId: "seg_1", startSec, endSec, text: "talking" };
}

function trim(startSec: number, endSec: number, assetId = "asset_1"): AxcutTrimRange {
	return { id: `trim_${startSec}`, assetId, startSec, endSec, reason: "manual", origin: "user" };
}

describe("buildIdleSpeedups", () => {
	it("speeds up a long park with no transcript at all", () => {
		expect(
			buildIdleSpeedups({ cursorTelemetry: oneIdleStretch, assetId: "asset_1", clips: [clip] }),
		).toEqual([{ startMs: 1200, endMs: 5000, speed: 3 }]);
	});

	// The whole point of the second signal: a narrator talking through the wait is
	// not waiting, they are the content, and 3× would make them a chipmunk.
	it("leaves a park that is talked over alone", () => {
		expect(
			buildIdleSpeedups({
				cursorTelemetry: oneIdleStretch,
				assetId: "asset_1",
				clips: [clip],
				words: [word(1.5, 2.4), word(2.6, 4.8)],
			}),
		).toEqual([]);
	});

	// Speech does not veto the whole stretch, it splits it — and only what is left
	// over on both sides clears the floor. Here 1.2–4.0s does, 4.5–5.0s does not.
	it("keeps only the silent part of a park that ends in speech", () => {
		expect(
			buildIdleSpeedups({
				cursorTelemetry: oneIdleStretch,
				assetId: "asset_1",
				clips: [clip],
				words: [word(4, 4.5)],
			}),
		).toEqual([{ startMs: 1200, endMs: 4000, speed: 3 }]);
	});

	it("refuses a stretch an existing trim already cuts", () => {
		expect(
			buildIdleSpeedups({
				cursorTelemetry: oneIdleStretch,
				assetId: "asset_1",
				clips: [clip],
				trimRanges: [trim(4, 6)],
			}),
		).toEqual([]);
	});

	// A trim on a different recording is not this recording's business.
	it("ignores a trim belonging to another asset", () => {
		expect(
			buildIdleSpeedups({
				cursorTelemetry: oneIdleStretch,
				assetId: "asset_1",
				clips: [clip],
				trimRanges: [trim(4, 6, "asset_2")],
			}),
		).toHaveLength(1);
	});

	// Running the pass twice must not stack a second region on the same wait.
	it("refuses a stretch an existing speed region already covers", () => {
		expect(
			buildIdleSpeedups({
				cursorTelemetry: oneIdleStretch,
				assetId: "asset_1",
				clips: [clip],
				existingSpeedRegions: [{ startMs: 4800, endMs: 9000 }],
			}),
		).toEqual([]);
	});

	// 2s of stillness is a pause, not a wait — under the floor and under no region.
	it("ignores a park shorter than the minimum", () => {
		expect(
			buildIdleSpeedups({
				cursorTelemetry: [...park(0, 1000, 0.2), ...park(1200, 3200, 0.8)],
				assetId: "asset_1",
				clips: [clip],
			}),
		).toEqual([]);
	});

	it("finds nothing when the recording has no cursor telemetry", () => {
		expect(buildIdleSpeedups({ cursorTelemetry: [], assetId: "asset_1", clips: [clip] })).toEqual(
			[],
		);
	});

	// The projection: a clip drawing source 10–60 at ruler 4 shifts every region by
	// its own offset, and the part of the park outside the clip's window is gone.
	it("projects onto each clip that draws the recording", () => {
		expect(
			buildIdleSpeedups({
				cursorTelemetry: oneIdleStretch,
				assetId: "asset_1",
				clips: [
					clip,
					{ ...clip, id: "clip_b", sourceStartSec: 2, timelineStartSec: 100, timelineEndSec: 158 },
				],
			}),
		).toEqual([
			{ startMs: 1200, endMs: 5000, speed: 3 },
			{ startMs: 100_000, endMs: 103_000, speed: 3 },
		]);
	});
});
