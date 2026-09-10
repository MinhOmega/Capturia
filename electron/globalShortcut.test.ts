// The four outcomes of registering a global hotkey.
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

/** The accelerator registry is module state, so each case gets a fresh module. */
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

describe("registerGlobalShortcut", () => {
	it("reports 'registered' and binds the accelerator", async () => {
		const { registerGlobalShortcut } = await freshModule();
		register.mockReturnValue(true);

		expect(registerGlobalShortcut("openApp", BINDING, () => undefined)).toBe("registered");
		expect(register).toHaveBeenCalledWith("CommandOrControl+Shift+O", expect.any(Function));
	});

	it("reports 'unchanged' — not 'registered' — when the binding is already live", async () => {
		const { registerGlobalShortcut } = await freshModule();
		register.mockReturnValue(true);
		registerGlobalShortcut("openApp", BINDING, () => undefined);
		register.mockClear();

		expect(registerGlobalShortcut("openApp", BINDING, () => undefined)).toBe("unchanged");
		// The point of the distinction: nothing was registered by that call.
		expect(register).not.toHaveBeenCalled();
	});

	it("reports 'conflict' when the key is taken but the session works", async () => {
		const { registerGlobalShortcut } = await freshModule();
		// The requested key fails; a probe nothing owns succeeds.
		register.mockImplementation((accelerator: string) => accelerator.includes("F19"));

		expect(registerGlobalShortcut("openApp", BINDING, () => undefined)).toBe("conflict");
		// A probe that succeeded must not be left holding a global key.
		expect(unregister).toHaveBeenCalledWith("CommandOrControl+Alt+Shift+F19");
	});

	it("reports 'unavailable' when every accelerator fails", async () => {
		const { registerGlobalShortcut } = await freshModule();
		// Measured behaviour of a Wayland session: nothing registers, whatever the key.
		register.mockReturnValue(false);

		expect(registerGlobalShortcut("openApp", BINDING, () => undefined)).toBe("unavailable");
	});

	it("keeps the working binding when a later registration fails", async () => {
		const { registerGlobalShortcut } = await freshModule();
		register.mockReturnValue(true);
		registerGlobalShortcut("openApp", BINDING, () => undefined);
		unregister.mockClear();
		register.mockReturnValue(false);

		expect(registerGlobalShortcut("openApp", { key: "j", ctrl: true }, () => undefined)).toBe(
			"unavailable",
		);
		// The old accelerator is still ours: nothing unregistered it.
		expect(unregister).not.toHaveBeenCalledWith("CommandOrControl+Shift+O");
	});
});

describe("a second global action", () => {
	/**
	 * The registry used to be one `currentAccelerator`, which is fine for one hotkey
	 * and silently wrong for two: re-registering either would have released the
	 * other's key.
	 */
	it("keeps each action's accelerator apart", async () => {
		const { registerGlobalShortcut } = await freshModule();
		register.mockReturnValue(true);

		registerGlobalShortcut("openApp", BINDING, () => undefined);
		registerGlobalShortcut("stopRecording", { key: "s", ctrl: true, shift: true }, () => undefined);
		unregister.mockClear();

		// Moving ONE of them releases only its own key.
		registerGlobalShortcut("stopRecording", { key: "k", ctrl: true }, () => undefined);

		expect(unregister).toHaveBeenCalledWith("CommandOrControl+Shift+S");
		expect(unregister).not.toHaveBeenCalledWith("CommandOrControl+Shift+O");
	});

	it("reports 'unchanged' per action, not across them", async () => {
		const { registerGlobalShortcut } = await freshModule();
		register.mockReturnValue(true);
		registerGlobalShortcut("openApp", BINDING, () => undefined);

		// Same binding, different action: nothing about this call is unchanged.
		expect(registerGlobalShortcut("stopRecording", BINDING, () => undefined)).not.toBe("unchanged");
	});
});

describe("loadAndRegisterGlobalShortcuts", () => {
	it("returns the startup outcome for every global action instead of discarding it", async () => {
		const { loadAndRegisterGlobalShortcuts } = await freshModule();
		register.mockReturnValue(false);

		// No shortcuts file, so this takes the default-binding path — the one that
		// runs on a fresh install, and the one whose result used to be dropped.
		await expect(
			loadAndRegisterGlobalShortcuts({
				openApp: () => undefined,
				stopRecording: () => undefined,
			}),
		).resolves.toEqual({ openApp: "unavailable", stopRecording: "unavailable" });
	});
});
