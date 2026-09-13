// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/contexts/I18nContext", () => ({
	useScopedT: () => (key: string) => key,
}));

vi.mock("sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock("@fix-webm-duration/fix", () => ({
	fixWebmDuration: async () => ({ arrayBuffer: async () => new ArrayBuffer(8) }),
}));

vi.mock("@/lib/audioMix", () => ({
	MIC_GAIN_BOOST: 1,
	mixAudioTracks: () => ({ context: null, track: null }),
}));

vi.mock("./recorderHandle", () => ({
	createRecorderHandle: () => {
		const recorder = {
			state: "recording",
			stop: () => {
				recorder.state = "inactive";
			},
			pause: () => undefined,
			resume: () => undefined,
			addEventListener: () => undefined,
		};
		return {
			recorder,
			recordedBlobPromise: Promise.resolve({ size: 10 }),
			isStreaming: () => false,
			discard: async () => undefined,
		};
	},
}));

import { useScreenRecorder } from "./useScreenRecorder";

type ElectronAPI = Window["electronAPI"];

const SOURCE = { id: "screen:0:0", name: "Screen 1", display_id: "1", thumbnail: "" };

let api: Record<string, ReturnType<typeof vi.fn>>;

function fakeTrack() {
	return {
		getSettings: () => ({ width: 1920, height: 1080, frameRate: 60 }),
		applyConstraints: async () => undefined,
		stop: () => undefined,
	};
}

/**
 * win32 WITHOUT the WGC helper: the one configuration that reaches the browser
 * pipeline and can still honour the user's cursor choice.
 */
function stubBrowserPipeline() {
	api = {
		getRecordingPrefs: vi.fn(async () => null),
		getPlatform: vi.fn(() => "win32"),
		getSelectedSource: vi.fn(async () => SOURCE),
		isNativeWindowsCaptureAvailable: vi.fn(async () => ({
			success: true,
			available: false,
			reason: "missing-helper",
		})),
		showCountdownOverlay: vi.fn(async () => true),
		setCountdownOverlayValue: vi.fn(async () => true),
		hideCountdownOverlay: vi.fn(async () => true),
		setRecordingState: vi.fn(),
		storeRecordedSession: vi.fn(async () => ({ success: true, path: "/tmp/rec.webm" })),
		setCurrentRecordingSession: vi.fn(async () => undefined),
		setCurrentVideoPath: vi.fn(async () => undefined),
		switchToEditor: vi.fn(async () => undefined),
		discardCursorTelemetry: vi.fn(),
	};
	window.electronAPI = api as unknown as ElectronAPI;

	const screenStream = {
		getVideoTracks: () => [fakeTrack()],
		getAudioTracks: () => [],
		getTracks: () => [fakeTrack()],
	};
	Object.defineProperty(navigator, "mediaDevices", {
		configurable: true,
		value: { getDisplayMedia: vi.fn(async () => screenStream) },
	});
	(globalThis as unknown as { MediaStream: unknown }).MediaStream = class {
		private tracks: unknown[] = [];
		addTrack(track: unknown) {
			this.tracks.push(track);
		}
		getTracks() {
			return this.tracks;
		}
		getAudioTracks() {
			return [];
		}
		getVideoTracks() {
			return this.tracks;
		}
	};
	(globalThis as unknown as { MediaRecorder: unknown }).MediaRecorder = {
		isTypeSupported: () => true,
	};
}

beforeEach(() => {
	vi.useFakeTimers();
	localStorage.clear();
	stubBrowserPipeline();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("the stop closure", () => {
	/**
	 * `stopRecording` lives in a ref, and `useRef` keeps only the FIRST render's
	 * argument. When the ref was never re-assigned, every stop finalized through
	 * the first render's `finalizeRecording` — which still held the hardcoded
	 * initial `"editable-overlay"` — and the saved session disagreed with the
	 * video it described.
	 */
	it("saves the cursor mode chosen after mount, not the initial one", async () => {
		const view = renderHook(() => useScreenRecorder());

		act(() => {
			view.result.current.setCursorCaptureMode("system");
		});

		await act(async () => {
			view.result.current.toggleRecording();
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(3_500);
		});
		expect(view.result.current.recording).toBe(true);

		await act(async () => {
			view.result.current.toggleRecording();
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});

		expect(api.storeRecordedSession).toHaveBeenCalledTimes(1);
		expect(api.storeRecordedSession.mock.calls[0][0]).toMatchObject({
			cursorCaptureMode: "system",
		});
	});
});
