import { describe, expect, it } from "vitest";
import type { CursorTelemetryPoint } from "@/components/video-editor/types";
import type { AxcutClip } from "../schema";
import type { ClipAnchored, MigratedRegion } from "./timelineMap";
import { anchorRegionsWithDerivedMs } from "./timelineMap";
import {
	buildAutoZoomSuggestions,
	buildAutoZoomSuggestionsForClips,
	detectZoomDwellCandidates,
	type ZoomSuggestionSample,
} from "./zoom-suggestions";

// A dwell = many samples clustered in time at (nearly) the same position.
function dwell(
	centerMs: number,
	cx: number,
	cy: number,
	count = 6,
	spanMs = 900,
): CursorTelemetryPoint[] {
	const step = spanMs / (count - 1);
	return Array.from({ length: count }, (_, i) => ({
		timeMs: centerMs - spanMs / 2 + i * step,
		cx,
		cy,
	}));
}

/**
 * `anchorRegionsWithDerivedMs` returns `T | (ClipAnchored<T> & ...)`: a region that
 * overlaps no clip comes back un-anchored. These tests are about where a suggestion
 * LANDS, so an un-anchored result is a failure, not a variant to handle -- narrow it
 * here rather than at four call sites.
 */
function expectAnchored<T extends { id: string; startMs: number; endMs: number }>(
	region: MigratedRegion<T>,
): ClipAnchored<T> & { startMs: number; endMs: number } {
	if (!("clipId" in region)) {
		throw new Error(`region ${region.id} anchored to no clip`);
	}
	return region as ClipAnchored<T> & { startMs: number; endMs: number };
}

describe("detectZoomDwellCandidates", () => {
	it("finds a dwell where the cursor sits still", () => {
		const candidates = detectZoomDwellCandidates(dwell(1000, 0.4, 0.6));
		expect(candidates).toHaveLength(1);
		expect(candidates[0].focus.cx).toBeCloseTo(0.4, 5);
		expect(candidates[0].focus.cy).toBeCloseTo(0.6, 5);
	});

	it("ignores a fast sweep across the screen (no dwell)", () => {
		const samples: CursorTelemetryPoint[] = Array.from({ length: 10 }, (_, i) => ({
			timeMs: i * 100,
			cx: i / 10,
			cy: i / 10,
		}));
		expect(detectZoomDwellCandidates(samples)).toHaveLength(0);
	});
});

describe("buildAutoZoomSuggestions", () => {
	it("returns a centered span around each accepted dwell", () => {
		const telemetry = dwell(2000, 0.5, 0.5);
		const suggestions = buildAutoZoomSuggestions({
			cursorTelemetry: telemetry,
			totalMs: 5000,
			existingRegions: [],
			defaultDurationMs: 2000,
		});
		expect(suggestions).toHaveLength(1);
		// centred on ~2000ms with a 2000ms default → ~1000..3000
		expect(suggestions[0].span.start).toBe(1000);
		expect(suggestions[0].span.end).toBe(3000);
	});

	it("drops candidates overlapping an existing zoom region", () => {
		const telemetry = dwell(2000, 0.5, 0.5);
		const suggestions = buildAutoZoomSuggestions({
			cursorTelemetry: telemetry,
			totalMs: 5000,
			existingRegions: [{ startMs: 1500, endMs: 2500 }],
			defaultDurationMs: 2000,
		});
		expect(suggestions).toHaveLength(0);
	});

	it("spaces two dwells and returns both when far apart", () => {
		const telemetry = [...dwell(1500, 0.2, 0.2), ...dwell(6000, 0.8, 0.8)];
		const suggestions = buildAutoZoomSuggestions({
			cursorTelemetry: telemetry,
			totalMs: 9000,
			existingRegions: [],
			defaultDurationMs: 1500,
		});
		expect(suggestions.length).toBe(2);
	});

	it("returns nothing without telemetry", () => {
		expect(
			buildAutoZoomSuggestions({
				cursorTelemetry: [],
				totalMs: 5000,
				existingRegions: [],
				defaultDurationMs: 2000,
			}),
		).toEqual([]);
	});
});

describe("buildAutoZoomSuggestionsForClips", () => {
	const clip = (
		id: string,
		assetId: string,
		sourceStartSec: number,
		sourceEndSec: number,
		timelineStartSec: number,
	): AxcutClip => ({
		id,
		assetId,
		sourceStartSec,
		sourceEndSec,
		timelineStartSec,
		timelineEndSec: timelineStartSec + (sourceEndSec - sourceStartSec),
		wordRefs: [],
		origin: "user",
		reason: "",
	});

	// The bug this covers: telemetry is in the recording's SOURCE time, zoom regions are
	// authored in RAW TIMELINE ms, and the two only coincide for a single clip starting at
	// 0. Every other layout put all the zooms on the first clip's stretch of ruler.
	it("gives a dwell to EVERY clip that replays it, not just the first", () => {
		// One recording, laid down twice: source 0-10 at ruler 0-10, then again at 10-20.
		const clips = [clip("clip_1", "a1", 0, 10, 0), clip("clip_2", "a1", 0, 10, 10)];
		const suggestions = buildAutoZoomSuggestionsForClips({
			cursorTelemetry: dwell(4000, 0.3, 0.7),
			assetId: "a1",
			clips,
			existingRegions: [],
			defaultDurationMs: 2000,
		});
		expect(suggestions.map((s) => s.span)).toEqual([
			{ start: 3000, end: 5000 }, // clip_1: source 4s sits at ruler 4s
			{ start: 13000, end: 15000 }, // clip_2: the SAME source 4s sits at ruler 14s
		]);
		for (const suggestion of suggestions) {
			expect(suggestion.focus.cx).toBeCloseTo(0.3, 5);
			expect(suggestion.focus.cy).toBeCloseTo(0.7, 5);
		}
	});

	it("shifts a dwell by the clip's own source in-point", () => {
		// A clip that starts 30s into the recording: source 34s is ruler 4s.
		const clips = [clip("clip_1", "a1", 30, 40, 0)];
		const suggestions = buildAutoZoomSuggestionsForClips({
			cursorTelemetry: dwell(34000, 0.5, 0.5),
			assetId: "a1",
			clips,
			existingRegions: [],
			defaultDurationMs: 2000,
		});
		expect(suggestions.map((s) => s.span)).toEqual([{ start: 3000, end: 5000 }]);
	});

	it("ignores a dwell that falls outside every clip's source window", () => {
		// The recording is long; the timeline keeps only its first 10s.
		const clips = [clip("clip_1", "a1", 0, 10, 0)];
		expect(
			buildAutoZoomSuggestionsForClips({
				cursorTelemetry: dwell(45000, 0.5, 0.5),
				assetId: "a1",
				clips,
				existingRegions: [],
				defaultDurationMs: 2000,
			}),
		).toEqual([]);
	});

	it("reserves an existing zoom on the clip it actually sits on, and only there", () => {
		// A zoom already covers the dwell on clip_1's ruler span. clip_1 yields; clip_2
		// replays the same source moment on a free stretch of ruler, so it still gets one.
		// Compared in source ms — the frame the caller used to hand down — that one region
		// suppressed the whole recording's worth of suggestions.
		const clips = [clip("clip_1", "a1", 0, 10, 0), clip("clip_2", "a1", 0, 10, 10)];
		const suggestions = buildAutoZoomSuggestionsForClips({
			cursorTelemetry: dwell(4000, 0.5, 0.5),
			assetId: "a1",
			clips,
			existingRegions: [{ startMs: 3500, endMs: 4500 }],
			defaultDurationMs: 2000,
		});
		expect(suggestions.map((s) => s.span)).toEqual([{ start: 13000, end: 15000 }]);
	});

	it("only reads the clips of the asset the telemetry belongs to", () => {
		const clips = [clip("clip_1", "a1", 0, 10, 0), clip("clip_2", "a2", 0, 10, 10)];
		const suggestions = buildAutoZoomSuggestionsForClips({
			cursorTelemetry: dwell(4000, 0.5, 0.5),
			assetId: "a2",
			clips,
			existingRegions: [],
			defaultDurationMs: 2000,
		});
		expect(suggestions.map((s) => s.span)).toEqual([{ start: 13000, end: 15000 }]);
	});

	it("skips a clip whose duration has not been probed yet", () => {
		const clips = [clip("clip_1", "a1", 0, 0, 0)];
		expect(
			buildAutoZoomSuggestionsForClips({
				cursorTelemetry: dwell(4000, 0.5, 0.5),
				assetId: "a1",
				clips,
				existingRegions: [],
				defaultDurationMs: 2000,
			}),
		).toEqual([]);
	});
});

// A stretch of plain movement between two positions, one sample every `stepMs`.
function sweep(
	fromMs: number,
	count: number,
	stepMs: number,
	cx: (i: number) => number,
	cy: (i: number) => number,
): ZoomSuggestionSample[] {
	return Array.from({ length: count }, (_, i) => ({
		timeMs: fromMs + i * stepMs,
		cx: cx(i),
		cy: cy(i),
		interactionType: "move" as const,
	}));
}

describe("interaction-driven suggestions", () => {
	it("turns a recorded click into a suggestion held over what was clicked", () => {
		const samples: ZoomSuggestionSample[] = [
			...sweep(
				0,
				5,
				100,
				() => 0.2,
				() => 0.2,
			),
			{ timeMs: 2000, cx: 0.7, cy: 0.3, interactionType: "click" },
			...sweep(
				2100,
				5,
				100,
				() => 0.7,
				() => 0.3,
			),
		];
		const [suggestion] = buildAutoZoomSuggestions({
			cursorTelemetry: samples,
			totalMs: 10_000,
			existingRegions: [],
			defaultDurationMs: 2000,
		});
		// CLICK_PRE_ROLL_MS (220) before, CLICK_HOLD_MS (1600) after — the click's
		// own extent, NOT the caller's defaultDurationMs.
		expect(suggestion.span).toEqual({ start: 1780, end: 3600 });
		expect(suggestion.reason).toBe("click");
		expect(suggestion.focus).toEqual({ cx: 0.7, cy: 0.3 });
	});

	it("frames the whole drag, not the point the button came up", () => {
		// Press top-left, release bottom-right: a selection rectangle. Focusing the
		// release point would put half the selected region off the zoomed frame.
		const samples: ZoomSuggestionSample[] = [
			{ timeMs: 1000, cx: 0.2, cy: 0.2, interactionType: "click" },
			...sweep(
				1100,
				4,
				100,
				(i) => 0.2 + i * 0.15,
				(i) => 0.2 + i * 0.05,
			),
			{ timeMs: 1500, cx: 0.8, cy: 0.4, interactionType: "mouseup" },
		];
		const [suggestion] = buildAutoZoomSuggestions({
			cursorTelemetry: samples,
			totalMs: 10_000,
			existingRegions: [],
			defaultDurationMs: 2000,
		});
		expect(suggestion.reason).toBe("selection");
		expect(suggestion.focus.cx).toBeCloseTo(0.5, 5);
		expect(suggestion.focus.cy).toBeCloseTo(0.3, 5);
	});

	it("reads a press released in place as a click, not a zero-area selection", () => {
		const samples: ZoomSuggestionSample[] = [
			{ timeMs: 1000, cx: 0.5, cy: 0.5, interactionType: "click" },
			{ timeMs: 1040, cx: 0.5, cy: 0.5, interactionType: "mouseup" },
			...sweep(
				1100,
				4,
				100,
				() => 0.5,
				() => 0.5,
			),
		];
		const [suggestion] = buildAutoZoomSuggestions({
			cursorTelemetry: samples,
			totalMs: 10_000,
			existingRegions: [],
			defaultDurationMs: 2000,
		});
		expect(suggestion.reason).toBe("click");
	});

	it("reads a double-click as one gesture", () => {
		const samples: ZoomSuggestionSample[] = [
			{ timeMs: 1000, cx: 0.5, cy: 0.5, interactionType: "click" },
			{ timeMs: 1150, cx: 0.5, cy: 0.5, interactionType: "click" },
			...sweep(
				1200,
				4,
				100,
				() => 0.5,
				() => 0.5,
			),
		];
		const suggestions = buildAutoZoomSuggestions({
			cursorTelemetry: samples,
			totalMs: 10_000,
			existingRegions: [],
			defaultDurationMs: 2000,
		});
		expect(suggestions.filter((s) => s.reason === "click")).toHaveLength(1);
	});

	// The ranking policy, and the reason this detector was worth extending: where
	// both signals describe the same stretch of ruler, the one that OBSERVED a user
	// action beats the one that inferred interest from the pointer holding still.
	it("gives a contested stretch of ruler to the click, not the dwell", () => {
		const samples: ZoomSuggestionSample[] = [
			...dwell(2000, 0.1, 0.1).map((s) => ({ ...s, interactionType: "move" as const })),
			{ timeMs: 2200, cx: 0.9, cy: 0.9, interactionType: "click" },
		];
		const suggestions = buildAutoZoomSuggestions({
			cursorTelemetry: samples,
			totalMs: 10_000,
			existingRegions: [],
			defaultDurationMs: 2000,
		});
		expect(suggestions).toHaveLength(1);
		expect(suggestions[0].reason).toBe("click");
		expect(suggestions[0].focus).toEqual({ cx: 0.9, cy: 0.9 });
	});

	it("zooms a deliberate traverse less hard than a click", () => {
		const suggestions = buildAutoZoomSuggestions({
			cursorTelemetry: sweep(
				0,
				12,
				100,
				(i) => i * 0.08,
				() => 0.5,
			),
			totalMs: 10_000,
			existingRegions: [],
			defaultDurationMs: 2000,
		});
		expect(suggestions.length).toBeGreaterThan(0);
		expect(suggestions.every((s) => s.reason === "movement")).toBe(true);
		expect(suggestions.every((s) => s.depth === 2)).toBe(true);
	});

	// The degrade path. `readCursorTelemetryFile` projects the sidecar down to
	// positions alone, and anything reading through it must keep working exactly as
	// it did before interactions were understood at all.
	it("falls back to dwell alone when the samples carry no interaction type", () => {
		const suggestions = buildAutoZoomSuggestions({
			cursorTelemetry: dwell(2000, 0.5, 0.5),
			totalMs: 5000,
			existingRegions: [],
			defaultDurationMs: 2000,
		});
		expect(suggestions).toHaveLength(1);
		expect(suggestions[0].reason).toBe("dwell");
		expect(suggestions[0].span).toEqual({ start: 1000, end: 3000 });
	});
});

// The conversion this workstream exists to get right: telemetry is recorded in an
// asset's SOURCE time, zoomRanges are stored clip-anchored in source time, and RAW
// TIMELINE ms is the axis between them. Asserting the two ends match — through the
// real anchoring machinery, not a re-derivation of it — is what catches a second
// clock being invented.
describe("source-time to clip-anchored round trip", () => {
	const clip = (
		id: string,
		assetId: string,
		sourceStartSec: number,
		sourceEndSec: number,
		timelineStartSec: number,
	): AxcutClip => ({
		id,
		assetId,
		sourceStartSec,
		sourceEndSec,
		timelineStartSec,
		timelineEndSec: timelineStartSec + (sourceEndSec - sourceStartSec),
		wordRefs: [],
		origin: "user",
		reason: "",
	});

	it("lands a click back on its own source second after a head trim and a reorder", () => {
		// Two slices of ONE recording, laid down out of order: source 60-70 plays
		// first, then source 20-30. A click at source 24s belongs to the SECOND
		// clip, at ruler 14s. Get the axis wrong and it lands at ruler 4s — on
		// footage from a different minute of the recording.
		const clips = [clip("clip_late", "a1", 60, 70, 0), clip("clip_early", "a1", 20, 30, 10)];
		const suggestions = buildAutoZoomSuggestionsForClips({
			cursorTelemetry: [
				{ timeMs: 23_800, cx: 0.4, cy: 0.4, interactionType: "move" },
				{ timeMs: 24_000, cx: 0.4, cy: 0.4, interactionType: "click" },
				{ timeMs: 24_200, cx: 0.4, cy: 0.4, interactionType: "move" },
			],
			assetId: "a1",
			clips,
			existingRegions: [],
			defaultDurationMs: 2000,
		});
		expect(suggestions).toHaveLength(1);
		// RAW ruler: clip_early starts at 10s, the click is 4s into its source window.
		expect(suggestions[0].span).toEqual({ start: 13_780, end: 15_600 });

		const [anchored] = anchorRegionsWithDerivedMs(
			suggestions.map((s, i) => ({
				id: `zoom_${i}`,
				startMs: s.span.start,
				endMs: s.span.end,
			})),
			clips,
			() => "zoom_extra",
		);
		// And back down to source time: the same 23.78-25.60s of the recording the
		// pre-roll and hold were measured against.
		const landed = expectAnchored(anchored);
		expect(landed.clipId).toBe("clip_early");
		expect(landed.sourceStartSec).toBeCloseTo(23.78, 5);
		expect(landed.sourceEndSec).toBeCloseTo(25.6, 5);
	});

	// Speed is a modifier laid OVER the ruler, not geometry baked into it: a raw
	// clip's timeline length always equals its source length (timelineMap.ts). So a
	// suggestion emitted in RAW ms is speed-invariant by construction, and this is
	// the assertion that would break if someone "helpfully" switched the suggester
	// to compressed/playback time — the axis a speed region does move.
	it("emits raw ruler positions, which a speed region cannot shift", () => {
		const clips = [clip("clip_1", "a1", 0, 30, 0)];
		const suggestions = buildAutoZoomSuggestionsForClips({
			cursorTelemetry: [
				{ timeMs: 19_800, cx: 0.6, cy: 0.6, interactionType: "move" },
				{ timeMs: 20_000, cx: 0.6, cy: 0.6, interactionType: "click" },
				{ timeMs: 20_200, cx: 0.6, cy: 0.6, interactionType: "move" },
			],
			assetId: "a1",
			clips,
			existingRegions: [],
			defaultDurationMs: 2000,
		});
		// Source 20s is raw 20s. Had the suggester walked the playback clock instead,
		// a 2x speed region over the first 10s would have reported this at 15s.
		expect(suggestions[0].span.start).toBe(19_780);
		const [anchored] = anchorRegionsWithDerivedMs(
			[{ id: "zoom_0", startMs: suggestions[0].span.start, endMs: suggestions[0].span.end }],
			clips,
			() => "zoom_extra",
		);
		expect(expectAnchored(anchored).sourceStartSec).toBeCloseTo(19.78, 5);
	});
});
