import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	MAX_RECORDING_MARKERS,
	readRecordingMarkers,
	sanitizeRecordingMarkers,
	writeRecordingMarkers,
} from "./recordingMarkers";

describe("sanitizeRecordingMarkers", () => {
	it("rounds, deduplicates and orders", () => {
		expect(sanitizeRecordingMarkers([900.4, 100, 400.6, 100.2])).toEqual([100, 401, 900]);
	});

	it("drops anything whose position cannot be trusted", () => {
		expect(sanitizeRecordingMarkers([Number.NaN, -1, Number.POSITIVE_INFINITY, "x", null])).toEqual(
			[],
		);
		expect(sanitizeRecordingMarkers("not an array")).toEqual([]);
		expect(sanitizeRecordingMarkers(undefined)).toEqual([]);
	});

	it("rejects rather than coerces the values that look like zero", () => {
		// `Number()` turns every one of these into 0, which is a valid-looking flag
		// on the recording's first frame invented out of corrupt input. This is a
		// hand-editable file on disk, so the strict check is the whole guard.
		expect(sanitizeRecordingMarkers([null, "", [], false, "0", "500"])).toEqual([]);
		// And a real zero still means the very start of the take.
		expect(sanitizeRecordingMarkers([0])).toEqual([0]);
	});

	it("caps a runaway shortcut", () => {
		const many = Array.from({ length: MAX_RECORDING_MARKERS + 50 }, (_, i) => i);
		expect(sanitizeRecordingMarkers(many)).toHaveLength(MAX_RECORDING_MARKERS);
	});
});

describe("the markers sidecar", () => {
	let dir: string;
	let video: string;

	beforeEach(async () => {
		dir = await mkdtemp(path.join(os.tmpdir(), "openscreen-markers-"));
		video = path.join(dir, "recording-1.mp4");
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("round-trips through the file", async () => {
		await writeRecordingMarkers(video, [2_500, 10.6, 2_500]);
		expect(await readRecordingMarkers(video)).toEqual([11, 2_500]);
	});

	it("reads nothing when there is no sidecar", async () => {
		expect(await readRecordingMarkers(video)).toEqual([]);
	});

	it("removes the file rather than writing an empty one", async () => {
		await writeRecordingMarkers(video, [1_000]);
		await writeRecordingMarkers(video, []);
		// A re-recorded take must not inherit the previous one's flags.
		expect(await readRecordingMarkers(video)).toEqual([]);
	});

	it("reads a malformed sidecar as nothing flagged rather than throwing", async () => {
		await writeFile(`${video}.markers.json`, "{ not json", "utf-8");
		expect(await readRecordingMarkers(video)).toEqual([]);
	});

	it("writes the version so a later format change can tell", async () => {
		await writeRecordingMarkers(video, [1_000]);
		const parsed = JSON.parse(await readFile(`${video}.markers.json`, "utf-8"));
		expect(parsed.version).toBe(1);
	});
});
