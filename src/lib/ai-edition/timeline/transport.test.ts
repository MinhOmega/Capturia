import { beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULT_SEEK_STEP,
	loadSeekStep,
	PREVIEW_RATES,
	saveSeekStep,
	seekStepSec,
	stepPreviewRate,
} from "./transport";

// An in-memory stand-in rather than `// @vitest-environment jsdom`: booting a
// jsdom costs this suite ~9.5s per file (see vitest.config.ts) and the only browser API
// under test here is a string-keyed store.
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

describe("seek step", () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it("keeps the frame step the arrow keys always had", () => {
		expect(seekStepSec("frame")).toBeCloseTo(1 / 60, 10);
		expect(seekStepSec("frame", 30)).toBeCloseTo(1 / 30, 10);
		// A nonsense frame rate must not produce Infinity or a negative step.
		expect(seekStepSec("frame", 0)).toBeCloseTo(1 / 60, 10);
	});

	it("gives the coarser steps their whole seconds", () => {
		expect(seekStepSec("second")).toBe(1);
		expect(seekStepSec("fiveSeconds")).toBe(5);
	});

	it("round-trips through storage and falls back on anything unrecognised", () => {
		expect(loadSeekStep()).toBe(DEFAULT_SEEK_STEP);
		saveSeekStep("second");
		expect(loadSeekStep()).toBe("second");
		localStorage.setItem("os-editor-seek-step", "parsec");
		expect(loadSeekStep()).toBe(DEFAULT_SEEK_STEP);
	});
});

describe("stepPreviewRate", () => {
	it("walks the table one notch at a time and stops at both ends", () => {
		expect(stepPreviewRate(1, 1)).toBe(1.5);
		expect(stepPreviewRate(1, -1)).toBe(0.5);
		expect(stepPreviewRate(PREVIEW_RATES[0], -1)).toBe(PREVIEW_RATES[0]);
		expect(stepPreviewRate(PREVIEW_RATES[PREVIEW_RATES.length - 1], 1)).toBe(
			PREVIEW_RATES[PREVIEW_RATES.length - 1],
		);
	});

	it("recovers from a rate that is not in the table", () => {
		// 1.7 is nearest 1.5, so it resolves there first: one notch up is 2, one down is 1.
		expect(stepPreviewRate(1.7, 1)).toBe(2);
		expect(stepPreviewRate(1.7, -1)).toBe(1);
	});
});
