// Deterministic dead-air detection: silences and filler runs, straight off the
// transcript's word timings. Pure — no DOM, no IPC, no model call.
//
// WHY this exists next to the agent. "Cut the dead time" is already a thing the
// deep agent can do: it reads `getTranscriptWords` and emits `addTrims`. That
// path is strictly better at judgement — it knows a pause before a punchline is
// not dead air — and strictly worse at everything else. It needs a configured
// provider, it costs a paid round trip per recording, and it sends the
// transcript off the machine. Finding a 900ms hole between two word timings
// needs none of that: it is a subtraction, it is exact, and it runs on a laptop
// in a plane. So the two coexist on purpose — this is the offline default, the
// agent is the pass you ask for when you want taste applied.
//
// TIME BASE: source seconds, which is already what `AxcutTrimRange` stores and
// what `AxcutWord` reports. There is no timeline projection here and there must
// not be one — the moment a cut is expressed in ruler coordinates it stops
// surviving a reorder. Zooms are the opposite case (see zoom-suggestions.ts):
// they are authored in RAW timeline ms because that is where zoomRanges live.
// Two different storage axes, each engine emitting its own — not one convention
// bent to cover both.

import type { AxcutTrimRange, AxcutWord } from "../schema";
import { isSilenceWord } from "./aggregated-transcript";

export type RoughCutReason = "silence" | "filler";

export interface RoughCutSuggestion {
	startSec: number;
	endSec: number;
	reason: RoughCutReason;
	/** 0–1. Orders the merge when two suggestions overlap; not a probability. */
	confidence: number;
}

/**
 * Gaps at least this long between two spoken words are dead air.
 *
 * 0.8s. Below roughly 0.5s a gap is the rhythm of ordinary speech and cutting it
 * makes the speaker sound rushed; `SILENCE_THRESHOLD_SEC` (0.2) exists to DRAW
 * silence in the transcript pane, which is a much lower bar than removing it.
 */
const MIN_SILENCE_SEC = 0.8;
/** A filler run shorter than this is not worth a cut. */
const MIN_FILLER_SEC = 0.26;
/**
 * Compared against words lowercased and stripped of punctuation.
 *
 * The filler list is deliberately short and covers the hesitation sounds that
 * carry no meaning in any register. It is not a disfluency dictionary: "like"
 * and "you know" are filler in one sentence and content in the next, and a
 * deterministic pass cannot tell which, so it does not try.
 */
const FILLER_WORDS = ["um", "uh", "erm", "emm", "ah", "er", "hmm", "呃", "嗯"];
/** Two suggestions closer than this are one cut. */
const MERGE_GAP_SEC = 0.04;
/** A run of fillers survives a gap this small between them. */
const MAX_FILLER_GAP_SEC = 0.2;

function normalizeTextToken(value: string): string {
	return value
		.toLowerCase()
		.trim()
		.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

/** Real spoken words, in order. Drops the `[silence]` pseudo-words
 *  `withSilenceGaps` inserts for display — a gap measured between two of THOSE
 *  is a gap inside a gap, and cutting it would cut speech that is still there. */
function spokenWords(words: AxcutWord[]): AxcutWord[] {
	return words
		.filter(
			(word) =>
				!isSilenceWord(word) &&
				normalizeTextToken(word.text).length > 0 &&
				Number.isFinite(word.startSec) &&
				Number.isFinite(word.endSec) &&
				word.endSec > word.startSec,
		)
		.sort((left, right) => left.startSec - right.startSec);
}

/**
 * Clamp to `[0, durationSec]`, drop the empty, and merge what touches. Two
 * suggestions that overlap become one carrying the HIGHER confidence's reason —
 * a filler run inside a long pause reads as "filler", which is the more specific
 * of the two things true about that stretch.
 */
function normalizeRoughCutSuggestions(
	input: RoughCutSuggestion[],
	durationSec: number,
): RoughCutSuggestion[] {
	const total = Math.max(0, durationSec);
	const normalized = input
		.map((item) => ({
			...item,
			startSec: Math.max(0, item.startSec),
			endSec: Math.min(total, item.endSec),
		}))
		.filter(
			(item) =>
				Number.isFinite(item.startSec) &&
				Number.isFinite(item.endSec) &&
				item.endSec > item.startSec,
		)
		.sort((left, right) => left.startSec - right.startSec);

	const merged: RoughCutSuggestion[] = [];
	for (const item of normalized) {
		const previous = merged[merged.length - 1];
		if (!previous || item.startSec > previous.endSec + MERGE_GAP_SEC) {
			merged.push({ ...item });
			continue;
		}
		previous.endSec = Math.max(previous.endSec, item.endSec);
		if (item.confidence > previous.confidence) {
			previous.reason = item.reason;
		}
		previous.confidence = Math.max(previous.confidence, item.confidence);
	}
	return merged;
}

/**
 * Every stretch worth cutting, in the asset's source seconds.
 *
 * Two detectors over one word list. Silence is the gap between consecutive words;
 * confidence rises with the gap because a four-second hole is more certainly dead
 * than a one-second one. Filler is a run of hesitation tokens, joined across gaps
 * under `MAX_FILLER_GAP_SEC` so "um, uh" is one cut rather than two.
 */
export function generateRoughCutSuggestions(
	words: AxcutWord[],
	durationSec: number,
): RoughCutSuggestion[] {
	const spoken = spokenWords(words);
	if (spoken.length === 0) return [];

	const suggestions: RoughCutSuggestion[] = [];

	for (let index = 1; index < spoken.length; index += 1) {
		const gap = spoken[index].startSec - spoken[index - 1].endSec;
		if (gap < MIN_SILENCE_SEC) continue;
		suggestions.push({
			startSec: spoken[index - 1].endSec,
			endSec: spoken[index].startSec,
			reason: "silence",
			confidence: Math.min(0.98, 0.55 + gap / 3),
		});
	}

	const fillerSet = new Set(FILLER_WORDS.map(normalizeTextToken).filter(Boolean));
	let runStart: AxcutWord | null = null;
	let runEnd: AxcutWord | null = null;

	const flushFillerRun = (): void => {
		if (!runStart || !runEnd) return;
		const duration = runEnd.endSec - runStart.startSec;
		if (duration >= MIN_FILLER_SEC) {
			suggestions.push({
				startSec: runStart.startSec,
				endSec: runEnd.endSec,
				reason: "filler",
				confidence: Math.min(0.96, 0.62 + duration / 2),
			});
		}
		runStart = null;
		runEnd = null;
	};

	for (const word of spoken) {
		if (!fillerSet.has(normalizeTextToken(word.text))) {
			flushFillerRun();
			continue;
		}
		if (runEnd && word.startSec - runEnd.endSec > MAX_FILLER_GAP_SEC) {
			flushFillerRun();
		}
		runStart ??= word;
		runEnd = word;
	}
	flushFillerRun();

	return normalizeRoughCutSuggestions(suggestions, durationSec);
}

/**
 * The suggestions as the document's own cut type, ready for `trimRanges`.
 *
 * `origin: "system"` because nobody asked for these by hand and no model
 * proposed them — they are what the timings say. That matters downstream: the
 * agent's trims are "agent", the user's are "user", and a pass that wants to
 * clear only the automatic cuts can tell them apart.
 *
 * `clipId` is deliberately left unset. A source-time range belongs to whichever
 * clip covers it, `trimAppliesToClip` (timeline/trim-mapping) is the single rule
 * that decides, and pinning a clip here would be a second answer to a question
 * that already has one.
 */
export function roughCutsToTrimRanges(
	suggestions: RoughCutSuggestion[],
	assetId: string,
	makeId: () => string,
): AxcutTrimRange[] {
	return suggestions.map((suggestion) => ({
		id: makeId(),
		assetId,
		startSec: suggestion.startSec,
		endSec: suggestion.endSec,
		reason: suggestion.reason,
		origin: "system" as const,
	}));
}

/**
 * The suggestions the document does not already cut.
 *
 * The pass is idempotent by nothing but this: running it twice on the same
 * recording finds the same pauses, and without a reservation step the second run
 * would stack a duplicate trim on every one of them. Same job the auto-zoom pass
 * does with `existingRegions`, one layer up.
 *
 * Overlap is judged on the ASSET alone. A suggestion carries no `clipId` on
 * purpose (see above), so it cannot be compared clip to clip — and touching an
 * existing cut at all is enough to leave the stretch to that cut, whoever made
 * it. That is deliberately conservative: a user's hand-made trim near a pause
 * keeps its edges rather than gaining a machine-made neighbour.
 */
export function dropTrimsAlreadyCovered(
	suggested: AxcutTrimRange[],
	existing: AxcutTrimRange[],
): AxcutTrimRange[] {
	const overlaps = (a: AxcutTrimRange, b: AxcutTrimRange) =>
		a.assetId === b.assetId && a.startSec < b.endSec && b.startSec < a.endSec;
	return suggested.filter((cut) => !existing.some((trim) => overlaps(cut, trim)));
}
