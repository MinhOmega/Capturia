// SRT / WebVTT sidecars for an export.
//
// Captions are burned into the frame by the compositor and nowhere else, so a viewer
// cannot turn them off, restyle them, or search them. A sidecar is the one form that
// travels with the file and stays optional; `website/docs/captions.md` states plainly
// that OpenScreen writes none, and this is what makes that sentence stale.
//
// THE ONLY HARD PART IS TIME. `deriveCaptionCues` hands back cues on the RAW ruler —
// the same coordinate the caption pills are drawn in, which still contains the trimmed
// stretches and is blind to speed. The exported file's own clock is the PROGRAMME:
// cuts are gone and a speed region has scaled what is left. Write the raw numbers into
// a `.srt` and every line after the first cut is late by the length of that cut.
//
// So the projection is not written here. `projectRawTimelineSecToPlayback` is the
// function the preview playhead, the audio mix and `sceneDescription` already use for
// exactly this question, and it models both trims and speed regions. Reusing it is the
// whole correctness argument: a second implementation of raw→programme could only
// agree with the render by coincidence, and would drift the first time either changed.

import { type PlaybackSpeedRegion, projectRawTimelineSecToPlayback } from "../document/timeline";
import type { AxcutClip, AxcutDocument, AxcutTrimRange } from "../schema";
import { type CaptionCue, deriveCaptionCues } from "./cues";
import type { CaptionSettings } from "./settings";
import type { CaptionTranslations } from "./translations";

export const SUBTITLE_SIDECAR_FORMATS = ["srt", "vtt"] as const;
export type SubtitleSidecarFormat = (typeof SUBTITLE_SIDECAR_FORMATS)[number];

/** Shortest cue worth writing. Below this a cue is a rounding artefact of the projection,
 *  or a line that the cut it sat in has left with nothing to cover. */
const MIN_EXPORTED_CUE_MS = 1;

function pad(value: number, length: number): string {
	return String(Math.max(0, Math.floor(value))).padStart(length, "0");
}

function splitTimestamp(msInput: number): [number, number, number, number] {
	const total = Math.max(0, Math.round(Number.isFinite(msInput) ? msInput : 0));
	return [
		Math.floor(total / 3_600_000),
		Math.floor(total / 60_000) % 60,
		Math.floor(total / 1000) % 60,
		total % 1000,
	];
}

/** `HH:MM:SS,mmm` — SubRip separates the milliseconds with a comma. */
export function formatSrtTimestamp(ms: number): string {
	const [h, m, s, ms3] = splitTimestamp(ms);
	return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(ms3, 3)}`;
}

/** `HH:MM:SS.mmm` — WebVTT uses a dot, and the two are not interchangeable. */
export function formatVttTimestamp(ms: number): string {
	const [h, m, s, ms3] = splitTimestamp(ms);
	return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}.${pad(ms3, 3)}`;
}

/**
 * WebVTT payloads are a small markup, so a bare `&`, `<` or `>` from a transcript would
 * open an entity or a cue-span tag. Escaping `>` also disposes of a literal `-->`, which
 * a payload line may never contain — it would be read as the next cue's timing line.
 */
export function escapeVttText(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Payload lines: newlines normalised, blank lines dropped — a blank line ends the cue. */
function payloadLines(text: string): string[] {
	return text
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

/**
 * Cues from the raw ruler onto the exported file's clock.
 *
 * A cue that straddles a cut comes back shortened by the cut; a cue that sat entirely
 * inside one collapses to zero length, because both of its ends clamp to the output edge
 * just before the removed stretch — and is dropped here rather than written as an
 * instantaneous flash. Speed regions scale the cues under them for the same reason the
 * frames under them are fewer.
 */
export function projectCuesToOutputTime(
	cues: readonly CaptionCue[],
	clips: AxcutClip[],
	trimRanges: AxcutTrimRange[],
	speedRegions: PlaybackSpeedRegion[] = [],
): CaptionCue[] {
	const toOutputMs = (rawMs: number) =>
		Math.round(
			projectRawTimelineSecToPlayback(clips, trimRanges, rawMs / 1000, speedRegions) * 1000,
		);
	return cues
		.map((cue) => ({ ...cue, startMs: toOutputMs(cue.startMs), endMs: toOutputMs(cue.endMs) }))
		.filter((cue) => cue.endMs - cue.startMs >= MIN_EXPORTED_CUE_MS)
		.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}

/** Cues that survive serialisation: finite times, positive duration, non-blank text. */
function serialisableCues(cues: readonly CaptionCue[]): CaptionCue[] {
	return cues.filter(
		(cue) =>
			Number.isFinite(cue.startMs) &&
			Number.isFinite(cue.endMs) &&
			cue.endMs - cue.startMs >= MIN_EXPORTED_CUE_MS &&
			payloadLines(cue.text).length > 0,
	);
}

/** SubRip. Cue numbers are 1-based and consecutive over the cues actually written, so a
 *  dropped cue does not leave a hole in the numbering that some players trip over. */
export function cuesToSrt(cues: readonly CaptionCue[]): string {
	const usable = serialisableCues(cues);
	if (usable.length === 0) return "";
	const blocks = usable.map((cue, index) =>
		[
			String(index + 1),
			`${formatSrtTimestamp(cue.startMs)} --> ${formatSrtTimestamp(cue.endMs)}`,
			...payloadLines(cue.text),
		].join("\n"),
	);
	return `${blocks.join("\n\n")}\n`;
}

/** WebVTT, with the mandatory signature. The signature is written even with no cues: an
 *  empty VTT is a valid file that a player accepts, an empty string is not. */
export function cuesToVtt(cues: readonly CaptionCue[]): string {
	const blocks = serialisableCues(cues).map((cue, index) =>
		[
			String(index + 1),
			`${formatVttTimestamp(cue.startMs)} --> ${formatVttTimestamp(cue.endMs)}`,
			...payloadLines(cue.text).map(escapeVttText),
		].join("\n"),
	);
	return `WEBVTT\n\n${blocks.length > 0 ? `${blocks.join("\n\n")}\n` : ""}`;
}

/**
 * Raw speed regions for a document, read the way `sceneDescription` reads them.
 *
 * They live on the legacy envelope because they carry a `speed` the shared `rangeSchema`
 * has no field for (see `SceneDescription.speedRegions`). Reading them anywhere else — or
 * forgetting them — is what silently desynchronises a sidecar from a sped-up export.
 */
function rawSpeedRegions(document: AxcutDocument): PlaybackSpeedRegion[] {
	const stored = (document.legacyEditor as Record<string, unknown> | null)?.speedRegions;
	if (!Array.isArray(stored)) return [];
	return (stored as PlaybackSpeedRegion[]).filter(
		(region) => Number.isFinite(region.speed) && region.speed > 0,
	);
}

/**
 * The sidecar for a finished export, or null when there is nothing to write.
 *
 * Null rather than an empty file: the caller skips the write, so a project with captions
 * off does not litter a zero-byte `.srt` next to every export.
 */
export function buildSubtitleSidecar(
	document: AxcutDocument | null | undefined,
	settings: CaptionSettings,
	translations: CaptionTranslations,
	format: SubtitleSidecarFormat,
): string | null {
	if (!document) return null;
	const cues = projectCuesToOutputTime(
		deriveCaptionCues(document, settings, translations),
		document.timeline.clips,
		document.timeline.trimRanges,
		rawSpeedRegions(document),
	);
	if (cues.length === 0) return null;
	return format === "srt" ? cuesToSrt(cues) : cuesToVtt(cues);
}
