import type { ZoomFocus } from "@/components/video-editor/types";
import { clamp } from "@/utils/math";

interface ViewportRatio {
	widthRatio: number;
	heightRatio: number;
}

export function getFocusBoundsForScale(zoomScale: number, viewportRatio?: ViewportRatio) {
	const wr = viewportRatio?.widthRatio ?? 1;
	const hr = viewportRatio?.heightRatio ?? 1;
	const marginX = Math.min(0.5, wr / (2 * zoomScale));
	const marginY = Math.min(0.5, hr / (2 * zoomScale));

	return {
		minX: marginX,
		maxX: 1 - marginX,
		minY: marginY,
		maxY: 1 - marginY,
	};
}

export function clampFocusToScale(
	focus: ZoomFocus,
	zoomScale: number,
	viewportRatio?: ViewportRatio,
): ZoomFocus {
	const baseFocus = {
		cx: clamp(focus.cx, 0, 1),
		cy: clamp(focus.cy, 0, 1),
	};
	const bounds = getFocusBoundsForScale(zoomScale, viewportRatio);

	return {
		cx: clamp(baseFocus.cx, bounds.minX, bounds.maxX),
		cy: clamp(baseFocus.cy, bounds.minY, bounds.maxY),
	};
}
