// What a "paste attributes" is allowed to carry, per kind.
//
// The picker is an ALLOW-list, so the interesting assertions are the absences: a field
// that describes where a region SITS must stay with the target, or pasting a look onto a
// pill would teleport it. Each kind below pins one of those.

import { describe, expect, it } from "vitest";
import { pickPasteableAttributes, type RegionSnapshot } from "./regionClipboard";

/** The fields every clip-anchored region carries, none of which is an attribute. */
const placement = {
	id: "src_1",
	startMs: 1000,
	endMs: 3000,
	clipId: "clip_a",
	sourceStartSec: 1,
	sourceEndSec: 3,
};

describe("pickPasteableAttributes", () => {
	it("takes a zoom's look and leaves its placement behind", () => {
		const attrs = pickPasteableAttributes({
			kind: "zoom",
			region: {
				...placement,
				depth: 5,
				focus: { cx: 0.2, cy: 0.8 },
				focusMode: "auto",
				rotationPreset: "iso",
			},
		});

		expect(attrs).toEqual({
			depth: 5,
			focus: { cx: 0.2, cy: 0.8 },
			focusMode: "auto",
			rotationPreset: "iso",
		});
	});

	it("omits a zoom field the source never had rather than clearing the target's", () => {
		// Writing `rotationPreset: undefined` onto a tilted target would flatten it — a
		// paste that REMOVES a property nobody copied.
		const attrs = pickPasteableAttributes({
			kind: "zoom",
			region: { ...placement, depth: 2, focus: { cx: 0.5, cy: 0.5 } },
		});

		expect(attrs).toEqual({ depth: 2, focus: { cx: 0.5, cy: 0.5 } });
		expect("rotationPreset" in attrs).toBe(false);
		expect("focusMode" in attrs).toBe(false);
	});

	it("takes an annotation's payload, style and size but never its position", () => {
		const attrs = pickPasteableAttributes({
			kind: "annotation",
			region: {
				...placement,
				type: "text",
				content: "Hello",
				// Parking slots, filled by a past type conversion. Carrying them would
				// overwrite what the TARGET parked.
				textContent: "Hello",
				imageContent: "data:image/png;base64,AAA",
				position: { x: 10, y: 90 },
				size: { width: 40, height: 25 },
				style: { color: "#ff0000", fontSize: 48 },
				zIndex: 7,
				blurData: { mode: "mosaic", blockSize: 12 },
			},
		});

		expect(attrs).toEqual({
			type: "text",
			content: "Hello",
			size: { width: 40, height: 25 },
			style: { color: "#ff0000", fontSize: 48 },
			blurData: { mode: "mosaic", blockSize: 12 },
		});
		expect("position" in attrs).toBe(false);
		expect("textContent" in attrs).toBe(false);
		expect("imageContent" in attrs).toBe(false);
		expect("zIndex" in attrs).toBe(false);
	});

	it("takes a speed region's speed and nothing else", () => {
		expect(
			pickPasteableAttributes({ kind: "speed", region: { ...placement, speed: 2.5 } }),
		).toEqual({ speed: 2.5 });
	});

	it("takes an audio track's mix but never its asset", () => {
		const attrs = pickPasteableAttributes({
			kind: "audio",
			region: {
				...placement,
				trackId: "track_1",
				assetId: "asset_music",
				kind: "music",
				durationSec: 120,
				offsetMs: 500,
				gainDb: -6,
				fadeInMs: 250,
				fadeOutMs: 400,
				loop: true,
				muted: false,
				label: "Bed",
				origin: "user",
			},
		});

		expect(attrs).toEqual({
			gainDb: -6,
			fadeInMs: 250,
			fadeOutMs: 400,
			loop: true,
			muted: false,
			label: "Bed",
		});
		// The clipboard outlives the project: an imposed asset reference is a pill that
		// plays nothing.
		expect("assetId" in attrs).toBe(false);
		expect("offsetMs" in attrs).toBe(false);
	});

	it("finds nothing on the two kinds that are only a span", () => {
		// Which is what hides the menu entry — one question, one answer, instead of a
		// kind list repeated at every call site.
		expect(pickPasteableAttributes({ kind: "trim", region: { durationSec: 2 } })).toEqual({});
		expect(
			pickPasteableAttributes({
				kind: "cameraFullscreen",
				region: { ...placement },
			} as RegionSnapshot),
		).toEqual({});
	});
});
