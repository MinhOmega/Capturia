// Integrated loudness of a recording, measured in the main process with the
// bundled ffmpeg — the number the Audio pane's "Auto-level" button turns into an
// output gain.
//
// Same shape as `audioPeaks.ts`: the renderer cannot spawn ffmpeg (it is
// sandboxed, deliberately), so the decode happens here and only the result
// crosses. It streams like `stt/extractAudio.ts` — `-f null -` means ffmpeg
// decodes the track and writes nothing, so the cost is CPU time and no memory on
// either side.
//
// ponytail: no disk cache, unlike peaks. Peaks are recomputed on every project
// open; this runs once, on a click, and the resulting gain is persisted in the
// document. Cache it only if something starts measuring automatically.

import { spawn } from "node:child_process";
import { resolveFfmpeg } from "./audioPeaks";

/** IPC reply. `lufs: null` on success means "no native ffmpeg here" — the pane
 *  hides the button rather than offering one that cannot work. */
export interface AudioLoudnessResult {
	success: boolean;
	lufs?: number | null;
	message?: string;
}

/** A wedged ffmpeg, not a recording. Matches the peaks/extraction paths. */
const MEASURE_TIMEOUT_MS = 60_000;

/**
 * Integrated loudness from ffmpeg's `ebur128` summary.
 *
 * The filter prints a running `I:` on every progress line and one final one under
 * `Summary:`, so the LAST match is the integrated value for the whole file. A
 * silent track reports `I: -inf LUFS`, which this deliberately does not match:
 * there is no gain that makes silence −16 LUFS.
 */
export function parseIntegratedLufs(stderr: string): number | null {
	const matches = stderr.match(/I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/g);
	if (!matches?.length) return null;
	const last = /(-?\d+(?:\.\d+)?)/.exec(matches[matches.length - 1]);
	const value = last ? Number(last[1]) : Number.NaN;
	return Number.isFinite(value) ? value : null;
}

/**
 * Integrated loudness of `filePath` in LUFS, or null when there is no ffmpeg to
 * measure with. Rejects when ffmpeg ran and found nothing to measure — a file
 * with no audio track, or a silent one — because that is a verdict the caller
 * has to report, not a gap it can fall back from.
 */
export async function measureAudioLoudness(filePath: string): Promise<number | null> {
	const ffmpeg = resolveFfmpeg();
	if (!ffmpeg) return null;

	const child = spawn(
		ffmpeg,
		[
			"-hide_banner",
			"-nostats",
			// `file:` pins the protocol: a path containing a colon ("C:\…", or a name
			// with one) would otherwise be read as a protocol specifier.
			"-i",
			`file:${filePath}`,
			"-vn",
			"-af",
			"ebur128",
			"-f",
			"null",
			"-",
		],
		{ stdio: ["ignore", "ignore", "pipe"] },
	);

	return new Promise<number>((resolve, reject) => {
		// The summary is the last thing ffmpeg writes, so a tail is all that is needed
		// and a long file cannot grow this without bound.
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`ffmpeg timed out after ${MEASURE_TIMEOUT_MS}ms on ${filePath}`));
		}, MEASURE_TIMEOUT_MS);

		child.stderr.on("data", (chunk: Buffer) => {
			stderr = (stderr + chunk.toString()).slice(-8192);
		});
		child.once("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			if (code !== 0) {
				reject(new Error(`ffmpeg exited ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
				return;
			}
			const lufs = parseIntegratedLufs(stderr);
			if (lufs === null) {
				reject(new Error(`No integrated loudness in ffmpeg's output for ${filePath}`));
				return;
			}
			resolve(lufs);
		});
	});
}
