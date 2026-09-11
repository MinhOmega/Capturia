import { describe, expect, it } from "vitest";
import { type AreaRect, areaToCropRegion, toPhysicalArea } from "./recordingArea";

// A 2880x1800 panel at scale factor 2: 1440x900 CSS pixels.
const RETINA = { width: 1440, height: 900 };

describe("record-area maths", () => {
	it("maps CSS pixels to physical pixels at a HiDPI scale factor of 2", () => {
		const area = toPhysicalArea({ x: 100, y: 50, width: 640, height: 360 }, RETINA, 2);
		expect(area).toEqual({ x: 200, y: 100, width: 1280, height: 720 });
		// The crop is the same fraction of the frame the rectangle was of the overlay.
		expect(areaToCropRegion(area as AreaRect, RETINA, 2)).toEqual({
			x: 100 / 1440,
			y: 50 / 900,
			width: 640 / 1440,
			height: 360 / 900,
		});
	});

	it("covers the whole physical frame at a fractional scale factor", () => {
		expect(
			toPhysicalArea({ x: 0, y: 0, width: 1536, height: 864 }, { width: 1536, height: 864 }, 1.25),
		).toEqual({
			x: 0,
			y: 0,
			width: 1920,
			height: 1080,
		});
	});

	it("cuts a rectangle to the display and grows it to the crop minimum inside it", () => {
		// Hangs off the top-left: cut, not shifted.
		expect(toPhysicalArea({ x: -50, y: -20, width: 200, height: 100 }, RETINA, 2)).toEqual({
			x: 0,
			y: 0,
			width: 300,
			height: 160,
		});
		// Hangs off the bottom-right and is left too small: 4% of 2880x1800 is 116x72,
		// pulled back inside the frame.
		expect(toPhysicalArea({ x: 1400, y: 880, width: 200, height: 100 }, RETINA, 2)).toEqual({
			x: 2764,
			y: 1728,
			width: 116,
			height: 72,
		});
	});

	it("refuses anything that is not a finite, positive-size rectangle", () => {
		const ok = { x: 0, y: 0, width: 10, height: 10 };
		expect(toPhysicalArea({ ...ok, x: Number.NaN }, RETINA, 2)).toBeNull();
		expect(toPhysicalArea({ ...ok, width: Number.POSITIVE_INFINITY }, RETINA, 2)).toBeNull();
		expect(toPhysicalArea({ ...ok, width: 0 }, RETINA, 2)).toBeNull();
		expect(toPhysicalArea({ ...ok, height: -5 }, RETINA, 2)).toBeNull();
		expect(toPhysicalArea(ok, RETINA, 0)).toBeNull();
		expect(toPhysicalArea(ok, { width: 0, height: 900 }, 2)).toBeNull();
		// What a hostile renderer could send over IPC.
		expect(toPhysicalArea({ ...ok, x: "1" } as unknown as AreaRect, RETINA, 2)).toBeNull();
	});
});
