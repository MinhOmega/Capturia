// Saved looks: a named bundle of APPEARANCE settings that can be applied to any
// project, and one of which can seed every new project.
//
// A look is stored as the same patch shapes the panes already write
// (`EditorSettingsPatch`, `CaptionSettings`), so applying one is the same two
// patch functions every other appearance edit goes through. What a look never
// carries is anything tied to the footage: regions, trims, zooms, crop, clips,
// the transcript, the camera framing, the audio gain.
//
// Persisted beside `userPreferences` with the same localStorage mechanism, under
// its own key: a custom background is an inline `data:` URL that can run to
// megabytes, and a quota failure here must not take the user's other
// preferences down with it.

import { toast } from "sonner";
import type { WebcamMaskShape } from "@/components/video-editor/types";
import { toastText } from "@/i18n/toastText";
import { WEBCAM_LAYOUT_PRESETS } from "@/lib/compositeLayout";
import { CURSOR_THEME_IDS, DEFAULT_CURSOR_THEME_ID } from "@/lib/cursor/cursorThemes";
import { safeJsonParse } from "@/lib/userPreferences";
import { classifyWallpaper, resolveImageWallpaperUrl } from "@/lib/wallpaper";
import { isAspectRatio } from "@/utils/aspectRatioUtils";
import { clamp, clamp01 } from "@/utils/math";
import {
	type CaptionSettings,
	getCaptionSettings,
	patchCaptionSettings,
} from "../captions/settings";
import { type AxcutDocument, createEmptyDocument } from "../schema";
import {
	DEFAULT_EDITOR_SETTINGS,
	type EditorSettingsPatch,
	getEditorSettings,
	patchEditorSettings,
} from "./editorSettings";

const LOOK_PRESETS_KEY = "capturia_look_presets";

/** Caption appearance only. Whether captions show, their language and their lane depend
 *  on the project's transcript, so a look leaves them alone. */
export type CaptionStyle = Omit<CaptionSettings, "enabled" | "language" | "captionLane">;

export interface Look {
	/** `aspectRatio` is present only when the user opted in when saving. */
	settings: EditorSettingsPatch;
	/** `null` when the source project never set a caption style: its insets would be the
	 *  aspect-derived defaults, and freezing a landscape default into a 9:16 project is the
	 *  exact failure `getCaptionSettings` takes an aspect to avoid. */
	captions: CaptionStyle | null;
}

export interface LookPreset extends Look {
	id: string;
	name: string;
}

export interface LookPresetState {
	presets: LookPreset[];
	defaultId: string | null;
}

const MASK_SHAPES: readonly WebcamMaskShape[] = ["rectangle", "circle", "square", "rounded"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The look a document currently wears.
 *
 * Read through the document's own readers, so a preset gets exactly the type guards and
 * clamps a project file does — and then clamped once more to the ranges the sliders
 * offer, which the readers leave open for a handful of fields.
 */
export function lookFromDocument(doc: AxcutDocument, includeAspectRatio: boolean): Look {
	const s = getEditorSettings(doc);
	const legacy = isRecord(doc.legacyEditor) ? doc.legacyEditor : null;
	let captions: CaptionStyle | null = null;
	if (isRecord(legacy?.captions)) {
		const {
			enabled: _enabled,
			language: _language,
			captionLane: _lane,
			...style
		} = getCaptionSettings(doc);
		captions = style;
	}
	return {
		settings: {
			wallpaper: s.wallpaper,
			shadowIntensity: clamp01(s.shadowIntensity),
			showBlur: s.showBlur,
			motionBlurAmount: clamp01(s.motionBlurAmount),
			borderRadius: clamp(s.borderRadius, 0, 64),
			padding: clamp(s.padding, 0, 100),
			webcamLayoutPreset: WEBCAM_LAYOUT_PRESETS.some((p) => p.value === s.webcamLayoutPreset)
				? s.webcamLayoutPreset
				: DEFAULT_EDITOR_SETTINGS.webcamLayoutPreset,
			webcamMaskShape: MASK_SHAPES.includes(s.webcamMaskShape)
				? s.webcamMaskShape
				: DEFAULT_EDITOR_SETTINGS.webcamMaskShape,
			webcamMirrored: s.webcamMirrored,
			webcamReactiveZoom: s.webcamReactiveZoom,
			webcamSizePreset: clamp(s.webcamSizePreset, 10, 50),
			webcamPosition: s.webcamPosition,
			webcamBackgroundMode: s.webcamBackgroundMode,
			webcamWallpaper: s.webcamWallpaper,
			webcamBlurIntensity: s.webcamBlurIntensity,
			cursor: {
				size: clamp(s.cursor.size, 0.5, 10),
				smoothing: clamp01(s.cursor.smoothing),
				motionBlur: clamp01(s.cursor.motionBlur),
				clickBounce: clamp(s.cursor.clickBounce, 0, 5),
				clipToBounds: s.cursor.clipToBounds,
				// Unknown ids are kept here and caught in `withAvailableAssets`, which is where
				// the user gets told a theme went missing.
				theme: s.cursorTheme,
				show: s.cursorShow,
			},
			...(includeAspectRatio && isAspectRatio(s.aspectRatio) ? { aspectRatio: s.aspectRatio } : {}),
		},
		captions,
	};
}

/** Applies the look's appearance fields and nothing else. Pure. */
export function applyLook(doc: AxcutDocument, look: Look): AxcutDocument {
	const next = patchEditorSettings(doc, look.settings);
	// Every inset is in the style, so the aspect `patchCaptionSettings` would use for
	// first-write defaults has nothing left to decide.
	return look.captions ? patchCaptionSettings(next, look.captions) : next;
}

// The schema rejects an empty title, and this runs at import time: an invalid probe
// would take projectStore (which imports this module) down with it.
const PROBE_DOC = createEmptyDocument({ projectId: "look-preset", title: "Look preset" });

/** A stored preset, rebuilt from known fields only — so a field a newer build wrote is
 *  ignored, and a hand-edited value lands in range — or `null` when it is not a preset. */
function parsePreset(raw: unknown): LookPreset | null {
	if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.name !== "string") return null;
	const name = raw.name.trim();
	if (!name) return null;
	const settings = isRecord(raw.settings) ? raw.settings : {};
	// Lay the raw values out as a document and read them back: the readers ARE the schema.
	const probe = patchEditorSettings(
		{ ...PROBE_DOC, legacyEditor: isRecord(raw.captions) ? { captions: raw.captions } : null },
		settings as EditorSettingsPatch,
	);
	return { id: raw.id, name, ...lookFromDocument(probe, settings.aspectRatio !== undefined) };
}

export function loadLookPresets(): LookPresetState {
	let raw: Record<string, unknown> | null = null;
	try {
		raw = safeJsonParse(localStorage.getItem(LOOK_PRESETS_KEY));
	} catch {
		return { presets: [], defaultId: null };
	}
	const list = raw?.presets;
	const presets = Array.isArray(list) ? list.flatMap((p) => parsePreset(p) ?? []) : [];
	const defaultId = presets.some((p) => p.id === raw?.defaultId)
		? (raw?.defaultId as string)
		: null;
	return { presets, defaultId };
}

/** Returns false when the write failed — most likely a custom background too large for
 *  the storage quota — so the caller can say so instead of losing the preset silently. */
export function saveLookPresets(state: LookPresetState): boolean {
	try {
		localStorage.setItem(LOOK_PRESETS_KEY, JSON.stringify(state));
		return true;
	} catch {
		return false;
	}
}

export function defaultLookPreset(): LookPreset | null {
	const { presets, defaultId } = loadLookPresets();
	return presets.find((p) => p.id === defaultId) ?? null;
}

/** Whether an image wallpaper still resolves. Colours, gradients and inline `data:` images
 *  carry their own content, so only a referenced file can have gone missing. */
function imageAvailable(value: string | undefined): Promise<boolean> {
	if (value === undefined) return Promise.resolve(true);
	const classified = classifyWallpaper(value);
	if (classified.kind !== "image" || classified.path.startsWith("data:")) {
		return Promise.resolve(true);
	}
	let url: string;
	try {
		url = resolveImageWallpaperUrl(classified.path);
	} catch {
		return Promise.resolve(false);
	}
	return new Promise((resolve) => {
		const img = new Image();
		img.onload = () => resolve(true);
		img.onerror = () => resolve(false);
		img.src = url;
	});
}

/**
 * The look with every referenced image or cursor theme that no longer exists reset to
 * its default — that field only — and one toast when anything was.
 */
export async function withAvailableAssets(look: Look): Promise<Look> {
	const s = look.settings;
	const [wallpaperOk, webcamWallpaperOk] = await Promise.all([
		imageAvailable(s.wallpaper),
		imageAvailable(s.webcamWallpaper),
	]);
	const themeOk = s.cursor?.theme === undefined || CURSOR_THEME_IDS.has(s.cursor.theme);
	if (wallpaperOk && webcamWallpaperOk && themeOk) return look;
	toast.warning(toastText("settings", "looks.missingAsset"));
	return {
		...look,
		settings: {
			...s,
			...(wallpaperOk ? {} : { wallpaper: DEFAULT_EDITOR_SETTINGS.wallpaper }),
			...(webcamWallpaperOk ? {} : { webcamWallpaper: DEFAULT_EDITOR_SETTINGS.webcamWallpaper }),
			cursor: { ...s.cursor, ...(themeOk ? {} : { theme: DEFAULT_CURSOR_THEME_ID }) },
		},
	};
}
