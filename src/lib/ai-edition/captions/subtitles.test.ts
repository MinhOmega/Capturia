// The claim under test is NOT that the writers emit well-formed SRT — that part is a
// format spec anyone can read. It is that the cue times in the file match the exported
// video's own clock, which is a different clock from the one `deriveCaptionCues` returns.
//
// Two things move it: a trim removes raw seconds, and a speed region scales them. The
// speed case is where naive sidecar writers drift, because subtracting the cut lengths
// (the obvious implementation) is exactly right for trims and silently wrong the moment
// any part of the timeline plays at anything other than 1x.

import { describe, expect, it } from "vitest";
import type { AxcutClip, AxcutTrimRange } from "../schema";
import type { CaptionCue } from "./cues";
import {
	cuesToSrt,
	cuesToVtt,
	escapeVttText,
	formatSrtTimestamp,
	formatVttTimestamp,
	projectCuesToOutputTime,
} from "./subtitles";

function clip(over: Partial<AxcutClip> & { id: string }): AxcutClip {
	return {
		assetId: "a1",
		sourceStartSec: 0,
		sourceEndSec: 20,
		timelineStartSec: 0,
		timelineEndSec: 20,
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

const cue = (id: string, startMs: number, endMs: number, text = id): CaptionCue => ({
	id,
	startMs,
	endMs,
	text,
});

/** One 20 s clip, one to one with the raw ruler. */
const ONE_CLIP = [clip({ id: "c1" })];

describe("timestamp formats", () => {
	it("writes SRT with a comma and VTT with a dot", () => {
		const ms = 3_723_004; // 1h 2m 3s 4ms
		expect(formatSrtTimestamp(ms)).toBe("01:02:03,004");
		expect(formatVttTimestamp(ms)).toBe("01:02:03.004");
	});

	it("clamps a negative or non-finite time rather than emitting a broken line", () => {
		expect(formatSrtTimestamp(-5)).toBe("00:00:00,000");
		expect(formatVttTimestamp(Number.NaN)).toBe("00:00:00.000");
	});
});

describe("projectCuesToOutputTime", () => {
	it("is the identity when nothing was cut and nothing was sped up", () => {
		const cues = [cue("a", 1000, 2000), cue("b", 5000, 6000)];
		expect(projectCuesToOutputTime(cues, ONE_CLIP, [])).toEqual(cues);
	});

	it("pulls a cue after a cut earlier by the length of the cut", () => {
		// Source 2..4 removed. A line at raw 10 s plays at 8 s in the export.
		const trims = [trim({ id: "t1", startSec: 2, endSec: 4 })];
		const [projected] = projectCuesToOutputTime([cue("a", 10_000, 11_000)], ONE_CLIP, trims);
		expect(projected.startMs).toBe(8000);
		expect(projected.endMs).toBe(9000);
	});

	it("drops a cue that sat entirely inside a cut", () => {
		const trims = [trim({ id: "t1", startSec: 2, endSec: 4 })];
		// Nothing plays at raw 3 s, so no line may claim a second of the export.
		expect(projectCuesToOutputTime([cue("a", 2500, 3500)], ONE_CLIP, trims)).toEqual([]);
	});

	it("shortens a cue straddling a cut to the part that survives", () => {
		const trims = [trim({ id: "t1", startSec: 5, endSec: 6 })];
		// raw 4..7 → output 4..6: the second inside the cut is gone, the rest still plays.
		const [projected] = projectCuesToOutputTime([cue("a", 4000, 7000)], ONE_CLIP, trims);
		expect(projected.startMs).toBe(4000);
		expect(projected.endMs).toBe(6000);
	});

	// THE ONE THAT CATCHES NAIVE IMPLEMENTATIONS. Subtracting removed spans gets every
	// assertion above right and this one wrong: with no trim at all there is nothing to
	// subtract, so a "just subtract the cuts" writer returns the raw times unchanged and
	// every line after the speed region is late.
	it("compresses cues under a speed region, and shifts everything after it", () => {
		const speed = [{ startMs: 4000, endMs: 8000, speed: 2 }];

		// Wholly inside the 2x region: raw 5..7 → output 4 + (5−4)/2 .. 4 + (7−4)/2.
		const [inside] = projectCuesToOutputTime([cue("a", 5000, 7000)], ONE_CLIP, [], speed);
		expect(inside.startMs).toBe(4500);
		expect(inside.endMs).toBe(5500);

		// Entirely after it: the 4 s region plays in 2 s, so everything later lands 2 s early.
		const [after] = projectCuesToOutputTime([cue("b", 12_000, 13_000)], ONE_CLIP, [], speed);
		expect(after.startMs).toBe(10_000);
		expect(after.endMs).toBe(11_000);

		// Before it: untouched. A speed region must not move what precedes it.
		const [before] = projectCuesToOutputTime([cue("c", 1000, 2000)], ONE_CLIP, [], speed);
		expect(before.startMs).toBe(1000);
	});

	it("applies a cut and a speed region together, in the order the programme plays them", () => {
		// Cut 1..2 (1 s gone), then 4..8 raw at 2x (plays in 2 s). A line at raw 12 s:
		// output = 12 − 1 (cut) − 2 (the region's saving) = 9 s.
		const trims = [trim({ id: "t1", startSec: 1, endSec: 2 })];
		const speed = [{ startMs: 4000, endMs: 8000, speed: 2 }];
		const [projected] = projectCuesToOutputTime(
			[cue("a", 12_000, 13_000)],
			ONE_CLIP,
			trims,
			speed,
		);
		expect(projected.startMs).toBe(9000);
		expect(projected.endMs).toBe(10_000);
	});

	it("returns cues in output order even when the input was not", () => {
		const cues = [cue("b", 5000, 6000), cue("a", 1000, 2000)];
		expect(projectCuesToOutputTime(cues, ONE_CLIP, []).map((c) => c.id)).toEqual(["a", "b"]);
	});
});

describe("cuesToSrt", () => {
	it("numbers cues from 1 and separates blocks with a blank line", () => {
		expect(cuesToSrt([cue("a", 0, 1000, "hello"), cue("b", 1000, 2000, "world")])).toBe(
			"1\n00:00:00,000 --> 00:00:01,000\nhello\n\n2\n00:00:01,000 --> 00:00:02,000\nworld\n",
		);
	});

	it("numbers over the cues actually written, leaving no hole where one was dropped", () => {
		// The middle cue has zero length and is not written; the third must still be "2".
		const written = cuesToSrt([
			cue("a", 0, 1000, "kept"),
			cue("b", 5, 5, "zero length"),
			cue("c", 2000, 3000, "also kept"),
		]);
		const indices = written
			.trim()
			.split("\n\n")
			.map((block) => block.split("\n")[0]);
		expect(indices).toEqual(["1", "2"]);
	});

	it("is empty when there is nothing to write, so the caller can skip the file", () => {
		expect(cuesToSrt([])).toBe("");
		expect(cuesToSrt([cue("a", 0, 1000, "   ")])).toBe("");
	});
});

describe("cuesToVtt", () => {
	it("always writes the signature, even with no cues", () => {
		expect(cuesToVtt([])).toBe("WEBVTT\n\n");
	});

	it("escapes markup so a transcript cannot open a tag or forge a timing line", () => {
		expect(escapeVttText("a < b & c --> d")).toBe("a &lt; b &amp; c --&gt; d");
		expect(cuesToVtt([cue("a", 0, 1000, "5 > 3")])).toContain("5 &gt; 3");
	});

	it("drops blank lines inside a payload, which would otherwise end the cue early", () => {
		const written = cuesToVtt([cue("a", 0, 1000, "first\n\nsecond")]);
		expect(written).toContain("first\nsecond");
	});
});
