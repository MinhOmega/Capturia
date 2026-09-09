// The `<videoPath>.markers.json` sidecar: moments the user flagged while
// recording, in the recorded file's own clock.
//
// Node-pure for the same reason `cursorSidecar.ts` is: no `electron` import and
// no `app.getPath`, so a test (or anything that is not an IPC handler) can read
// and write one without dragging the Electron runtime in.
//
// Times are SOURCE milliseconds — measured from the first captured frame, with
// paused stretches already collapsed out. The renderer supplies them, because it
// is the side that already keeps that clock (`getRecordingDurationMs`, which is
// accumulated-minus-paused); main would otherwise need a second copy of the
// pause bookkeeping per platform. This module only stores and returns them.
// Turning a source ms into a timeline position is the editor's job
// (`src/lib/ai-edition/timeline/recordingMarkers.ts`).
//
// ponytail: adjacency only, no fingerprint fallback. `cursorSidecar` can follow
// a moved recording because the registry records its telemetry path; adding a
// second field there buys markers the same trick and can wait until someone
// moves a recording out from under a project and misses them.

import fs from "node:fs/promises";

export const RECORDING_MARKERS_VERSION = 1;

/**
 * A flagged moment is one keystroke. This is a ceiling on a runaway shortcut,
 * not a budget anyone should ever meet.
 */
export const MAX_RECORDING_MARKERS = 500;

export interface RecordingMarkersFile {
	version: number;
	/** Source milliseconds into the recording, ascending, unique. */
	markers: number[];
}

export function markersPathFor(videoPath: string): string {
	return `${videoPath}.markers.json`;
}

/**
 * Whole-millisecond, ascending, unique, capped.
 *
 * Rounded before deduplication so two flags in the same millisecond collapse to
 * one tick rather than two the editor draws on top of each other. Anything that
 * is not a usable time is dropped: a marker whose position cannot be trusted is
 * worse than no marker, because it sends the user to the wrong frame.
 */
export function sanitizeRecordingMarkers(input: unknown): number[] {
	if (!Array.isArray(input)) return [];
	const seen = new Set<number>();
	for (const value of input) {
		const ms = Number(value);
		if (!Number.isFinite(ms) || ms < 0) continue;
		seen.add(Math.round(ms));
		if (seen.size >= MAX_RECORDING_MARKERS) break;
	}
	return [...seen].sort((a, b) => a - b);
}

/**
 * Writes the sidecar, or removes it when there is nothing to record.
 *
 * An empty list deletes rather than writing `[]` so a re-recorded take cannot
 * inherit a stale file, and so "no sidecar" keeps meaning exactly one thing.
 */
export async function writeRecordingMarkers(videoPath: string, input: unknown): Promise<number> {
	const markers = sanitizeRecordingMarkers(input);
	const target = markersPathFor(videoPath);
	if (markers.length === 0) {
		await fs.rm(target, { force: true });
		return 0;
	}

	const payload: RecordingMarkersFile = { version: RECORDING_MARKERS_VERSION, markers };
	await fs.writeFile(target, JSON.stringify(payload), "utf-8");
	return markers.length;
}

/**
 * The markers beside a recording, or an empty list.
 *
 * Never throws: a missing sidecar is the normal case, and a malformed one must
 * read as "nothing flagged" rather than taking the editor down on load.
 */
export async function readRecordingMarkers(videoPath: string): Promise<number[]> {
	try {
		const raw = await fs.readFile(markersPathFor(videoPath), "utf-8");
		const parsed = JSON.parse(raw) as Partial<RecordingMarkersFile>;
		return sanitizeRecordingMarkers(parsed?.markers);
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
			console.warn("[recording-markers] unreadable sidecar for", videoPath, error);
		}
		return [];
	}
}
