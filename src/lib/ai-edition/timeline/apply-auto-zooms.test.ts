import { describe, expect, it, vi } from "vitest";
import type { CursorTelemetryPoint } from "@/components/video-editor/types";
import { type AxcutDocument, createEmptyDocument } from "../schema";
import {
	appendAutoZoomSuggestions,
	collectAutoZoomSuggestionsForDocument,
	collectAutoZoomSuggestionsForLatestDocument,
	collectFlagZoomSuggestionsForLatestDocument,
} from "./apply-auto-zooms";

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

function documentWithClip(durationSec = 10): AxcutDocument {
	const doc = createEmptyDocument({ projectId: "p1", title: "Recording" });
	return {
		...doc,
		assets: [
			{
				id: "asset_1",
				kind: "video",
				label: "rec.mp4",
				originalPath: "C:\\recordings\\rec.mp4",
				cameraTrack: null,
				durationSec,
			},
		],
		project: { ...doc.project, primaryAssetId: "asset_1" },
		timeline: {
			...doc.timeline,
			clips: [
				{
					id: "clip_1",
					assetId: "asset_1",
					sourceStartSec: 0,
					sourceEndSec: durationSec,
					timelineStartSec: 0,
					timelineEndSec: durationSec,
					wordRefs: [],
					origin: "system",
					reason: "",
				},
			],
		},
	};
}

describe("collectAutoZoomSuggestionsForDocument", () => {
	it("builds suggestions from the asset's cursor sidecar", async () => {
		const document = documentWithClip();
		const suggestions = await collectAutoZoomSuggestionsForDocument(document, async () =>
			dwell(4000, 0.4, 0.6),
		);
		expect(suggestions).toHaveLength(1);
		expect(suggestions[0].span.start).toBe(3000);
		expect(suggestions[0].span.end).toBe(5000);
		expect(suggestions[0].focus.cx).toBeCloseTo(0.4, 5);
	});

	it("asks for telemetry on the asset path, not a file URL", async () => {
		const document = documentWithClip();
		const paths: string[] = [];
		await collectAutoZoomSuggestionsForDocument(document, async (videoPath) => {
			paths.push(videoPath);
			return [];
		});
		expect(paths).toEqual(["C:\\recordings\\rec.mp4"]);
	});

	it("returns nothing without a clip window", async () => {
		const document = createEmptyDocument({ projectId: "p1", title: "Empty" });
		const suggestions = await collectAutoZoomSuggestionsForDocument(document, async () =>
			dwell(1000, 0.5, 0.5),
		);
		expect(suggestions).toEqual([]);
	});
});

describe("appendAutoZoomSuggestions", () => {
	it("leaves the document unchanged when there is nothing to add", () => {
		const document = documentWithClip();
		expect(appendAutoZoomSuggestions(document, [])).toBe(document);
	});

	it("anchors each suggestion onto the clip", () => {
		const document = documentWithClip();
		const next = appendAutoZoomSuggestions(
			document,
			[{ span: { start: 3000, end: 5000 }, focus: { cx: 0.4, cy: 0.6 } }],
			(prefix) => `${prefix}_fixed`,
		);
		expect(next).not.toBe(document);
		expect(next.zoomRanges).toHaveLength(1);
		expect(next.zoomRanges[0]).toMatchObject({
			startMs: 3000,
			endMs: 5000,
			depth: 3,
			focusMode: "auto",
			clipId: "clip_1",
		});
	});
});

describe("collectAutoZoomSuggestionsForLatestDocument", () => {
	const telemetry: CursorTelemetryPoint[] = [0, 600, 1200, 1800].map((timeMs) => ({
		timeMs,
		cx: 0.5,
		cy: 0.5,
	}));

	it("collects once when the clips stand still", async () => {
		const doc = documentWithClip();
		const getTelemetry = vi.fn(async () => telemetry);

		const out = await collectAutoZoomSuggestionsForLatestDocument(() => doc, getTelemetry);

		expect(out?.document).toBe(doc);
		expect(getTelemetry).toHaveBeenCalledTimes(1);
	});

	// THE case: the telemetry read takes seconds, and the suggestions carry timeline
	// spans that `appendAutoZoomSuggestions` will anchor against whatever the store
	// holds at write time. A trim landing in between makes the first collection
	// describe a timeline that no longer exists.
	it("collects again when the clips moved during the read", async () => {
		const before = documentWithClip();
		const after: AxcutDocument = {
			...before,
			timeline: {
				...before.timeline,
				clips: before.timeline.clips.map((clip) => ({ ...clip, sourceEndSec: 4 })),
			},
		};
		let current = before;
		const getTelemetry = vi.fn(async () => {
			current = after;
			return telemetry;
		});

		const out = await collectAutoZoomSuggestionsForLatestDocument(() => current, getTelemetry);

		expect(out?.document).toBe(after);
		expect(getTelemetry.mock.calls.length).toBeGreaterThan(1);
	});

	it("gives up when the project is gone", async () => {
		const getTelemetry = vi.fn(async () => telemetry);
		expect(await collectAutoZoomSuggestionsForLatestDocument(() => null, getTelemetry)).toBeNull();
		expect(getTelemetry).not.toHaveBeenCalled();
	});
});

describe("collectFlagZoomSuggestionsForLatestDocument", () => {
	it("zooms a normal flag and counts the covered and trimmed ones it skips", async () => {
		// A zoom already sits over 6s, and a cut removes 11-13s.
		const withZoom = appendAutoZoomSuggestions(documentWithClip(20), [
			{ span: { start: 5500, end: 6500 }, focus: { cx: 0.5, cy: 0.5 } },
		]);
		const document: AxcutDocument = {
			...withZoom,
			timeline: {
				...withZoom.timeline,
				trimRanges: [
					{
						id: "trim_1",
						assetId: "asset_1",
						startSec: 11,
						endSec: 13,
						reason: "",
						origin: "user",
					},
				],
			},
		};
		const paths: string[] = [];

		const out = await collectFlagZoomSuggestionsForLatestDocument(
			() => document,
			async (videoPath) => {
				paths.push(videoPath);
				return dwell(2000, 0.25, 0.75);
			},
			[2000, 6000, 12000], // normal, covered, trimmed
		);

		expect(paths).toEqual(["C:\\recordings\\rec.mp4"]);
		expect(out?.covered).toBe(1);
		expect(out?.trimmed).toBe(1);
		const [zoom] = out?.suggestions ?? [];
		expect(out?.suggestions).toHaveLength(1);
		// Starts slightly before the flag and is held past it.
		expect(zoom.span.start).toBeGreaterThan(1000);
		expect(zoom.span.start).toBeLessThan(2000);
		expect(zoom.span.end).toBeGreaterThan(2000);
		expect(zoom.depth).toBe(3);
		// Focused where the pointer was at that instant.
		expect(zoom.focus.cx).toBeCloseTo(0.25, 5);
		expect(zoom.focus.cy).toBeCloseTo(0.75, 5);
	});

	// A recorded area is a crop over the whole display. A detected dwell outside it is
	// dropped (zoom-suggestions.test.ts), but a flag is the user asking for a zoom: it
	// keeps its zoom, focused at the nearest point of the crop.
	it("keeps a flag outside a cropped clip's area and clamps its focus into the crop", async () => {
		const base = documentWithClip(20);
		const document: AxcutDocument = {
			...base,
			timeline: {
				...base.timeline,
				clips: base.timeline.clips.map((clip) => ({
					...clip,
					cropRegion: { x: 0.5, y: 0, width: 0.5, height: 0.5 },
				})),
			},
		};

		const out = await collectFlagZoomSuggestionsForLatestDocument(
			() => document,
			async () => [...dwell(2000, 0.25, 0.75), ...dwell(6000, 0.75, 0.25)],
			[2000, 6000], // outside the crop, inside it
		);

		expect(out?.suggestions.map((zoom) => zoom.focus)).toEqual([
			{ cx: 0, cy: 1 },
			{ cx: 0.5, cy: 0.5 },
		]);
		expect(out?.covered).toBe(0);
	});

	// A system-cursor take has no telemetry, so a flag falls back to the centre -- of the
	// AREA. The full frame's centre, mapped through a top-left-quarter crop, lands on the
	// area's bottom-right corner.
	it("centres a flag with no telemetry on a cropped clip's area, not the frame", async () => {
		const base = documentWithClip(20);
		const document: AxcutDocument = {
			...base,
			timeline: {
				...base.timeline,
				clips: base.timeline.clips.map((clip) => ({
					...clip,
					cropRegion: { x: 0, y: 0, width: 0.5, height: 0.5 },
				})),
			},
		};

		const out = await collectFlagZoomSuggestionsForLatestDocument(
			() => document,
			async () => [],
			[2000],
		);

		expect(out?.suggestions.map((zoom) => zoom.focus)).toEqual([{ cx: 0.5, cy: 0.5 }]);
	});
});
