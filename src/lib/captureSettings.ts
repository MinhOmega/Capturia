/**
 * What the user gets to decide about capture itself: how many frames a second,
 * and how large they may be.
 *
 * Both exist because the encoder is not always fast enough for the display it
 * is pointed at. A 2560x1440@60 take on a machine where every hardware encoder
 * was refused fell back to software openh264 at 13.6 ms/frame against a 16.7 ms
 * budget and dropped 4792 of 11390 frames — 42%. Halving the frame rate doubles
 * the budget to 33.3 ms; capping the long edge to 1080p cuts the pixels per
 * frame by 44%. Either one alone clears that overload, which is why they are two
 * controls rather than one "quality" profile: the user knows whether they would
 * rather give up motion or detail.
 */

export type CaptureFrameRate = 24 | 30 | 60 | 120;
export type CaptureResolutionPreset = "auto" | "1080p" | "1440p" | "2160p";

/** Selectable frame rates, in the order the picker shows them. */
export const CAPTURE_FRAME_RATES: readonly CaptureFrameRate[] = [24, 30, 60, 120];

/** Selectable resolution caps, in the order the picker shows them. */
export const CAPTURE_RESOLUTION_PRESETS: readonly CaptureResolutionPreset[] = [
	"auto",
	"1080p",
	"1440p",
	"2160p",
];

/**
 * The long edge each preset caps to, or null for "whatever the display gives".
 *
 * The LONG edge rather than a width: a portrait monitor, a rotated display and a
 * single tall window all have to cap to something sensible, and only the longer
 * dimension answers that for all three.
 */
const LONG_EDGE_BY_PRESET: Record<CaptureResolutionPreset, number | null> = {
	auto: null,
	"1080p": 1920,
	"1440p": 2560,
	"2160p": 3840,
};

export function isCaptureFrameRate(value: unknown): value is CaptureFrameRate {
	return CAPTURE_FRAME_RATES.includes(value as CaptureFrameRate);
}

export function isCaptureResolutionPreset(value: unknown): value is CaptureResolutionPreset {
	return CAPTURE_RESOLUTION_PRESETS.includes(value as CaptureResolutionPreset);
}

/** The preset's long-edge ceiling, or null when the capture size is left alone. */
export function captureLongEdge(preset: CaptureResolutionPreset): number | null {
	return LONG_EDGE_BY_PRESET[preset];
}

/**
 * Shrinks a capture size to the preset's ceiling, keeping the aspect ratio.
 *
 * Returns the input untouched when it already fits — including for `auto`, which
 * is what keeps every platform's existing behaviour bit-for-bit when the user
 * has not chosen a cap. Both dimensions come back even: H.264 chroma is
 * subsampled 2x2, so an odd width or height is either rejected outright or
 * silently rounded by the encoder.
 */
export function capCaptureSize(
	width: number,
	height: number,
	preset: CaptureResolutionPreset,
): { width: number; height: number } {
	const longEdge = captureLongEdge(preset);
	const current = Math.max(width, height);
	if (longEdge === null || current <= longEdge || current <= 0) {
		return { width, height };
	}
	const scale = longEdge / current;
	return { width: toEven(width * scale), height: toEven(height * scale) };
}

/** Nearest even number, never below 2 — the smallest size an H.264 plane can have. */
function toEven(value: number): number {
	return Math.max(2, Math.round(value / 2) * 2);
}
