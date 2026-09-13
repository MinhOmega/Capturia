// Idle stretches, as speed regions. Pure — no DOM, no IPC, no model call.
//
// The sibling of `rough-cut.ts`, and the difference is the whole point: dead air
// is a stretch where nothing is SAID, and the honest answer to it is a cut. An
// idle stretch is one where nothing is DONE — the pointer parked while a build
// runs — and cutting it would hide that the wait happened. So this compresses
// instead: the wait stays on the ruler, it just goes past at 3×.
//
// Two signals, and both have to agree. The cursor must be parked (the dwell walk
// from `zoom-suggestions.ts`, at its own `DWELL_MOVE_THRESHOLD`), and nobody may
// be speaking over it — a narrator talking through the wait is not idle, they are
// the content. With no transcript there is no second signal and the pass runs on
// the cursor alone, which is the recorder-first case this exists for.
//
// TIME BASE: the dwell walk reads the asset's SOURCE ms, the same as the zoom
// suggester; the output is RAW TIMELINE ms, because that is where speed regions
// live (`useTimeline.addSpeed`, `timeline/speed.ts`). The projection between the
// two is one clip's offset, and a clip drawing the same recording twice gets its
// own region each time — the same rule `placeInClip` holds for zooms.

import type { AxcutClip, AxcutTrimRange, AxcutWord } from "../schema";
import { isSilenceWord } from "./aggregated-transcript";
import { type Interval, subtractInterval } from "./intervals";
import type { SpeedRegion } from "./speed";
import {
	detectZoomDwellCandidates,
	normalizeCursorTelemetry,
	type ZoomSuggestionSample,
} from "./zoom-suggestions";

/**
 * Below this a speed region is not worth having.
 *
 * 2.5s, against the wand's 450ms dwell floor: a zoom over a one-second pause is a
 * flourish, a 3× region over one is a glitch — the ease in and out would be most
 * of what you see. It is also the taste guard. A speaker pausing for effect holds
 * it for under two seconds; a build you are waiting on takes ten.
 */
export const MIN_IDLE_DURATION_MS = 2_500;

/** Fast enough to skip a wait, slow enough to still read as the same recording. */
export const DEFAULT_IDLE_SPEED = 3;

/** A speed region to add, in RAW TIMELINE ms. `useTimeline.addSpeedRegionsBulk` ids
 *  and anchors it; nothing here knows about clips' identities. */
export interface IdleSpeedup {
	startMs: number;
	endMs: number;
	speed: number;
}

/** Real spoken words. Drops the `[silence]` pseudo-words the transcript pane
 *  inserts for display — treating one as speech would make every gap "spoken". */
function spokenIntervals(words: AxcutWord[]): Interval[] {
	return words
		.filter(
			(word) =>
				!isSilenceWord(word) &&
				word.text.trim().length > 0 &&
				Number.isFinite(word.startSec) &&
				Number.isFinite(word.endSec) &&
				word.endSec > word.startSec,
		)
		.map((word) => ({ startSec: word.startSec, endSec: word.endSec }));
}

/**
 * Every stretch of one recording worth speeding up, on the ruler.
 *
 * `cursorTelemetry` is in the asset's own source ms, `words` and `trimRanges` in
 * its source seconds, `existingSpeedRegions` in RAW TIMELINE ms — each already the
 * axis its own store uses, none of them converted on the way in.
 *
 * The three refusals, in the order they are cheapest to make: speech splits a
 * candidate (subtracting each word can leave two shorter stretches, or none); a
 * trim anywhere over it drops it whole, the conservative reading
 * `dropTrimsAlreadyCovered` takes for cuts — a stretch that does not play is not
 * a stretch to speed up; an existing speed region over the projected span drops
 * it too, which is the only thing making a second run of the pass a no-op.
 */
export function buildIdleSpeedups(options: {
	/** Samples in the asset's own SOURCE ms. */
	cursorTelemetry: ZoomSuggestionSample[];
	assetId: string;
	clips: AxcutClip[];
	/** The asset's transcript, if it has one. Empty = cursor-only. */
	words?: AxcutWord[];
	/** The document's cuts, in SOURCE seconds. Filtered to this asset here. */
	trimRanges?: AxcutTrimRange[];
	/** Already-placed speed spans, in RAW TIMELINE ms. */
	existingSpeedRegions?: Pick<SpeedRegion, "startMs" | "endMs">[];
	speed?: number;
}): IdleSpeedup[] {
	const {
		cursorTelemetry,
		assetId,
		clips,
		words = [],
		trimRanges = [],
		existingSpeedRegions = [],
		speed = DEFAULT_IDLE_SPEED,
	} = options;

	// The wand's own dwell walk, with its ceiling lifted: `MAX_DWELL_DURATION_MS`
	// rejects a run over 2.6s because a nine-second zoom is not a zoom, and a
	// nine-second wait is precisely what this pass is looking for.
	//
	// ponytail: the walk reports a run as centre + duration rather than a span, so
	// the span is reconstructed. `centerTimeMs` is rounded, so an edge can land
	// half a millisecond off a sample time — irrelevant against a 2.5s floor, and
	// cheaper than a second copy of the walk.
	const idle: Interval[] = detectZoomDwellCandidates(
		normalizeCursorTelemetry(cursorTelemetry, Number.POSITIVE_INFINITY),
		Number.POSITIVE_INFINITY,
	)
		.filter((candidate) => candidate.strength >= MIN_IDLE_DURATION_MS)
		.map((candidate) => ({
			startSec: (candidate.centerTimeMs - candidate.strength / 2) / 1000,
			endSec: (candidate.centerTimeMs + candidate.strength / 2) / 1000,
		}));

	const silent = spokenIntervals(words).reduce(subtractInterval, idle);

	const cuts = trimRanges.filter((trim) => trim.assetId === assetId);
	const untrimmed = silent.filter(
		(span) => !cuts.some((cut) => span.startSec < cut.endSec && cut.startSec < span.endSec),
	);

	return clips.flatMap((clip) => {
		if (clip.assetId !== assetId) return [];
		const clipEndSec = clip.sourceEndSec ?? clip.sourceStartSec;
		if (clipEndSec <= clip.sourceStartSec) return [];
		const offsetMs = (clip.timelineStartSec - clip.sourceStartSec) * 1000;
		return untrimmed.flatMap((span): IdleSpeedup[] => {
			const startMs = Math.round(Math.max(span.startSec, clip.sourceStartSec) * 1000 + offsetMs);
			const endMs = Math.round(Math.min(span.endSec, clipEndSec) * 1000 + offsetMs);
			if (endMs - startMs < MIN_IDLE_DURATION_MS) return [];
			if (existingSpeedRegions.some((region) => startMs < region.endMs && region.startMs < endMs))
				return [];
			return [{ startMs, endMs, speed }];
		});
	});
}
