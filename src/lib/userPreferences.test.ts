import { beforeEach, describe, expect, it } from "vitest";
import { loadUserPreferences, saveUserPreferences } from "./userPreferences";

describe("user preferences", () => {
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
