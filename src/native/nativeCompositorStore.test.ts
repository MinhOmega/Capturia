import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_EDITOR_SETTINGS } from "@/lib/ai-edition/store/editorSettings";
import type { CompositorParamValue } from "./contracts";

// The parameter list is spelled out even though the body ignores it: `vi.fn`
// infers the mock's call signature from the implementation, so a zero-argument
// one types `mock.calls` as an empty tuple and every `calls[i][1]` below becomes
// a type error rather than a string.
const setCompositorParam = vi.fn((_id: number, _key: string, _value: CompositorParamValue) =>
	Promise.resolve(),
);
const setCompositorScene = vi.fn((_id: number, _sceneJson: string) => Promise.resolve());

vi.mock("./compositorViewClient", () => ({
	setCompositorParam: (id: number, key: string, value: CompositorParamValue) =>
		setCompositorParam(id, key, value),
	setCompositorPlaying: vi.fn(() => Promise.resolve()),
	setCompositorScene: (id: number, sceneJson: string) => setCompositorScene(id, sceneJson),
	setCompositorTime: vi.fn(() => Promise.resolve()),
}));

/**
 * The full key set the addon understands, transcribed from
 * `crates/compositor/src/live.rs` — `set_param_bool` (3), `set_param_num` (9)
 * and `set_param_str` (2). Anything the addon accepts and the app never pushes
 * silently keeps its compiled-in default, which is exactly the bug this file
 * guards: `cursorSize` was only ever pushed by the cursor panel's mount effect,
 * and the inspector shows one panel at a time, so a project's cursor settings
 * did not reach the preview until the user opened that panel.
 */
const ADDON_KEYS = [
	"backgroundBlur",
	"webcamMirror",
	"cursorShow",
	"shadow",
	"roundness",
	"motionBlur",
	"padding",
	"webcamSize",
	"cursorSize",
	"cursorClickBounce",
	"cursorSmoothing",
	"cursorMotionBlur",
	"backgroundColor",
	"webcamShape",
] as const;

describe("pushAllNativeParams", () => {
	beforeEach(() => {
		vi.resetModules();
		setCompositorParam.mockClear();
	});

	async function pushWith(overrides: Record<string, unknown> = {}) {
		const store = await import("./nativeCompositorStore");
		store.setCurrentNativeViewId(1);
		setCompositorParam.mockClear();
		store.pushAllNativeParams({
			...DEFAULT_EDITOR_SETTINGS,
			...overrides,
		} as Parameters<typeof store.pushAllNativeParams>[0]);
		return new Map(
			setCompositorParam.mock.calls.map((c) => [c[1] as string, c[2] as CompositorParamValue]),
		);
	}

	it("pushes every key the addon understands", async () => {
		// A hex wallpaper so backgroundColor is included; a gradient or image
		// wallpaper legitimately travels in the scene instead.
		const pushed = await pushWith({ wallpaper: "#101820" });
		const missing = ADDON_KEYS.filter((k) => !pushed.has(k));
		expect(missing, `params the addon accepts but nothing pushes: ${missing.join(", ")}`).toEqual(
			[],
		);
	});

	it("sends cursor values RAW, not in slider space", async () => {
		// SliderCell displays cursor.size * 10 and divides by 10 on the way out;
		// smoothing and motionBlur use * 100. Pushing a slider-space value from
		// here would scale the preview by 10 or 100 on load — a regression that
		// would look like "the cursor is enormous when I open a project".
		const pushed = await pushWith({
			cursor: { size: 3, clickBounce: 2.5, smoothing: 0.67, motionBlur: 0.35 },
		});
		expect(pushed.get("cursorSize")).toBe(3);
		expect(pushed.get("cursorClickBounce")).toBe(2.5);
		expect(pushed.get("cursorSmoothing")).toBeCloseTo(0.67, 5);
		expect(pushed.get("cursorMotionBlur")).toBeCloseTo(0.35, 5);
	});

	it("converts padding and the two base-unit scales", async () => {
		const pushed = await pushWith({
			padding: 50,
			borderRadius: 48,
			webcamSizePreset: 33.4,
		});
		expect(pushed.get("padding")).toBeCloseTo(0.5, 5);
		// NATIVE_SCREEN_BASE_RADIUS_PX = 24, NATIVE_WEBCAM_BASE_PCT = 16.7.
		expect(pushed.get("roundness")).toBeCloseTo(2, 5);
		expect(pushed.get("webcamSize")).toBeCloseTo(2, 5);
	});

	it("omits backgroundColor when the wallpaper is not a literal colour", async () => {
		const pushed = await pushWith({ wallpaper: "wallpapers/ridges.jpg" });
		expect(pushed.has("backgroundColor")).toBe(false);
	});

	it("memoises so a view activating later still gets everything", async () => {
		// The ordering guarantee the fix leans on: params pushed before a view
		// exists are replayed on activation, so the overlay needs no viewId guard.
		const store = await import("./nativeCompositorStore");
		store.setCurrentNativeViewId(null);
		setCompositorParam.mockClear();
		store.pushAllNativeParams({
			...DEFAULT_EDITOR_SETTINGS,
			wallpaper: "#101820",
		} as Parameters<typeof store.pushAllNativeParams>[0]);
		expect(setCompositorParam).not.toHaveBeenCalled();

		store.setCurrentNativeViewId(7);
		const replayed = new Set(setCompositorParam.mock.calls.map((c) => c[1] as string));
		const missing = ADDON_KEYS.filter((k) => !replayed.has(k));
		expect(missing, `not replayed on activation: ${missing.join(", ")}`).toEqual([]);
	});
});

describe("setNativeScene", () => {
	beforeEach(() => {
		vi.resetModules();
		setCompositorScene.mockClear();
	});

	/**
	 * The overlay rebuilds and ships the WHOLE scene on every document write, and a
	 * slider drag or a transcript keystroke is one write per frame — while the slider's
	 * own value already goes out live through `setNativeParam`. Sending bytes the native
	 * side already has costs a caption derivation over the whole transcript, a projection
	 * per region kind and a layout per clip, then hundreds of KB across the bridge, per
	 * frame.
	 */
	it("does not re-send a scene the active view already has", async () => {
		const store = await import("./nativeCompositorStore");
		store.setCurrentNativeViewId(1);

		store.setNativeScene('{"clips":[]}');
		store.setNativeScene('{"clips":[]}');
		store.setNativeScene('{"clips":[]}');

		expect(setCompositorScene).toHaveBeenCalledTimes(1);
	});

	it("sends it again when it actually changes", async () => {
		const store = await import("./nativeCompositorStore");
		store.setCurrentNativeViewId(1);

		store.setNativeScene('{"clips":[]}');
		store.setNativeScene('{"clips":[1]}');

		expect(setCompositorScene).toHaveBeenCalledTimes(2);
	});

	/** A freshly created view holds nothing, so an identical scene must still reach it. */
	it("sends it again to a new view", async () => {
		const store = await import("./nativeCompositorStore");
		store.setCurrentNativeViewId(1);
		store.setNativeScene('{"clips":[]}');

		store.setCurrentNativeViewId(2);
		store.setNativeScene('{"clips":[]}');

		expect(setCompositorScene).toHaveBeenCalledTimes(2);
		expect(setCompositorScene.mock.calls[1][0]).toBe(2);
	});
});
