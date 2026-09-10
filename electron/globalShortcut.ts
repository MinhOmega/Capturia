import fs from "node:fs/promises";
import { globalShortcut } from "electron";
import {
	DEFAULT_SHORTCUTS,
	GLOBAL_SHORTCUT_ACTIONS,
	type GlobalShortcutAction,
	type GlobalShortcutStatuses,
	type ShortcutBinding,
	type ShortcutStatus,
} from "../src/lib/shortcuts";
import { SHORTCUTS_FILE } from "./ipc/handlers";

// Maps KeyboardEvent.key values to Electron accelerator key names
const KEY_TO_ACCELERATOR: Record<string, string> = {
	" ": "Space",
	"+": "Plus",
	"-": "numsub",
	"*": "nummult",
	"/": "numdiv",
	arrowup: "Up",
	arrowdown: "Down",
	arrowleft: "Left",
	arrowright: "Right",
	escape: "Escape",
	enter: "Return",
	backspace: "Backspace",
	delete: "Delete",
	tab: "Tab",
};

function bindingToAccelerator(binding: ShortcutBinding): string {
	const parts: string[] = [];
	if (binding.ctrl) parts.push("CommandOrControl");
	if (binding.shift) parts.push("Shift");
	if (binding.alt) parts.push("Alt");

	const keyLower = binding.key.toLowerCase();
	const acceleratorKey = KEY_TO_ACCELERATOR[keyLower] ?? binding.key.toUpperCase();
	parts.push(acceleratorKey);

	return parts.join("+");
}

/**
 * The accelerator each action currently holds, so a re-register knows what to
 * release and an unchanged binding can be recognised as such.
 *
 * Per action rather than one slot: two global hotkeys means the openApp key must
 * not be released because the stop key changed.
 */
const currentAccelerators: Partial<Record<GlobalShortcutAction, string>> = {};

/**
 * Accelerators nothing plausibly binds, used only to classify a failure.
 *
 * A genuine conflict is specific to ONE key; a session that cannot do global
 * shortcuts at all fails every one of them. Two probes, so the freak case of some
 * other app owning the first cannot turn into a wrong "unavailable" claim.
 */
const PROBE_ACCELERATORS = ["CommandOrControl+Alt+Shift+F19", "CommandOrControl+Alt+Shift+F18"];

/**
 * Whether this session can register ANY global shortcut.
 *
 * Asked by trying, not by reading the environment. Electron exposes no "are global
 * shortcuts supported" API, and deciding from `XDG_SESSION_TYPE` would be a
 * prediction about a compositor rather than an observation: measured on Ubuntu
 * GNOME/Wayland (electron 41.2.1) EVERY accelerator fails, under both
 * `--ozone-platform=wayland` and `=x11` — but KWin and the rest are free to differ,
 * and telling a user their session cannot do something it can is a worse lie than
 * the silence this replaces. So: register a key nothing owns and see what happens.
 */
function sessionAcceptsGlobalShortcuts(): boolean {
	return PROBE_ACCELERATORS.some((probe) => {
		// Registered already means the API works, and it is not ours to unregister.
		if (globalShortcut.isRegistered(probe)) return true;
		if (!globalShortcut.register(probe, () => undefined)) return false;
		globalShortcut.unregister(probe);
		return true;
	});
}

export type { ShortcutStatus };

export function registerGlobalShortcut(
	action: GlobalShortcutAction,
	binding: ShortcutBinding,
	onTrigger: () => void,
): ShortcutStatus {
	const accelerator = bindingToAccelerator(binding);

	// Deliberately NOT "registered": this call registered nothing. Both were `true`
	// before, which let a caller report success for a hotkey that may be dead.
	if (accelerator === currentAccelerators[action]) {
		return "unchanged";
	}

	// Register the new shortcut before unregistering the old, so a failure leaves the old binding intact
	const success = globalShortcut.register(accelerator, onTrigger);

	if (success) {
		const previous = currentAccelerators[action];
		if (previous) {
			globalShortcut.unregister(previous);
		}
		currentAccelerators[action] = accelerator;
		console.log(`Global shortcut registered for ${action}: ${accelerator}`);
		return "registered";
	}

	// Which of the two failures this is decides what the user gets told, and the old
	// copy asserted the conflict one unconditionally — advice that sends a Wayland
	// user through every key on the keyboard, none of which can work.
	const status = sessionAcceptsGlobalShortcuts() ? "conflict" : "unavailable";
	console.warn(
		`Failed to register global shortcut for ${action}: ${accelerator} (${
			status === "conflict"
				? "already taken by another application"
				: "this session does not support global shortcuts"
		})`,
	);
	return status;
}

/**
 * Registers every global hotkey from the saved config, falling back to the
 * defaults for anything the file does not carry — including the whole file being
 * absent, which is every fresh install.
 */
export async function loadAndRegisterGlobalShortcuts(
	handlers: Record<GlobalShortcutAction, () => void>,
): Promise<GlobalShortcutStatuses> {
	let saved: Record<string, ShortcutBinding> = {};
	try {
		saved = JSON.parse(await fs.readFile(SHORTCUTS_FILE, "utf-8"));
	} catch {
		// No file yet, or one this build cannot read: the defaults below are the answer.
	}

	const statuses = {} as GlobalShortcutStatuses;
	for (const action of GLOBAL_SHORTCUT_ACTIONS) {
		statuses[action] = registerGlobalShortcut(
			action,
			saved?.[action] ?? DEFAULT_SHORTCUTS[action],
			handlers[action],
		);
	}
	return statuses;
}

export function unregisterAllGlobalShortcuts(): void {
	globalShortcut.unregisterAll();
}
