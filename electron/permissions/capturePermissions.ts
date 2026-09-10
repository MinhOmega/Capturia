/**
 * What the OS will actually tell us about the permissions this app needs.
 *
 * The rule this module exists to enforce: a row never claims `granted` from a
 * weaker signal than a real status query. Where a platform has no such query,
 * the key is not listed for that platform at all rather than shown with a
 * status we invented.
 *
 * Which keys each platform lists, and why:
 *
 *  - macOS gates all four. `getMediaAccessStatus` answers for screen, camera
 *    and microphone; `isTrustedAccessibilityClient` answers for Accessibility,
 *    which the mac cursor helper needs for its mouse event tap (see
 *    `macNativeCursorRecordingSession.ts`).
 *  - Windows gates camera and microphone through the privacy toggles, and
 *    `getMediaAccessStatus` reads them. It has no consent gate for desktop
 *    capture and no Accessibility trust concept, so those two keys are absent
 *    rather than rendered as a permanent "unknown" the user cannot act on.
 *  - Linux has none of them: `getMediaAccessStatus` is macOS/Windows only, and
 *    capture consent belongs to the Wayland portal, which asks at the moment
 *    recording starts and answers to nothing we could query beforehand. The
 *    list is empty and the UI drops the whole section.
 *
 * Input Monitoring is deliberately absent everywhere — see the report in
 * `capturePermissions.test.ts`; nothing in this app requests it.
 */

import type { PermissionSettingsTarget } from "../windowPermissions";

export type CapturePermissionKey = "screen" | "camera" | "microphone" | "accessibility";

export type CapturePermissionStatus =
	| "granted"
	| "denied"
	| "restricted"
	| "not-determined"
	| "unknown";

/** What the row's one button does. `granted` means there is nothing left to do. */
export type CapturePermissionAction = "granted" | "request" | "open-settings";

export interface CapturePermissionRow {
	readonly key: CapturePermissionKey;
	readonly status: CapturePermissionStatus;
	readonly requiredForRecording: boolean;
	readonly action: CapturePermissionAction;
}

const PLATFORM_KEYS: Readonly<Record<string, readonly CapturePermissionKey[]>> = {
	darwin: ["screen", "camera", "microphone", "accessibility"],
	win32: ["camera", "microphone"],
};

/** The keys this platform can answer for, in display order. Empty is a valid answer. */
export function capturePermissionKeys(
	platform: NodeJS.Platform = process.platform,
): readonly CapturePermissionKey[] {
	return PLATFORM_KEYS[platform] ?? [];
}

/** Which privacy pane fixes each key. Every listed key must have one — pinned by the test. */
export const PERMISSION_SETTINGS_TARGETS: Readonly<
	Record<CapturePermissionKey, PermissionSettingsTarget>
> = {
	screen: "screen-capture",
	camera: "camera",
	microphone: "microphone",
	accessibility: "accessibility",
};

/** The `systemPreferences` calls this module needs, narrowed so the test can fake them. */
export interface CapturePermissionProbe {
	mediaAccessStatus(kind: "screen" | "camera" | "microphone"): string;
	accessibilityTrusted(): boolean;
}

const MEDIA_STATUSES: ReadonlySet<string> = new Set([
	"granted",
	"denied",
	"restricted",
	"not-determined",
]);

/**
 * Accessibility trust is a boolean: the app is in the list or it is not. macOS
 * exposes no way to tell "never asked" from "asked and refused", so untrusted
 * reports as `denied` — the pessimistic half of a two-valued answer, and the
 * one whose action (open the pane) is right either way.
 */
export function readCapturePermissionStatus(
	key: CapturePermissionKey,
	probe: CapturePermissionProbe,
): CapturePermissionStatus {
	try {
		if (key === "accessibility") return probe.accessibilityTrusted() ? "granted" : "denied";
		const raw = probe.mediaAccessStatus(key);
		return MEDIA_STATUSES.has(raw) ? (raw as CapturePermissionStatus) : "unknown";
	} catch {
		// A throwing probe is a platform that cannot answer, which is not a grant.
		return "unknown";
	}
}

/**
 * `not-determined` is the only state the app can resolve by itself: the OS will
 * show its prompt. Anything else — denied, restricted, or a status we could not
 * read — is settled in System Settings, so the button goes there rather than
 * firing a request the OS answers silently from its existing record.
 */
export function capturePermissionAction(status: CapturePermissionStatus): CapturePermissionAction {
	if (status === "granted") return "granted";
	if (status === "not-determined") return "request";
	return "open-settings";
}

export function buildCapturePermissions(
	probe: CapturePermissionProbe,
	platform: NodeJS.Platform = process.platform,
): CapturePermissionRow[] {
	return capturePermissionKeys(platform).map((key) => {
		const status = readCapturePermissionStatus(key, probe);
		return {
			key,
			status,
			// Screen capture is the only one that stops a recording outright; the rest
			// turn off a track the user may not have asked for.
			requiredForRecording: key === "screen",
			action: capturePermissionAction(status),
		};
	});
}
