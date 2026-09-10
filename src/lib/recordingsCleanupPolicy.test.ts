import { describe, expect, it } from "vitest";
import {
	planRecordingCleanup,
	type RecordingArtifactEntry,
	type RecordingCleanupPolicy,
	recordingGroupKeyFromFileName,
} from "./recordingsCleanupPolicy";

function entry(name: string, size: number, mtimeMs: number): RecordingArtifactEntry {
	return { name, size, mtimeMs };
}

const policy = (over: Partial<RecordingCleanupPolicy>): RecordingCleanupPolicy => ({
	maxTotalBytes: 420,
	targetTotalBytes: 220,
	maxVideoAgeMs: 1_000_000,
	minKeepVideoGroups: 2,
	orphanSidecarAgeMs: 1_000_000,
	...over,
});

describe("naming", () => {
	it("recognises every artefact one take leaves behind", () => {
		for (const name of [
			"recording-1.mp4",
			"recording-1.webm",
			"recording-1-webcam.mp4",
			"recording-1.mp4.cursor.json",
			"recording-1.mp4.markers.json",
			"recording-1.session.json",
			"recording-1.webm.duration-patch.tmp",
			"recording-1.webm.reindex.tmp",
		]) {
			expect(recordingGroupKeyFromFileName(name), name).toBe("recording-1");
		}
	});

	it("leaves alone anything it cannot name", () => {
		// The registry lives in this directory too, and deleting it would lose the
		// only record of where a moved recording's camera and sidecars went.
		for (const name of [
			"media-links.registry.json",
			"notes.txt",
			"recording.mp4",
			"holiday-recording-1.mp4",
			"recording-1.txt",
		]) {
			expect(recordingGroupKeyFromFileName(name), name).toBeNull();
		}
	});
});

describe("planRecordingCleanup", () => {
	it("trims oldest-first to the target once the cap is exceeded", () => {
		const entries = [1, 2, 3, 4, 5, 6].flatMap((i) => [
			entry(`recording-${i}.mp4`, 100, i * 10),
			entry(`recording-${i}.mp4.cursor.json`, 10, i * 10),
		]);

		const plan = planRecordingCleanup(entries, { nowMs: 1_000, policy: policy({}) });

		expect(plan.filesToDelete).toEqual([
			"recording-1.mp4",
			"recording-1.mp4.cursor.json",
			"recording-2.mp4",
			"recording-2.mp4.cursor.json",
			"recording-3.mp4",
			"recording-3.mp4.cursor.json",
			"recording-4.mp4",
			"recording-4.mp4.cursor.json",
		]);
		expect(plan.managedGroupCount).toBe(6);
	});

	it("deletes a whole take, camera and sidecars with it", () => {
		const entries = [
			entry("recording-1.mp4", 100, 10),
			entry("recording-1-webcam.mp4", 60, 10),
			entry("recording-1.mp4.cursor.json", 10, 10),
			entry("recording-1.mp4.markers.json", 5, 10),
			entry("recording-1.session.json", 1, 10),
			entry("recording-2.mp4", 100, 20),
			entry("recording-3.mp4", 100, 30),
		];

		const plan = planRecordingCleanup(entries, {
			nowMs: 1_000,
			policy: policy({ maxTotalBytes: 200, targetTotalBytes: 200 }),
		});

		// Never a video without its sidecars: that is exactly the orphan the third
		// pass would then have to clean up. Compared as a set — the plan's own order
		// is locale collation, which is not what this test is about.
		expect(new Set(plan.filesToDelete)).toEqual(
			new Set([
				"recording-1.mp4",
				"recording-1-webcam.mp4",
				"recording-1.mp4.cursor.json",
				"recording-1.mp4.markers.json",
				"recording-1.session.json",
			]),
		);
	});

	it("keeps the newest N takes however old or large they are", () => {
		const entries = [
			entry("recording-10.mp4", 120, 100),
			entry("recording-11.mp4", 120, 200),
			entry("recording-12.mp4", 120, 4_300),
			entry("recording-13.mp4", 120, 4_500),
		];

		const plan = planRecordingCleanup(entries, {
			nowMs: 5_000,
			policy: policy({ maxVideoAgeMs: 1_000, minKeepVideoGroups: 2 }),
		});

		expect(plan.filesToDelete).toEqual(["recording-10.mp4", "recording-11.mp4"]);
	});

	it("never touches a take a project still points at", () => {
		const entries = [
			entry("recording-1.mp4", 120, 100),
			entry("recording-1.mp4.cursor.json", 10, 100),
			entry("recording-2.mp4", 120, 200),
			entry("recording-3.mp4", 120, 4_300),
			entry("recording-4.mp4", 120, 4_500),
		];

		const plan = planRecordingCleanup(entries, {
			nowMs: 5_000,
			policy: policy({ maxVideoAgeMs: 1_000, minKeepVideoGroups: 2 }),
			protectedFileNames: ["recording-1.mp4"],
		});

		// A project whose media is gone is not a freed gigabyte, it is lost work —
		// and the sidecar goes with the video it belongs to.
		expect(plan.filesToDelete).toEqual(["recording-2.mp4"]);
	});

	it("collects sidecars and manifests whose recording is long gone", () => {
		const entries = [
			entry("recording-1.mp4.cursor.json", 10, 100),
			entry("recording-1.session.json", 1, 100),
			// Fresh enough that the recording may still be in flight.
			entry("recording-2.mp4.markers.json", 5, 4_900),
		];

		const plan = planRecordingCleanup(entries, {
			nowMs: 5_000,
			policy: policy({ orphanSidecarAgeMs: 1_000 }),
		});

		expect(plan.filesToDelete).toEqual(["recording-1.mp4.cursor.json", "recording-1.session.json"]);
	});

	it("collects repair scratch left beside a video it is keeping", () => {
		// webm-duration and webm-seek-index both write a sibling and rename it over
		// the recording, so one left behind means the process died mid-repair.
		const entries = [
			entry("recording-9.webm", 120, 4_900),
			entry("recording-9.webm.duration-patch.tmp", 40, 100),
			entry("recording-9.webm.reindex.tmp", 40, 4_950),
		];

		const plan = planRecordingCleanup(entries, {
			nowMs: 5_000,
			policy: policy({ orphanSidecarAgeMs: 1_000 }),
		});

		// The stale one goes; the one that could still be an in-flight repair stays.
		expect(plan.filesToDelete).toEqual(["recording-9.webm.duration-patch.tmp"]);
	});

	it("ignores entries whose size or mtime cannot be trusted", () => {
		const entries = [
			entry("recording-1.mp4", Number.NaN, 10),
			entry("recording-2.mp4", 100, Number.NaN),
			entry("", 100, 10),
		];

		const plan = planRecordingCleanup(entries, { nowMs: 1_000, policy: policy({}) });

		expect(plan.filesToDelete).toEqual([]);
		expect(plan.managedGroupCount).toBe(0);
	});
});
