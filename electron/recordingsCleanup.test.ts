// The half of the sweep that needs a filesystem: which recordings a project
// still needs, and the refusal to delete when that cannot be answered in full.
// The ordering rules are `src/lib/recordingsCleanupPolicy.test.ts`.

import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runRecordingsCleanup } from "./recordingsCleanup";

let userDataDir: string;
let recordingsDir: string;

/**
 * A take old enough that every age rule is past it. `daysAgo` staggers them so
 * "the newest take is exempt" has one unambiguous answer.
 */
async function aged(name: string, daysAgo: number, bytes = 1024) {
	const file = path.join(recordingsDir, name);
	await writeFile(file, Buffer.alloc(bytes));
	const when = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
	await utimes(file, when, when);
}

async function project(name: string, mediaPaths: string[]) {
	await writeFile(
		path.join(userDataDir, "projects", name),
		JSON.stringify({ assets: mediaPaths.map((originalPath) => ({ originalPath })) }),
		"utf-8",
	);
}

const sweep = () =>
	runRecordingsCleanup({
		recordingsDir,
		userDataDir,
		reason: "startup",
		// One kept take, so the fixtures below are about references and not about
		// the newest-N exemption.
		policy: { minKeepVideoGroups: 1, maxVideoAgeMs: 1_000 },
	});

const remaining = () => readdir(recordingsDir).then((names) => names.sort());

beforeEach(async () => {
	userDataDir = await mkdtemp(path.join(os.tmpdir(), "openscreen-cleanup-"));
	recordingsDir = path.join(userDataDir, "recordings");
	await mkdir(recordingsDir, { recursive: true });
	await mkdir(path.join(userDataDir, "projects"), { recursive: true });
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
	vi.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(async () => {
	vi.restoreAllMocks();
	await rm(userDataDir, { recursive: true, force: true });
});

describe("runRecordingsCleanup", () => {
	it("keeps a take a project references and removes one nothing does", async () => {
		await aged("recording-1.mp4", 400);
		await aged("recording-1.mp4.cursor.json", 400);
		await aged("recording-2.mp4", 300);
		await aged("recording-3.mp4", 200);
		await project("keep.capturia", [path.join(recordingsDir, "recording-1.mp4")]);

		await sweep();

		// recording-3 survives as the newest kept take; recording-2 is nobody's.
		expect(await remaining()).toEqual([
			"recording-1.mp4",
			"recording-1.mp4.cursor.json",
			"recording-3.mp4",
		]);
	});

	// The extension rename is a DELETION hazard here, not just a naming one: a
	// project this scan cannot see is a project whose takes look unreferenced, and
	// unreferenced takes are exactly what this sweep removes. Every spelling the
	// app still opens has to protect its media.
	for (const legacyName of ["legacy.openscreen", "legacy.axcut"]) {
		it(`reads the pre-rename ${legacyName} projects too`, async () => {
			await aged("recording-1.mp4", 400);
			await aged("recording-2.mp4", 300);
			await aged("recording-3.mp4", 200);
			await project(legacyName, [path.join(recordingsDir, "recording-1.mp4")]);

			await sweep();

			expect(await remaining()).toContain("recording-1.mp4");
		});
	}

	it("deletes NOTHING when a project file cannot be read", async () => {
		await aged("recording-1.mp4", 400);
		await aged("recording-2.mp4", 300);
		await aged("recording-3.mp4", 200);
		await writeFile(path.join(userDataDir, "projects", "broken.capturia"), "{ not json", "utf-8");

		await sweep();

		// A partial protected set is worse than no cleanup: it looks like a
		// successful run while removing exactly the media it could not vouch for.
		expect(await remaining()).toHaveLength(3);
	});

	it("leaves files it does not recognise alone", async () => {
		await aged("media-links.registry.json", 400);
		await aged("someone-elses-notes.txt", 400);
		await aged("recording-1.mp4", 400);
		await aged("recording-2.mp4", 300);

		await sweep();

		expect(await remaining()).toContain("media-links.registry.json");
		expect(await remaining()).toContain("someone-elses-notes.txt");
	});
});
