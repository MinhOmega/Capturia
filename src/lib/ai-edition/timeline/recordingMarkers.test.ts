// The only non-trivial thing in the markers feature: a moment flagged at wall
// clock T during capture has to keep meaning the same frame after the editor has
// reordered, trimmed and retimed the recording underneath it.
//
// The claim these hold is the two-clock split. `sourceSec` never moves — it is
// what the sidecar stores. `rulerSec` follows the clip that carries the moment,
// so a reorder moves the marker with its content. `outputSec` additionally
// compresses trims out and scales by speed, so it is where the marker lands in
// the exported film. Getting `outputSec` from `sourceSec` directly, or storing a
// ruler position, is exactly the bug this shape exists to prevent.

import { describe, expect, it } from "vitest";
import type { AxcutClip, AxcutDocument, AxcutTrimRange } from "../schema";
import { resolveRecordingMarkers } from "./recordingMarkers";

function clip(over: Partial<AxcutClip> & { id: string }): AxcutClip {
	return {
		assetId: "a1",
		sourceStartSec: 0,
		sourceEndSec: 10,
		timelineStartSec: 0,
		timelineEndSec: 10,
		wordRefs: [],
		origin: "user",
		reason: "",
		...over,
	} as AxcutClip;
}

function trim(over: Partial<AxcutTrimRange> & { id: string }): AxcutTrimRange {
	return {
		assetId: "a1",
		startSec: 0,
		endSec: 1,
		origin: "user",
		reason: "",
		...over,
	} as AxcutTrimRange;
}

/** A 20s recording as two clips laid end to end, cut at source 10. */
function twoClips(): AxcutClip[] {
	return [
		clip({ id: "c1", sourceEndSec: 10, timelineEndSec: 10 }),
		clip({
			id: "c2",
			sourceStartSec: 10,
			sourceEndSec: 20,
			timelineStartSec: 10,
			timelineEndSec: 20,
		}),
	];
}

function doc(over: {
	clips?: AxcutClip[];
	trimRanges?: AxcutTrimRange[];
	speedRegions?: unknown;
}): AxcutDocument {
	return {
		timeline: {
			clips: over.clips ?? twoClips(),
			gaps: [],
			trimRanges: over.trimRanges ?? [],
			muteRanges: [],
			speedRanges: [],
			captionRanges: [],
		},
		legacyEditor: over.speedRegions === undefined ? null : { speedRegions: over.speedRegions },
	} as unknown as AxcutDocument;
}

describe("resolveRecordingMarkers", () => {
	it("is the identity on an untouched recording", () => {
		const markers = resolveRecordingMarkers(doc({}), "a1", [3_000, 14_500]);

		expect(markers).toEqual([
			{ clipId: "c1", sourceSec: 3, rulerSec: 3, outputSec: 3, removed: false },
			{ clipId: "c2", sourceSec: 14.5, rulerSec: 14.5, outputSec: 14.5, removed: false },
		]);
	});

	it("follows its clip when the take is reordered, and reorders with it", () => {
		// Same 20s of source, second half played first.
		const swapped = [
			clip({
				id: "c2",
				sourceStartSec: 10,
				sourceEndSec: 20,
				timelineStartSec: 0,
				timelineEndSec: 10,
			}),
			clip({
				id: "c1",
				sourceStartSec: 0,
				sourceEndSec: 10,
				timelineStartSec: 10,
				timelineEndSec: 20,
			}),
		];

		const markers = resolveRecordingMarkers(doc({ clips: swapped }), "a1", [3_000, 14_500]);

		// Source is untouched; ruler and output followed the content.
		expect(markers).toEqual([
			{ clipId: "c2", sourceSec: 14.5, rulerSec: 4.5, outputSec: 4.5, removed: false },
			{ clipId: "c1", sourceSec: 3, rulerSec: 13, outputSec: 13, removed: false },
		]);
	});

	it("shifts output time by the trims that precede it, and leaves the ruler alone", () => {
		// A trim is a hole in playback, not a shortening of the raw ruler.
		const trims = [trim({ id: "t1", startSec: 2, endSec: 5 })];

		const markers = resolveRecordingMarkers(doc({ trimRanges: trims }), "a1", [1_000, 8_000]);

		expect(markers).toEqual([
			{ clipId: "c1", sourceSec: 1, rulerSec: 1, outputSec: 1, removed: false },
			// 3s of film removed before it: ruler still 8, output 5.
			{ clipId: "c1", sourceSec: 8, rulerSec: 8, outputSec: 5, removed: false },
		]);
	});

	it("flags a marker the user later trimmed over instead of dropping it", () => {
		const trims = [trim({ id: "t1", startSec: 2, endSec: 5 })];

		const [marker] = resolveRecordingMarkers(doc({ trimRanges: trims }), "a1", [3_500]);

		expect(marker.removed).toBe(true);
		// The raw axis is not compacted, so the ruler position is still honest.
		expect(marker.rulerSec).toBe(3.5);
		// Output collapses to the edge the film jumps to, so a seek still lands.
		expect(marker.outputSec).toBe(2);
	});

	it("scales output time through a speed region while source and ruler stand still", () => {
		// 0-4s of raw ruler played at 2x: 4s of content takes 2s to play.
		const speedRegions = [{ id: "s1", startMs: 0, endMs: 4_000, speed: 2 }];

		const markers = resolveRecordingMarkers(doc({ speedRegions }), "a1", [2_000, 6_000]);

		expect(markers).toEqual([
			{ clipId: "c1", sourceSec: 2, rulerSec: 2, outputSec: 1, removed: false },
			// 4s at 2x = 2s, plus the 2s after the region at 1x.
			{ clipId: "c1", sourceSec: 6, rulerSec: 6, outputSec: 4, removed: false },
		]);
	});

	it("composes a trim and a speed region on the same marker", () => {
		const trims = [trim({ id: "t1", startSec: 1, endSec: 2 })];
		const speedRegions = [{ id: "s1", startMs: 0, endMs: 4_000, speed: 2 }];

		const [marker] = resolveRecordingMarkers(
			doc({ trimRanges: trims, speedRegions }),
			"a1",
			[6_000],
		);

		// Kept raw before it: [0,1) and [2,6). The first 4s of ruler run at 2x, so
		// [0,1) costs 0.5 and [2,4) costs 1; [4,6) is 1x and costs 2.
		expect(marker.rulerSec).toBe(6);
		expect(marker.outputSec).toBeCloseTo(3.5, 6);
	});

	// The case neither this suite nor zoom-suggestions' had, which is why the two
	// features disagreed about it in silence: one source instant produced a zoom
	// suggestion on both copies of a duplicated take and a marker on only the
	// first. `buildAutoZoomSuggestionsForClips` loops every matching clip; so does
	// this now.
	it("flags EVERY clip that replays the instant, not just the first", () => {
		// One recording laid down twice: source 0-10 at ruler 0-10, then again at
		// ruler 10-20 — the same fixture zoom-suggestions pins this behaviour with.
		const duplicated = [
			clip({ id: "c1", sourceEndSec: 10, timelineEndSec: 10 }),
			clip({ id: "c2", sourceEndSec: 10, timelineStartSec: 10, timelineEndSec: 20 }),
		];

		const markers = resolveRecordingMarkers(doc({ clips: duplicated }), "a1", [4_000]);

		expect(markers).toEqual([
			{ clipId: "c1", sourceSec: 4, rulerSec: 4, outputSec: 4, removed: false },
			// The SAME flagged instant, on the copy that replays it.
			{ clipId: "c2", sourceSec: 4, rulerSec: 14, outputSec: 14, removed: false },
		]);
	});

	it("gives a shared clip boundary to both clips, as zoom-suggestions does", () => {
		// c1 ends and c2 begins at source 10. zoom-suggestions' window test is
		// `>= start && <= start + window` on both ends, so an instant landing exactly
		// there belongs to both; matching it is what keeps the two features agreeing
		// on edges and not just on fan-out. Contiguous clips map it to one ruler
		// point, so `clipId` is the only thing separating the two rows.
		const markers = resolveRecordingMarkers(doc({}), "a1", [10_000]);

		expect(markers.map((m) => [m.clipId, m.rulerSec])).toEqual([
			["c1", 10],
			["c2", 10],
		]);
	});

	it("drops a marker no clip carries any more, and one from another asset", () => {
		// Only the first half of the recording is still on the timeline.
		const oneClip = [clip({ id: "c1", sourceEndSec: 10, timelineEndSec: 10 })];

		expect(resolveRecordingMarkers(doc({ clips: oneClip }), "a1", [14_500])).toEqual([]);
		expect(resolveRecordingMarkers(doc({}), "other-asset", [3_000])).toEqual([]);
	});

	it("ignores unusable input rather than fabricating a position", () => {
		const unusable = [Number.NaN, -1, Number.POSITIVE_INFINITY];
		expect(resolveRecordingMarkers(doc({}), "a1", unusable)).toEqual([]);
		expect(resolveRecordingMarkers(null, "a1", [1_000])).toEqual([]);
		expect(resolveRecordingMarkers(doc({}), undefined, [1_000])).toEqual([]);
		expect(resolveRecordingMarkers(doc({ clips: [] }), "a1", [1_000])).toEqual([]);
		// A non-array speedRegions is a real shape on disk: `legacyEditor` is a
		// passthrough blob zod does not validate.
		expect(resolveRecordingMarkers(doc({ speedRegions: "nope" }), "a1", [3_000])).toEqual([
			{ clipId: "c1", sourceSec: 3, rulerSec: 3, outputSec: 3, removed: false },
		]);
	});
});
