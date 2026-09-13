import { describe, expect, it } from "vitest";
import { normalizeBlurColor } from "./blurEffects";

describe("blur color helpers", () => {
	it("normalizes invalid blur colors to white", () => {
		expect(normalizeBlurColor("black")).toBe("black");
		expect(normalizeBlurColor("invalid")).toBe("white");
	});
});
