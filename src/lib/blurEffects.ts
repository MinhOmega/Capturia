import type { BlurColor, BlurType } from "@/components/video-editor/types";

export function normalizeBlurType(value: unknown): BlurType {
	void value;
	return "mosaic";
}

export function normalizeBlurColor(value: unknown): BlurColor {
	return value === "black" ? "black" : "white";
}
