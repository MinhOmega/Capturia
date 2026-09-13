import { beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULT_PREFS,
	getProjectFolder,
	loadUserPreferences,
	parentDirectoryOf,
	saveUserPreferences,
} from "./userPreferences";

describe("parentDirectoryOf", () => {
	it("returns the directory for a POSIX path", () => {
		expect(parentDirectoryOf("/Users/me/Movies/clip.mp4")).toBe("/Users/me/Movies");
	});

	it("returns the directory for a Windows path", () => {
		expect(parentDirectoryOf("C:\\Users\\me\\Movies\\clip.mp4")).toBe("C:\\Users\\me\\Movies");
	});

	it("preserves the POSIX root when the file is at /", () => {
		expect(parentDirectoryOf("/video.mp4")).toBe("/");
	});

	it("preserves the Windows drive root with its trailing separator", () => {
		expect(parentDirectoryOf("C:\\video.mp4")).toBe("C:\\");
		expect(parentDirectoryOf("D:/video.mp4")).toBe("D:/");
	});

	it("returns null when no separator is present", () => {
		expect(parentDirectoryOf("video.mp4")).toBeNull();
		expect(parentDirectoryOf("")).toBeNull();
	});
});

describe("projectFolder preference", () => {
	// jsdom's localStorage isn't exposed as a global in this vitest setup, so
	// stub it with an in-memory shim before each test. Mirrors what the real
	// browser localStorage exposes, scoped to the keys we touch.
	beforeEach(() => {
		const store = new Map<string, string>();
		const stub = {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => {
				store.set(key, String(value));
			},
			removeItem: (key: string) => {
				store.delete(key);
			},
			clear: () => store.clear(),
			key: (i: number) => Array.from(store.keys())[i] ?? null,
			get length() {
				return store.size;
			},
		};
		Object.defineProperty(globalThis, "localStorage", {
			value: stub,
			configurable: true,
		});
	});

	it("defaults to null when nothing is persisted", () => {
		expect(loadUserPreferences().projectFolder).toBeNull();
		expect(getProjectFolder()).toBeUndefined();
	});

	it("round-trips a saved project folder", () => {
		saveUserPreferences({ projectFolder: "/Users/me/Projects/demos" });
		expect(loadUserPreferences().projectFolder).toBe("/Users/me/Projects/demos");
		expect(getProjectFolder()).toBe("/Users/me/Projects/demos");
	});

	it("ignores non-string persisted values and falls back to the default", () => {
		localStorage.setItem("openscreen_user_preferences", JSON.stringify({ projectFolder: 42 }));
		expect(loadUserPreferences().projectFolder).toBe(DEFAULT_PREFS.projectFolder);
	});

	it("ignores empty-string persisted values and falls back to the default", () => {
		localStorage.setItem("openscreen_user_preferences", JSON.stringify({ projectFolder: "" }));
		expect(loadUserPreferences().projectFolder).toBe(DEFAULT_PREFS.projectFolder);
	});

	it("is independent of exportFolder", () => {
		saveUserPreferences({ exportFolder: "/Users/me/Downloads" });
		saveUserPreferences({ projectFolder: "/Users/me/Projects/demos" });
		const prefs = loadUserPreferences();
		expect(prefs.exportFolder).toBe("/Users/me/Downloads");
		expect(prefs.projectFolder).toBe("/Users/me/Projects/demos");
	});
});

describe("user preferences", () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it("persists the tray layout preference", () => {
		saveUserPreferences({ trayLayout: "vertical" });

		expect(loadUserPreferences().trayLayout).toBe("vertical");
	});

	it("falls back to the default tray layout for invalid stored values", () => {
		localStorage.setItem("openscreen_user_preferences", JSON.stringify({ trayLayout: "diagonal" }));

		expect(loadUserPreferences().trayLayout).toBe("horizontal");
	});

	it("persists the software encoder preference", () => {
		saveUserPreferences({ preferSoftwareEncoder: true });

		expect(loadUserPreferences().preferSoftwareEncoder).toBe(true);
	});

	it("falls back to the default software encoder preference for invalid stored values", () => {
		localStorage.setItem(
			"openscreen_user_preferences",
			JSON.stringify({ preferSoftwareEncoder: "yes" }),
		);

		expect(loadUserPreferences().preferSoftwareEncoder).toBe(false);
	});

	it("persists the software encoder fallback notice suppression", () => {
		saveUserPreferences({ hideSoftwareEncoderFallbackNotice: true });

		expect(loadUserPreferences().hideSoftwareEncoderFallbackNotice).toBe(true);
	});

	it("falls back to showing the software encoder fallback notice for invalid stored values", () => {
		localStorage.setItem(
			"openscreen_user_preferences",
			JSON.stringify({ hideSoftwareEncoderFallbackNotice: "yes" }),
		);

		expect(loadUserPreferences().hideSoftwareEncoderFallbackNotice).toBe(false);
	});
});

describe("remembered export settings", () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it("round-trips frame rate, codec, ratios and GIF options", () => {
		saveUserPreferences({
			exportFps: 24,
			exportCodec: "h265",
			exportRatios: ["9:16", "1:1"],
			exportGif: { frameRate: 30, size: "large", loop: false, dither: true },
		});

		const prefs = loadUserPreferences();
		expect(prefs.exportFps).toBe(24);
		expect(prefs.exportCodec).toBe("h265");
		expect(prefs.exportRatios).toEqual(["9:16", "1:1"]);
		expect(prefs.exportGif).toEqual({
			frameRate: 30,
			size: "large",
			loop: false,
			dither: true,
		});
	});

	it("gives prefs written by an older build the new defaults", () => {
		localStorage.setItem("openscreen_user_preferences", JSON.stringify({ exportFormat: "gif" }));

		const prefs = loadUserPreferences();
		expect(prefs.exportFormat).toBe("gif");
		expect(prefs.exportFps).toBe(DEFAULT_PREFS.exportFps);
		expect(prefs.exportCodec).toBe(DEFAULT_PREFS.exportCodec);
		expect(prefs.exportRatios).toBe(DEFAULT_PREFS.exportRatios);
		expect(prefs.exportGif).toEqual(DEFAULT_PREFS.exportGif);
	});

	it("rejects stored values the exporter would refuse", () => {
		localStorage.setItem(
			"openscreen_user_preferences",
			JSON.stringify({
				exportFps: 120,
				// Valid in the `ExportVideoCodec` type, rejected by the native pipeline.
				exportCodec: "vp9",
				exportRatios: ["16:9", "not-a-ratio", 7],
				exportGif: { frameRate: 7, size: "gigantic", loop: "yes", dither: true },
			}),
		);

		const prefs = loadUserPreferences();
		expect(prefs.exportFps).toBe(DEFAULT_PREFS.exportFps);
		expect(prefs.exportCodec).toBe("h264");
		expect(prefs.exportRatios).toEqual(["16:9"]);
		// Only the bad fields fall back; `dither` survives.
		expect(prefs.exportGif).toEqual({ ...DEFAULT_PREFS.exportGif, dither: true });
	});
});
