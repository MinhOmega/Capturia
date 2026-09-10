import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";
import {
	DEFAULT_SHORTCUTS,
	GLOBAL_SHORTCUT_ACTIONS,
	type GlobalShortcutAction,
	type GlobalShortcutStatuses,
	mergeWithDefaults,
	type ShortcutBinding,
	type ShortcutsConfig,
} from "@/lib/shortcuts";
import { isMac as getIsMac } from "@/utils/platformUtils";

interface ShortcutsContextValue {
	shortcuts: ShortcutsConfig;
	isMac: boolean;
	setShortcuts: (config: ShortcutsConfig) => void;
	persistShortcuts: (config?: ShortcutsConfig) => Promise<GlobalShortcutStatuses>;
	/** What startup made of each OS-owned hotkey, so the dialog can stop offering a
	 *  rebind on a session where no rebind can succeed. */
	globalShortcutStatuses: GlobalShortcutStatuses;
	isConfigOpen: boolean;
	openConfig: () => void;
	closeConfig: () => void;
}

const ShortcutsContext = createContext<ShortcutsContextValue | null>(null);

export function useShortcuts(): ShortcutsContextValue {
	const ctx = useContext(ShortcutsContext);
	if (!ctx) throw new Error("useShortcuts must be used within <ShortcutsProvider>");
	return ctx;
}

export function ShortcutsProvider({ children }: { children: ReactNode }) {
	const [shortcuts, setShortcuts] = useState<ShortcutsConfig>(DEFAULT_SHORTCUTS);
	// `getIsMac()` is synchronous, but it reads `window.electronAPI`, so keep it
	// in an effect rather than in the initial state — that keeps the first render
	// free of any dependency on preload having been installed.
	const [isMac, setIsMac] = useState(false);
	const [isConfigOpen, setIsConfigOpen] = useState(false);
	// Optimistic default: in browser mode and in tests there is no main process to
	// ask, and claiming the hotkeys are broken there would be its own wrong message.
	const [globalShortcutStatuses, setGlobalShortcutStatuses] = useState<GlobalShortcutStatuses>({
		openApp: "registered",
		stopRecording: "registered",
	});

	useEffect(() => {
		setIsMac(getIsMac());

		// Guard `electronAPI` itself, not just the method on it — that is what the
		// note above is after. Without preload (browser mode, and any test that
		// renders a consumer) the bare property read threw and took the whole
		// subtree with it, rather than falling back to the defaults already in
		// state.
		window.electronAPI
			?.getShortcuts?.()
			?.then((saved) => {
				if (saved) {
					setShortcuts(mergeWithDefaults(saved as Partial<ShortcutsConfig>));
				}
			})
			.catch(() => {
				// Keep default shortcuts if persisted settings can't be loaded.
			});

		window.electronAPI
			?.getGlobalShortcutStatuses?.()
			?.then((statuses) => {
				if (statuses) setGlobalShortcutStatuses(statuses);
			})
			.catch(() => {
				// An unanswered question is not evidence the hotkeys are broken.
			});
	}, []);

	const persistShortcuts = useCallback(
		async (config?: ShortcutsConfig): Promise<GlobalShortcutStatuses> => {
			const configToSave = config ?? shortcuts;
			await window.electronAPI?.saveShortcuts?.(configToSave);

			const bindings: Partial<Record<GlobalShortcutAction, ShortcutBinding>> = {};
			for (const action of GLOBAL_SHORTCUT_ACTIONS) {
				bindings[action] = configToSave[action];
			}
			const result = await window.electronAPI?.updateGlobalShortcuts?.(bindings);
			// No main process (browser mode, tests): the local shortcuts still saved, and
			// there is no global one to have failed.
			const statuses = result?.statuses ?? {
				openApp: "registered" as const,
				stopRecording: "registered" as const,
			};
			setGlobalShortcutStatuses(statuses);
			return statuses;
		},
		[shortcuts],
	);

	const openConfig = useCallback(() => setIsConfigOpen(true), []);
	const closeConfig = useCallback(() => setIsConfigOpen(false), []);

	const value = useMemo<ShortcutsContextValue>(
		() => ({
			shortcuts,
			isMac,
			setShortcuts,
			persistShortcuts,
			globalShortcutStatuses,
			isConfigOpen,
			openConfig,
			closeConfig,
		}),
		[
			shortcuts,
			isMac,
			persistShortcuts,
			globalShortcutStatuses,
			isConfigOpen,
			openConfig,
			closeConfig,
		],
	);

	return <ShortcutsContext.Provider value={value}>{children}</ShortcutsContext.Provider>;
}
