import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Boots `main.ts` far enough to own the two renderer-driven quit channels, with every
 * window, tray and menu replaced by a no-op stand-in. The take state is reached the same
 * way the app reaches it: through the `onRecordingStateChange` callback main hands to
 * `registerIpcHandlers`.
 */
const hoisted = vi.hoisted(() => {
	/** Any property is a no-op method; the few main.ts actually reads are answered. */
	const stub = (): Record<string, unknown> =>
		new Proxy(
			{},
			{
				get: (target, property) => {
					if (property in target) return Reflect.get(target, property);
					if (property === "isDestroyed") return () => false;
					if (property === "isVisible") return () => true;
					if (property === "isMinimized") return () => false;
					if (property === "getURL") return () => "http://localhost/index.html";
					if (property === "webContents") return stub();
					if (property === "id") return 1;
					if (property === "then") return undefined;
					return () => undefined;
				},
			},
		);
	return {
		stub,
		listeners: new Map<string, (...args: unknown[]) => unknown>(),
		quit: vi.fn(),
		onRecordingStateChange: null as null | ((recording: boolean, sourceName: string) => void),
	};
});

vi.mock("electron", () => {
	const window = hoisted.stub();
	return {
		app: Object.assign(hoisted.stub(), {
			quit: hoisted.quit,
			whenReady: () => Promise.resolve(),
			requestSingleInstanceLock: () => true,
			getPath: () => "/tmp/capturia-main-test",
			getVersion: () => "0.0.0",
			getName: () => "Capturia",
			isPackaged: false,
			commandLine: { appendSwitch: vi.fn() },
			on: vi.fn(),
		}),
		BrowserWindow: Object.assign(
			function BrowserWindow() {
				return window;
			},
			{ fromWebContents: () => window, getAllWindows: () => [] },
		),
		clipboard: hoisted.stub(),
		dialog: { showMessageBox: vi.fn(async () => ({ response: 1 })) },
		ipcMain: {
			on: (channel: string, fn: (...args: unknown[]) => unknown) =>
				hoisted.listeners.set(channel, fn),
			handle: vi.fn(),
			removeHandler: vi.fn(),
		},
		Menu: Object.assign(hoisted.stub(), {
			buildFromTemplate: () => hoisted.stub(),
			setApplicationMenu: vi.fn(),
		}),
		nativeImage: { createFromPath: () => hoisted.stub(), createEmpty: () => hoisted.stub() },
		net: hoisted.stub(),
		session: { defaultSession: hoisted.stub() },
		shell: hoisted.stub(),
		systemPreferences: { getMediaAccessStatus: () => "granted" },
		Tray: function Tray() {
			return hoisted.stub();
		},
	};
});

vi.mock("./windows", () => ({
	createCountdownOverlayWindow: () => hoisted.stub(),
	createEditorWindow: () => hoisted.stub(),
	createHudOverlayWindow: () => hoisted.stub(),
	createNotesWindow: () => hoisted.stub(),
	createSourceSelectorWindow: () => hoisted.stub(),
}));

vi.mock("./ipc/handlers", () => ({
	exportDiagnosticFile: vi.fn(),
	getSelectedDesktopSource: () => null,
	readableApprovedPath: () => null,
	registerIpcHandlers: (...args: unknown[]) => {
		hoisted.onRecordingStateChange = args[8] as (recording: boolean, sourceName: string) => void;
	},
}));

vi.mock("./stt", () => ({ registerSttIpc: vi.fn(), shutdownStt: vi.fn(async () => undefined) }));
vi.mock("./globalShortcut", () => ({
	loadAndRegisterGlobalShortcuts: vi.fn(async () => ({})),
	registerGlobalShortcut: vi.fn(),
	unregisterAllGlobalShortcuts: vi.fn(),
}));
vi.mock("./recordingsCleanup", () => ({ scheduleRecordingsCleanup: vi.fn() }));
vi.mock("./securityPolicy", () => ({
	installNavigationPolicy: vi.fn(),
	installPermissionPolicy: vi.fn(),
}));
vi.mock("./main-process-errors", () => ({ installMainProcessErrorGuards: vi.fn() }));
vi.mock("./cli/cliMain", () => ({ runCli: vi.fn() }));

function setRecording(recording: boolean) {
	hoisted.onRecordingStateChange?.(recording, "Screen 1");
}

describe("quitting while a take is running", () => {
	beforeAll(async () => {
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		await import("./main");
		// Let the `whenReady` chain register the handlers it owns.
		await vi.waitFor(() => expect(hoisted.onRecordingStateChange).not.toBeNull());
	});

	it("caps what a renderer console line can write to stdout", () => {
		const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		try {
			hoisted.listeners.get("renderer-console-log")?.({}, "x".repeat(64 * 1024));
			expect(write).toHaveBeenCalledOnce();
			expect(String(write.mock.calls[0][0]).length).toBeLessThanOrEqual(8 * 1024 + 32);
		} finally {
			write.mockRestore();
		}
	});

	it.each(["app-quit", "hud-overlay-close"])("%s is refused mid-recording", (channel) => {
		setRecording(true);
		hoisted.quit.mockClear();

		hoisted.listeners.get(channel)?.();
		expect(hoisted.quit).not.toHaveBeenCalled();

		// …and still quits once the take is over, which is the whole point of the flag.
		setRecording(false);
		hoisted.listeners.get(channel)?.();
		expect(hoisted.quit).toHaveBeenCalledOnce();
	});
});
