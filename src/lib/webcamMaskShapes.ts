import type { WebcamMaskShape } from "@/components/video-editor/types";

/**
 * Returns a CSS clip-path value for the given shape, or null if borderRadius alone suffices.
 */
export function getCssClipPath(shape: WebcamMaskShape): string | null {
	switch (shape) {
		case "circle":
			return "circle(50% at 50% 50%)";
		case "rectangle":
		case "rounded":
		case "square":
		default:
			return null;
	}
}
