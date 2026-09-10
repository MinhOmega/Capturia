// The two preview-transport knobs the keyboard drives: how far an arrow key seeks, and
// how fast the preview plays back.
//
// Both are about REVIEWING the film, not about editing it, which is why neither touches
// the document. A review speed is deliberately not persisted at all (it lives in the
// project store for the session); the seek step is, because "my arrow keys move a second"
// is a habit, not a per-project decision — localStorage, like the editor's other layout
// preferences (see `os-editor-chat-width` in NewEditorShell).
//
// In particular the review speed is NOT a speed region: a speed region is an edit, stored
// on the timeline, exported, and undoable. This one only changes how fast you watch.

/** How far one arrow-key press moves the playhead. */
export const SEEK_STEPS = ["frame", "second", "fiveSeconds"] as const;

export type SeekStep = (typeof SEEK_STEPS)[number];

/** One frame, which is what the arrow keys did before this was configurable. */
export const DEFAULT_SEEK_STEP: SeekStep = "frame";

/** Assumed preview frame rate. The same 1/60 the arrow keys have always stepped by —
 *  named here rather than written out at the one call site so the step table below and
 *  the label the shortcuts dialog shows can never disagree about it. */
export const PREVIEW_FPS = 60;

export function seekStepSec(step: SeekStep, fps: number = PREVIEW_FPS): number {
	switch (step) {
		case "second":
			return 1;
		case "fiveSeconds":
			return 5;
		default:
			return 1 / (fps > 0 ? fps : PREVIEW_FPS);
	}
}

const SEEK_STEP_KEY = "os-editor-seek-step";

function isSeekStep(value: unknown): value is SeekStep {
	return SEEK_STEPS.includes(value as SeekStep);
}

export function loadSeekStep(): SeekStep {
	try {
		const stored = localStorage.getItem(SEEK_STEP_KEY);
		return isSeekStep(stored) ? stored : DEFAULT_SEEK_STEP;
	} catch {
		// A blocked/unavailable localStorage is not a reason to lose the arrow keys.
		return DEFAULT_SEEK_STEP;
	}
}

export function saveSeekStep(step: SeekStep): void {
	try {
		localStorage.setItem(SEEK_STEP_KEY, step);
	} catch {
		// Same: the setting simply does not survive the session.
	}
}

/**
 * The review speeds `[` and `]` step through.
 *
 * Stops at 4×, well under the browser's 16× `playbackRate` ceiling, because a speed
 * REGION multiplies on top of this one and the product is what the preview has to be able
 * to play. Slower than 0.25× is where Chromium mutes the audio, which is the opposite of
 * what someone reviewing a voiceover at half speed is asking for.
 */
export const PREVIEW_RATES = [0.25, 0.5, 1, 1.5, 2, 4] as const;

export const DEFAULT_PREVIEW_RATE = 1;

/** The next review speed one notch in `direction`, clamped at both ends. An unlisted
 *  current rate lands on the nearest listed one, so the pair can never get stuck. */
export function stepPreviewRate(rate: number, direction: -1 | 1): number {
	const nearest = PREVIEW_RATES.reduce((best, candidate) =>
		Math.abs(candidate - rate) < Math.abs(best - rate) ? candidate : best,
	);
	const index = PREVIEW_RATES.indexOf(nearest);
	return PREVIEW_RATES[Math.min(PREVIEW_RATES.length - 1, Math.max(0, index + direction))];
}
