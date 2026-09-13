import { describe, expect, it } from "vitest";
import { clampFocus } from "@/components/video-editor/types";
import { clamp, clamp01 } from "./math";

// Two of the 16 private clamps this file replaced guarded non-finite input.
// Folding them in dropped those guards, so this pins the guard down at the
// shared definition and at the caller that relied on it.

describe("clamp", () => {
	it("constrains to [min, max]", () => {
		expect(clamp(5, 0, 1)).toBe(1);
		expect(clamp(-5, 0, 1)).toBe(0);
		expect(clamp(0.4, 0, 1)).toBe(0.4);
		expect(clamp01(2)).toBe(1);
	});

	it("floors non-finite input to min instead of propagating NaN", () => {
		expect(clamp(Number.NaN, 2, 8)).toBe(2);
		expect(clamp(Number.POSITIVE_INFINITY, 2, 8)).toBe(2);
		expect(clamp(Number.NEGATIVE_INFINITY, 2, 8)).toBe(2);
		expect(clamp01(Number.NaN)).toBe(0);
	});
});

describe("callers that depend on the guard", () => {
	it("an unknown zoom focus recentres rather than jumping to the corner", () => {
		expect(clampFocus({ cx: Number.NaN, cy: Number.NaN })).toEqual({ cx: 0.5, cy: 0.5 });
		expect(clampFocus({ cx: 2, cy: -1 })).toEqual({ cx: 1, cy: 0 });
	});
});
