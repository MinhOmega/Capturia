import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import { cacheKey, resolveFfmpeg } from "./audioPeaks";

/**
 * Poster frames for the project list and the media cards: one small JPEG per
 * file, grabbed by ffmpeg in the main process and cached on disk beside the
 * waveform peaks.
 *
 * ffmpeg rather than a DOM `<video>` because the project list has to show
 * posters for projects that are not open, so the work belongs in main anyway;
 * and ffmpeg opens every container the importer accepts (.mkv, .avi, .wmv)
 * where Chromium plays only some of them. Same binary, same cache key as
 * `audioPeaks.ts`.
 */

const POSTER_WIDTH = 320;

/** A single-frame grab that has not finished by now is a wedged ffmpeg. */
const GRAB_TIMEOUT_MS = 15_000;

function posterCacheDir(): string | null {
	try {
		return typeof app?.getPath === "function"
			? path.join(app.getPath("userData"), "posters")
			: null;
	} catch {
		return null;
	}
}

function grabFrame(ffmpeg: string, filePath: string, atSec: number): Promise<Buffer> {
	const child = spawn(
		ffmpeg,
		[
			"-hide_banner",
			"-loglevel",
			"error",
			// Before `-i`: an input seek jumps to the nearest keyframe instead of
			// decoding everything up to `atSec`.
			"-ss",
			String(Math.max(0, atSec)),
			"-i",
			// Pinned to the file protocol, so a path that happens to read as a URL
			// (`http://…`, `concat:…`) from a project file is never fetched.
			`file:${filePath}`,
			"-frames:v",
			"1",
			"-vf",
			`scale=${POSTER_WIDTH}:-2`,
			"-f",
			"image2pipe",
			"-c:v",
			"mjpeg",
			"-q:v",
			"5",
			"-",
		],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);
	return new Promise<Buffer>((resolve, reject) => {
		const chunks: Buffer[] = [];
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`ffmpeg timed out grabbing a poster from ${filePath}`));
		}, GRAB_TIMEOUT_MS);
		child.stdout.on("data", (c: Buffer) => chunks.push(c));
		child.stderr.on("data", (c: Buffer) => {
			stderr = (stderr + c.toString()).slice(-2048);
		});
		child.once("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			const jpeg = Buffer.concat(chunks);
			// An audio-only file, or a seek past the end, exits 0 with nothing written.
			if (code !== 0 || jpeg.length === 0) {
				reject(
					new Error(`ffmpeg produced no poster (${code})${stderr ? `: ${stderr.trim()}` : ""}`),
				);
				return;
			}
			resolve(jpeg);
		});
	});
}

function toDataUrl(jpeg: Buffer): string {
	return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
}

// ponytail: one ffmpeg at a time. The first open of a long project list asks
// for every poster at once, and N parallel decodes would compete with the
// editor for CPU; they trickle in instead and are cached for good. A small pool
// if that first open ever feels slow.
let lane: Promise<unknown> = Promise.resolve();

/**
 * A `data:` URL of a frame near `atSec`, or null when there is no ffmpeg or the
 * file cannot be decoded (the caller keeps its placeholder).
 *
 * One poster per source file: named `<path hash>-<path + size + mtime hash>`, so
 * a re-encoded or replaced file gets a fresh poster, and writing it deletes the
 * file's older entries. `atSec` only picks the frame on a miss and is not part
 * of the key — keyed on it, every trim of a project's first clip, or any time a
 * renderer cared to ask for, left one more JPEG behind for good.
 */
export async function getPosterFrame(filePath: string, atSec = 0): Promise<string | null> {
	const ffmpeg = resolveFfmpeg();
	if (!ffmpeg) return null;

	const fileId = createHash("sha1").update(filePath).digest("hex").slice(0, 16);
	// Throws for a missing file, which the IPC handler turns into a placeholder.
	const name = `${fileId}-${await cacheKey(filePath)}.jpg`;
	const dir = posterCacheDir();
	const cachePath = dir ? path.join(dir, name) : null;
	const readCached = async () =>
		cachePath ? await readFile(cachePath).then(toDataUrl, () => null) : null;

	const cached = await readCached();
	if (cached) return cached;

	const task = lane.then(async () => {
		// A request queued behind an identical one finds its result here.
		const late = await readCached();
		if (late) return late;
		const at = Math.max(0, Math.round(atSec));
		// A seek past the end writes no frame, so a file shorter than `at` gets
		// its first one instead — clamping without having to probe the duration.
		const jpeg = await grabFrame(ffmpeg, filePath, at).catch((error: unknown) =>
			at > 0 ? grabFrame(ffmpeg, filePath, 0) : Promise.reject(error),
		);
		if (cachePath && dir) {
			try {
				await mkdir(dir, { recursive: true });
				// Through a temp name, so a crash mid-write never leaves a torn JPEG
				// that the next launch would serve as the poster.
				await writeFile(`${cachePath}.tmp`, jpeg);
				await rename(`${cachePath}.tmp`, cachePath);
				// Safe to sweep here: the lane means no other write is in flight.
				for (const entry of await readdir(dir)) {
					if (entry.startsWith(`${fileId}-`) && entry !== name) {
						await rm(path.join(dir, entry), { force: true });
					}
				}
			} catch {
				// A cache we cannot write means regenerating next time, not a failure.
			}
		}
		return toDataUrl(jpeg);
	});
	lane = task.catch(() => undefined);
	return task;
}
