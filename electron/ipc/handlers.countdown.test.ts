// The countdown overlay is what the recorder waits on before a take starts, so a
// handler that never resolves is a recording that never happens.

import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import type { BrowserWindow } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../main", () => ({ RECORDINGS_DIR: path.join(os.tmpdir(), "capturia-test-recordings") }));

const ipc = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => unknown>() }));

vi.mock("electron", async () => {
	const { EventEmitter: EE } = await import("node:events");
	return {
		app: Object.assign(new EE(), {
			getPath: () => os.tmpdir(),
			getVersion: () => "2.1.0",
			isPackaged: false,
			getAppPath: () => process.cwd(),
			quit: vi.fn(),
			commandLine: { appendSwitch: vi.fn() },
		}),
		BrowserWindow: class extends EE {},
		ipcMain: Object.assign(new EE(), {
			handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
				ipc.handlers.set(channel, fn);
			},
			removeHandler: vi.fn(),
		}),
		desktopCapturer: {},
		dialog: {},
		screen: {},
		shell: {},
		systemPreferences: { getMediaAccessStatus: () => "granted" },
	};
});

class FakeOverlay extends EventEmitter {
	webContents = Object.assign(new EventEmitter(), {
		isLoading: () => true,
		send: vi.fn(),
	});
	isDestroyed = () => false;
	isVisible = () => true;
	showInactive = vi.fn();
}

/** Registers the real handlers against a countdown overlay that is still loading. */
async function showCountdownOn(overlay: FakeOverlay) {
	const { registerIpcHandlers } = await import("./handlers");
	const asWindow = overlay as unknown as BrowserWindow;
	const nullWindow = () => null;
	registerIpcHandlers(
		vi.fn(),
		() => asWindow,
		() => asWindow,
		() => asWindow,
		nullWindow,
		nullWindow,
		nullWindow,
		() => asWindow,
	);
	const show = ipc.handlers.get("countdown-overlay-show");
	if (!show) throw new Error("countdown-overlay-show was not registered");
	return show({}, 3, 1) as Promise<void>;
}

afterEach(() => {
	vi.useRealTimers();
});

describe("countdown-overlay-show", () => {
	it("resolves on did-finish-load even when ready-to-show already fired", async () => {
		const overlay = new FakeOverlay();
		// The overlay rendered on a previous take: its one `ready-to-show` is long gone,
		// while `isLoading()` is still true for the load now in progress.
		overlay.emit("ready-to-show");

		const shown = showCountdownOn(overlay);
		overlay.webContents.emit("did-finish-load");

		await expect(shown).resolves.toBeUndefined();
		expect(overlay.webContents.send).toHaveBeenCalledWith("countdown-overlay-value", 3, 1);
	});

	it("shows the overlay anyway when the load never finishes", async () => {
		vi.useFakeTimers();
		const overlay = new FakeOverlay();

		const shown = showCountdownOn(overlay);
		await vi.advanceTimersByTimeAsync(3_000);

		await expect(shown).resolves.toBeUndefined();
		expect(overlay.webContents.send).toHaveBeenCalledWith("countdown-overlay-value", 3, 1);
	});
});
