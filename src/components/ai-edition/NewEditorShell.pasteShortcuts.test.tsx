// @vitest-environment jsdom
// Ctrl+V and Ctrl+Shift+V are two different verbs on one clipboard: paste a NEW region at
// the playhead, or write the copied region's attributes onto the pill already selected
// (upstream #24). They share a key, so the only thing keeping them apart is the order they
// are tested in — `shortcuts.pasteAttributes` before `shortcuts.paste`.
//
// `matchesShortcut` compares Shift exactly, so as the two ship neither can swallow the
// other; what this file pins is that the shift form REACHES the attribute paste at all and
// does not simply fall through to the one below it, which is what the shortcut did before
// the binding existed. Both bindings are rebindable, so the order is a live guard rather
// than a formality.
//
// Same shape as NewEditorShell.dialogShortcuts.test.tsx: shortcuts bound on `window`, fired
// at `document.body`, with the contexts stubbed so the shell mounts without a provider tree.

import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The two halves of the clipboard the shell reaches through a dynamic import. `pasteClipboard`
// is called by BOTH paste paths; `pickPasteableAttributes` by only the attribute one, which is
// what makes it the observable that tells the two apart.
const pickPasteableAttributes = vi.hoisted(() => vi.fn(() => ({ depth: 6 })));
const pasteClipboard = vi.hoisted(() =>
	vi.fn(() => ({ kind: "zoom" as const, region: { id: "zoom_src", startMs: 0, endMs: 1000 } })),
);

vi.mock("@/lib/ai-edition/store/regionClipboard", () => ({
	pasteClipboard,
	pickPasteableAttributes,
	copyRegion: vi.fn(),
	clearRegionClipboard: vi.fn(),
	useRegionClipboard: () => ({ hasContent: true, kind: "zoom", read: () => null }),
	useCopyRegion: () => vi.fn(),
}));

vi.mock("@/contexts/ShortcutsContext", async () => {
	const { DEFAULT_SHORTCUTS } = await import("@/lib/shortcuts");
	return {
		useShortcuts: () => ({
			shortcuts: DEFAULT_SHORTCUTS,
			isMac: false,
			isConfigOpen: false,
			openConfig: vi.fn(),
			closeConfig: vi.fn(),
			setShortcuts: vi.fn(),
			persistShortcuts: () => Promise.resolve("registered" as const),
			globalShortcutStatuses: {
				openApp: "registered" as const,
				stopRecording: "registered" as const,
			},
		}),
	};
});

vi.mock("@/contexts/I18nContext", () => ({
	useI18n: () => ({
		locale: "en",
		setLocale: vi.fn(),
	}),
	useScopedT: () => (key: string) => key,
}));

import { EditorDialogsProvider } from "@/contexts/EditorDialogsContext";
import { createEmptyDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { NewEditorShell } from "./NewEditorShell";

/** Every paste shortcut sits behind `hasProject`, which is just "is there a document". */
function renderShellWithProject() {
	const rendered = render(
		<EditorDialogsProvider>
			<NewEditorShell />
		</EditorDialogsProvider>,
	);
	act(() => {
		useProjectStore.setState({ document: createEmptyDocument({ projectId: "p", title: "t" }) });
	});
	return rendered;
}

beforeEach(() => {
	pickPasteableAttributes.mockClear();
	pasteClipboard.mockClear();
	localStorage.clear();
	(window as unknown as { electronAPI?: unknown }).electronAPI = {
		onAiEditionChatEvent: () => () => {
			/* unsubscribe */
		},
		setTitleBarOverlay: () => {
			/* no native titlebar */
		},
		setHasUnsavedChanges: () => {
			/* no window close guard */
		},
		onRequestCloseConfirm: () => () => {
			/* unsubscribe */
		},
		onRequestSaveBeforeClose: () => () => {
			/* unsubscribe */
		},
		sendCloseConfirmResponse: () => {
			/* nothing is closing this window */
		},
		findRecordingCamera: () => Promise.resolve(null),
		preparePreviewAudioTrack: () => Promise.resolve(null),
	};
	Element.prototype.scrollTo = () => {
		/* no scrolling in jsdom */
	};
	(globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver = class {
		observe() {
			/* never fires: nothing has a layout in jsdom */
		}
		unobserve() {
			/* see observe */
		}
		disconnect() {
			/* see observe */
		}
	};
});

afterEach(() => {
	cleanup();
	useProjectStore.getState().clear();
	(window as unknown as { electronAPI?: unknown }).electronAPI = undefined;
});

describe("NewEditorShell paste bindings", () => {
	it("routes Ctrl+Shift+V to the attribute paste instead of letting it fall through", async () => {
		renderShellWithProject();

		await act(async () => {
			fireEvent.keyDown(document.body, { key: "v", ctrlKey: true, shiftKey: true });
		});

		// Reached the attribute path: only that one asks the clipboard what may be pasted
		// ONTO a region. Before the binding existed this key matched nothing at all.
		expect(pickPasteableAttributes).toHaveBeenCalledTimes(1);
	});

	it("leaves plain Ctrl+V on the paste-at-playhead path", async () => {
		renderShellWithProject();

		await act(async () => {
			fireEvent.keyDown(document.body, { key: "v", ctrlKey: true });
		});

		// The other half of the guard: adding the shift form must not turn every paste
		// into an attribute paste.
		expect(pasteClipboard).toHaveBeenCalled();
		expect(pickPasteableAttributes).not.toHaveBeenCalled();
	});
});
