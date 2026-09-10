/**
 * The status/action decision table, pinned per platform.
 *
 * Why Input Monitoring is not a key here, though the old tree listed it:
 * nothing in this app asks for it. The only event tap the app creates is in
 * `electron/native/screencapturekit/Sources/OpenScreenMacOSCursorHelper/main.swift`,
 * and it is `.listenOnly` over `leftMouseDown | leftMouseUp` — mouse events
 * only, which TCC gates under Accessibility, and which is exactly the
 * permission `macNativeCursorRecordingSession.ts:140` checks. Global shortcuts
 * go through Electron's `globalShortcut` (Carbon hotkeys, no TCC service), and
 * `electron-builder.json5` declares no `NSInputMonitoringUsageDescription`.
 * Electron also exposes no query for it, so the row could only ever have read
 * "unknown" — a permanently unactionable line about a permission the app does
 * not use.
 */

import { describe, expect, it } from "vitest";
import { settingsPaneUrl } from "../windowPermissions";
import {
	buildCapturePermissions,
	type CapturePermissionProbe,
	capturePermissionAction,
	capturePermissionKeys,
	PERMISSION_SETTINGS_TARGETS,
} from "./capturePermissions";

function probe(
	media: Partial<Record<"screen" | "camera" | "microphone", string>>,
	accessibilityTrusted = false,
): CapturePermissionProbe {
	return {
		mediaAccessStatus: (kind) => media[kind] ?? "unknown",
		accessibilityTrusted: () => accessibilityTrusted,
	};
}

describe("capturePermissionKeys", () => {
	it("lists only what the platform can be asked about", () => {
		expect(capturePermissionKeys("darwin")).toEqual([
			"screen",
			"camera",
			"microphone",
			"accessibility",
		]);
		// Windows gates camera and microphone; it has no screen-capture consent
		// and no accessibility trust, so those are absent rather than "unknown".
		expect(capturePermissionKeys("win32")).toEqual(["camera", "microphone"]);
		// Linux consent belongs to the portal, asked at capture time.
		expect(capturePermissionKeys("linux")).toEqual([]);
	});

	it("gives every listed key a settings pane on its own platform", () => {
		for (const platform of ["darwin", "win32"] as const) {
			for (const key of capturePermissionKeys(platform)) {
				expect(settingsPaneUrl(PERMISSION_SETTINGS_TARGETS[key], platform)).toBeTruthy();
			}
		}
	});
});

describe("capturePermissionAction", () => {
	it("only offers a request where the OS will still prompt", () => {
		expect(capturePermissionAction("granted")).toBe("granted");
		expect(capturePermissionAction("not-determined")).toBe("request");
		expect(capturePermissionAction("denied")).toBe("open-settings");
		expect(capturePermissionAction("restricted")).toBe("open-settings");
		// The whole point: an unreadable status sends the user to Settings. It
		// must never resolve to "granted" or to a dead button.
		expect(capturePermissionAction("unknown")).toBe("open-settings");
	});
});

describe("buildCapturePermissions", () => {
	it("reports what the probe said, and marks screen as the blocking one", () => {
		const rows = buildCapturePermissions(
			probe({ screen: "granted", camera: "not-determined", microphone: "denied" }, true),
			"darwin",
		);
		expect(rows).toEqual([
			{ key: "screen", status: "granted", requiredForRecording: true, action: "granted" },
			{ key: "camera", status: "not-determined", requiredForRecording: false, action: "request" },
			{
				key: "microphone",
				status: "denied",
				requiredForRecording: false,
				action: "open-settings",
			},
			{
				key: "accessibility",
				status: "granted",
				requiredForRecording: false,
				action: "granted",
			},
		]);
	});

	it("reads untrusted accessibility as denied, never as unknown", () => {
		const [row] = buildCapturePermissions(probe({}, false), "darwin").filter(
			(each) => each.key === "accessibility",
		);
		expect(row).toMatchObject({ status: "denied", action: "open-settings" });
	});

	it("never turns an unreported or throwing status into a grant", () => {
		const throwing: CapturePermissionProbe = {
			mediaAccessStatus: () => {
				throw new Error("unsupported on this platform");
			},
			accessibilityTrusted: () => false,
		};
		for (const row of buildCapturePermissions(throwing, "darwin")) {
			expect(row.action).toBe("open-settings");
		}
		// A status string outside the documented set is also not a grant.
		const [camera] = buildCapturePermissions(probe({ camera: "yes-probably" }), "win32");
		expect(camera).toMatchObject({ status: "unknown", action: "open-settings" });
	});

	it("renders nothing on Linux", () => {
		expect(buildCapturePermissions(probe({ screen: "granted" }), "linux")).toEqual([]);
	});
});
