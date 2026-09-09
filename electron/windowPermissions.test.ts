import { describe, expect, it } from "vitest";
import {
	isPermissionAllowed,
	type OpenScreenWindowType,
	rememberWindowType,
	settingsPaneUrl,
	windowTypeForContents,
	windowTypeFromUrl,
} from "./windowPermissions";

function allowed(
	permission: string,
	windowType: OpenScreenWindowType | null,
	extra: { isMainFrame?: boolean; mediaKinds?: readonly ("screen" | "camera" | "microphone")[] } = {},
): boolean {
	return isPermissionAllowed({
		permission,
		windowType,
		isMainFrame: extra.isMainFrame ?? true,
		mediaKinds: extra.mediaKinds,
	});
}

describe("isPermissionAllowed", () => {
	it("gives the recorder HUD every capture kind", () => {
		for (const permission of [
			"screen",
			"display-capture",
			"camera",
			"videoCapture",
			"microphone",
			"audioCapture",
		]) {
			expect(allowed(permission, "hud-overlay")).toBe(true);
		}
	});

	it("gives the editor the microphone but never the camera or the screen", () => {
		// The editor records voiceover audio layers, so denying the mic here would
		// break AddAudioLayerDialog. Camera and screen are what the guard exists for.
		expect(allowed("microphone", "editor")).toBe(true);
		expect(allowed("audioCapture", "editor")).toBe(true);
		expect(allowed("camera", "editor")).toBe(false);
		expect(allowed("videoCapture", "editor")).toBe(false);
		expect(allowed("screen", "editor")).toBe(false);
		expect(allowed("display-capture", "editor")).toBe(false);
	});

	it("denies every capture kind to windows that only display", () => {
		for (const windowType of [
			"source-selector",
			"countdown-overlay",
			"notes",
			"bench",
		] as const) {
			for (const permission of ["screen", "display-capture", "camera", "microphone"]) {
				expect(allowed(permission, windowType)).toBe(false);
			}
		}
	});

	it("keeps the CLI runners working", () => {
		expect(allowed("screen", "cli-record")).toBe(true);
		expect(allowed("microphone", "cli-record")).toBe(true);
		// The sources runner needs a mic grant before device labels are readable.
		expect(allowed("microphone", "cli-sources")).toBe(true);
		expect(allowed("screen", "cli-sources")).toBe(false);
		expect(allowed("microphone", "cli-export")).toBe(false);
	});

	it("resolves a generic media request against every kind it names", () => {
		expect(allowed("media", "editor", { mediaKinds: ["microphone"] })).toBe(true);
		expect(allowed("media", "editor", { mediaKinds: ["camera"] })).toBe(false);
		// A camera+mic request in the editor fails on the camera half.
		expect(allowed("media", "editor", { mediaKinds: ["microphone", "camera"] })).toBe(false);
		expect(allowed("media", "hud-overlay", { mediaKinds: ["microphone", "camera"] })).toBe(true);
	});

	it("treats a kindless media query as 'could this window capture at all'", () => {
		// navigator.permissions.query() does not always name a kind; answering
		// "denied" there would make the editor's own UI misreport itself.
		expect(allowed("media", "editor")).toBe(true);
		expect(allowed("media", "source-selector")).toBe(false);
	});

	it("denies everything to an unknown window and to subframes", () => {
		expect(allowed("microphone", null)).toBe(false);
		expect(allowed("fullscreen", null)).toBe(false);
		expect(allowed("microphone", "hud-overlay", { isMainFrame: false })).toBe(false);
		expect(allowed("fullscreen", "editor", { isMainFrame: false })).toBe(false);
	});

	it("allows fullscreen in any window the main process built, and nothing else", () => {
		expect(allowed("fullscreen", "editor")).toBe(true);
		expect(allowed("geolocation", "editor")).toBe(false);
		expect(allowed("notifications", "hud-overlay")).toBe(false);
		expect(allowed("clipboard-read", "editor")).toBe(false);
	});
});

describe("windowTypeFromUrl", () => {
	it("reads the type the main process put in the query", () => {
		expect(windowTypeFromUrl("http://localhost:5173/?windowType=editor")).toBe("editor");
		expect(windowTypeFromUrl("file:///app/dist/index.html?windowType=hud-overlay")).toBe(
			"hud-overlay",
		);
		expect(windowTypeFromUrl("http://localhost:5173/?windowType=bench")).toBe("bench");
	});

	it("maps the notes window, which is loaded without a windowType", () => {
		expect(windowTypeFromUrl("http://localhost:5173/?showNotes=true")).toBe("notes");
		expect(windowTypeFromUrl("file:///app/dist/index.html?showNotes=true")).toBe("notes");
	});

	it("refuses a type the main process never builds", () => {
		expect(windowTypeFromUrl("http://localhost:5173/?windowType=attacker")).toBeNull();
		expect(windowTypeFromUrl("http://localhost:5173/")).toBeNull();
		// A declared type wins over showNotes, so nothing can smuggle itself in as notes.
		expect(windowTypeFromUrl("http://localhost:5173/?windowType=nope&showNotes=true")).toBeNull();
		expect(windowTypeFromUrl("devtools://devtools/bundled/devtools_app.html")).toBeNull();
		expect(windowTypeFromUrl("not a url")).toBeNull();
	});
});

describe("rememberWindowType", () => {
	it("records the first commit and ignores later relabelling", () => {
		const contents = {};
		expect(windowTypeForContents(contents)).toBeNull();
		rememberWindowType(contents, "editor");
		rememberWindowType(contents, "hud-overlay");
		expect(windowTypeForContents(contents)).toBe("editor");
	});

	it("returns null for a WebContents the app did not build", () => {
		expect(windowTypeForContents(null)).toBeNull();
		expect(windowTypeForContents(undefined)).toBeNull();
		expect(windowTypeForContents({})).toBeNull();
	});
});

describe("settingsPaneUrl", () => {
	it("deep-links the macOS privacy panes", () => {
		expect(settingsPaneUrl("screen-capture", "darwin")).toBe(
			"x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
		);
		expect(settingsPaneUrl("accessibility", "darwin")).toBe(
			"x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
		);
		expect(settingsPaneUrl("input-monitoring", "darwin")).toBe(
			"x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent",
		);
	});

	it("deep-links what Windows exposes and nothing it does not", () => {
		expect(settingsPaneUrl("microphone", "win32")).toBe("ms-settings:privacy-microphone");
		expect(settingsPaneUrl("camera", "win32")).toBe("ms-settings:privacy-webcam");
		expect(settingsPaneUrl("accessibility", "win32")).toBeNull();
	});

	it("has no deep link on Linux", () => {
		expect(settingsPaneUrl("microphone", "linux")).toBeNull();
		expect(settingsPaneUrl("screen-capture", "linux")).toBeNull();
	});
});
