import { describe, expect, it } from "vitest";
import type { AxcutTrimRange, AxcutWord } from "../schema";
import {
	dropTrimsAlreadyCovered,
	generateRoughCutSuggestions,
	roughCutsToTrimRanges,
} from "./rough-cut";

let counter = 0;
function word(text: string, startSec: number, endSec: number, id?: string): AxcutWord {
	return { id: id ?? `w_${++counter}`, segmentId: "seg_1", startSec, endSec, text };
}

describe("generateRoughCutSuggestions", () => {
	it("cuts a long hole between two spoken words", () => {
		expect(generateRoughCutSuggestions([word("hello", 0, 0.5), word("world", 2, 2.5)], 10)).toEqual(
			[{ startSec: 0.5, endSec: 2, reason: "silence", confidence: 0.98 }],
		);
	});

	// The whole risk of an automatic silence cut: taking the breaths out of ordinary
	// speech and leaving the speaker sounding like a chipmunk. 0.3s is rhythm.
	it("leaves the pauses that are just how people talk", () => {
		expect(
			generateRoughCutSuggestions([word("hello", 0, 0.5), word("world", 0.8, 1.2)], 10),
		).toEqual([]);
	});

	it("joins a run of hesitation sounds into one cut", () => {
		const suggestions = generateRoughCutSuggestions(
			[word("so", 0, 0.3), word("um,", 0.4, 0.7), word("uh", 0.8, 1.1), word("anyway", 1.2, 1.6)],
			10,
		);
		// One cut over "um, uh" — not two — and the punctuation on "um," does not
		// stop it matching the lexicon.
		expect(suggestions).toEqual([
			{ startSec: 0.4, endSec: 1.1, reason: "filler", confidence: 0.96 },
		]);
	});

	it("ignores a single filler too short to be worth a cut", () => {
		expect(
			generateRoughCutSuggestions(
				[word("so", 0, 0.3), word("um", 0.4, 0.5), word("hi", 0.6, 0.9)],
				10,
			),
		).toEqual([]);
	});

	// `withSilenceGaps` inserts `[silence]` pseudo-words for the transcript pane.
	// Measuring a gap between two of THOSE would be measuring a gap inside a gap,
	// and a cut derived from it would remove speech that is still there.
	it("does not measure gaps against the transcript pane's silence pseudo-words", () => {
		expect(
			generateRoughCutSuggestions(
				[word("hello", 0, 0.5), word("[silence]", 0.5, 3, "silence_1"), word("world", 3, 3.5)],
				10,
			),
		).toEqual([{ startSec: 0.5, endSec: 3, reason: "silence", confidence: 0.98 }]);
	});

	it("clamps a cut to the asset's duration", () => {
		expect(generateRoughCutSuggestions([word("a", 0, 0.5), word("b", 4, 4.5)], 3)).toEqual([
			{ startSec: 0.5, endSec: 3, reason: "silence", confidence: 0.98 },
		]);
	});

	// Five and a half seconds in which the only sound was "um uh" is one dead
	// stretch, not three suggestions the user has to accept one at a time.
	it("merges touching silence and filler cuts into one span", () => {
		expect(
			generateRoughCutSuggestions(
				[word("go", 0, 0.4), word("um", 2, 2.9), word("uh", 3, 3.9), word("on", 6, 6.4)],
				10,
			),
		).toEqual([{ startSec: 0.4, endSec: 6, reason: "silence", confidence: 0.98 }]);
	});

	it("returns nothing without a transcript", () => {
		expect(generateRoughCutSuggestions([], 10)).toEqual([]);
	});
});

describe("roughCutsToTrimRanges", () => {
	// The output contract: the document's own cut type, in SOURCE seconds, with no
	// clipId — `trimAppliesToClip` decides which clip a source range belongs to, and
	// it must stay the only thing that does.
	it("emits document trim ranges marked as machine-made", () => {
		let id = 0;
		expect(
			roughCutsToTrimRanges(
				generateRoughCutSuggestions([word("hello", 0, 0.5), word("world", 2, 2.5)], 10),
				"asset_1",
				() => `trim_${++id}`,
			),
		).toEqual([
			{
				id: "trim_1",
				assetId: "asset_1",
				startSec: 0.5,
				endSec: 2,
				reason: "silence",
				origin: "system",
			},
		]);
	});
});

describe("dropTrimsAlreadyCovered", () => {
	function trim(id: string, assetId: string, startSec: number, endSec: number): AxcutTrimRange {
		return { id, assetId, startSec, endSec, reason: "silence", origin: "system" };
	}

	// What makes a second run a no-op instead of a pile of duplicate cuts.
	it("keeps only the stretches no existing trim touches", () => {
		const kept = dropTrimsAlreadyCovered(
			[trim("t_1", "asset_1", 1, 2), trim("t_2", "asset_1", 5, 6), trim("t_3", "asset_2", 1, 2)],
			[
				// Overlaps t_1 by a tenth of a second — still that trim's stretch.
				{ ...trim("old", "asset_1", 1.9, 3), origin: "user" },
				// The same span as t_3, on an asset t_3 has nothing to do with.
				trim("elsewhere", "asset_3", 1, 2),
			],
		);
		expect(kept.map((cut) => cut.id)).toEqual(["t_2", "t_3"]);
	});

	// Touching end-to-start is not overlapping: a cut that begins exactly where
	// another ends removes a different stretch of the recording.
	it("keeps a cut that only abuts an existing trim", () => {
		expect(
			dropTrimsAlreadyCovered([trim("t_1", "asset_1", 2, 3)], [trim("old", "asset_1", 1, 2)]),
		).toHaveLength(1);
	});
});
