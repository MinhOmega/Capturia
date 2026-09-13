// The `measure-audio-loudness` handler spends an approval like every other read of a
// renderer-supplied path: a path the renderer merely names — a recording it was never
// granted, someone else's media — must be refused BEFORE ffmpeg is spawned on it.
import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({ handle: vi.fn() }));
const measureAudioLoudness = vi.hoisted(() => vi.fn(async () => -23));

vi.mock("electron", () => ({
	app: {
		getPath: () => "/tmp/capturia-test",
		getAppPath: () => "/tmp/capturia-test",
		getVersion: () => "0.0.0-test",
		getName: () => "Capturia",
		on: vi.fn(),
		whenReady: async () => undefined,
		isPackaged: false,
	},
	BrowserWindow: class {
		static getAllWindows() {
			return [];
		}
	},
	desktopCapturer: { getSources: vi.fn() },
	dialog: {},
	ipcMain: { handle: electron.handle, on: vi.fn(), removeHandler: vi.fn() },
	screen: { getAllDisplays: () => [], getPrimaryDisplay: () => ({}) },
	shell: {},
	systemPreferences: { getMediaAccessStatus: () => "granted" },
	nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
}));
vi.mock("../main", () => ({ RECORDINGS_DIR: "/tmp/capturia-test/recordings" }));
vi.mock("../media/audioLoudness", () => ({ measureAudioLoudness }));

const { registerIpcHandlers } = await import("./handlers");

type Handler = (event: unknown, ...args: unknown[]) => Promise<{ success: boolean }>;

function loudnessHandler(): Handler {
	electron.handle.mockClear();
	const noWindow = () => null;
	registerIpcHandlers(
		() => undefined,
		(() => null) as never,
		(() => null) as never,
		(() => null) as never,
		noWindow,
		noWindow,
		noWindow,
	);
	const entry = electron.handle.mock.calls.find(([name]) => name === "measure-audio-loudness");
	if (!entry) throw new Error("measure-audio-loudness was never registered");
	return entry[1] as Handler;
}

describe("measure-audio-loudness IPC", () => {
	beforeEach(() => {
		measureAudioLoudness.mockClear();
	});

	it("refuses a path the renderer was never granted, without spawning ffmpeg", async () => {
		const handle = loudnessHandler();

		// An existing media file outside every approved root: the recordings folders, a
		// file the user picked, or a loaded project's assets.
		expect(await handle(null, "/etc/shadow.mp4")).toEqual({
			success: false,
			message: "File path is not approved",
		});
		expect(measureAudioLoudness).not.toHaveBeenCalled();
	});

	it("refuses an empty or missing path the same way", async () => {
		const handle = loudnessHandler();

		expect((await handle(null, "")).success).toBe(false);
		expect((await handle(null, undefined)).success).toBe(false);
		expect(measureAudioLoudness).not.toHaveBeenCalled();
	});
});
