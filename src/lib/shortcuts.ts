export const SHORTCUT_ACTIONS = [
	"openApp",
	"stopRecording",
	"addZoom",
	"addTrim",
	"addSpeed",
	"addCameraFullscreen",
	"addAnnotation",
	"addAudio",
	"addVoiceover",
	"splitAtPlayhead",
	"deleteSelected",
	"playPause",
	"copySelected",
	"paste",
] as const;

export type ShortcutAction = (typeof SHORTCUT_ACTIONS)[number];

export interface ShortcutBinding {
	key: string;
	/** Maps to Cmd on macOS, Ctrl on Windows/Linux */
	ctrl?: boolean;
	shift?: boolean;
	alt?: boolean;
}

export type ShortcutsConfig = Record<ShortcutAction, ShortcutBinding>;

/**
 * The actions the OS owns rather than the renderer.
 *
 * These are the only ones that work while the app is not focused, which is also
 * the only reason to spend a global key on them: `openApp` is unreachable by
 * definition when the window is hidden, and a stop hotkey is worthless if you have
 * to click the app first to use it. Everything else in `SHORTCUT_ACTIONS` is an
 * editor keydown and needs no OS registration.
 */
export const GLOBAL_SHORTCUT_ACTIONS = ["openApp", "stopRecording"] as const;

export type GlobalShortcutAction = (typeof GLOBAL_SHORTCUT_ACTIONS)[number];

export function isGlobalShortcutAction(action: ShortcutAction): action is GlobalShortcutAction {
	return (GLOBAL_SHORTCUT_ACTIONS as readonly string[]).includes(action);
}

/**
 * Outcome of registering one GLOBAL shortcut.
 *
 * Four states rather than a boolean because the two failures need different words:
 * "conflict" is one key the user can change, "unavailable" is the whole session and
 * changing keys cannot help. "unchanged" is kept apart from "registered" so nothing
 * can report success for a call that registered nothing.
 */
export type ShortcutStatus = "registered" | "unchanged" | "conflict" | "unavailable";

/** What the last registration achieved, per global action. */
export type GlobalShortcutStatuses = Record<GlobalShortcutAction, ShortcutStatus>;

/** Whether a global hotkey actually works right now. */
export function isGlobalShortcutLive(status: ShortcutStatus): boolean {
	return status === "registered" || status === "unchanged";
}

export interface FixedShortcut {
	i18nKey: string;
	label: string;
	display: string;
	bindings: ShortcutBinding[];
}

export const FIXED_SHORTCUTS: FixedShortcut[] = [
	{ i18nKey: "undo", label: "Undo", display: "Ctrl + Z", bindings: [{ key: "z", ctrl: true }] },
	{
		i18nKey: "redo",
		label: "Redo",
		display: "Ctrl + Shift + Z / Ctrl + Y",
		bindings: [
			{ key: "z", ctrl: true, shift: true },
			{ key: "y", ctrl: true },
		],
	},
	{
		i18nKey: "cycleAnnotationsForward",
		label: "Cycle Annotations Forward",
		display: "Tab",
		bindings: [{ key: "tab" }],
	},
	{
		i18nKey: "cycleAnnotationsBackward",
		label: "Cycle Annotations Backward",
		display: "Shift + Tab",
		bindings: [{ key: "tab", shift: true }],
	},
	{
		i18nKey: "deleteSelectedAlt",
		label: "Delete Selected (alt)",
		display: "Del / ⌫",
		bindings: [{ key: "delete" }, { key: "backspace" }],
	},
	{
		i18nKey: "panTimeline",
		label: "Pan Timeline",
		display: "Scroll",
		bindings: [],
	},
	{ i18nKey: "zoomTimeline", label: "Zoom Timeline", display: "Ctrl + Scroll", bindings: [] },
	// The keyboard half of the same gesture. Unlike the wheel it has no cursor to zoom
	// around, so it zooms around the PLAYHEAD — which is also the moment you are about to
	// cut, and the reason a keyboard zoom is worth having at all.
	{
		i18nKey: "zoomTimelineIn",
		label: "Zoom Timeline In",
		display: "Ctrl + =",
		bindings: [{ key: "=", ctrl: true }],
	},
	{
		i18nKey: "zoomTimelineOut",
		label: "Zoom Timeline Out",
		display: "Ctrl + -",
		bindings: [{ key: "-", ctrl: true }],
	},
	{ i18nKey: "frameBack", label: "Frame Back", display: "←", bindings: [{ key: "arrowleft" }] },
	{
		i18nKey: "frameForward",
		label: "Frame Forward",
		display: "→",
		bindings: [{ key: "arrowright" }],
	},
	// Review speed — how fast you WATCH, not a speed region. See timeline/transport.ts.
	{
		i18nKey: "reviewSpeedDown",
		label: "Review Speed Down",
		display: "[",
		bindings: [{ key: "[" }],
	},
	{ i18nKey: "reviewSpeedUp", label: "Review Speed Up", display: "]", bindings: [{ key: "]" }] },
];

export type ShortcutConflict =
	| { type: "configurable"; action: ShortcutAction }
	| { type: "fixed"; label: string };

export function bindingsEqual(a: ShortcutBinding, b: ShortcutBinding): boolean {
	return (
		a.key.toLowerCase() === b.key.toLowerCase() &&
		!!a.ctrl === !!b.ctrl &&
		!!a.shift === !!b.shift &&
		!!a.alt === !!b.alt
	);
}

export function findConflict(
	binding: ShortcutBinding,
	forAction: ShortcutAction,
	config: ShortcutsConfig,
): ShortcutConflict | null {
	for (const fixed of FIXED_SHORTCUTS) {
		if (fixed.bindings.some((b) => bindingsEqual(b, binding))) {
			return { type: "fixed", label: fixed.label };
		}
	}
	for (const action of SHORTCUT_ACTIONS) {
		if (action !== forAction && bindingsEqual(config[action], binding)) {
			return { type: "configurable", action };
		}
	}
	return null;
}

export const DEFAULT_SHORTCUTS: ShortcutsConfig = {
	openApp: { key: "o", ctrl: true, shift: true },
	// Global, so it can stop a take while the app is behind whatever is being
	// recorded — which is the only state a recording is ever watched from.
	stopRecording: { key: "s", ctrl: true, shift: true },
	addZoom: { key: "z" },
	addTrim: { key: "t" },
	addSpeed: { key: "s" },
	addCameraFullscreen: { key: "c" },
	addAnnotation: { key: "a" },
	addAudio: { key: "m" },
	// Record a voiceover over the timeline from the playhead.
	addVoiceover: { key: "v" },
	// Not the bare `S` the old fork used for its scissors mode: `S` is Add Speed here, and
	// a default that has to steal a key from an existing default is not a default.
	splitAtPlayhead: { key: "k", ctrl: true },
	deleteSelected: { key: "d", ctrl: true },
	playPause: { key: " " },
	copySelected: { key: "c", ctrl: true },
	paste: { key: "v", ctrl: true },
};

export const SHORTCUT_LABELS: Record<ShortcutAction, string> = {
	openApp: "Open App",
	stopRecording: "Stop Recording",
	addZoom: "Add Zoom",
	addTrim: "Add Trim",
	addSpeed: "Add Speed",
	addCameraFullscreen: "Add Full Camera",
	addAnnotation: "Add Annotation",
	addAudio: "Add Audio",
	addVoiceover: "Record Voiceover",
	splitAtPlayhead: "Split at Playhead",
	deleteSelected: "Delete Selected",
	playPause: "Play / Pause",
	copySelected: "Copy Selected",
	paste: "Paste",
};

export function matchesShortcut(
	e: KeyboardEvent,
	binding: ShortcutBinding | undefined,
	isMacPlatform: boolean,
): boolean {
	if (!binding) return false;
	if (e.key.toLowerCase() !== binding.key.toLowerCase()) return false;

	const primaryMod = isMacPlatform ? e.metaKey : e.ctrlKey;
	if (primaryMod !== !!binding.ctrl) return false;
	if (e.shiftKey !== !!binding.shift) return false;
	if (e.altKey !== !!binding.alt) return false;

	return true;
}

/**
 * Does `e` match any binding of the FIXED shortcut named `i18nKey`?
 *
 * So a handler and the dialog's conflict table read the same row instead of holding two
 * copies of one key. The configurable actions already had that through `shortcuts[action]`;
 * the fixed ones were being re-typed at their handlers, which is how a key can end up
 * reserved in the dialog and dead in the editor.
 */
export function matchesFixedShortcut(
	e: KeyboardEvent,
	i18nKey: string,
	isMacPlatform: boolean,
): boolean {
	const fixed = FIXED_SHORTCUTS.find((f) => f.i18nKey === i18nKey);
	return !!fixed?.bindings.some((binding) => matchesShortcut(e, binding, isMacPlatform));
}

/** True when the event target is a text-editing surface where shortcuts should not fire. */
export function isTextEditingTarget(target: EventTarget | null): boolean {
	return (
		target instanceof HTMLInputElement ||
		target instanceof HTMLTextAreaElement ||
		(target instanceof HTMLElement && target.isContentEditable)
	);
}

const KEY_LABELS: Record<string, string> = {
	" ": "Space",
	delete: "Del",
	backspace: "⌫",
	escape: "Esc",
	arrowup: "↑",
	arrowdown: "↓",
	arrowleft: "←",
	arrowright: "→",
};

export function formatBinding(binding: ShortcutBinding, isMac: boolean): string {
	const parts: string[] = [];
	if (binding.ctrl) parts.push(isMac ? "⌘" : "Ctrl");
	if (binding.shift) parts.push(isMac ? "⇧" : "Shift");
	if (binding.alt) parts.push(isMac ? "⌥" : "Alt");
	parts.push(KEY_LABELS[binding.key] ?? binding.key.toUpperCase());
	return parts.join(" + ");
}

export function mergeWithDefaults(partial: Partial<ShortcutsConfig>): ShortcutsConfig {
	const merged = { ...DEFAULT_SHORTCUTS };
	for (const action of SHORTCUT_ACTIONS) {
		if (partial[action]) {
			merged[action] = partial[action] as ShortcutBinding;
		}
	}
	return merged;
}
