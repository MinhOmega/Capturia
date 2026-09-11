import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

function readSettings(userData: string): Record<string, unknown> {
	try {
		const value: unknown = JSON.parse(
			readFileSync(path.join(userData, "recording-settings.json"), "utf8"),
		);
		return value !== null && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

/** Sets one key, keeping every other one. Throws on a failed write, so no caller reports a
 *  preference that will not survive a restart. */
function writeSetting(userData: string, key: string, value: unknown): void {
	const destination = path.join(userData, "recording-settings.json");
	const temporary = `${destination}.${process.pid}.tmp`;
	try {
		writeFileSync(
			temporary,
			`${JSON.stringify({ ...readSettings(userData), [key]: value })}\n`,
			"utf8",
		);
		renameSync(temporary, destination);
	} finally {
		rmSync(temporary, { force: true });
	}
}

/** Default on for new users; a saved false must survive an app restart. */
export function loadAutoZoomEnabled(userData: string): boolean {
	const value = readSettings(userData).autoZoomEnabled;
	return typeof value === "boolean" ? value : true;
}

/** Save only this durable preference; device selection remains session-only. */
export function saveAutoZoomEnabled(userData: string, enabled: boolean): void {
	if (typeof enabled !== "boolean") throw new TypeError("autoZoomEnabled must be a boolean");
	writeSetting(userData, "autoZoomEnabled", enabled);
}

/** Settings → "Save recordings to" as saved, or null for the default folder. Unvalidated:
 *  every use goes through `validRecordingsFolder` (recordingsFolder.ts). */
export function loadRecordingsFolder(userData: string): string | null {
	const value = readSettings(userData).recordingsFolder;
	return typeof value === "string" ? value : null;
}

export function saveRecordingsFolder(userData: string, folder: string | null): void {
	writeSetting(userData, "recordingsFolder", folder);
}
