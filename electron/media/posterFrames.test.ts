// @vitest-environment node
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
	userData: "",
	spawn: vi.fn(),
}));

vi.mock("electron", () => ({ app: { getPath: () => hoisted.userData } }));
vi.mock("node:child_process", () => ({ spawn: hoisted.spawn }));
vi.mock("./audioPeaks", async (importOriginal) => ({
	...(await importOriginal<typeof import("./audioPeaks")>()),
	resolveFfmpeg: () => "/fake/ffmpeg",
}));

import { getPosterFrame } from "./posterFrames";

/** Stands in for ffmpeg: writes one "JPEG" to stdout and exits 0. */
function fakeFfmpeg(bytes: string) {
	const child = Object.assign(new EventEmitter(), {
		stdout: new EventEmitter(),
		stderr: new EventEmitter(),
		kill: vi.fn(),
	});
	setImmediate(() => {
		child.stdout.emit("data", Buffer.from(bytes));
		child.emit("close", 0);
	});
	return child;
}

describe("getPosterFrame cache", () => {
	const root = mkdtempSync(path.join(tmpdir(), "capturia-posters-"));
	const video = path.join(root, "clip.mp4");

	beforeEach(() => {
		hoisted.userData = path.join(root, "userData");
		hoisted.spawn.mockReset();
	});

	afterAll(() => rmSync(root, { recursive: true, force: true }));

	it("serves the cached poster until the file's size or mtime changes", async () => {
		writeFileSync(video, "first encode");
		hoisted.spawn.mockImplementation(() => fakeFfmpeg("poster-1"));
		const first = await getPosterFrame(video, 1);
		expect(first).toBe(`data:image/jpeg;base64,${Buffer.from("poster-1").toString("base64")}`);

		// Unchanged file: straight from disk, no decode.
		expect(await getPosterFrame(video, 1)).toBe(first);
		expect(hoisted.spawn).toHaveBeenCalledTimes(1);

		// Same size, new mtime — a file replaced in place must not keep the old poster.
		writeFileSync(video, "second encod");
		utimesSync(video, new Date(), new Date(Date.now() + 5_000));
		hoisted.spawn.mockImplementation(() => fakeFfmpeg("poster-2"));
		const second = await getPosterFrame(video, 1);
		expect(second).toBe(`data:image/jpeg;base64,${Buffer.from("poster-2").toString("base64")}`);
		expect(hoisted.spawn).toHaveBeenCalledTimes(2);

		// A different size invalidates it too.
		writeFileSync(video, "a longer third encode");
		hoisted.spawn.mockImplementation(() => fakeFfmpeg("poster-3"));
		expect(await getPosterFrame(video, 1)).not.toBe(second);
		expect(hoisted.spawn).toHaveBeenCalledTimes(3);
	});
});
