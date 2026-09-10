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

/** Enough of the API for a native Windows take to start. */
function stubElectronAPI() {
	api = {
		getRecordingPrefs: vi.fn(async () => null),
		getPlatform: vi.fn(() => "win32"),
		getSelectedSource: vi.fn(async () => SOURCE),
		isNativeWindowsCaptureAvailable: vi.fn(async () => ({ success: true, available: true })),
		startNativeWindowsRecording: vi.fn(async () => ({ success: true, recordingId: 7 })),
		showCountdownOverlay: vi.fn(async () => true),
		setCountdownOverlayValue: vi.fn(async () => true),
		hideCountdownOverlay: vi.fn(async () => true),
		setCurrentRecordingSession: vi.fn(async () => undefined),
		setCurrentVideoPath: vi.fn(async () => undefined),
		switchToEditor: vi.fn(async () => undefined),
	};
	window.electronAPI = api as unknown as ElectronAPI;
}

/** Presses record and lets every already-resolved promise settle, WITHOUT advancing
 *  the clock — so anything that starts here started without waiting. */
async function pressRecord() {
	const view = renderHook(() => useScreenRecorder());
	await act(async () => {
		view.result.current.toggleRecording();
	});
	await act(async () => {
		await vi.advanceTimersByTimeAsync(0);
	});
	return view;
}

beforeEach(() => {
	vi.useFakeTimers();
	localStorage.clear();
	stubElectronAPI();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("countdown length", () => {
	it("counts three seconds down by default", async () => {
		const view = await pressRecord();

		expect(api.showCountdownOverlay).toHaveBeenCalledWith(3, expect.any(Number));
		expect(api.startNativeWindowsRecording).not.toHaveBeenCalled();

		await act(async () => {
			await vi.advanceTimersByTimeAsync(3_500);
		});
		expect(api.startNativeWindowsRecording).toHaveBeenCalledTimes(1);
		expect(view.result.current.recording).toBe(true);
	});

	it("counts ten seconds down when asked to", async () => {
		saveUserPreferences({ countdownSeconds: 10 });

		await pressRecord();

		expect(api.showCountdownOverlay).toHaveBeenCalledWith(10, expect.any(Number));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(3_500);
		});
		// Still counting: a longer countdown must not start early.
		expect(api.startNativeWindowsRecording).not.toHaveBeenCalled();

		await act(async () => {
			await vi.advanceTimersByTimeAsync(7_000);
		});
		expect(api.startNativeWindowsRecording).toHaveBeenCalledTimes(1);
	});

	/**
	 * The point of the whole setting. 0 is a value, not a missing one — a truthiness
	 * check on the stored preference would read it as "unset" and hand back the
	 * 3 s default, which is the bug this asserts against.
	 */
	it("starts immediately at 0, with no overlay at all", async () => {
		saveUserPreferences({ countdownSeconds: 0 });

		const view = await pressRecord();

		expect(api.startNativeWindowsRecording).toHaveBeenCalledTimes(1);
		expect(view.result.current.recording).toBe(true);
		expect(api.showCountdownOverlay).not.toHaveBeenCalled();
		expect(api.setCountdownOverlayValue).not.toHaveBeenCalled();
	});

	it("survives the round trip through storage as 0, not as the default", async () => {
		saveUserPreferences({ countdownSeconds: 0 });

		const view = await pressRecord();

		expect(view.result.current.countdownSeconds).toBe(0);
	});
});
