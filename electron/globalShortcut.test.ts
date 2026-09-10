// The four outcomes of registering the openApp hotkey.
//
// This exists because the module used to answer `boolean`, which collapsed two
// pairs of distinct states: "registered" with "nothing to do", and "that key is
// taken" with "this session cannot do global shortcuts at all". The second pair is
// what the user is told, and getting it wrong sends a Wayland user through every
// key on the keyboard looking for one that works.

import { beforeEach, describe, expect, it, vi } from "vitest";

const register = vi.fn();
const unregister = vi.fn();
const isRegistered = vi.fn();

vi.mock("electron", () => ({
	globalShortcut: {
		register: (...args: unknown[]) => register(...args),
		unregister: (...args: unknown[]) => unregister(...args),
		isRegistered: (...args: unknown[]) => isRegistered(...args),
		unregisterAll: vi.fn(),
	},
}));

// Imported only for SHORTCUTS_FILE; the real module pulls in the whole IPC layer.
vi.mock("./ipc/handlers", () => ({ SHORTCUTS_FILE: "/nonexistent/shortcuts.json" }));

/** `currentAccelerator` is module state, so each case gets a fresh module. */
async function freshModule() {
	vi.resetModules();
	return import("./globalShortcut");
}

const BINDING = { key: "o", ctrl: true, shift: true };

beforeEach(() => {
	register.mockReset();
	unregister.mockReset();
	isRegistered.mockReset();
	isRegistered.mockReturnValue(false);
});

describe("registerOpenAppShortcut", () => {
	it("reports 'registered' and binds the accelerator", async () => {
		const { registerOpenAppShortcut } = await freshModule();
		register.mockReturnValue(true);

		expect(registerOpenAppShortcut(BINDING, () => undefined)).toBe("registered");
		expect(register).toHaveBeenCalledWith("CommandOrControl+Shift+O", expect.any(Function));
	});

	it("reports 'unchanged' — not 'registered' — when the binding is already live", async () => {
		const { registerOpenAppShortcut } = await freshModule();
		register.mockReturnValue(true);
		registerOpenAppShortcut(BINDING, () => undefined);
		register.mockClear();

		expect(registerOpenAppShortcut(BINDING, () => undefined)).toBe("unchanged");
		// The point of the distinction: nothing was registered by that call.
		expect(register).not.toHaveBeenCalled();
	});

	it("reports 'conflict' when the key is taken but the session works", async () => {
		const { registerOpenAppShortcut } = await freshModule();
		// The requested key fails; a probe nothing owns succeeds.
		register.mockImplementation((accelerator: string) => accelerator.includes("F19"));

		expect(registerOpenAppShortcut(BINDING, () => undefined)).toBe("conflict");
		// A probe that succeeded must not be left holding a global key.
		expect(unregister).toHaveBeenCalledWith("CommandOrControl+Alt+Shift+F19");
	});

	it("reports 'unavailable' when every accelerator fails", async () => {
		const { registerOpenAppShortcut } = await freshModule();
		// Measured behaviour of a Wayland session: nothing registers, whatever the key.
		register.mockReturnValue(false);

		expect(registerOpenAppShortcut(BINDING, () => undefined)).toBe("unavailable");
	});

	it("keeps the working binding when a later registration fails", async () => {
		const { registerOpenAppShortcut } = await freshModule();
		register.mockReturnValue(true);
		registerOpenAppShortcut(BINDING, () => undefined);
		unregister.mockClear();
		register.mockReturnValue(false);

		expect(registerOpenAppShortcut({ key: "j", ctrl: true }, () => undefined)).toBe("unavailable");
		// The old accelerator is still ours: nothing unregistered it.
		expect(unregister).not.toHaveBeenCalledWith("CommandOrControl+Shift+O");
	});
});

describe("loadAndRegisterGlobalShortcut", () => {
	it("returns the startup outcome instead of discarding it", async () => {
		const { loadAndRegisterGlobalShortcut } = await freshModule();
		register.mockReturnValue(false);

		// No shortcuts file, so this takes the default-binding path — the one that
		// runs on a fresh install, and the one whose result used to be dropped.
		await expect(loadAndRegisterGlobalShortcut(() => undefined)).resolves.toBe("unavailable");
	});
});
