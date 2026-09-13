// Quit and window lifecycle of the main process. Everything here is main.ts's own
// wiring — the ordering between a quit and the writes still in flight, and the
// close-confirm handshake — so the test drives the real module with a fake `electron`.

import { EventEmitter } from "node:events";
import os from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";

let nextId = 1;

class FakeWebContents extends EventEmitter {
	id = nextId++;
	send = vi.fn();
	getURL = () => "";
	isLoading = () => false;
	isDestroyed = () => false;
	setWindowOpenHandler = vi.fn();
	session = { setPermissionRequestHandler: vi.fn() };
}

class FakeWindow extends EventEmitter {
	webContents = new FakeWebContents();
	destroyed = false;
	close = vi.fn(() => {
		this.destroyed = true;
	});
	isDestroyed = () => this.destroyed;
	isVisible = () => true;
	isMinimized = () => false;
	show = vi.fn();
	focus = vi.fn();
	restore = vi.fn();
	showInactive = vi.fn();
	getNormalBounds = () => ({ x: 0, y: 0, width: 800, height: 600 });
	isMaximized = () => false;
}

vi.mock("electron", async () => {
	const { EventEmitter } = await import("node:events");
	const appEmitter = new EventEmitter();
	const app = Object.assign(appEmitter, {
		quit: vi.fn(),
		exit: vi.fn(),
		getPath: () => os.tmpdir(),
		getVersion: () => "2.1.0",
		getAppPath: () => process.cwd(),
		isPackaged: false,
		requestSingleInstanceLock: () => true,
		whenReady: () => Promise.resolve(),
		commandLine: { appendSwitch: vi.fn() },
		setAboutPanelOptions: vi.fn(),
		showAboutPanel: vi.fn(),
		dock: { show: vi.fn() },
		setName: vi.fn(),
	});

	const ipcMain = Object.assign(new EventEmitter(), {
		handle: vi.fn(),
		removeHandler: vi.fn(),
	});

	class BrowserWindow extends EventEmitter {
		static getAllWindows = vi.fn(() => [] as unknown[]);
		static getFocusedWindow = vi.fn(() => null);
	}

	return {
		app,
		ipcMain,
		BrowserWindow,
		Menu: {
			buildFromTemplate: vi.fn(() => ({ popup: vi.fn() })),
			setApplicationMenu: vi.fn(),
			getApplicationMenu: vi.fn(() => null),
		},
		Tray: class {
			setToolTip = vi.fn();
			setContextMenu = vi.fn();
			setImage = vi.fn();
			on = vi.fn();
			destroy = vi.fn();
		},
		nativeImage: { createFromPath: () => ({ resize: () => ({}) }) },
		clipboard: { writeText: vi.fn() },
		dialog: { showMessageBox: vi.fn(), showSaveDialog: vi.fn() },
		net: { fetch: vi.fn() },
		session: { defaultSession: { setDisplayMediaRequestHandler: vi.fn() } },
		shell: { openExternal: vi.fn(), openPath: vi.fn() },
		systemPreferences: { getMediaAccessStatus: () => "granted", askForMediaAccess: vi.fn() },
	};
});

// Mocked, not real: the real module registers ~200 handlers and imports main.ts back.
// These three exports are what the quit path uses, and the test drives them directly.
const handlersMock = vi.hoisted(() => ({
	pending: [] as Promise<unknown>[],
	endAll: vi.fn(async () => undefined),
	registerArgs: [] as unknown[],
}));

vi.mock("./ipc/handlers", async () => ({
	exportDiagnosticFile: vi.fn(),
	getSelectedDesktopSource: vi.fn(() => null),
	pendingRecordingWrites: () => handlersMock.pending,
	recordingStreams: { endAll: handlersMock.endAll },
	registerIpcHandlers: (...args: unknown[]) => {
		handlersMock.registerArgs = args;
	},
	withDeadline: <T>(work: Promise<T>, ms: number, message: string) =>
		Promise.race([
			work,
			new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(message)), ms)),
		]),
	SHORTCUTS_FILE: "/nonexistent/shortcuts.json",
}));

const shutdownStt = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("./stt", () => ({ registerSttIpc: vi.fn(), shutdownStt }));

const windowsMock = vi.hoisted(() => ({ created: [] as unknown[], order: [] as string[] }));
vi.mock("./windows", async () => {
	const make = (kind: string) =>
		vi.fn(() => {
			windowsMock.order.push(`create:${kind}`);
			const win = new FakeWindow();
			windowsMock.created.push(win);
			return win;
		});
	return {
		createEditorWindow: make("editor"),
		createHudOverlayWindow: make("hud"),
		createCountdownOverlayWindow: make("countdown"),
		createNotesWindow: make("notes"),
		createSourceSelectorWindow: make("source-selector"),
	};
});

vi.mock("./cli/args", () => ({ parseCliArgs: () => null }));
vi.mock("./cli/cliMain", () => ({ runCli: vi.fn() }));
vi.mock("./securityPolicy", () => ({
	installNavigationPolicy: vi.fn(),
	installPermissionPolicy: vi.fn(),
}));
vi.mock("./recordingsCleanup", () => ({ scheduleRecordingsCleanup: vi.fn() }));
vi.mock("./globalShortcut", () => ({
	loadAndRegisterGlobalShortcuts: vi.fn(async () => ({
		openApp: "registered",
		stopRecording: "registered",
	})),
	registerGlobalShortcut: vi.fn(() => "registered"),
	unregisterAllGlobalShortcuts: vi.fn(),
}));

/** main.ts is all module state, so every case boots it fresh. */
async function bootMain() {
	vi.resetModules();
	handlersMock.pending = [];
	handlersMock.registerArgs = [];
	handlersMock.endAll.mockClear();
	windowsMock.created = [];
	windowsMock.order = [];
	await import("./main");
	const electron = await import("electron");
	// Let the appReady chain run to registerIpcHandlers.
	await vi.waitFor(() => expect(handlersMock.registerArgs.length).toBeGreaterThan(0));
	return {
		app: electron.app as unknown as { quit: ReturnType<typeof vi.fn> } & NodeJS.EventEmitter,
		ipcMain: electron.ipcMain as unknown as NodeJS.EventEmitter,
		createEditorWindowWrapper: handlersMock.registerArgs[0] as () => void,
	};
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

beforeEach(() => {
	shutdownStt.mockClear();
});

describe("before-quit", () => {
	it("holds the quit until the recording finalisation in flight has settled", async () => {
		const { app } = await bootMain();
		const write = deferred();
		handlersMock.pending = [write.promise];

		app.emit("before-quit", { preventDefault: vi.fn() });
		await Promise.resolve();
		await Promise.resolve();

		// The stop handler is still writing the manifest: quitting now truncates it.
		expect(app.quit).not.toHaveBeenCalled();

		write.resolve();
		await vi.waitFor(() => expect(app.quit).toHaveBeenCalled());
		// Open chunk streams get flushed on the way out, not dropped.
		expect(handlersMock.endAll).toHaveBeenCalled();
	});

	it("quits anyway once the flush deadline passes", async () => {
		vi.useFakeTimers();
		try {
			const { app } = await bootMain();
			handlersMock.pending = [new Promise<void>(() => undefined)];

			app.emit("before-quit", { preventDefault: vi.fn() });
			await vi.advanceTimersByTimeAsync(10_000);

			expect(app.quit).toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
});
