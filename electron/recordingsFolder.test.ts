import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	isPathWithinRecordingRoots,
	takeOutputPath,
	validRecordingsFolder,
} from "./recordingsFolder";

// Lets a test stand in for a folder whose permission bits say "writable" while creating a
// file there still fails — what a read-only share or `C:\Program Files` looks like on Windows.
const fsFaults = vi.hoisted(() => ({ refuseCreate: false }));
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		openSync: (...args: Parameters<typeof actual.openSync>) => {
			if (fsFaults.refuseCreate) {
				throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
			}
			return actual.openSync(...args);
		},
	};
});

const temps: string[] = [];

afterEach(() => {
	fsFaults.refuseCreate = false;
	for (const dir of temps) rmSync(dir, { recursive: true, force: true });
	temps.length = 0;
});

/** `<tmp>/default`, `<tmp>/chosen` and `<tmp>/outside`, all real directories. */
function roots() {
	const base = mkdtempSync(path.join(os.tmpdir(), "capturia-recordings-folder-"));
	temps.push(base);
	const dirs = {
		base,
		defaultDir: path.join(base, "default"),
		chosen: path.join(base, "chosen"),
		outside: path.join(base, "outside"),
	};
	for (const dir of [dirs.defaultDir, dirs.chosen, dirs.outside]) mkdirSync(dir);
	return dirs;
}

// Links need a privilege on Windows that CI and most dev machines do not hold.
const itWithSymlinks = it.skipIf(process.platform === "win32");

describe("isPathWithinRecordingRoots", () => {
	it("allows the default folder exactly as before, whatever the file is called", () => {
		const { defaultDir, chosen } = roots();
		expect(
			isPathWithinRecordingRoots(path.join(defaultDir, "recording-1.webm"), defaultDir, null),
		).toBe(true);
		expect(
			isPathWithinRecordingRoots(path.join(defaultDir, "voiceover-x.webm"), defaultDir, chosen),
		).toBe(true);
	});

	it("allows the chosen folder for Capturia's own files, existing or about to be written", () => {
		const { defaultDir, chosen } = roots();
		writeFileSync(path.join(chosen, "recording-1.mp4"), "");
		expect(
			isPathWithinRecordingRoots(path.join(chosen, "recording-1.mp4"), defaultDir, chosen),
		).toBe(true);
		expect(
			isPathWithinRecordingRoots(path.join(chosen, "recording-2-webcam.webm"), defaultDir, chosen),
		).toBe(true);
		expect(
			isPathWithinRecordingRoots(path.join(chosen, "recording-1.session.json"), defaultDir, chosen),
		).toBe(true);
		expect(
			isPathWithinRecordingRoots(
				path.join(chosen, "recording-1.mp4.cursor.json"),
				defaultDir,
				chosen,
			),
		).toBe(true);
	});

	it("refuses the user's own files in the chosen folder", () => {
		const { defaultDir, chosen } = roots();
		writeFileSync(path.join(chosen, "holiday.mp4"), "");
		expect(isPathWithinRecordingRoots(path.join(chosen, "holiday.mp4"), defaultDir, chosen)).toBe(
			false,
		);
		expect(
			isPathWithinRecordingRoots(path.join(chosen, "notes.session.json"), defaultDir, chosen),
		).toBe(false);
		expect(isPathWithinRecordingRoots(chosen, defaultDir, chosen)).toBe(false);
	});

	it("refuses the chosen folder once it is no longer the chosen one", () => {
		const { defaultDir, chosen } = roots();
		expect(isPathWithinRecordingRoots(path.join(chosen, "recording-1.mp4"), defaultDir, null)).toBe(
			false,
		);
	});

	it("rejects `..` traversal and sibling prefixes out of either root", () => {
		const { defaultDir, chosen, outside, base } = roots();
		for (const root of [defaultDir, chosen]) {
			expect(
				isPathWithinRecordingRoots(
					path.join(root, "..", "outside", "recording-1.mp4"),
					defaultDir,
					chosen,
				),
			).toBe(false);
			expect(
				isPathWithinRecordingRoots(
					`${root}${path.sep}..${path.sep}recording-1.mp4`,
					defaultDir,
					chosen,
				),
			).toBe(false);
		}
		mkdirSync(`${chosen}-evil`);
		expect(
			isPathWithinRecordingRoots(
				path.join(`${chosen}-evil`, "recording-1.mp4"),
				defaultDir,
				chosen,
			),
		).toBe(false);
		expect(
			isPathWithinRecordingRoots(path.join(outside, "recording-1.mp4"), defaultDir, chosen),
		).toBe(false);
		expect(isPathWithinRecordingRoots(path.join(base, "recording-1.mp4"), defaultDir, chosen)).toBe(
			false,
		);
	});

	itWithSymlinks("rejects a symlink in the chosen folder that points out of it", () => {
		const { defaultDir, chosen, outside } = roots();
		writeFileSync(path.join(outside, "recording-1.mp4"), "");
		symlinkSync(outside, path.join(chosen, "escape"), "dir");
		symlinkSync(path.join(outside, "recording-1.mp4"), path.join(chosen, "recording-2.mp4"));
		symlinkSync(path.join(outside, "missing.mp4"), path.join(chosen, "recording-3.mp4"));

		// Through a linked directory, a linked file, and a dangling link that a write would follow.
		expect(
			isPathWithinRecordingRoots(
				path.join(chosen, "escape", "recording-1.mp4"),
				defaultDir,
				chosen,
			),
		).toBe(false);
		expect(
			isPathWithinRecordingRoots(
				path.join(chosen, "escape", "recording-9.mp4"),
				defaultDir,
				chosen,
			),
		).toBe(false);
		expect(
			isPathWithinRecordingRoots(path.join(chosen, "recording-2.mp4"), defaultDir, chosen),
		).toBe(false);
		expect(
			isPathWithinRecordingRoots(path.join(chosen, "recording-3.mp4"), defaultDir, chosen),
		).toBe(false);
	});

	itWithSymlinks("still allows a chosen folder that is itself reached through a link", () => {
		const { defaultDir, chosen, base } = roots();
		const linked = path.join(base, "linked-chosen");
		symlinkSync(chosen, linked, "dir");
		writeFileSync(path.join(chosen, "recording-1.mp4"), "");
		expect(
			isPathWithinRecordingRoots(path.join(linked, "recording-1.mp4"), defaultDir, linked),
		).toBe(true);
	});
});

describe("validRecordingsFolder", () => {
	it("accepts an existing absolute directory and nothing else", () => {
		const { chosen, base } = roots();
		const file = path.join(base, "file.txt");
		writeFileSync(file, "");
		expect(validRecordingsFolder(chosen)).toBe(chosen);
		expect(validRecordingsFolder(null)).toBeNull();
		expect(validRecordingsFolder("relative/folder")).toBeNull();
		expect(validRecordingsFolder(path.join(base, "unplugged"))).toBeNull();
		expect(validRecordingsFolder(file)).toBeNull();
	});

	// root ignores the permission bits, so the check cannot fail there.
	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"refuses a folder it can no longer write to only when asked about writing",
		() => {
			const { chosen } = roots();
			chmodSync(chosen, 0o500);
			try {
				expect(validRecordingsFolder(chosen)).toBe(chosen);
				expect(validRecordingsFolder(chosen, { writable: true })).toBeNull();
			} finally {
				chmodSync(chosen, 0o700);
			}
		},
	);

	it("decides writability by creating a file, not by permission bits, and leaves nothing behind", () => {
		const { chosen } = roots();
		writeFileSync(path.join(chosen, "holiday.mp4"), "");
		expect(validRecordingsFolder(chosen, { writable: true })).toBe(chosen);
		expect(readdirSync(chosen)).toEqual(["holiday.mp4"]);

		fsFaults.refuseCreate = true;
		expect(validRecordingsFolder(chosen)).toBe(chosen);
		expect(validRecordingsFolder(chosen, { writable: true })).toBeNull();
	});
});

describe("takeOutputPath", () => {
	it("places a take-named file in the take folder", () => {
		const { defaultDir, chosen } = roots();
		expect(takeOutputPath("recording-5.webm", chosen, defaultDir, chosen)).toBe(
			path.join(chosen, "recording-5.webm"),
		);
		expect(takeOutputPath("recording-5-webcam.webm", defaultDir, defaultDir, null)).toBe(
			path.join(defaultDir, "recording-5-webcam.webm"),
		);
	});

	it("refuses paths, traversal and names Capturia does not write", () => {
		const { defaultDir, chosen } = roots();
		for (const name of ["../recording-5.mp4", "sub/recording-5.mp4", "", "holiday.mp4"]) {
			expect(() => takeOutputPath(name, chosen, defaultDir, chosen)).toThrow();
		}
		expect(() =>
			takeOutputPath(path.join(chosen, "recording-5.mp4"), chosen, defaultDir, chosen),
		).toThrow();
	});

	itWithSymlinks("refuses a take name in the chosen folder that links out of it", () => {
		const { defaultDir, chosen, outside } = roots();
		const victim = path.join(outside, "other-tool.mp4");
		writeFileSync(victim, "keep me");
		symlinkSync(victim, path.join(chosen, "recording-5.mp4"));
		symlinkSync(path.join(outside, "missing.mp4"), path.join(chosen, "recording-6.mp4"));

		expect(() => takeOutputPath("recording-5.mp4", chosen, defaultDir, chosen)).toThrow(
			"outside the recordings folder",
		);
		expect(() => takeOutputPath("recording-6.mp4", chosen, defaultDir, chosen)).toThrow(
			"outside the recordings folder",
		);
		expect(readFileSync(victim, "utf8")).toBe("keep me");
	});
});
