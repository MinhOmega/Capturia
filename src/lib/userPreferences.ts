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
import type { ExportFormat, ExportQuality } from "@/lib/exporter";
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
