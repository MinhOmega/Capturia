// @vitest-environment jsdom
// Cancelling a running export. The button existed and was wired to `handleClose`, which
// refused to act mid-render AND was disabled exactly while an export was running — so there
// was no way to stop one. What matters here is the state machine around the cancel, not the
// compositor: the native export is stubbed, and the contract under test is that a rejection
// carrying `EXPORT_CANCELLED` returns the dialog to a usable idle state rather than an error.
import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

/** Resolvers for the in-flight export, so the test decides when (and how) it settles. */
let settleExport: { reject: (err: Error) => void };

vi.mock("@/native", () => ({
	exportMultiNative: vi.fn(
		() =>
			new Promise((_resolve, reject) => {
				settleExport = { reject };
			}),
	),
	exportGifNative: vi.fn(async () => ({ videoDurationS: 12, wallS: 3 })),
	useIsCpuCompositor: () => false,
}));

vi.mock("@/native/sceneDescription", () => ({
	buildSceneDescription: () => ({ speedRegions: [] }),
	resolveVisibleClips: (doc: AxcutDocument) => doc.timeline.clips,
}));

import { toast } from "sonner";
import { I18nProvider } from "@/contexts/I18nContext";
import { type AxcutDocument, axcutSchemaVersion } from "@/lib/ai-edition/schema";
import { ExportDialog } from "./ExportDialog";

type ElectronAPI = Window["electronAPI"];

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

let exportCancel: ReturnType<typeof vi.fn>;

beforeEach(() => {
	exportCancel = vi.fn(async () => undefined);
	window.electronAPI = {
		pickExportSavePath: vi.fn(async () => ({ path: "/tmp/openscreen/Test_project.mp4" })),
		onNativeExportProgress: vi.fn(() => noop),
		exportCancel,
	} as unknown as ElectronAPI;
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

/** Renders the dialog open and starts an MP4 export, leaving it mid-render. */
async function startExport(onClose: () => void = noop) {
	render(
		<I18nProvider>
			<ExportDialog open={true} onClose={onClose} onReopen={noop} document={DOC} />
		</I18nProvider>,
	);
	fireEvent.click(screen.getByRole("button", { name: /export mp4/i }));
	return await screen.findByRole("button", { name: /cancel export/i });
}

describe("ExportDialog — cancelling a running export", () => {
	it("offers an ENABLED cancel button while rendering", async () => {
		const cancel = await startExport();
		// The defect was `disabled={isBusy}` — disabled precisely when it was needed.
		expect(cancel).toBeEnabled();
	});

	it("asks the native side to stop when clicked", async () => {
		fireEvent.click(await startExport());
		expect(exportCancel).toHaveBeenCalledTimes(1);
	});

	it("returns to idle — not to an error — once the export rejects as cancelled", async () => {
		fireEvent.click(await startExport());
		settleExport.reject(new Error("EXPORT_CANCELLED"));

		// Back on the form with the export button live again: a second export must be possible.
		await waitFor(() => {
			expect(screen.getByRole("button", { name: /export mp4/i })).toBeEnabled();
		});
		// A cancel is a user decision, so it must not be reported as a failure.
		expect(toast.error).not.toHaveBeenCalled();
		expect(screen.queryByRole("button", { name: /cancel export/i })).not.toBeInTheDocument();
	});

	it("still reports a genuine export failure as an error", async () => {
		fireEvent.click(await startExport());
		settleExport.reject(new Error("encoder exploded"));

		await waitFor(() => {
			expect(toast.error).toHaveBeenCalled();
		});
	});
});

describe("ExportDialog — minimizing to the floating pill", () => {
	it("closes mid-export instead of refusing, and keeps reporting the run in the pill", async () => {
		const onClose = vi.fn();
		const { rerender } = render(
			<I18nProvider>
				<ExportDialog open={true} onClose={onClose} onReopen={noop} document={DOC} />
			</I18nProvider>,
		);
		fireEvent.click(screen.getByRole("button", { name: /export mp4/i }));
		await screen.findByRole("button", { name: /cancel export/i });

		// `handleClose` used to return early while rendering, so the dialog could not be
		// dismissed at all until the export finished.
		fireEvent.click(screen.getByRole("button", { name: /close/i }));
		expect(onClose).toHaveBeenCalled();

		// Re-render rather than re-mount: the component staying mounted across `open` is
		// exactly WHY the progress survives, so a fresh mount would test nothing.
		rerender(
			<I18nProvider>
				<ExportDialog open={false} onClose={onClose} onReopen={noop} document={DOC} />
			</I18nProvider>,
		);
		expect(await screen.findByText(/rendering frames|exporting/i)).toBeInTheDocument();
	});

	it("renders no pill when nothing is exporting", () => {
		render(
			<I18nProvider>
				<ExportDialog open={false} onClose={noop} onReopen={noop} document={DOC} />
			</I18nProvider>,
		);
		expect(screen.queryByText(/rendering frames|exporting/i)).not.toBeInTheDocument();
	});
});
