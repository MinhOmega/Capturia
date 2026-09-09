import { app, type Session, shell } from "electron";
import { attachNavigationPolicy } from "./navigationPolicy";
import {
	type CaptureKind,
	isPermissionAllowed,
	rememberWindowType,
	windowTypeForContents,
	windowTypeFromUrl,
} from "./windowPermissions";

/**
 * Binds the two pure policies (`navigationPolicy`, `windowPermissions`) to
 * Electron, for both boot paths: the GUI (`main.ts`) and the CLI (`cli/cliMain.ts`).
 *
 * The navigation guard hangs off `app.on("web-contents-created")` rather than off
 * each window creation site. Windows are created in six places across two entry
 * points, and a guard you have to remember to call at a seventh is a guard that
 * gets forgotten — this way a new window is covered before it has loaded
 * anything, and DevTools and any future window come along for free.
 */

/** `video`/`audio` as Electron reports them, in the vocabulary the policy uses. */
function toCaptureKinds(mediaTypes: readonly string[] | undefined): CaptureKind[] {
	const kinds: CaptureKind[] = [];
	for (const mediaType of mediaTypes ?? []) {
		if (mediaType === "video") kinds.push("camera");
		else if (mediaType === "audio") kinds.push("microphone");
	}
	return kinds;
}

/**
 * Refuse page-driven navigation and `window.open` in every window, and record
 * what each window is so the permission handlers can key on it.
 *
 * Call once per process, as early as possible.
 */
export function installNavigationPolicy(): void {
	app.on("web-contents-created", (_event, contents) => {
		attachNavigationPolicy(contents, {
			openExternal: (url) => shell.openExternal(url),
			// The first document the main process commits names the window. A later
			// commit cannot relabel it (`rememberWindowType` keeps the first), and
			// the navigation policy refuses one anyway.
			onTrustedDocument: (url) => {
				const windowType = windowTypeFromUrl(url);
				if (windowType) rememberWindowType(contents, windowType);
			},
		});
	});
}

/**
 * Restrict camera, microphone and screen-capture grants to the windows that
 * actually record. Replaces the blanket allowlist both boot paths used to
 * install, which granted capture to any WebContents that asked.
 */
export function installPermissionPolicy(targetSession: Session): void {
	targetSession.setPermissionCheckHandler((webContents, permission, _origin, details) => {
		// A status query (`navigator.permissions.query`) names at most one kind, and
		// "unknown" means it named none.
		const mediaType = details.mediaType;
		return isPermissionAllowed({
			permission,
			windowType: windowTypeForContents(webContents),
			isMainFrame: details.isMainFrame !== false,
			mediaKinds: toCaptureKinds(mediaType ? [mediaType] : undefined),
		});
	});

	targetSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
		const mediaTypes = "mediaTypes" in details ? details.mediaTypes : undefined;
		const windowType = windowTypeForContents(webContents);
		const granted = isPermissionAllowed({
			permission,
			windowType,
			isMainFrame: details.isMainFrame !== false,
			mediaKinds: toCaptureKinds(mediaTypes),
		});
		if (!granted) {
			console.warn(`[permissions] denied ${permission} to ${windowType ?? "an unknown window"}`);
		}
		callback(granted);
	});
}
