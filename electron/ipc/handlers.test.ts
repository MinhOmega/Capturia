import { beforeEach, describe, expect, it, vi } from "vitest";

const RECORDINGS_DIR = "/tmp/capturia-test/recordings";

const hoisted = vi.hoisted(() => ({
	handlers: new Map<string, (...args: never[]) => unknown>(),
	showItemInFolder: vi.fn(),
	openPath: vi.fn(async () => ""),
	getSources: vi.fn(async () => []),
}));

vi.mock("electron", () => ({
	app: {
		getPath: () => "/tmp/capturia-test",
		getName: () => "Capturia",
		getVersion: () => "0.0.0",
		isPackaged: false,
		on: vi.fn(),
	},
	BrowserWindow: Object.assign(vi.fn(), {
		fromWebContents: () => null,
		getAllWindows: () => [],
	}),
	desktopCapturer: { getSources: hoisted.getSources },
	dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn(), showMessageBox: vi.fn() },
	ipcMain: {
		handle: (channel: string, fn: (...args: never[]) => unknown) =>
			hoisted.handlers.set(channel, fn),
		on: vi.fn(),
		removeHandler: vi.fn(),
	},
	screen: { getPrimaryDisplay: () => ({ scaleFactor: 1 }), getAllDisplays: () => [] },
	shell: {
		showItemInFolder: hoisted.showItemInFolder,
		openPath: hoisted.openPath,
		openExternal: vi.fn(),
	},
	systemPreferences: { getMediaAccessStatus: () => "granted" },
	nativeImage: { createFromPath: vi.fn() },
}));

vi.mock("../main", () => ({ RECORDINGS_DIR }));

const { registerIpcHandlers } = await import("./handlers");

function invoke(channel: string, ...args: unknown[]) {
	const handler = hoisted.handlers.get(channel);
	if (!handler) throw new Error(`No handler registered for ${channel}`);
	return handler(...([{}, ...args] as never[]));
}

beforeEach(() => {
	hoisted.handlers.clear();
	hoisted.showItemInFolder.mockClear();
	hoisted.openPath.mockClear();
	hoisted.getSources.mockClear();
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
	registerIpcHandlers(
		vi.fn(),
		(() => null) as never,
		(() => null) as never,
		(() => null) as never,
		() => null,
		() => null,
		() => null,
	);
});

describe("reveal-in-folder", () => {
	it("refuses a path that is neither an approved read nor an approved export", async () => {
		await expect(invoke("reveal-in-folder", "/etc/passwd")).resolves.toMatchObject({
			success: false,
		});
		expect(hoisted.showItemInFolder).not.toHaveBeenCalled();
		expect(hoisted.openPath).not.toHaveBeenCalled();
	});

	it("still reveals a recording, which is what the real callers hand it", async () => {
		const recording = `${RECORDINGS_DIR}/take.webm`;
		await expect(invoke("reveal-in-folder", recording)).resolves.toMatchObject({ success: true });
		expect(hoisted.showItemInFolder).toHaveBeenCalledWith(recording);
	});
});
