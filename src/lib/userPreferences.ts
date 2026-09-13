import {
	DEFAULT_EDITOR_LAYOUT_SETTINGS,
	DEFAULT_EXPORT_SETTINGS,
} from "@/components/video-editor/editorDefaults";
import {
	type CaptureFrameRate,
	type CaptureResolutionPreset,
	type CountdownSeconds,
	isCaptureFrameRate,
	isCaptureResolutionPreset,
	isCountdownSeconds,
	isMicrophoneGain,
	type MicrophoneGain,
} from "@/lib/captureSettings";
import {
	type ExportFormat,
	type ExportQuality,
	type ExportVideoCodec,
	GIF_SIZE_PRESETS,
	type GifFrameRate,
	type GifSizePreset,
	isValidGifFrameRate,
} from "@/lib/exporter";
import { type AspectRatio, isAspectRatio } from "@/utils/aspectRatioUtils";

const PREFS_KEY = "openscreen_user_preferences";

export interface UserPreferences {
	/** Default padding % */
	padding: number;
	/** Default aspect ratio */
	aspectRatio: AspectRatio;
	/** Default export quality */
	exportQuality: ExportQuality;
	/** Default export format */
	exportFormat: ExportFormat;
	/** Default MP4 frame rate */
	exportFps: 24 | 30 | 60;
	/** Default MP4 codec. Only what the native exporter accepts — "vp9" is rejected
	 *  by the pipeline, so a stored one falls back to H.264 instead of failing a run. */
	exportCodec: Exclude<ExportVideoCodec, "vp9">;
	/** Aspect ratios ticked for the last export; null means "follow the document" */
	exportRatios: AspectRatio[] | null;
	/** Default GIF options */
	exportGif: {
		frameRate: GifFrameRate;
		size: GifSizePreset;
		loop: boolean;
		dither: boolean;
	};
	/** Folder used for the most recent successful export, if any */
	exportFolder: string | null;
	/** Folder of the most recently opened project, if any */
	projectFolder: string | null;
	/** Recording HUD control layout */
	trayLayout: "horizontal" | "vertical";
	/** Force the Windows native recorder to use the software H.264 encoder */
	preferSoftwareEncoder: boolean;
	/** Stop showing the notice that recording fell back to software encoding */
	hideSoftwareEncoderFallbackNotice: boolean;
	/** Frames per second to capture at */
	captureFrameRate: CaptureFrameRate;
	/** Ceiling on the captured frame size, or "auto" to record what the display gives */
	captureResolution: CaptureResolutionPreset;
	/** Seconds counted down before a take starts; 0 starts it immediately */
	countdownSeconds: CountdownSeconds;
	/** Multiplier on the microphone level the mix would otherwise use */
	microphoneGain: MicrophoneGain;
}

export const DEFAULT_PREFS: UserPreferences = {
	padding: DEFAULT_EDITOR_LAYOUT_SETTINGS.padding,
	aspectRatio: DEFAULT_EDITOR_LAYOUT_SETTINGS.aspectRatio,
	exportQuality: DEFAULT_EXPORT_SETTINGS.quality,
	exportFormat: DEFAULT_EXPORT_SETTINGS.format,
	// The export dialog's own opening state before it remembered anything.
	exportFps: 60,
	exportCodec: "h264",
	exportRatios: null,
	exportGif: { frameRate: 15, size: "medium", loop: true, dither: false },
	exportFolder: null,
	projectFolder: null,
	trayLayout: "horizontal",
	preferSoftwareEncoder: false,
	hideSoftwareEncoderFallbackNotice: false,
	// 60/auto is what every take used before these two became selectable, so an
	// existing user's recordings do not change under them.
	captureFrameRate: 60,
	captureResolution: "auto",
	// 3 s and unity gain are what every take used before these became selectable.
	countdownSeconds: 3,
	microphoneGain: 1,
};

/** Parses stored preferences without throwing on malformed JSON. */
export function safeJsonParse(text: string | null): Record<string, unknown> | null {
	if (!text) return null;
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/** Per-field fallback for the stored GIF options — a partial or malformed object keeps
 *  the fields it does carry instead of losing the lot. */
function readGifPrefs(raw: unknown): UserPreferences["exportGif"] {
	const stored = (raw ?? {}) as Record<string, unknown>;
	return {
		frameRate:
			typeof stored.frameRate === "number" && isValidGifFrameRate(stored.frameRate)
				? stored.frameRate
				: DEFAULT_PREFS.exportGif.frameRate,
		size:
			typeof stored.size === "string" && stored.size in GIF_SIZE_PRESETS
				? (stored.size as GifSizePreset)
				: DEFAULT_PREFS.exportGif.size,
		loop: typeof stored.loop === "boolean" ? stored.loop : DEFAULT_PREFS.exportGif.loop,
		dither: typeof stored.dither === "boolean" ? stored.dither : DEFAULT_PREFS.exportGif.dither,
	};
}

/** Load preferences from localStorage, falling back to defaults for missing or invalid fields. */
export function loadUserPreferences(): UserPreferences {
	let raw: Record<string, unknown> | null = null;
	try {
		raw = safeJsonParse(localStorage.getItem(PREFS_KEY));
	} catch {
		return { ...DEFAULT_PREFS };
	}
	if (!raw || typeof raw !== "object") return { ...DEFAULT_PREFS };

	return {
		padding:
			typeof raw.padding === "number" &&
			Number.isFinite(raw.padding) &&
			raw.padding >= 0 &&
			raw.padding <= 100
				? raw.padding
				: DEFAULT_PREFS.padding,
		aspectRatio: isAspectRatio(raw.aspectRatio) ? raw.aspectRatio : DEFAULT_PREFS.aspectRatio,
		exportQuality:
			raw.exportQuality === "medium" ||
			raw.exportQuality === "good" ||
			raw.exportQuality === "source"
				? (raw.exportQuality as ExportQuality)
				: DEFAULT_PREFS.exportQuality,
		exportFormat:
			raw.exportFormat === "gif" || raw.exportFormat === "mp4"
				? (raw.exportFormat as ExportFormat)
				: DEFAULT_PREFS.exportFormat,
		exportFps:
			raw.exportFps === 24 || raw.exportFps === 30 || raw.exportFps === 60
				? raw.exportFps
				: DEFAULT_PREFS.exportFps,
		// "vp9" is a valid `ExportVideoCodec` the native pipeline refuses, so it is
		// rejected here rather than in every reader.
		exportCodec:
			raw.exportCodec === "h264" || raw.exportCodec === "h265"
				? raw.exportCodec
				: DEFAULT_PREFS.exportCodec,
		// Ratios the current document does not offer are dropped by the reader, which is
		// the only place that knows the document; here only the shape is checked.
		exportRatios: Array.isArray(raw.exportRatios)
			? raw.exportRatios.filter(isAspectRatio)
			: DEFAULT_PREFS.exportRatios,
		exportGif: readGifPrefs(raw.exportGif),
		exportFolder:
			typeof raw.exportFolder === "string" && raw.exportFolder.length > 0
				? raw.exportFolder
				: DEFAULT_PREFS.exportFolder,
		projectFolder:
			typeof raw.projectFolder === "string" && raw.projectFolder.length > 0
				? raw.projectFolder
				: DEFAULT_PREFS.projectFolder,
		trayLayout:
			raw.trayLayout === "horizontal" || raw.trayLayout === "vertical"
				? raw.trayLayout
				: DEFAULT_PREFS.trayLayout,
		preferSoftwareEncoder:
			typeof raw.preferSoftwareEncoder === "boolean"
				? raw.preferSoftwareEncoder
				: DEFAULT_PREFS.preferSoftwareEncoder,
		hideSoftwareEncoderFallbackNotice:
			typeof raw.hideSoftwareEncoderFallbackNotice === "boolean"
				? raw.hideSoftwareEncoderFallbackNotice
				: DEFAULT_PREFS.hideSoftwareEncoderFallbackNotice,
		captureFrameRate: isCaptureFrameRate(raw.captureFrameRate)
			? raw.captureFrameRate
			: DEFAULT_PREFS.captureFrameRate,
		captureResolution: isCaptureResolutionPreset(raw.captureResolution)
			? raw.captureResolution
			: DEFAULT_PREFS.captureResolution,
		// `isCountdownSeconds`, not a truthiness check: a stored 0 is a valid choice
		// and must survive the round trip instead of reverting to the default.
		countdownSeconds: isCountdownSeconds(raw.countdownSeconds)
			? raw.countdownSeconds
			: DEFAULT_PREFS.countdownSeconds,
		microphoneGain: isMicrophoneGain(raw.microphoneGain)
			? raw.microphoneGain
			: DEFAULT_PREFS.microphoneGain,
	};
}

/**
 * Parent directory of a saved file path. Handles both POSIX and Windows
 * separators since the path comes from the OS save dialog. Root dirs keep their
 * trailing separator so the result stays a valid directory ("/video.mp4" -> "/",
 * "C:\\video.mp4" -> "C:\\"). Returns null if no separator is found.
 */
export function parentDirectoryOf(filePath: string): string | null {
	const lastSep = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
	if (lastSep < 0) return null;

	// POSIX root, e.g. "/video.mp4" -> "/"
	if (lastSep === 0) return filePath[0];

	// Windows drive root, e.g. "C:\\video.mp4" -> "C:\\"
	if (lastSep === 2 && /^[A-Za-z]:[/\\]/.test(filePath)) {
		return filePath.slice(0, lastSep + 1);
	}

	return filePath.slice(0, lastSep);
}

/** Remembered export folder as `string | undefined`, for IPC handlers that treat absence as "use the default". */
export function getExportFolder(): string | undefined {
	return loadUserPreferences().exportFolder ?? undefined;
}

/** Remembered open-project folder as `string | undefined`, for IPC handlers that treat absence as "use the default". */
export function getProjectFolder(): string | undefined {
	return loadUserPreferences().projectFolder ?? undefined;
}

/** Persist preferences to localStorage; only the provided fields are updated. */
export function saveUserPreferences(partial: Partial<UserPreferences>): void {
	const current = loadUserPreferences();
	const merged = { ...current, ...partial };
	try {
		localStorage.setItem(PREFS_KEY, JSON.stringify(merged));
	} catch {
		// localStorage may be unavailable (e.g. private browsing, quota exceeded)
	}
}
