// The moments a user flagged while recording, as the editor needs them.
//
// The sidecar stores each marker in SOURCE time — the recorded file's own clock,
// with pauses already collapsed out, measured from the first captured frame. The
// editor draws two other clocks: the RAW ruler (where the playhead lives, and
// where trims are holes rather than shortenings) and the OUTPUT programme (the
// finished film, trims removed and speed applied). A marker therefore has to
// travel the same two hops every other source-anchored thing travels, and it has
// to survive a clip being moved, split, retimed or trimmed underneath it.
//
// Nothing here is new machinery. `locateSourcePosition` is the existing
// source→raw mapping (exact, because trims do not compact the raw axis);
// `projectRawTimelineSecToPlayback` is the existing raw→output projection, the
// same one the exporter and the audio mixer use; `removedRawSpans`/`removalAt`
// are the existing "is this moment in the film at all" test. This module only
// composes them and says what to do when they disagree.
//
// Markers are NOT stored in the document. They live next to the recording as
// source time and are resolved on demand, which is what makes them survive every
// edit for free: there is no derived ruler position to go stale, and no schema
// version to migrate. It also means the editor cannot author them — flagging a
// moment is something you do while recording, which is the whole feature.

import { type PlaybackSpeedRegion, projectRawTimelineSecToPlayback } from "../document/timeline";
import type { AxcutDocument } from "../schema";
import { removalAt, removedRawSpans } from "./programme-time";
import { locateSourcePosition } from "./virtual-preview";

export interface ResolvedRecordingMarker {
	/** Seconds into the recorded file. The stored, canonical value. */
	sourceSec: number;
	/** Where it sits on the RAW ruler — the coordinate the playhead seeks to. */
	rulerSec: number;
	/** Where it sits in the finished programme, trims removed and speed applied. */
	outputSec: number;
	/**
	 * A trim, or a gap between two clips, cuts this moment out of playback.
	 *
	 * Kept rather than dropped: the marker still has an honest ruler position
	 * (the raw axis is not compacted by trims), and a flag the user set and then
	 * trimmed over should read as "you cut this" rather than silently vanish.
	 * `outputSec` for a removed marker is the output edge just before the cut,
	 * which is where the film jumps — so seeking to it still lands somewhere
	 * meaningful.
	 */
	removed: boolean;
}

/** `legacyEditor.speedRegions` is a passthrough blob; zod validates nothing inside it. */
function speedRegionsOf(document: AxcutDocument): PlaybackSpeedRegion[] {
	const regions = (document.legacyEditor as { speedRegions?: unknown } | null)?.speedRegions;
	if (!Array.isArray(regions)) return [];
	return regions.filter(
		(region): region is PlaybackSpeedRegion =>
			Boolean(region) &&
			typeof region === "object" &&
			typeof (region as PlaybackSpeedRegion).startMs === "number" &&
			typeof (region as PlaybackSpeedRegion).endMs === "number" &&
			typeof (region as PlaybackSpeedRegion).speed === "number" &&
			(region as PlaybackSpeedRegion).speed > 0,
	);
}

/**
 * Source-time markers as timeline positions, ordered by where they now play.
 *
 * A marker no clip carries is dropped outright: the take it belonged to was
 * removed from the project, so there is no moment to jump to. That is distinct
 * from `removed`, which means the moment IS in a clip but a trim cuts it — those
 * are kept and flagged.
 */
export function resolveRecordingMarkers(
	document: AxcutDocument | null | undefined,
	assetId: string | undefined,
	markersMs: readonly number[] | null | undefined,
): ResolvedRecordingMarker[] {
	if (!document || !assetId || !markersMs?.length) return [];

	const { clips, trimRanges } = document.timeline;
	if (clips.length === 0) return [];

	const speedRegions = speedRegionsOf(document);
	const removed = removedRawSpans(clips, trimRanges);
	const resolved: ResolvedRecordingMarker[] = [];

	for (const markerMs of markersMs) {
		if (!Number.isFinite(markerMs) || markerMs < 0) continue;
		const sourceSec = markerMs / 1000;
		const position = locateSourcePosition(clips, sourceSec, assetId);
		if (!position) continue;

		resolved.push({
			sourceSec,
			rulerSec: position.virtualTimeSec,
			outputSec: projectRawTimelineSecToPlayback(
				clips,
				trimRanges,
				position.virtualTimeSec,
				speedRegions,
			),
			removed: removalAt(removed, position.virtualTimeSec) !== null,
		});
	}

	return resolved.sort((a, b) => a.rulerSec - b.rulerSec);
}

/**
 * The marker to jump to from `fromSec`, or null when there is none that way.
 *
 * `epsilonSec` keeps a jump from landing back on the marker the playhead is
 * already sitting on after a seek has rounded the time.
 */
export function adjacentMarkerSec(
	markers: readonly ResolvedRecordingMarker[],
	fromSec: number,
	direction: "next" | "previous",
	epsilonSec = 0.005,
): number | null {
	if (markers.length === 0 || !Number.isFinite(fromSec)) return null;

	let best: number | null = null;
	for (const { rulerSec } of markers) {
		if (direction === "next") {
			if (rulerSec > fromSec + epsilonSec && (best === null || rulerSec < best)) best = rulerSec;
		} else if (rulerSec < fromSec - epsilonSec && (best === null || rulerSec > best)) {
			best = rulerSec;
		}
	}
	return best;
}
