// A look applied while its save is still in flight must already be in the store, or a
// pane edit made during that round-trip builds on the pre-look document and one of the
// two is lost to whichever save lands last.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyDocument } from "@/lib/ai-edition/schema";
import { getEditorSettings } from "@/lib/ai-edition/store/editorSettings";
import type { LookPreset } from "@/lib/ai-edition/store/lookPresets";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { clearHistory, past } from "@/lib/ai-edition/store/undoStack";
import { applyLookPreset } from "./LookPresetsMenu";

const save = vi.hoisted(() => vi.fn());
vi.mock("@/native/client", () => ({ nativeBridgeClient: { aiEdition: { save } } }));

const doc = createEmptyDocument({ projectId: "p1", title: "Test" });
const preset: LookPreset = {
	id: "l1",
	name: "Mine",
	settings: { padding: 80, wallpaper: "#123456" },
	captions: null,
};

afterEach(() => {
	clearHistory();
	save.mockReset();
});

describe("applyLookPreset", () => {
	it("holds the look in the store before the save resolves, as one undo step", async () => {
		let finish: (() => void) | undefined;
		save.mockImplementation(
			(document: unknown) =>
				new Promise((resolve) => {
					finish = () => resolve({ success: true, document });
				}),
		);
		useProjectStore.setState({ projectId: "p1", document: doc });

		const applied = applyLookPreset(preset);
		await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));

		// The save has not resolved: the store holds the look anyway.
		expect(getEditorSettings(useProjectStore.getState().document).padding).toBe(80);

		finish?.();
		await applied;
		expect(getEditorSettings(useProjectStore.getState().document).padding).toBe(80);
		expect(past).toHaveLength(1);
		expect(past[0].doc).toEqual(doc);
	});
});
