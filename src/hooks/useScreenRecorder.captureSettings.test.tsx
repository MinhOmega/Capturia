// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/contexts/I18nContext", () => ({
	useScopedT: () => (key: string) => key,
}));

vi.mock("sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { saveUserPreferences } from "@/lib/userPreferences";
import { useScreenRecorder } from "./useScreenRecorder";

type ElectronAPI = Window["electronAPI"];

const SOURCE = { id: "screen:0:0", name: "Screen 1", display_id: "1", thumbnail: "" };

let api: Record<string, ReturnType<typeof vi.fn>>;

/**
 * Enough of the API for one native take to start on any of the three platforms.
 * Nothing here stops the recording: every assertion reads the request the hook
 * sent, which the helper stub captures on the way past.
 */
function stubElectronAPI(platform: string) {
	api = {
		getRecordingPrefs: vi.fn(async () => null),
		getPlatform: vi.fn(() => platform),
		getSelectedSource: vi.fn(async () => SOURCE),
		isNativeWindowsCaptureAvailable: vi.fn(async () => ({
			success: true,
			available: platform === "win32",
			reason: platform === "win32" ? undefined : "unsupported-platform",
		})),
		isNativeMacCaptureAvailable: vi.fn(async () => ({
			success: true,
			available: platform === "darwin",
			reason: platform === "darwin" ? undefined : "unsupported-platform",
		})),
		isNativeLinuxCaptureAvailable: vi.fn(async () => ({
			success: true,
			available: platform === "linux",
			reason: platform === "linux" ? undefined : "unsupported-platform",
		})),
		startNativeWindowsRecording: vi.fn(async () => ({ success: true, recordingId: 7 })),
		startNativeMacRecording: vi.fn(async () => ({ success: true, recordingId: 7 })),
		startNativeLinuxRecording: vi.fn(async () => ({ success: true, recordingId: 7 })),
		prepareNativeLinuxRecording: vi.fn(async () => ({ success: true, recordingId: 7 })),
		cancelNativeLinuxPrepare: vi.fn(async () => undefined),
		requestNativeMacCursorAccess: vi.fn(async () => ({ granted: true, status: "granted" })),
		showCountdownOverlay: vi.fn(async () => true),
		setCountdownOverlayValue: vi.fn(async () => true),
		hideCountdownOverlay: vi.fn(async () => true),
		setCurrentRecordingSession: vi.fn(async () => undefined),
		setCurrentVideoPath: vi.fn(async () => undefined),
		switchToEditor: vi.fn(async () => undefined),
	};
	window.electronAPI = api as unknown as ElectronAPI;
}

/** Drives the hook through the 3s countdown and returns the request the helper got. */
async function captureRequest(start: ReturnType<typeof vi.fn>) {
	const view = renderHook(() => useScreenRecorder());
	await act(async () => {
		view.result.current.toggleRecording();
	});
	await act(async () => {
		await vi.advanceTimersByTimeAsync(3_500);
	});
	expect(start).toHaveBeenCalledTimes(1);
	return start.mock.calls[0][0] as {
		video: { fps: number; width?: number; height?: number; bitrate?: number; maxLongEdge?: number };
		audio: { microphone: { gain: number } };
	};
}

beforeEach(() => {
	vi.useFakeTimers();
	localStorage.clear();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("capture frame rate", () => {
	it("defaults to 60 fps at the full 4K ceiling", async () => {
		stubElectronAPI("win32");

		const request = await captureRequest(api.startNativeWindowsRecording);

		expect(request.video).toMatchObject({ fps: 60, width: 3840, height: 2160 });
	});

	it("reaches the Windows helper", async () => {
		saveUserPreferences({ captureFrameRate: 30 });
		stubElectronAPI("win32");

		const request = await captureRequest(api.startNativeWindowsRecording);

		expect(request.video.fps).toBe(30);
	});

	it("reaches the macOS helper", async () => {
		saveUserPreferences({ captureFrameRate: 24 });
		stubElectronAPI("darwin");

		const request = await captureRequest(api.startNativeMacRecording);

		expect(request.video.fps).toBe(24);
	});

	it("reaches the Linux helper, in both the prepare and the start call", async () => {
		saveUserPreferences({ captureFrameRate: 120 });
		stubElectronAPI("linux");

		const request = await captureRequest(api.startNativeLinuxRecording);

		expect(request.video.fps).toBe(120);
		// The negotiated session must describe the same capture as the started one.
		expect(api.prepareNativeLinuxRecording.mock.calls[0][0].video.fps).toBe(120);
	});
});

describe("capture bitrate", () => {
	/**
	 * The 1.7x boost pays for the extra frames a 60 fps take carries. Asking for
	 * it at 30 fps buys nothing and was what the frame rate control would have
	 * left behind had it not been threaded into the bitrate too.
	 */
	it("pays the high-frame-rate boost at 60 fps", async () => {
		stubElectronAPI("darwin");

		const request = await captureRequest(api.startNativeMacRecording);

		expect(request.video.bitrate).toBe(Math.round(45_000_000 * 1.7));
	});

	it("drops the boost below 60 fps", async () => {
		saveUserPreferences({ captureFrameRate: 30 });
		stubElectronAPI("darwin");

		const request = await captureRequest(api.startNativeMacRecording);

		expect(request.video.bitrate).toBe(45_000_000);
	});

	it("is derived from the capped size, not the 4K ceiling", async () => {
		saveUserPreferences({ captureFrameRate: 30, captureResolution: "1080p" });
		stubElectronAPI("darwin");

		const request = await captureRequest(api.startNativeMacRecording);

		expect(request.video).toMatchObject({ width: 1920, height: 1080, bitrate: 18_000_000 });
	});
});

describe("microphone gain", () => {
	/**
	 * A multiplier on the mix's own levelling, not a replacement for it: at the
	 * default the request must carry exactly the 1.4x boost that shipped before the
	 * setting existed, or every existing user's recordings change loudness.
	 */
	it("leaves the request at the app's own boost by default", async () => {
		stubElectronAPI("win32");

		const request = await captureRequest(api.startNativeWindowsRecording);

		expect(request.audio.microphone.gain).toBeCloseTo(1.4);
	});

	it("multiplies the app's boost by the user's choice", async () => {
		saveUserPreferences({ microphoneGain: 2 });
		stubElectronAPI("win32");

		const request = await captureRequest(api.startNativeWindowsRecording);

		expect(request.audio.microphone.gain).toBeCloseTo(2.8);
	});

	it("reaches the Linux helper too", async () => {
		saveUserPreferences({ microphoneGain: 0.5 });
		stubElectronAPI("linux");

		const request = await captureRequest(api.startNativeLinuxRecording);

		expect(request.audio.microphone.gain).toBeCloseTo(0.7);
	});
});

describe("capture resolution cap", () => {
	it("lowers the ceiling the Windows helper is given", async () => {
		saveUserPreferences({ captureResolution: "1440p" });
		stubElectronAPI("win32");

		const request = await captureRequest(api.startNativeWindowsRecording);

		expect(request.video).toMatchObject({ width: 2560, height: 1440 });
	});

	it("travels to the Linux helper as a long edge", async () => {
		saveUserPreferences({ captureResolution: "1080p" });
		stubElectronAPI("linux");

		const request = await captureRequest(api.startNativeLinuxRecording);

		expect(request.video.maxLongEdge).toBe(1920);
	});

	/** "auto" must leave the helper's zero-copy dmabuf path untouched. */
	it("sends no long edge to the Linux helper on auto", async () => {
		stubElectronAPI("linux");

		const request = await captureRequest(api.startNativeLinuxRecording);

		expect(request.video).not.toHaveProperty("maxLongEdge");
	});
});
