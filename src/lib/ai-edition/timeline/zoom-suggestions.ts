// Cursor-telemetry-driven auto-zoom suggestions. Pure, no DOM/IPC.
//
// Ported from main's `src/components/video-editor/timeline/zoomSuggestionUtils.ts`
// (the legacy editor's "magic wand" auto-zoom) into the ai-edition timeline
// module. This is NOT an AI feature — it is a deterministic detector over
// recorded cursor telemetry.
//
// It reads TWO kinds of signal, and the distinction is the whole design:
//
//   INTERACTIONS (click, drag) are ground truth. The recorder tags the sample
//   coinciding with a real button press `interactionType: "click"` on every
//   platform we support — macOS and Windows from their native helpers, Linux
//   from evdev (see `lib/cursor/cursorCapabilities.ts`). Where the user clicked
//   is not a guess about where they were looking; it is where they acted.
//
//   DWELL is a proxy. Stretches where the cursor sits still become candidates
//   focused on the average position during the run. It is the only signal
//   available when telemetry carries positions alone, and it is measurably
//   noisy: on a real 66s screencast the detector reported 6 of 6 annotated
//   interest zones but 8 false positives out of 16.
//
// So interactions outrank dwell in the ranking, rather than the two competing on
// an equal footing — a click beats a pause over the same stretch of ruler. When
// the samples carry no `interactionType` at all (the position-only projection in
// `readCursorTelemetryFile`), the interaction detectors yield nothing and this
// degrades exactly to the dwell-only detector it grew from.

import {
	DEFAULT_ZOOM_DEPTH,
	type ZoomDepth,
	type ZoomFocus,
} from "@/components/video-editor/types";
import { interpolateCursorAt } from "@/lib/zoomMath/cursorFollowUtils";
import type { AxcutClip } from "../schema";
import type { ResolvedRecordingMarker } from "./recordingMarkers";

export const MIN_DWELL_DURATION_MS = 450;
export const MAX_DWELL_DURATION_MS = 2600;
export const DWELL_MOVE_THRESHOLD = 0.02;
/** Minimum spacing between two accepted suggestion centres. */
export const SUGGESTION_SPACING_MS = 1800;

// Holds are tuned for the zoom camera curve (`lib/zoomMath/zoomRegionUtils.ts`):
// the zoom-in ease starts ~1s before startMs and reaches full magnification
// shortly after it, and the zoom-out takes ~1s after endMs. A region therefore
// needs roughly 1.2s to be seen at full zoom at all.
const CLICK_PRE_ROLL_MS = 220;
const CLICK_HOLD_MS = 1_600;
/** Two clicks closer than this are one gesture (a double-click), not two zooms. */
const CLICK_MIN_GAP_MS = 260;

const DRAG_PRE_ROLL_MS = 120;
const DRAG_BASE_HOLD_MS = 1_550;
const DRAG_MAX_EXTRA_HOLD_MS = 2_200;
const DRAG_DURATION_HOLD_FACTOR = 0.9;
const DRAG_SPAN_HOLD_FACTOR = 2_000;
/** Below this the press-drag-release travelled nothing: a click, not a selection. */
const DRAG_MIN_DIMENSION = 0.008;
const DRAG_MIN_DURATION_MS = 120;

const MOVEMENT_PRE_ROLL_MS = 120;
const MOVEMENT_HOLD_MS = 1_200;
const MOVEMENT_MIN_GAP_MS = 680;
const MOVEMENT_MIN_DISTANCE = 0.018;
const MOVEMENT_BASE_SPEED = 0.42;
const MOVEMENT_PERCENTILE = 0.86;
/** A movement candidate this close to a real interaction is that interaction's
 *  own approach stroke — the pointer travelling to the thing it clicked. */
const MOVEMENT_INTERACTION_GUARD_MS = 360;

/** 500ms of zoom-in overlap plus ~700ms visibly held at full magnification. */
export const MIN_REGION_DURATION_MS = 1_200;

/** What produced a candidate. Interactions are observations; `dwell` is a guess; a
 *  `flag` is the user saying so outright, while recording. */
export type ZoomCandidateReason = "click" | "selection" | "movement" | "dwell" | "flag";

export interface ZoomDwellCandidate {
	centerTimeMs: number;
	focus: ZoomFocus;
	strength: number;
}

export interface ZoomCandidate extends ZoomDwellCandidate {
	reason: ZoomCandidateReason;
	depth: ZoomDepth;
	/** Set when the signal knows its own extent — a click's hold, a drag's
	 *  duration. Absent for dwell, which takes `defaultDurationMs`. */
	spanMs?: { start: number; end: number };
}

/**
 * Anything shaped like a recorded cursor sample. `CursorTelemetryPoint` (positions
 * only) and `CursorRecordingSample` (positions plus interaction type) are both
 * assignable, which is what lets one detector serve both readers.
 */
export interface ZoomSuggestionSample {
	timeMs: number;
	cx: number;
	cy: number;
	interactionType?: string | null;
	visible?: boolean;
}

function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.min(1, value));
}

function isVisible(sample: ZoomSuggestionSample): boolean {
	return sample.visible !== false;
}

function normalizeTelemetrySample<T extends ZoomSuggestionSample>(sample: T, totalMs: number): T {
	return {
		...sample,
		timeMs: Math.max(0, Math.min(sample.timeMs, totalMs)),
		cx: clamp01(sample.cx),
		cy: clamp01(sample.cy),
	};
}

export function normalizeCursorTelemetry<T extends ZoomSuggestionSample>(
	telemetry: T[],
	totalMs: number,
): T[] {
	return [...telemetry]
		.filter(
			(sample) =>
				Number.isFinite(sample.timeMs) && Number.isFinite(sample.cx) && Number.isFinite(sample.cy),
		)
		.sort((a, b) => a.timeMs - b.timeMs)
		.map((sample) => normalizeTelemetrySample(sample, totalMs));
}

/**
 * `maxDwellDurationMs` exists for ONE caller and defaults to the magic wand's
 * own ceiling so that caller is untouched.
 *
 * ponytail: the ceiling REJECTS a run outright rather than splitting it, so a
 * cursor parked for eight seconds while the user reads the screen produces no
 * candidate at all. That is a defensible auto-zoom policy — a nine-second zoom
 * is not a zoom — and an indefensible reporting policy: the moments it drops are
 * precisely the ones a human would name first if asked "where did the pointer
 * sit?".
 */
export function detectZoomDwellCandidates(
	samples: ZoomSuggestionSample[],
	maxDwellDurationMs: number = MAX_DWELL_DURATION_MS,
): ZoomDwellCandidate[] {
	if (samples.length < 2) {
		return [];
	}

	const dwellCandidates: ZoomDwellCandidate[] = [];
	let runStart = 0;

	const pushRunIfDwell = (startIndex: number, endIndexExclusive: number) => {
		if (endIndexExclusive - startIndex < 2) {
			return;
		}

		const start = samples[startIndex];
		const end = samples[endIndexExclusive - 1];
		const runDuration = end.timeMs - start.timeMs;
		if (runDuration < MIN_DWELL_DURATION_MS || runDuration > maxDwellDurationMs) {
			return;
		}

		const runSamples = samples.slice(startIndex, endIndexExclusive);
		const avgCx = runSamples.reduce((sum, sample) => sum + sample.cx, 0) / runSamples.length;
		const avgCy = runSamples.reduce((sum, sample) => sum + sample.cy, 0) / runSamples.length;

		dwellCandidates.push({
			centerTimeMs: Math.round((start.timeMs + end.timeMs) / 2),
			focus: { cx: avgCx, cy: avgCy },
			strength: runDuration,
		});
	};

	for (let index = 1; index < samples.length; index += 1) {
		const prev = samples[index - 1];
		const curr = samples[index];
		const distance = Math.hypot(curr.cx - prev.cx, curr.cy - prev.cy);

		if (distance > DWELL_MOVE_THRESHOLD) {
			pushRunIfDwell(runStart, index);
			runStart = index;
		}
	}
	pushRunIfDwell(runStart, samples.length);

	return dwellCandidates;
}

function quantile(sortedValues: number[], ratio: number): number {
	if (sortedValues.length === 0) return 0;
	const index = Math.floor((sortedValues.length - 1) * clamp01(ratio));
	return sortedValues[Math.max(0, Math.min(index, sortedValues.length - 1))];
}

/**
 * Speed above which a move is "the pointer went somewhere on purpose", in frame
 * fractions per second. Adaptive rather than fixed: a 4K capture and a laptop
 * screen produce very different absolute speeds for the same gesture, so the
 * threshold is the recording's own 86th percentile — floored at a constant so a
 * recording where the pointer barely moved does not promote its own jitter.
 */
function resolveMovementSpeedThreshold(samples: ZoomSuggestionSample[]): number {
	const speeds: number[] = [];
	for (let index = 1; index < samples.length; index += 1) {
		const previous = samples[index - 1];
		const current = samples[index];
		if (!isVisible(previous) || !isVisible(current)) continue;
		const dt = current.timeMs - previous.timeMs;
		if (dt < 6 || dt > 320) continue;
		const distance = Math.hypot(current.cx - previous.cx, current.cy - previous.cy);
		if (distance < 0.0008) continue;
		speeds.push(distance / (dt / 1_000));
	}

	if (speeds.length === 0) return MOVEMENT_BASE_SPEED;
	speeds.sort((left, right) => left - right);
	return Math.max(MOVEMENT_BASE_SPEED, quantile(speeds, MOVEMENT_PERCENTILE));
}

function isNearAnyTime(sortedTimes: number[], timeMs: number, windowMs: number): boolean {
	if (sortedTimes.length === 0) return false;
	let low = 0;
	let high = sortedTimes.length;
	while (low < high) {
		const mid = (low + high) >> 1;
		if (sortedTimes[mid] < timeMs) low = mid + 1;
		else high = mid;
	}
	const left = low - 1;
	if (left >= 0 && Math.abs(sortedTimes[left] - timeMs) < windowMs) return true;
	if (low < sortedTimes.length && Math.abs(sortedTimes[low] - timeMs) < windowMs) return true;
	return false;
}

function spanWithHold(
	startAnchorMs: number,
	endAnchorMs: number,
	preRollMs: number,
	holdMs: number,
): { start: number; end: number } {
	const start = Math.max(0, Math.round(startAnchorMs - preRollMs));
	const end = Math.max(start + MIN_REGION_DURATION_MS, Math.round(endAnchorMs + holdMs));
	return { start, end };
}

/**
 * Candidates from what the user DID: presses, and press-drag-release selections.
 *
 * A drag is derived rather than recorded: the recorder tags the press `click` and
 * the release `mouseup`, so a selection is the pair plus the path between them.
 * A pair that travelled less than `DRAG_MIN_DIMENSION` and lasted under
 * `DRAG_MIN_DURATION_MS` is a plain click that happened to report its release.
 *
 * Returns an empty list for position-only telemetry, which is the whole reason
 * this can sit in front of the dwell detector without changing its behaviour.
 */
export function detectInteractionCandidates(samples: ZoomSuggestionSample[]): ZoomCandidate[] {
	const candidates: ZoomCandidate[] = [];
	let lastAcceptedAt = Number.NEGATIVE_INFINITY;

	for (let index = 0; index < samples.length; index += 1) {
		const press = samples[index];
		if (press.interactionType !== "click" || !isVisible(press)) continue;
		if (press.timeMs - lastAcceptedAt < CLICK_MIN_GAP_MS) continue;

		// Walk to the matching release, tracking the bounding box of the path. A
		// press with no release at all (the recording ended mid-drag, or the
		// platform reports presses only) falls through as a click.
		let release: ZoomSuggestionSample | null = null;
		let minX = press.cx;
		let maxX = press.cx;
		let minY = press.cy;
		let maxY = press.cy;
		for (let scan = index + 1; scan < samples.length; scan += 1) {
			const sample = samples[scan];
			if (sample.interactionType === "click") break;
			minX = Math.min(minX, sample.cx);
			maxX = Math.max(maxX, sample.cx);
			minY = Math.min(minY, sample.cy);
			maxY = Math.max(maxY, sample.cy);
			if (sample.interactionType === "mouseup") {
				release = sample;
				break;
			}
		}

		const dragDurationMs = release ? release.timeMs - press.timeMs : 0;
		const dragSpan = release ? Math.max(maxX - minX, maxY - minY) : 0;
		const isDrag =
			release !== null &&
			(dragSpan >= DRAG_MIN_DIMENSION || dragDurationMs >= DRAG_MIN_DURATION_MS);

		if (isDrag && release) {
			// Frame the whole selection, not just where the button came up.
			const focus = { cx: clamp01((minX + maxX) / 2), cy: clamp01((minY + maxY) / 2) };
			const holdMs = Math.min(
				DRAG_BASE_HOLD_MS + DRAG_MAX_EXTRA_HOLD_MS,
				DRAG_BASE_HOLD_MS +
					dragDurationMs * DRAG_DURATION_HOLD_FACTOR +
					dragSpan * DRAG_SPAN_HOLD_FACTOR,
			);
			candidates.push({
				centerTimeMs: Math.round((press.timeMs + release.timeMs) / 2),
				focus,
				strength: 3.8 + Math.min(1.6, dragSpan * 8),
				reason: "selection",
				depth: 3,
				spanMs: spanWithHold(press.timeMs, release.timeMs, DRAG_PRE_ROLL_MS, holdMs),
			});
			lastAcceptedAt = release.timeMs;
			continue;
		}

		candidates.push({
			centerTimeMs: press.timeMs,
			focus: { cx: clamp01(press.cx), cy: clamp01(press.cy) },
			strength: 3.2,
			reason: "click",
			depth: 3,
			spanMs: spanWithHold(press.timeMs, press.timeMs, CLICK_PRE_ROLL_MS, CLICK_HOLD_MS),
		});
		lastAcceptedAt = press.timeMs;
	}

	return candidates;
}

/** Candidates from a deliberate, fast traverse — the pointer being taken somewhere. */
function detectMovementCandidates(
	samples: ZoomSuggestionSample[],
	interactionTimes: number[],
): ZoomCandidate[] {
	const threshold = resolveMovementSpeedThreshold(samples);
	const candidates: ZoomCandidate[] = [];
	let lastAt = Number.NEGATIVE_INFINITY;

	for (let index = 1; index < samples.length; index += 1) {
		const previous = samples[index - 1];
		const current = samples[index];
		if (!isVisible(previous) || !isVisible(current)) continue;

		const dt = current.timeMs - previous.timeMs;
		if (dt < 6 || dt > 320) continue;

		const distance = Math.hypot(current.cx - previous.cx, current.cy - previous.cy);
		if (distance < MOVEMENT_MIN_DISTANCE) continue;

		const speed = distance / (dt / 1_000);
		if (speed < threshold) continue;
		if (current.timeMs - lastAt < MOVEMENT_MIN_GAP_MS) continue;
		if (isNearAnyTime(interactionTimes, current.timeMs, MOVEMENT_INTERACTION_GUARD_MS)) continue;

		candidates.push({
			centerTimeMs: current.timeMs,
			focus: { cx: clamp01(current.cx), cy: clamp01(current.cy) },
			strength: speed,
			reason: "movement",
			depth: 2,
			spanMs: spanWithHold(current.timeMs, current.timeMs, MOVEMENT_PRE_ROLL_MS, MOVEMENT_HOLD_MS),
		});
		lastAt = current.timeMs;
	}

	return candidates;
}

/**
 * Every signal, on one comparable scale, ranked highest first.
 *
 * The scale matters more than any single detector. Dwell's native strength is a
 * DURATION in milliseconds (450–2600), so ranking it raw against a click's 3.2
 * would let any pause outrank every click ever recorded. It is remapped to
 * 1.0–2.0 — monotonic in run length, so dwells keep their order among themselves,
 * but strictly below a click (3.2) and a selection (3.8+). That is the intended
 * policy, not a scaling convenience: an observed interaction should win a
 * contested stretch of ruler against a guess about where the user was looking.
 */
export function detectZoomCandidates(samples: ZoomSuggestionSample[]): ZoomCandidate[] {
	const interactions = detectInteractionCandidates(samples);
	const interactionTimes = interactions.map((c) => c.centerTimeMs).sort((a, b) => a - b);
	const movement = detectMovementCandidates(samples, interactionTimes);
	const dwell = detectZoomDwellCandidates(samples).map(
		(candidate): ZoomCandidate => ({
			...candidate,
			strength: 1 + Math.min(1, candidate.strength / MAX_DWELL_DURATION_MS),
			reason: "dwell",
			depth: 3,
		}),
	);

	return [...interactions, ...movement, ...dwell].sort((a, b) => b.strength - a.strength);
}

export interface AutoZoomSuggestion {
	span: { start: number; end: number };
	focus: ZoomFocus;
	/** Absent for callers that predate per-signal depth; they get the default. */
	depth?: ZoomDepth;
	reason?: ZoomCandidateReason;
}

/**
 * Build non-overlapping zoom suggestions from cursor telemetry: detect candidates,
 * rank by strength, space by SUGGESTION_SPACING_MS, drop any overlapping an existing
 * region. Pure, shared by the magic-wand toggle and the on-load auto-suggest pass.
 *
 * `existingRegions` is the avoid-list: a candidate landing on one is dropped rather
 * than carved, because a zoom sliced down to whatever the user left free is no longer
 * the zoom the signal asked for. Accepted suggestions join the list, so they never
 * overlap each other either.
 */
export function buildAutoZoomSuggestions(options: {
	cursorTelemetry: ZoomSuggestionSample[];
	totalMs: number;
	existingRegions: { startMs: number; endMs: number }[];
	defaultDurationMs: number;
	/** The clip's crop, in fractions of the frame. See `placeZoomCandidates`. */
	crop?: { x: number; y: number; width: number; height: number };
}): AutoZoomSuggestion[] {
	const { cursorTelemetry, totalMs, existingRegions, defaultDurationMs, crop } = options;
	if (totalMs <= 0 || cursorTelemetry.length < 2) {
		return [];
	}

	const defaultDuration = Math.min(defaultDurationMs, totalMs);
	if (defaultDuration <= 0) {
		return [];
	}

	const normalizedSamples = normalizeCursorTelemetry(cursorTelemetry, totalMs);
	if (normalizedSamples.length < 2) {
		return [];
	}

	return placeZoomCandidates(detectZoomCandidates(normalizedSamples), {
		totalMs,
		existingRegions,
		defaultDurationMs: defaultDuration,
		crop,
	});
}

/**
 * The placement half of `buildAutoZoomSuggestions`: take candidates in order, space them,
 * size them, fit them in `[0, totalMs]` and drop any that lands on a reserved span. Every
 * candidate source goes through here, so a flagged moment and a detected click obey the
 * same spacing and overlap rules rather than two copies of them.
 */
function placeZoomCandidates(
	candidates: ZoomCandidate[],
	options: {
		totalMs: number;
		existingRegions: { startMs: number; endMs: number }[];
		/** Width for a candidate that carries no `spanMs` of its own. */
		defaultDurationMs: number;
		/**
		 * The clip's crop, in fractions of the frame. Telemetry is full-frame, a zoom's focus
		 * is a fraction of the crop (the compositor's `screen_source_rect`), so every focus is
		 * mapped into it. What falls outside is not in the picture: a detected moment there is
		 * dropped, which keeps a recorded area's zooms inside the area -- but a flag is the
		 * user asking for a zoom at that moment, so it keeps its zoom, focused at the
		 * nearest point of the crop.
		 */
		crop?: { x: number; y: number; width: number; height: number };
	},
): AutoZoomSuggestion[] {
	const { totalMs, existingRegions, defaultDurationMs: defaultDuration, crop } = options;
	const reservedSpans = existingRegions
		.map((region) => ({ start: region.startMs, end: region.endMs }))
		.sort((a, b) => a.start - b.start);

	const acceptedCenters: number[] = [];
	const suggestions: AutoZoomSuggestion[] = [];

	for (const candidate of candidates) {
		// Before spacing, so a moment outside the crop cannot crowd out one inside it.
		let focus = crop
			? {
					cx: (candidate.focus.cx - crop.x) / crop.width,
					cy: (candidate.focus.cy - crop.y) / crop.height,
				}
			: candidate.focus;
		if (!(focus.cx >= 0 && focus.cx <= 1 && focus.cy >= 0 && focus.cy <= 1)) {
			if (candidate.reason !== "flag") continue;
			focus = { cx: clamp01(focus.cx), cy: clamp01(focus.cy) };
		}

		const tooCloseToAccepted = acceptedCenters.some(
			(center) => Math.abs(center - candidate.centerTimeMs) < SUGGESTION_SPACING_MS,
		);
		if (tooCloseToAccepted) {
			continue;
		}

		// A signal that knows its own extent keeps it — a click's hold and a drag's
		// duration are the point. Only dwell falls back to the caller's default.
		const width = candidate.spanMs
			? Math.min(candidate.spanMs.end - candidate.spanMs.start, totalMs)
			: defaultDuration;
		const preferredStart = candidate.spanMs
			? candidate.spanMs.start
			: Math.round(candidate.centerTimeMs - width / 2);
		const candidateStart = Math.max(0, Math.min(preferredStart, totalMs - width));
		const candidateEnd = candidateStart + width;
		if (candidateEnd - candidateStart < MIN_REGION_DURATION_MS) {
			continue;
		}

		const hasOverlap = reservedSpans.some(
			(span) => candidateEnd > span.start && candidateStart < span.end,
		);
		if (hasOverlap) {
			continue;
		}

		reservedSpans.push({ start: candidateStart, end: candidateEnd });
		acceptedCenters.push(candidate.centerTimeMs);
		suggestions.push({
			span: { start: candidateStart, end: candidateEnd },
			focus,
			depth: candidate.depth,
			reason: candidate.reason,
		});
	}

	return suggestions;
}

/**
 * The same detector, run over a TIMELINE instead of over a bare media file — and the
 * only entry point a caller holding an `AxcutDocument` should use.
 *
 * Cursor telemetry is recorded against the ORIGINAL media file, so `timeMs` is the
 * asset's SOURCE time (the same axis `cursor-track.ts` maps through
 * `locateSourcePosition`, and the same one trims are stored in). Zoom regions are
 * authored in RAW TIMELINE ms — that is what `anchorRegionsWithDerivedMs` ventilates
 * across the clips. The two axes coincide for exactly one layout: a single clip,
 * starting at 0, covering the whole recording. Any other timeline made the detector's
 * output land wherever `[0, assetDuration]` happens to fall on the ruler, which is the
 * first clip's span — hence "auto-zoom only decorates the first clip". Two clips over
 * ONE recording make it plainer still: the second clip replays source time the first
 * already used, so no amount of arithmetic on a single asset-wide span can say which of
 * them a dwell belongs to. It belongs to BOTH, and gets one zoom on each.
 *
 * So the projection is per clip, and it is a plain shift: a raw clip is identity between
 * its source time and its raw-virtual time (see timeline/timelineMap.ts), so a dwell at
 * source `t` on a clip covering `[sourceStartSec, sourceEndSec]` sits at
 * `timelineStartSec + (t - sourceStartSec)`. Each clip is handed only the samples inside
 * its own source window, so a dwell that a cut split across two clips is no longer one
 * dwell — which is right: the cursor did not sit still across the cut on the timeline the
 * user is watching. `existingRegions` is in RAW TIMELINE ms (what the store holds), so it
 * reserves the right stretch of ruler on every clip instead of only on the first.
 *
 * RAW ms is also what makes the output survive SPEED regions. Speed is a modifier over
 * the ruler, not geometry baked into it — a raw clip's timeline length equals its source
 * length whatever speed plays over it (timelineMap.ts) — so a suggestion emitted here
 * lands on the same frame whether or not the user later speeds that stretch up. Emitting
 * playback-time (`compressed`) offsets instead would slip every suggestion after the
 * first speed region, which is the same class of bug the raw/compressed split exists to
 * prevent. There is one clock convention here, and it is upstream's.
 *
 * Clips of other assets are skipped, as are clips with no probed source window.
 * `buildAutoZoomSuggestions` is reused verbatim per clip — spacing, ranking and the
 * reserve rule keep their single definition.
 */
export function buildAutoZoomSuggestionsForClips(options: {
	/** Samples in the asset's own SOURCE time. */
	cursorTelemetry: ZoomSuggestionSample[];
	assetId: string;
	clips: AxcutClip[];
	/** Already-placed zoom spans, in RAW TIMELINE ms. */
	existingRegions: { startMs: number; endMs: number }[];
	defaultDurationMs: number;
}): AutoZoomSuggestion[] {
	const { cursorTelemetry, assetId, clips, existingRegions, defaultDurationMs } = options;
	return clips.flatMap((clip) =>
		clip.assetId !== assetId
			? []
			: placeInClip(clip, existingRegions, (sourceOffsetMs, windowMs, clipRegions, crop) =>
					buildAutoZoomSuggestions({
						cursorTelemetry: cursorTelemetry
							.filter(
								(sample) =>
									sample.timeMs >= sourceOffsetMs && sample.timeMs <= sourceOffsetMs + windowMs,
							)
							.map((sample) => ({ ...sample, timeMs: sample.timeMs - sourceOffsetMs })),
						totalMs: windowMs,
						existingRegions: clipRegions,
						defaultDurationMs,
						crop,
					}),
				),
	);
}

/**
 * Run `place` in one clip's own frame — its source window as `[0, windowMs]`, and the
 * reserved ruler spans shifted into it — then lift what it placed back onto the ruler.
 * The projection `buildAutoZoomSuggestionsForClips` documents, held once for every
 * candidate source. Skips a clip with no probed source window.
 */
function placeInClip(
	clip: AxcutClip,
	existingRegions: { startMs: number; endMs: number }[],
	place: (
		sourceOffsetMs: number,
		windowMs: number,
		clipRegions: { startMs: number; endMs: number }[],
		crop: AxcutClip["cropRegion"],
	) => AutoZoomSuggestion[],
): AutoZoomSuggestion[] {
	const sourceEndSec = clip.sourceEndSec ?? clip.sourceStartSec;
	const windowMs = (sourceEndSec - clip.sourceStartSec) * 1000;
	if (windowMs <= 0) return [];
	const sourceOffsetMs = clip.sourceStartSec * 1000;
	const timelineOffsetMs = clip.timelineStartSec * 1000;
	const clipRegions = existingRegions.map((region) => ({
		startMs: region.startMs - timelineOffsetMs,
		endMs: region.endMs - timelineOffsetMs,
	}));
	return place(sourceOffsetMs, windowMs, clipRegions, clip.cropRegion).map((suggestion) => ({
		...suggestion,
		span: {
			start: suggestion.span.start + timelineOffsetMs,
			end: suggestion.span.end + timelineOffsetMs,
		},
	}));
}

/**
 * One zoom per moment the user flagged while recording, placed by the same rules as every
 * other suggestion.
 *
 * `markers` is `resolveRecordingMarkers`' output, so the fan-out is already done: a flag on a
 * clip that is on the timeline twice arrives twice, once per `clipId`, and each row is placed
 * on its own clip. A row the resolver marked `removed` (a trim cuts it) is not placed — a zoom
 * over footage that never plays is not a zoom. Each zoom is held like a click (a short
 * pre-roll before the flag, then a hold), focused where the pointer was at that instant, at
 * the default depth.
 *
 * `covered` counts the rows the placement rules refused — an existing zoom, or the zoom of an
 * earlier flag, already sits on that stretch of ruler — so a caller can say why fewer zooms
 * landed than flags were set. A clip too short to hold any zoom refuses its flags too, and
 * they are counted here as well.
 */
export function buildFlagZoomSuggestions(options: {
	markers: ResolvedRecordingMarker[];
	clips: AxcutClip[];
	/** Samples in the recording's own SOURCE time, same as the markers. */
	cursorTelemetry: ZoomSuggestionSample[];
	/** Already-placed zoom spans, in RAW TIMELINE ms. */
	existingRegions: { startMs: number; endMs: number }[];
}): { suggestions: AutoZoomSuggestion[]; covered: number; trimmed: number } {
	const { markers, clips, existingRegions } = options;
	const telemetry = normalizeCursorTelemetry(options.cursorTelemetry, Number.POSITIVE_INFINITY);
	const live = markers.filter((marker) => !marker.removed);
	const suggestions = clips.flatMap((clip) => {
		const flags = live.filter((marker) => marker.clipId === clip.id);
		if (flags.length === 0) return [];
		return placeInClip(clip, existingRegions, (sourceOffsetMs, windowMs, clipRegions, crop) =>
			placeZoomCandidates(
				flags.map((marker): ZoomCandidate => {
					const atMs = marker.sourceSec * 1000 - sourceOffsetMs;
					return {
						centerTimeMs: atMs,
						// No pointer to follow: the centre of what is in the picture. In full-frame
						// units, like telemetry, because `placeZoomCandidates` maps it into the crop.
						focus:
							interpolateCursorAt(telemetry, marker.sourceSec * 1000) ??
							(crop
								? { cx: crop.x + crop.width / 2, cy: crop.y + crop.height / 2 }
								: { cx: 0.5, cy: 0.5 }),
						strength: 0,
						reason: "flag",
						depth: DEFAULT_ZOOM_DEPTH,
						spanMs: spanWithHold(atMs, atMs, CLICK_PRE_ROLL_MS, CLICK_HOLD_MS),
					};
				}),
				// Every flag carries its own span, so there is no default width to fall back on.
				{ totalMs: windowMs, existingRegions: clipRegions, defaultDurationMs: 0, crop },
			),
		);
	});
	return {
		suggestions,
		covered: live.length - suggestions.length,
		trimmed: markers.length - live.length,
	};
}
