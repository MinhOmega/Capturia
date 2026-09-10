import { describe, expect, it } from "vitest";
import { capCaptureSize, captureLongEdge } from "./captureSettings";

describe("capCaptureSize", () => {
	it("leaves a size alone on auto", () => {
		expect(capCaptureSize(3840, 2160, "auto")).toEqual({ width: 3840, height: 2160 });
	});

	it("leaves a size alone when it already fits the cap", () => {
		expect(capCaptureSize(1280, 720, "1080p")).toEqual({ width: 1280, height: 720 });
	});

	it("caps the long edge and keeps the aspect ratio", () => {
		expect(capCaptureSize(3840, 2160, "1080p")).toEqual({ width: 1920, height: 1080 });
		expect(capCaptureSize(3840, 2160, "1440p")).toEqual({ width: 2560, height: 1440 });
	});

	it("caps the long edge of a portrait size, not its width", () => {
		expect(capCaptureSize(1440, 2560, "1080p")).toEqual({ width: 1080, height: 1920 });
	});

	it("returns even dimensions, which H.264 chroma subsampling requires", () => {
		// 21:9 at 3440x1440 scaled to a 1920 long edge is 803.7 tall.
		const { width, height } = capCaptureSize(3440, 1440, "1080p");
		expect(width % 2).toBe(0);
		expect(height % 2).toBe(0);
		expect({ width, height }).toEqual({ width: 1920, height: 804 });
	});

	it("has no ceiling for auto and one per preset", () => {
		expect(captureLongEdge("auto")).toBeNull();
		expect(captureLongEdge("2160p")).toBe(3840);
	});
});
