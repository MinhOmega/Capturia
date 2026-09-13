// @vitest-environment jsdom
// The export dialog remembers its own settings (C5). Two halves are under test: the form
// seeds from `loadUserPreferences()`, and it writes back ONLY after a run that succeeded —
// remembering "GIF" from a cancelled or failed run is the failure mode the spec calls out.
import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

/** The export options object is the 4th argument of both native calls — what the seeded
 *  form actually asked the exporter for. */
const exportMultiNative = vi.fn(async (..._args: unknown[]) => ({ videoDurationS: 12, wallS: 3 }));
const exportGifNative = vi.fn(async (..._args: unknown[]) => ({ videoDurationS: 12, wallS: 3 }));

vi.mock("@/native", () => ({
	exportMultiNative: (...args: unknown[]) => exportMultiNative(...args),
	exportGifNative: (...args: unknown[]) => exportGifNative(...args),
	useIsCpuCompositor: () => false,
}));

vi.mock("@/native/sceneDescription", () => ({
	buildSceneDescription: () => ({ speedRegions: [] }),
	resolveVisibleClips: (doc: AxcutDocument) => doc.timeline.clips,
}));

import { I18nProvider } from "@/contexts/I18nContext";
import { type AxcutDocument, axcutSchemaVersion } from "@/lib/ai-edition/schema";
import { loadUserPreferences, saveUserPreferences } from "@/lib/userPreferences";
import { ExportDialog } from "./ExportDialog";

type ElectronAPI = Window["electronAPI"];

const SAVED_PATH = "/tmp/openscreen/Test_project.mp4";

const noop = () => undefined;

const DOC: AxcutDocument = {
	schemaVersion: axcutSchemaVersion,
	project: {
		id: "proj_1",
		title: "Test project",
		createdAt: "2026-06-26T10:00:00Z",
		updatedAt: "2026-06-26T10:00:00Z",
		primaryAssetId: "a1",
	},
	assets: [
		{
			id: "a1",
			kind: "video",
			label: "asset",
			originalPath: "/tmp/a.mp4",
			cameraTrack: null,
			video: { codec: "h264", width: 1920, height: 1080, fps: 30 },
		},
	],
	transcript: null,
	transcripts: [],
	timeline: {
		clips: [
			{
				id: "c1",
				assetId: "a1",
				sourceStartSec: 0,
				sourceEndSec: 10,
				timelineStartSec: 0,
				timelineEndSec: 10,
				wordRefs: [],
				origin: "user",
				reason: "",
			},
		],
		gaps: [],
		trimRanges: [],
		muteRanges: [],
		speedRanges: [],
		captionRanges: [],
	},
	annotations: [],
	zoomRanges: [],
	audioTracks: [],
	legacyEditor: null,
};

let pickExportSavePath: ReturnType<typeof vi.fn>;

function stubElectronAPI() {
	pickExportSavePath = vi.fn(async () => ({ path: SAVED_PATH }));
	window.electronAPI = {
		pickExportSavePath,
		onNativeExportProgress: vi.fn(() => noop),
		revealInFolder: vi.fn(async () => ({ success: true })),
	} as unknown as ElectronAPI;
}

function renderDialog() {
	render(
		<I18nProvider>
			<ExportDialog open={true} onClose={noop} document={DOC} />
		</I18nProvider>,
	);
}

const ratioBox = (label: string) => screen.getByRole("checkbox", { name: label });

describe("ExportDialog — remembered export settings", () => {
	beforeEach(() => {
		localStorage.clear();
		stubElectronAPI();
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("seeds format, GIF options, ratios and folder from the stored preferences", async () => {
		saveUserPreferences({
			exportFormat: "gif",
			exportGif: { frameRate: 30, size: "large", loop: false, dither: true },
			exportRatios: ["9:16"],
			exportFolder: "/previous/folder",
		});

		renderDialog();

		expect(ratioBox("9:16")).toHaveAttribute("aria-checked", "true");
		expect(ratioBox("16:9")).toHaveAttribute("aria-checked", "false");

		fireEvent.click(screen.getByRole("button", { name: /export gif/i }));

		await waitFor(() => expect(exportGifNative).toHaveBeenCalled());
		// The remembered folder is what the save dialog opens in.
		expect(pickExportSavePath).toHaveBeenCalledWith(
			expect.any(String),
			"/previous/folder",
			undefined,
		);
		const options = exportGifNative.mock.calls[0][3] as Record<string, unknown>;
		expect(options).toMatchObject({ fps: 30, loopCount: 1, dither: true });
	});

	it("seeds the MP4 frame rate and codec, rejecting a stored codec the exporter refuses", async () => {
		// "vp9" is a valid `ExportVideoCodec` the native pipeline rejects outright; a stored
		// one must not reach the exporter. Written raw, the way an older build could have.
		localStorage.setItem(
			"openscreen_user_preferences",
			JSON.stringify({ exportFps: 30, exportCodec: "vp9" }),
		);

		renderDialog();
		fireEvent.click(screen.getByRole("button", { name: /export mp4/i }));

		await waitFor(() => expect(exportMultiNative).toHaveBeenCalled());
		expect(exportMultiNative.mock.calls[0][3]).toMatchObject({ fps: 30, codec: "h264" });
	});

	it("drops a remembered ratio this document does not offer", async () => {
		// "64:27" is a valid token (an ultrawide capture's native shape) but not one of this
		// document's options, so it never reaches the batch.
		saveUserPreferences({ exportRatios: ["64:27", "9:16"] });

		renderDialog();

		expect(ratioBox("9:16")).toHaveAttribute("aria-checked", "true");
		fireEvent.click(screen.getByRole("button", { name: /export mp4/i }));

		await waitFor(() => expect(exportMultiNative).toHaveBeenCalled());
		// One ratio survived, so this is a single-file export: no batch tokens.
		expect(pickExportSavePath).toHaveBeenCalledWith(expect.any(String), undefined, undefined);
		expect(exportMultiNative).toHaveBeenCalledTimes(1);
	});

	it("falls back to the document's ratio when every remembered ratio is gone", async () => {
		saveUserPreferences({ exportRatios: ["64:27"] });

		renderDialog();

		// Never an empty batch: the document's own 16:9 stands in.
		expect(ratioBox("16:9")).toHaveAttribute("aria-checked", "true");
	});

	it("writes the settings back after a successful export", async () => {
		renderDialog();
		fireEvent.click(screen.getByRole("button", { name: /^gif$/i }));
		fireEvent.click(screen.getByRole("button", { name: /export gif/i }));

		await waitFor(() => expect(loadUserPreferences().exportFormat).toBe("gif"));
		expect(loadUserPreferences().exportFolder).toBe("/tmp/openscreen");
		expect(loadUserPreferences().exportRatios).toEqual(["16:9"]);
	});

	it("remembers nothing when the export fails", async () => {
		exportGifNative.mockRejectedValueOnce(new Error("encoder exploded"));

		renderDialog();
		fireEvent.click(screen.getByRole("button", { name: /^gif$/i }));
		fireEvent.click(screen.getByRole("button", { name: /export gif/i }));

		await waitFor(() => expect(exportGifNative).toHaveBeenCalled());
		// A 10-minute GIF remembered from a run that produced nothing is the exact trap.
		await waitFor(() => expect(screen.getByText(/encoder exploded/i)).toBeInTheDocument());
		expect(loadUserPreferences().exportFormat).toBe("mp4");
		expect(loadUserPreferences().exportFolder).toBeNull();
	});
});
