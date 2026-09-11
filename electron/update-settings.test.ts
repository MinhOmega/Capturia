import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseUpdateMode } from "./background-update";
import {
	loadIncludePrereleases,
	loadUpdateMode,
	saveIncludePrereleases,
	saveUpdateMode,
	updateSettingsPath,
} from "./update-settings";

const temps: string[] = [];

afterEach(() => {
	for (const dir of temps) rmSync(dir, { recursive: true, force: true });
	temps.length = 0;
});

function tmp(): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), "os-update-settings-"));
	temps.push(dir);
	return dir;
}

describe("update settings", () => {
	it("round-trips a saved mode through load", () => {
		const dir = tmp();
		saveUpdateMode(dir, "download-and-install");
		expect(loadUpdateMode(dir)).toBe("download-and-install");
	});

	it("defaults to notify when nothing was ever saved", () => {
		expect(loadUpdateMode(tmp())).toBe("notify");
	});

	it("falls back to notify on a corrupt settings file instead of throwing", () => {
		const dir = tmp();
		writeFileSync(updateSettingsPath(dir), '{"mode": not-even-json !!}');
		expect(loadUpdateMode(dir)).toBe("notify");
	});

	it("keeps pre-release builds off unless they were turned on", () => {
		const dir = tmp();
		expect(loadIncludePrereleases(dir)).toBe(false);
		writeFileSync(updateSettingsPath(dir), '{"prereleases": "yes"}');
		expect(loadIncludePrereleases(dir)).toBe(false);
		saveIncludePrereleases(dir, true);
		expect(loadIncludePrereleases(dir)).toBe(true);
	});

	it("saves each setting without dropping the other", () => {
		const dir = tmp();
		saveIncludePrereleases(dir, true);
		saveUpdateMode(dir, "download");
		expect(loadIncludePrereleases(dir)).toBe(true);
		saveIncludePrereleases(dir, false);
		expect(loadUpdateMode(dir)).toBe("download");
		expect(loadIncludePrereleases(dir)).toBe(false);
	});

	it("refuses garbage mode values rather than trusting the file", () => {
		for (const garbage of ["install-silently", "", 42, null, { mode: "download" }]) {
			expect(parseUpdateMode(garbage)).toBe("notify");
		}
		expect(parseUpdateMode("download")).toBe("download");
	});
});
