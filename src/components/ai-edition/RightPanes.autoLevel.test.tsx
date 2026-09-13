// @vitest-environment jsdom
// Auto-level: one click measures the primary clip's integrated loudness in main and turns
// it into the output gain that lands speech at −16 LUFS — through the same `set` writer the
// Reset button uses, so it is one undo step and no new `documentWriteAudit` row.
import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { toast } from "sonner";
import { I18nProvider } from "@/contexts/I18nContext";
import { LOCALE_STORAGE_KEY } from "@/i18n/config";
import { type AxcutDocument, createEmptyDocument } from "@/lib/ai-edition/schema";
import { getEditorSettings } from "@/lib/ai-edition/store/editorSettings";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { AudioPane } from "./RightPanes";

type ElectronAPI = Window["electronAPI"];

function seedProject(noAudio = false): AxcutDocument {
	const base = createEmptyDocument({ projectId: "project_audio", title: "Audio" });
	return {
		...base,
		assets: [
			{
				id: "asset_1",
				kind: "video",
				label: "screen.webm",
				originalPath: "/tmp/screen.webm",
				durationSec: 10,
				video: { codec: "unknown", width: 1920, height: 1080, fps: 30 },
				cameraTrack: null,
				transcriptionFailure: noAudio ? { kind: "no-audio", message: "" } : null,
			},
		],
		project: { ...base.project, primaryAssetId: "asset_1" },
	};
}

function renderPane(doc: AxcutDocument) {
	useProjectStore.setState({
		projectId: doc.project.id,
		document: doc,
		revision: 1,
		status: "ready",
	});
	return render(
		<I18nProvider>
			<AudioPane />
		</I18nProvider>,
	);
}

/** Only what Auto-level reaches for. `lufs: null` is main's "no ffmpeg here". */
function stubBridge(result: unknown) {
	window.electronAPI = {
		measureAudioLoudness: vi.fn(async () => result),
	} as unknown as ElectronAPI;
}

const gainOf = () => getEditorSettings(useProjectStore.getState().document).audioGainDb;

beforeEach(() => {
	localStorage.clear();
	localStorage.setItem(LOCALE_STORAGE_KEY, "en");
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	localStorage.clear();
	useProjectStore.getState().clear();
	window.electronAPI = undefined as unknown as ElectronAPI;
});

describe("AudioPane Auto-level", () => {
	it("writes the gain that brings the measured loudness to −16 LUFS", async () => {
		stubBridge({ success: true, lufs: -23 });
		renderPane(seedProject());

		fireEvent.click(screen.getByRole("button", { name: "Auto-level" }));

		await waitFor(() => expect(gainOf()).toBe(7));
		expect(toast.success).toHaveBeenCalledWith(expect.stringContaining("7.0 dB"));
	});

	it("clamps a quiet take to the ±12 dB limit and says so", async () => {
		// −40 LUFS wants +24 dB; the gain the export and the preview share is capped at
		// AUDIO_GAIN_DB_LIMIT, so the toast has to admit the clip is still quiet.
		stubBridge({ success: true, lufs: -40 });
		renderPane(seedProject());

		fireEvent.click(screen.getByRole("button", { name: "Auto-level" }));

		await waitFor(() => expect(gainOf()).toBe(12));
		expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/more than ±12 dB/));
	});

	it("is disabled for a clip with no audio track", () => {
		stubBridge({ success: true, lufs: -23 });
		renderPane(seedProject(true));

		expect(screen.getByRole("button", { name: "Auto-level" })).toBeDisabled();
	});

	it("hides itself when the host cannot measure at all", async () => {
		// No preload bridge: the browser shim, where there is no ffmpeg to reach.
		renderPane(seedProject());
		expect(screen.queryByRole("button", { name: "Auto-level" })).not.toBeInTheDocument();

		cleanup();
		// A bridge that answers "no ffmpeg on this host" — the button goes away rather
		// than offering a measurement that cannot happen again.
		stubBridge({ success: true, lufs: null });
		renderPane(seedProject());
		fireEvent.click(screen.getByRole("button", { name: "Auto-level" }));

		await waitFor(() =>
			expect(screen.queryByRole("button", { name: "Auto-level" })).not.toBeInTheDocument(),
		);
		expect(gainOf()).toBe(0);
	});

	it("reports a failed measurement without quoting ffmpeg at the user", async () => {
		stubBridge({ success: false, message: "ffmpeg exited 1: Stream map 'a' matches no streams." });
		renderPane(seedProject());

		fireEvent.click(screen.getByRole("button", { name: "Auto-level" }));

		await waitFor(() => expect(toast.error).toHaveBeenCalled());
		expect(toast.error).toHaveBeenCalledWith("Could not measure the main clip's loudness.");
		expect(gainOf()).toBe(0);
	});
});
