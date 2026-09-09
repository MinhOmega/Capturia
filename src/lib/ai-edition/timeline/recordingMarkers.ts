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
// Nothing here is new machinery. `placementRawSec` is the existing source→raw
// shift (exact, because trims do not compact the raw axis);
// `projectRawTimelineSecToPlayback` is the existing raw→output projection, the
// same one the exporter and the audio mixer use; `removedRawSpans`/`removalAt`
// are the existing "is this moment in the film at all" test. This module only
// composes them and says what to do when they disagree.
//
// It does NOT use `locateSourcePosition`, which is the obvious-looking choice
// and the wrong one: that is a `findIndex` built for a playhead, which is in
// exactly one place at a time. A flagged instant is not — see the fan-out note
// on `resolveRecordingMarkers`.
//
// Markers are NOT stored in the document. They live next to the recording as
// source time and are resolved on demand, which is what makes them survive every
// edit for free: there is no derived ruler position to go stale, and no schema
// version to migrate. It also means the editor cannot author them — flagging a
// moment is something you do while recording, which is the whole feature.

import { type PlaybackSpeedRegion, projectRawTimelineSecToPlayback } from "../document/timeline";
import type { AxcutDocument } from "../schema";
import { placementRawSec } from "./aggregated-transcript";
import { removalAt, removedRawSpans } from "./programme-time";

export interface ResolvedRecordingMarker {
	/**
	 * The clip replaying this instant.
	 *
	 * Present because one marker can resolve several times, so `sourceSec` alone
	 * no longer identifies a row — and at a shared "A ends where B begins"
	 * boundary neither does `rulerSec`, since both clips map that instant to the
	 * same point on the ruler. This is what a caller keys a list on.
	 */
	clipId: string;
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
 * ONE MARKER PER CLIP THAT REPLAYS IT, not one per marker. Put the same take on
 * the timeline twice — duplicate a clip, or split one without trimming — and the
 * flagged instant is genuinely played twice, so it is flagged twice. Resolving
 * only the first clip (which is what `locateSourcePosition` does: it is a
 * `findIndex`, built for a playhead that is in exactly one place) put every
 * marker on the first copy and left the second bare.
 *
 * That is also what `buildAutoZoomSuggestionsForClips` does with cursor dwells,
 * and the two sit on the same ruler: before this, one source instant produced a
 * zoom suggestion on both copies and a marker on only one. Same document, same
 * instant, two different answers — which reads as a bug whichever of them the
 * user notices first. The window test below is `>=`/`<=` on both ends for the
 * same reason: it is the test zoom-suggestions uses, so an instant landing
 * exactly on a shared "A ends where B begins" boundary appears on both clips in
 * both features rather than on whichever one each happened to pick.
 *
 * A marker no clip carries at all is dropped: the take it belonged to is no
 * longer in the project, so there is no moment to jump to. That is distinct from
 * `removed`, which means the moment IS in a clip but a trim cuts it — those are
 * kept and flagged.
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

		for (const clip of clips) {
			if (clip.assetId !== assetId) continue;
			// An unprobed clip has no source window to fall inside yet. Skipped
			// rather than passed through, matching zoom-suggestions' `windowMs <= 0`.
			const sourceEndSec = clip.sourceEndSec ?? clip.sourceStartSec;
			if (sourceEndSec <= clip.sourceStartSec) continue;
			if (sourceSec < clip.sourceStartSec || sourceSec > sourceEndSec) continue;

			const rulerSec = placementRawSec(clip, sourceSec);
			resolved.push({
				clipId: clip.id,
				sourceSec,
				rulerSec,
				outputSec: projectRawTimelineSecToPlayback(clips, trimRanges, rulerSec, speedRegions),
				removed: removalAt(removed, rulerSec) !== null,
			});
		}
	}

	return resolved.sort((a, b) => a.rulerSec - b.rulerSec);
}
