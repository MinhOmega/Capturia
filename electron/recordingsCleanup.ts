// Sweeps the recordings directory, once, at startup.
//
// Nothing did before: `RECORDINGS_DIR` only ever grew. Every take a user started
// is still in there — the discarded ones, the ones whose helper died, their
// cursor and marker sidecars, their session manifests, and the repair scratch of
// any that crashed mid-remux. A user who records daily fills a disk in weeks,
// and a full disk is how a recording dies (see `src/lib/recordingDiskSpace.ts`).
//
// The decisions are all in `src/lib/recordingsCleanupPolicy.ts`, which is pure.
// This file does two things that need a filesystem: work out which recordings a
// saved project still needs, and delete.
//
// THE ONE RULE THAT MATTERS: if the protected set cannot be computed in full,
// nothing is deleted. A partial answer is worse than no cleanup, because it
// looks like a successful run while removing exactly the media whose project
// could not be read.
//
// Node-pure, like `cursorSidecar.ts`: no `electron` import, both directories are
// injected. Importing `RECORDINGS_DIR` from `main.ts` would drag the Electron
// runtime into the tests, and `handlers.ts` already documents the TDZ trap that
// circular import creates.

import fs from "node:fs/promises";
import path from "node:path";
import {
	createRecordingCleanupPolicy,
	planRecordingCleanup,
	type RecordingArtifactEntry,
	type RecordingCleanupPolicy,
	recordingGroupKeyFromFileName,
} from "../src/lib/recordingsCleanupPolicy";

export type RecordingsCleanupOptions = {
	recordingsDir: string;
	/** `<userData>`: holds `projects/`, which says which recordings are still needed. */
	userDataDir: string;
	/**
	 * Recordings that are not in a project YET — the take being recorded right
	 * now, and the one parked in the hand-off slot waiting for the editor to open.
	 */
	excludePaths?: string[];
	reason: "startup" | "post-recording";
	policy?: Partial<RecordingCleanupPolicy>;
};

type ProtectedMediaScan =
	| { ok: true; fileNames: Set<string>; projectCount: number }
	/** Something the scan needed could not be read; the caller must not delete. */
	| { ok: false; reason: string };

/** Written by `DocumentService`; `.axcut` is the pre-rename spelling it still opens. */
const PROJECT_FILE_EXTENSIONS = [".openscreen", ".axcut"];

// Projects are the ONLY protection source, deliberately. `media-links.registry.json`
// looks like a second one, but `registerRecordingMediaLinks` writes an entry for
// every recording ever made — reading it as "still referenced" would protect the
// whole directory and make this a no-op. A recording nobody kept is exactly what
// this is here to remove.

/** Every media path an AxcutDocument can point at. */
function mediaPathsInProject(raw: unknown): string[] {
	const assets = (raw as { assets?: unknown })?.assets;
	if (!Array.isArray(assets)) return [];

	const paths: string[] = [];
	for (const asset of assets) {
		if (!asset || typeof asset !== "object") continue;
		const candidate = asset as {
			originalPath?: unknown;
			proxyPath?: unknown;
			waveformPath?: unknown;
			cameraTrack?: { sourcePath?: unknown } | null;
		};
		for (const value of [
			candidate.originalPath,
			candidate.proxyPath,
			candidate.waveformPath,
			candidate.cameraTrack?.sourcePath,
		]) {
			if (typeof value === "string" && value.length > 0) paths.push(value);
		}
	}
	return paths;
}

/**
 * Every recording inside `recordingsDir` that a saved project still references.
 *
 * Paths go through `realpath` before being compared, so a symlinked recordings
 * directory (or a symlinked recording) still matches the file on disk. A name is
 * protected whether or not the file is still there: a project pointing at a path
 * in this directory keeps that name reserved.
 *
 * Any project file that cannot be read or parsed aborts the WHOLE scan — see the
 * rule at the top of this file.
 */
async function collectProtectedRecordingNames(options: {
	recordingsDir: string;
	userDataDir: string;
}): Promise<ProtectedMediaScan> {
	const projectsDir = path.join(options.userDataDir, "projects");

	let projectFiles: string[] = [];
	try {
		projectFiles = (await fs.readdir(projectsDir)).filter((name) =>
			PROJECT_FILE_EXTENSIONS.some((extension) => name.endsWith(extension)),
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			return { ok: false, reason: `projects dir unreadable: ${String(error)}` };
		}
	}

	const referencedPaths = new Set<string>();
	for (const fileName of projectFiles) {
		try {
			const raw = JSON.parse(await fs.readFile(path.join(projectsDir, fileName), "utf-8"));
			for (const mediaPath of mediaPathsInProject(raw)) referencedPaths.add(mediaPath);
		} catch (error) {
			return { ok: false, reason: `project unreadable (${fileName}): ${String(error)}` };
		}
	}

	let realRecordingsDir: string;
	try {
		realRecordingsDir = await fs.realpath(options.recordingsDir);
	} catch (error) {
		return { ok: false, reason: `recordings dir unresolvable: ${String(error)}` };
	}

	const fileNames = new Set<string>();
	for (const referenced of referencedPaths) {
		let resolved = path.resolve(referenced);
		try {
			resolved = await fs.realpath(resolved);
		} catch {
			// Missing or unresolvable: fall back to the lexical path.
		}
		if (path.dirname(resolved) !== realRecordingsDir) continue;
		fileNames.add(path.basename(resolved));
	}

	return { ok: true, fileNames, projectCount: projectFiles.length };
}

async function readRecordingEntries(recordingsDir: string): Promise<RecordingArtifactEntry[]> {
	const dirEntries = await fs.readdir(recordingsDir, { withFileTypes: true });
	const stats = await Promise.all(
		dirEntries
			.filter((entry) => entry.isFile())
			.map(async (entry) => {
				try {
					const stat = await fs.stat(path.join(recordingsDir, entry.name));
					return { name: entry.name, size: stat.size, mtimeMs: stat.mtimeMs };
				} catch {
					return null;
				}
			}),
	);

	return stats.filter((item): item is RecordingArtifactEntry => Boolean(item));
}

/** One cleanup pass, awaited. */
export async function runRecordingsCleanup(options: RecordingsCleanupOptions): Promise<void> {
	const normalizedDir = path.resolve(options.recordingsDir);
	const protectedMedia = await collectProtectedRecordingNames({
		recordingsDir: normalizedDir,
		userDataDir: options.userDataDir,
	});
	if (!protectedMedia.ok) {
		console.warn(
			`[recordings-cleanup] skipped reason=${options.reason}: cannot tell which ` +
				`recordings a project still needs (${protectedMedia.reason})`,
		);
		return;
	}

	const entries = await readRecordingEntries(normalizedDir);
	const plan = planRecordingCleanup(entries, {
		policy: createRecordingCleanupPolicy(options.policy),
		protectedFileNames: protectedMedia.fileNames,
	});
	if (plan.filesToDelete.length === 0) return;

	const excludedGroupKeys = new Set(
		(options.excludePaths ?? [])
			.map((filePath) => recordingGroupKeyFromFileName(path.basename(filePath)))
			.filter((key): key is string => Boolean(key)),
	);

	const sizeByName = new Map(entries.map((entry) => [entry.name, entry.size]));
	let deletedCount = 0;
	let deletedBytes = 0;
	for (const fileName of plan.filesToDelete) {
		const groupKey = recordingGroupKeyFromFileName(fileName);
		if (groupKey && excludedGroupKeys.has(groupKey)) continue;
		// The plan only ever names basenames; anything else means the plan (or the
		// directory listing behind it) is not what this believes it is.
		if (path.basename(fileName) !== fileName) continue;

		try {
			await fs.rm(path.join(normalizedDir, fileName), { force: true });
			deletedCount += 1;
			deletedBytes += sizeByName.get(fileName) ?? 0;
		} catch (error) {
			console.warn("[recordings-cleanup] failed to remove", fileName, error);
		}
	}

	if (deletedCount > 0) {
		const freedMb = (deletedBytes / (1024 * 1024)).toFixed(1);
		console.info(
			`[recordings-cleanup] reason=${options.reason} deleted=${deletedCount} freed=${freedMb}MB ` +
				`managedGroups=${plan.managedGroupCount} protected=${protectedMedia.fileNames.size} ` +
				`projects=${protectedMedia.projectCount}`,
		);
	}
}

/** Fire-and-forget form. A cleanup failure must never take the app down with it. */
export function scheduleRecordingsCleanup(options: RecordingsCleanupOptions): void {
	void runRecordingsCleanup(options).catch((error) => {
		console.warn("[recordings-cleanup] run failed:", error);
	});
}
