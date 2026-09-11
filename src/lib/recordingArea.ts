// The maths behind "record an area". The area is drawn on an overlay in CSS pixels;
// the crop it becomes lives in the recorded video's pixels. The display is recorded
// whole, at its physical resolution, so the bridge between the two is the display's
// scale factor. Shared by the overlay (what it draws and reads out) and the main
// process (which re-validates whatever the overlay sends), so the two cannot disagree.

import { MIN_CROP_PCT } from "../components/ai-edition/cropDraft";

export interface AreaRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));

function physicalSize(displaySize: { width: number; height: number }, scaleFactor: number) {
	return {
		width: Math.round(displaySize.width * scaleFactor),
		height: Math.round(displaySize.height * scaleFactor),
	};
}

/**
 * A rectangle drawn in CSS pixels (DIP, relative to the display's top-left) as whole
 * physical pixels of that display: cut to the display, then grown to at least the
 * crop dialog's minimum on each side (staying inside the display), so the crop it seeds
 * is one the dialog accepts.
 *
 * Null unless every number is finite and the size is positive: this is what the main
 * process runs on the rectangle an overlay sends over IPC.
 */
export function toPhysicalArea(
	css: AreaRect,
	displaySize: { width: number; height: number },
	scaleFactor: number,
): AreaRect | null {
	const numbers = [
		css.x,
		css.y,
		css.width,
		css.height,
		displaySize.width,
		displaySize.height,
		scaleFactor,
	];
	if (!numbers.every(Number.isFinite) || css.width <= 0 || css.height <= 0 || scaleFactor <= 0) {
		return null;
	}
	const frame = physicalSize(displaySize, scaleFactor);
	if (frame.width <= 0 || frame.height <= 0) return null;

	const axis = (start: number, length: number, frameLength: number) => {
		const from = clamp(Math.round(start * scaleFactor), 0, frameLength);
		const to = clamp(Math.round((start + length) * scaleFactor), 0, frameLength);
		const size = Math.max(to - from, Math.ceil((frameLength * MIN_CROP_PCT) / 100));
		return { at: Math.min(from, frameLength - size), size };
	};
	const x = axis(css.x, css.width, frame.width);
	const y = axis(css.y, css.height, frame.height);
	return { x: x.at, y: y.at, width: x.size, height: y.size };
}

/** A physical area of a display recorded whole, as the clip crop (fractions of the frame). */
export function areaToCropRegion(
	area: AreaRect,
	displaySize: { width: number; height: number },
	scaleFactor: number,
): AreaRect {
	const frame = physicalSize(displaySize, scaleFactor);
	return {
		x: area.x / frame.width,
		y: area.y / frame.height,
		width: area.width / frame.width,
		height: area.height / frame.height,
	};
}
