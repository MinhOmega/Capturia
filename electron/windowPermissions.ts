/**
 * Which window may hold which web permission.
 *
 * Before this module the session handed `media`, `screen` and `display-capture`
 * to whichever WebContents asked. The editor runs with `webSecurity: false` and
 * renders model-generated content, so "the renderer is trusted" was not a strong
 * enough premise: a page that got into the editor could have opened the camera
 * or started a screen capture without a line of our own code asking for it.
 *
 * Capture is not one window's job here, so the policy is per media kind rather
 * than per window:
 *
 *  - screen capture belongs to the recorder surfaces alone — the HUD overlay and
 *    the CLI record runner. It is the grant with the largest blast radius, and
 *    nothing else asks for a display: the editor's Rec stage is a pre-flight
 *    that hands the actual recording to the HUD (`electronAPI.startNewRecording`);
 *  - the camera belongs to those two and to the editor, whose Rec stage shows a
 *    live webcam preview (`RecStage` -> `useCameraPreviewStream`);
 *  - the microphone belongs to those three — the editor both records voiceover
 *    audio layers (`AddAudioLayerDialog`) and meters the mic in the Rec stage —
 *    and to the CLI sources runner, which needs a short-lived grant to read
 *    device labels;
 *  - the source selector, the area selector, the countdown overlay, the notes
 *    window and the bench window never capture anything. The bench renders App's default placeholder,
 *    not the editor shell.
 *
 * Refusing a kind a window does use is not a quiet failure: `getUserMedia`
 * rejects with `NotAllowedError`, and because device LABELS require a grant,
 * `enumerateDevices` also starts returning unlabeled entries, so a device picker
 * degrades to raw device-ID hashes for a user who never opened a preview. The
 * table in `windowPermissions.test.ts` pins each window against the call sites
 * that justify it; change one only with the other.
 *
 * A window's identity comes from the FIRST document the main process commits
 * (`did-navigate`), not from `webContents.getURL()` read at request time: a
 * renderer can rewrite the reported URL with `history.replaceState`, and that is
 * precisely the claim this policy must not accept. `navigationPolicy.ts` refuses
 * any real navigation to a different `windowType` on top of that, so the two
 * guards lock each other in.
 */

/**
 * Every window the main process builds. Exported so the test can assert its
 * call-site mapping covers all of them: a new window type added here without an
 * entry there fails the suite rather than silently inheriting "no capture".
 */
const WINDOW_TYPE_LIST = [
	"hud-overlay",
	"editor",
	"bench",
	"source-selector",
	"area-selector",
	"countdown-overlay",
	"notes",
	"cli-record",
	"cli-export",
	"cli-sources",
	"cli-captions",
] as const;

export type OpenScreenWindowType = (typeof WINDOW_TYPE_LIST)[number];
export const WINDOW_TYPES: ReadonlySet<string> = new Set(WINDOW_TYPE_LIST);

/** The media kinds the policy distinguishes. */
export type CaptureKind = "screen" | "camera" | "microphone";

/**
 * Chromium spells the same underlying request several ways depending on the API
 * and the platform. `media` is the generic `getUserMedia` request whose kinds
 * arrive separately in the request details.
 */
const PERMISSION_KINDS: ReadonlyMap<string, CaptureKind> = new Map<string, CaptureKind>([
	["screen", "screen"],
	["display-capture", "screen"],
	["camera", "camera"],
	["videoCapture", "camera"],
	["microphone", "microphone"],
	["audioCapture", "microphone"],
]);

/** Windows allowed to hold each capture kind. */
const CAPTURE_WINDOWS: ReadonlyMap<CaptureKind, ReadonlySet<OpenScreenWindowType>> = new Map([
	// Nothing outside the two recorder surfaces ever asks for a display.
	["screen", new Set<OpenScreenWindowType>(["hud-overlay", "cli-record"])],
	[
		"camera",
		// The editor's Rec stage previews the selected webcam before handing the
		// recording to the HUD, and its camera picker needs the grant for labels.
		new Set<OpenScreenWindowType>(["hud-overlay", "cli-record", "editor"]),
	],
	[
		"microphone",
		// The editor meters the mic in the Rec stage and records voiceover audio
		// layers; the CLI sources runner needs a grant before `enumerateDevices`
		// will report device labels.
		new Set<OpenScreenWindowType>(["hud-overlay", "cli-record", "cli-sources", "editor"]),
	],
]);

/** Non-capture permissions any window the main process built may hold. */
const WINDOW_PERMISSIONS: ReadonlySet<string> = new Set(["fullscreen"]);

/**
 * Non-capture permissions scoped to particular windows -- `CAPTURE_WINDOWS`'s
 * shape, without a `CaptureKind`.
 *
 * `local-fonts` enumerates every font installed on the machine, which is a
 * fingerprinting surface, so it is not in `WINDOW_PERMISSIONS` above: only the
 * editor gets it, because only the editor offers the caption font picker that
 * needs to know which families the compositor will be able to resolve.
 */
const SCOPED_WINDOW_PERMISSIONS: ReadonlyMap<string, ReadonlySet<OpenScreenWindowType>> = new Map([
	["local-fonts", new Set<OpenScreenWindowType>(["editor"])],
]);

export interface PermissionDecisionInput {
	readonly permission: string;
	/** What the main process built this WebContents as; null when it built no such window. */
	readonly windowType: OpenScreenWindowType | null | undefined;
	/** Subframes never capture: only the window's own document asks. */
	readonly isMainFrame: boolean;
	/**
	 * Kinds carried by a generic `media` request. Electron populates these for the
	 * request handler; the check handler (`navigator.permissions.query`) may not,
	 * and an empty list there means "any kind this window could hold".
	 */
	readonly mediaKinds?: readonly CaptureKind[];
}

function mayCapture(windowType: OpenScreenWindowType, kind: CaptureKind): boolean {
	return CAPTURE_WINDOWS.get(kind)?.has(windowType) ?? false;
}

/** Pure predicate behind both permission handlers. */
export function isPermissionAllowed(input: PermissionDecisionInput): boolean {
	const windowType = input.windowType;
	if (!windowType || !WINDOW_TYPES.has(windowType)) return false;
	if (!input.isMainFrame) return false;

	const kind = PERMISSION_KINDS.get(input.permission);
	if (kind) return mayCapture(windowType, kind);

	if (input.permission === "media") {
		const kinds = input.mediaKinds ?? [];
		// A request naming its kinds must satisfy every one of them.
		if (kinds.length > 0) return kinds.every((each) => mayCapture(windowType, each));
		// A bare status query: true when the window may capture anything at all.
		return mayCapture(windowType, "camera") || mayCapture(windowType, "microphone");
	}

	const scoped = SCOPED_WINDOW_PERMISSIONS.get(input.permission);
	if (scoped) return scoped.has(windowType);

	return WINDOW_PERMISSIONS.has(input.permission);
}

/**
 * The `windowType` a committed document identifies, or null for a document the
 * main process did not build (DevTools, `about:blank`).
 *
 * The notes window is loaded as `?showNotes=true` rather than with a
 * `windowType`, so it is mapped here rather than at its creation site.
 */
export function windowTypeFromUrl(rawUrl: string): OpenScreenWindowType | null {
	let params: URLSearchParams;
	try {
		params = new URL(rawUrl).searchParams;
	} catch {
		return null;
	}
	const declared = params.get("windowType");
	if (declared && WINDOW_TYPES.has(declared)) return declared as OpenScreenWindowType;
	if (!declared && params.get("showNotes") === "true") return "notes";
	return null;
}

const windowTypes = new WeakMap<object, OpenScreenWindowType>();

/**
 * Record what the main process committed into this WebContents. Called from the
 * central `web-contents-created` hook on the FIRST commit only: a later
 * navigation cannot relabel a window (and `navigationPolicy` refuses one anyway).
 */
export function rememberWindowType(contents: object, windowType: OpenScreenWindowType): void {
	if (windowTypes.has(contents)) return;
	windowTypes.set(contents, windowType);
}

/** The recorded type, or null for a WebContents the app did not build. */
export function windowTypeForContents(
	contents: object | null | undefined,
): OpenScreenWindowType | null {
	if (!contents) return null;
	return windowTypes.get(contents) ?? null;
}

/**
 * OS privacy panes the app can deep-link to.
 *
 * `shell.openExternal` is the only way to open these, and the URLs are built
 * from this fixed table rather than from anything a renderer supplies — which is
 * why they are exempt from `normalizeExternalUrl`'s http/https/mailto allowlist.
 * Returns null where the platform has no deep link: Linux has no single answer,
 * and Windows has no pane for screen capture or accessibility trust because it
 * gates neither. `capturePermissions.ts` only offers a target its platform
 * lists, so a null here is never reachable from the permissions panel.
 */
export type PermissionSettingsTarget = "screen-capture" | "camera" | "microphone" | "accessibility";

const MACOS_PANES: Record<PermissionSettingsTarget, string> = {
	"screen-capture": "Privacy_ScreenCapture",
	camera: "Privacy_Camera",
	microphone: "Privacy_Microphone",
	accessibility: "Privacy_Accessibility",
};

const WINDOWS_PANES: Partial<Record<PermissionSettingsTarget, string>> = {
	"screen-capture": "ms-settings:privacy-general",
	camera: "ms-settings:privacy-webcam",
	microphone: "ms-settings:privacy-microphone",
};

export function settingsPaneUrl(
	target: PermissionSettingsTarget,
	platform: NodeJS.Platform = process.platform,
): string | null {
	if (platform === "darwin") {
		return `x-apple.systempreferences:com.apple.preference.security?${MACOS_PANES[target]}`;
	}
	if (platform === "win32") return WINDOWS_PANES[target] ?? null;
	return null;
}
