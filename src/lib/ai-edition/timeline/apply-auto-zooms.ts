// Shared auto-zoom apply path: the HUD toggle / fresh-recording import and the
// timeline wand both end here. Suggestion math stays in zoom-suggestions.ts;
// this file only collects per-asset telemetry and appends the resulting regions.

import { createId } from "../document/ids";
import type { AxcutAsset, AxcutDocument } from "../schema";
import { anchorRegionsWithDerivedMs } from "./timelineMap";
import {
	type AutoZoomSuggestion,
	buildAutoZoomSuggestionsForClips,
	type ZoomSuggestionSample,
} from "./zoom-suggestions";

export const AUTO_ZOOM_DEFAULT_DURATION_MS = 2000;

/** Reads one recording's cursor samples. Typed to what the suggester reads, so both
 *  `getTelemetry` (positions) and `getRecordingData` (positions plus clicks, with a
 *  nullable `cursorType` the suggester never looks at) satisfy it without a cast. */
export type AutoZoomTelemetryReader = (
	videoPath: string,
) => Promise<ZoomSuggestionSample[] | null | undefined>;

/** Which assets to read telemetry for. The wand takes every video on the document;
 *  the fresh-recording import narrows it to the take it is pending on, so a project
 *  that already holds other footage does not pay an IPC round trip per asset. */
export type AutoZoomAssetFilter = (asset: AxcutAsset) => boolean;

export async function collectAutoZoomSuggestionsForDocument(
	document: AxcutDocument,
	getTelemetry: AutoZoomTelemetryReader,
	includeAsset: AutoZoomAssetFilter = () => true,
): Promise<AutoZoomSuggestion[]> {
	const existingRegions = document.zoomRanges.map((region) => ({
		startMs: region.startMs,
		endMs: region.endMs,
	}));
	const assetsWithClips = document.assets.filter(
		(asset) =>
			asset.kind === "video" &&
			asset.originalPath &&
			includeAsset(asset) &&
			document.timeline.clips.some((clip) => clip.assetId === asset.id),
	);
	const perSource = await Promise.all(
		assetsWithClips.map(async (asset) => {
			const telemetry = (await getTelemetry(asset.originalPath)) ?? [];
			return buildAutoZoomSuggestionsForClips({
				cursorTelemetry: telemetry,
				assetId: asset.id,
				clips: document.timeline.clips,
				existingRegions,
				defaultDurationMs: AUTO_ZOOM_DEFAULT_DURATION_MS,
			});
		}),
	);
	return perSource.flat();
}

/**
 * The clip geometry the suggestions were built against, as a comparable string.
 *
 * Suggestions carry TIMELINE spans, and `appendAutoZoomSuggestions` anchors them
 * against whatever clips the document holds when the write happens. Collecting
 * takes a multi-second telemetry round trip, so those two documents are not
 * necessarily the same one — and if a clip was trimmed, moved, added, removed or
 * reordered in between, the spans land on different media, or on nothing.
 */
export function clipExtentSignature(document: AxcutDocument): string {
	return document.timeline.clips
		.map(
			(clip) =>
				`${clip.id}:${clip.assetId}:${clip.sourceStartSec}:${clip.sourceEndSec ?? ""}:${clip.timelineStartSec}:${clip.timelineEndSec}`,
		)
		.join("|");
}

/**
 * Collect against the document as it is NOW, and collect again if the clips moved
 * while the telemetry was being read.
 *
 * One retry, not a loop: a user who keeps editing through the wait will keep
 * invalidating it, and the honest answer there is the write-time guards, not
 * spinning here. Returns the suggestions together with the document they were
 * built from, so the caller can tell what they describe.
 */
export async function collectAutoZoomSuggestionsForLatestDocument(
	readDocument: () => AxcutDocument | null,
	getTelemetry: AutoZoomTelemetryReader,
	includeAsset?: AutoZoomAssetFilter,
): Promise<{ document: AxcutDocument; suggestions: AutoZoomSuggestion[] } | null> {
	const start = readDocument();
	if (!start) return null;
	const startSignature = clipExtentSignature(start);
	const suggestions = await collectAutoZoomSuggestionsForDocument(
		start,
		getTelemetry,
		includeAsset,
	);
	const latest = readDocument();
	if (!latest) return null;
	if (clipExtentSignature(latest) === startSignature) {
		return { document: latest, suggestions };
	}
	return {
		document: latest,
		suggestions: await collectAutoZoomSuggestionsForDocument(latest, getTelemetry, includeAsset),
	};
}

export function appendAutoZoomSuggestions(
	document: AxcutDocument,
	suggestions: AutoZoomSuggestion[],
	makeId: (prefix: string) => string = createId,
): AxcutDocument {
	if (suggestions.length === 0) return document;
	const anchored = suggestions.flatMap((suggestion) =>
		anchorRegionsWithDerivedMs(
			[
				{
					id: makeId("zoom"),
					startMs: Math.round(suggestion.span.start),
					endMs: Math.round(suggestion.span.end),
					// The signal picks the magnification: a click frames a control
					// tightly, a fast traverse only wants a nudge. `3` stays the
					// default for a suggester that does not say.
					depth: suggestion.depth ?? (3 as const),
					focus: { cx: suggestion.focus.cx, cy: suggestion.focus.cy },
					focusMode: "auto" as const,
				},
			],
			document.timeline.clips,
			() => makeId("zoom"),
		),
	);
	return {
		...document,
		zoomRanges: [...document.zoomRanges, ...anchored] as AxcutDocument["zoomRanges"],
	};
}
