import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseUpdateMode, type UpdateMode } from "./background-update";

export function updateSettingsPath(userData: string): string {
	return path.join(userData, "update-settings.json");
}

function readSettings(userData: string): { mode?: unknown; prereleases?: unknown } {
	const file = updateSettingsPath(userData);
	if (!existsSync(file)) return {};
	try {
		return (
			(JSON.parse(readFileSync(file, "utf8")) as { mode?: unknown; prereleases?: unknown }) ?? {}
		);
	} catch {
		return {};
	}
}

/** Both settings share one file, so each save carries the other one over unchanged. */
function writeSettings(userData: string, next: { mode?: UpdateMode; prereleases?: boolean }): void {
	const settings = {
		mode: loadUpdateMode(userData),
		prereleases: loadIncludePrereleases(userData),
		...next,
	};
	try {
		writeFileSync(updateSettingsPath(userData), `${JSON.stringify(settings)}\n`, "utf8");
	} catch {
		// Best-effort; a failed write must not block the tray click.
	}
}

export function loadUpdateMode(userData: string): UpdateMode {
	return parseUpdateMode(readSettings(userData).mode);
}

export function saveUpdateMode(userData: string, mode: UpdateMode): void {
	writeSettings(userData, { mode });
}

/** Settings → "Get pre-release builds". Off unless the file says exactly `true`. */
export function loadIncludePrereleases(userData: string): boolean {
	return readSettings(userData).prereleases === true;
}

export function saveIncludePrereleases(userData: string, prereleases: boolean): void {
	writeSettings(userData, { prereleases });
}
