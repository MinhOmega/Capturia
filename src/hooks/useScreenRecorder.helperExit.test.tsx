// @vitest-environment jsdom
//
// A capture helper that dies mid-take used to be invisible: Windows and macOS
// swallowed the process's `error`/`close` into a console warning, Linux only
// told promises that happened to be pending, and the HUD went on counting
// elapsed seconds against a process that no longer existed. The user believed
// they were recording.
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/contexts/I18nContext", () => ({
	useScopedT: () => (key: string) => key,
}));

vi.mock("sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { toast } from "sonner";
import { useScreenRecorder } from "./useScreenRecorder";

type ElectronAPI = Window["electronAPI"];

const SOURCE = { id: "screen:0:0", name: "Screen 1", display_id: "1", thumbnail: "" };

let api: Record<string, ReturnType<typeof vi.fn>>;
/** The renderer's subscription, captured so the test can play the main process. */
let announceHelperExit: ((payload: { platform: string; detail: string }) => void) | null;

function stubElectronAPI() {
	announceHelperExit = null;
	api = {
		getRecordingPrefs: vi.fn(async () => null),
		getPlatform: vi.fn(() => "win32"),
		getSelectedSource: vi.fn(async () => SOURCE),
		isNativeWindowsCaptureAvailable: vi.fn(async () => ({ success: true, available: true })),
		startNativeWindowsRecording: vi.fn(async () => ({ success: true, recordingId: 7 })),
		stopNativeWindowsRecording: vi.fn(async () => ({ success: true })),
		showCountdownOverlay: vi.fn(async () => true),
		setCountdownOverlayValue: vi.fn(async () => true),
		hideCountdownOverlay: vi.fn(async () => true),
		setCurrentRecordingSession: vi.fn(async () => undefined),
		setCurrentVideoPath: vi.fn(async () => undefined),
		switchToEditor: vi.fn(async () => undefined),
		onNativeCaptureHelperExited: vi.fn((callback: typeof announceHelperExit) => {
			announceHelperExit = callback;
			return () => {
				announceHelperExit = null;
			};
		}),
	};
	window.electronAPI = api as unknown as ElectronAPI;
}

type RecorderView = { result: { current: ReturnType<typeof useScreenRecorder> } };

async function settle(ms = 0) {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});
}

async function startNativeRecording(view: RecorderView) {
	await act(async () => {
		view.result.current.toggleRecording();
	});
	await settle(3_500);
	expect(view.result.current.recording).toBe(true);
}

async function helperExits(detail = "code=null signal=SIGKILL") {
	expect(announceHelperExit).toBeTypeOf("function");
	await act(async () => {
		announceHelperExit?.({ platform: "win32", detail });
	});
	await settle();
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(console, "error").mockImplementation(() => undefined);
	stubElectronAPI();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("useScreenRecorder native capture helper exit", () => {
	it("says so and leaves the recording state when the helper dies mid-take", async () => {
		const view = renderHook(() => useScreenRecorder());
		await startNativeRecording(view);

		await helperExits();

		expect(toast.error).toHaveBeenCalledWith("recording.helperExited");
		// The whole point: the HUD must not sit there looking like it is recording.
		expect(view.result.current.recording).toBe(false);
		// Through the normal stop, so whatever the dead helper wrote is salvaged
		// rather than abandoned.
		expect(api.stopNativeWindowsRecording).toHaveBeenCalled();
	});

	it("ignores the clean exit that follows a stop the app asked for", async () => {
		const view = renderHook(() => useScreenRecorder());
		await startNativeRecording(view);

		// Press stop, then let the helper exit as it always does afterwards.
		await act(async () => {
			view.result.current.toggleRecording();
		});
		await helperExits("code=0 signal=null");

		expect(toast.error).not.toHaveBeenCalledWith("recording.helperExited");
		expect(api.stopNativeWindowsRecording).toHaveBeenCalledTimes(1);
	});

	it("ignores an exit while nothing is recording", async () => {
		renderHook(() => useScreenRecorder());
		await settle();

		await helperExits();

		expect(toast.error).not.toHaveBeenCalled();
		expect(api.stopNativeWindowsRecording).not.toHaveBeenCalled();
	});
});
