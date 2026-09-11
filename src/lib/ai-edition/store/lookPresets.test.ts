import { afterEach, describe, expect, it } from "vitest";
import { getCaptionSettings } from "../captions/settings";
import { type AxcutDocument, createEmptyDocument } from "../schema";
import { getEditorSettings, patchEditorSettings } from "./editorSettings";
import { applyLook, loadLookPresets, lookFromDocument } from "./lookPresets";

// In-memory stand-in, as in `transport.test.ts`: a string-keyed store is the only browser
// API the loader touches, and a jsdom costs seconds per file.
const store = new Map<string, string>();
globalThis.localStorage = {
	getItem: (key: string) => store.get(key) ?? null,
	setItem: (key: string, value: string) => void store.set(key, value),
	removeItem: (key: string) => void store.delete(key),
	clear: () => store.clear(),
	key: (index: number) => [...store.keys()][index] ?? null,
	get length() {
		return store.size;
	},
} satisfies Storage;

const empty = createEmptyDocument({ projectId: "p1", title: "Test" });

/** A project with content in every place a look must not reach. */
const target: AxcutDocument = {
	...empty,
	timeline: {
		...empty.timeline,
		trimRanges: [{ id: "t1", assetId: "a1", startSec: 1, endSec: 2, reason: "", origin: "user" }],
	},
	zoomRanges: [{ id: "z1", startMs: 0, endMs: 1000, depth: 2, focus: { cx: 0.3, cy: 0.7 } }],
	legacyEditor: {
		cropRegion: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 },
		speedRegions: [{ id: "s1", startMs: 0, endMs: 500, speed: 2 }],
		webcamCropRegion: { x: 0, y: 0, width: 0.5, height: 0.5 },
		audioGainDb: -6,
		padding: 10,
		captions: { enabled: true, language: "fr", fontSize: 30 },
	},
};

afterEach(() => localStorage.clear());

describe("applyLook", () => {
	it("changes appearance and leaves regions, trims, zooms and crop untouched", () => {
		const source = patchEditorSettings(empty, {
			padding: 80,
			borderRadius: 12,
			wallpaper: "#123456",
			aspectRatio: "9:16",
			cursor: { size: 5, theme: "default" },
		});
		const look = lookFromDocument(
			{ ...source, legacyEditor: { ...source.legacyEditor, captions: { fontSize: 90 } } },
			false,
		);

		const next = applyLook(target, look);
		const settings = getEditorSettings(next);
		expect(settings.padding).toBe(80);
		expect(settings.borderRadius).toBe(12);
		expect(settings.wallpaper).toBe("#123456");
		expect(settings.cursor.size).toBe(5);
		expect(getCaptionSettings(next).fontSize).toBe(90);

		// Untouched by construction: the same objects, not merely equal ones.
		expect(next.timeline).toBe(target.timeline);
		expect(next.zoomRanges).toBe(target.zoomRanges);
		const before = target.legacyEditor as Record<string, unknown>;
		const after = next.legacyEditor as Record<string, unknown>;
		for (const key of ["cropRegion", "speedRegions", "webcamCropRegion", "audioGainDb"]) {
			expect(after[key]).toBe(before[key]);
		}
		// The opt-in was off, so the canvas keeps its shape; captions stay on, in French.
		expect(settings.aspectRatio).toBe("16:9");
		expect(getCaptionSettings(next).enabled).toBe(true);
		expect(getCaptionSettings(next).language).toBe("fr");
	});

	it("loads a hand-edited preset clamped, and ignores fields it does not know", () => {
		localStorage.setItem(
			"capturia_look_presets",
			JSON.stringify({
				presets: [
					{
						id: "l1",
						name: " Mine ",
						settings: { padding: 5000, borderRadius: -3, cropRegion: { x: 0.9 }, futureField: 1 },
						captions: { fontSize: 9999 },
					},
					{ id: "broken" },
				],
				defaultId: "l1",
			}),
		);
		const { presets, defaultId } = loadLookPresets();
		expect(presets).toHaveLength(1);
		expect(defaultId).toBe("l1");
		const [preset] = presets;
		expect(preset.name).toBe("Mine");
		expect(preset.settings.padding).toBe(100);
		expect(preset.settings.borderRadius).toBe(0);
		expect(preset.settings).not.toHaveProperty("cropRegion");
		expect(preset.settings).not.toHaveProperty("futureField");
		expect(preset.settings).not.toHaveProperty("aspectRatio");
		expect(preset.captions?.fontSize).toBe(200);
	});
});
