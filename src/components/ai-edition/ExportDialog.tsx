// Export dialog for the new editor. Wires together:
// 1. pickExportSavePath (native save dialog)
// 2. the native D3D exporter (exportMultiNative / exportGifNative)
// 3. writeExportToPath (writes the resulting buffer to disk)
//
// Format/quality/GIF options live in the dialog's local state. The
// legacy `ExportDialog` (in components/video-editor) is the rich version
// used by the legacy VideoEditor; this one is a compact surface tuned for
// the new shell's modal style.

import { Download, FileVideo, FolderOpen, Loader2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useScopedT } from "@/contexts/I18nContext";
import { writeSubtitleSidecars } from "@/lib/ai-edition/captions";
import {
	collectEffectiveClipDims,
	type Dims,
	pickExtremeDims,
	pickOutputDims,
	resolveAspectRatioValue,
} from "@/lib/ai-edition/document/outputFormat";
import type { AxcutDocument } from "@/lib/ai-edition/schema";
import { getEditorSettings, patchEditorSettings } from "@/lib/ai-edition/store/editorSettings";
import { assetCameraSource } from "@/lib/ai-edition/timeline/camera";
import { resolveClipSourceEndSec } from "@/lib/ai-edition/timeline/clipDuration";
import {
	type ExportFormat,
	type ExportProgress,
	type ExportQuality,
	type ExportVideoCodec,
	GIF_FRAME_RATES,
	GIF_SIZE_PRESETS,
	type GifFrameRate,
	type GifSizePreset,
} from "@/lib/exporter";
import { runBatchExport } from "@/lib/exporter/batchExport";
import { calculateMp4ExportSettings, wouldUpscale } from "@/lib/exporter/mp4ExportSettings";
import { outputFrameCount } from "@/lib/exporter/outputFrameCount";
import { exportGifNative, exportMultiNative, useIsCpuCompositor } from "@/native";
import type { CompositorClipInput } from "@/native/contracts";
import { buildSceneDescription, resolveVisibleClips } from "@/native/sceneDescription";
import {
	ASPECT_RATIO_PRESETS,
	type AspectRatio,
	getAspectRatioLabel,
	toAspectRatioToken,
} from "@/utils/aspectRatioUtils";
import { ExportProgressFloat } from "./ExportProgressFloat";
import { ModalShell } from "./Modals";
import styles from "./NewEditorShell.module.css";

type Phase = "idle" | "configuring" | "rendering" | "writing" | "done" | "error";

/** hh:mm:ss (always shows hours, unlike the shared mm:ss `formatTimePadded`) — exports can run
 *  past an hour on either axis (video duration or render wall-time). */
function formatHms(totalSeconds: number): string {
	const s = Math.max(0, Math.round(totalSeconds));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	return [h, m, sec].map((v) => v.toString().padStart(2, "0")).join(":");
}

/** Opens the exported file's containing folder, selecting the file itself where the OS supports
 *  it. The main handler owns the fallback (`shell.openPath` on the parent directory) for the
 *  cases `showItemInFolder` rejects — a file moved or deleted since the export, or a platform
 *  that cannot reveal — so nothing here has to pre-check that the file still exists.
 *
 *  Shared by the success toast's action and the done panel's button so the two can't drift.
 *  `revealInFolder` is a bare ipcRenderer.invoke, so it rejects when the main handler throws,
 *  and resolves `{ success: false }` when even the fallback failed. The export already
 *  succeeded — failing to open the folder is not worth a second error toast, but it is worth
 *  a line. */
/** Last path segment, for listing what a partial batch left behind. Handles both
 *  separators because the path comes from the main process, not from this platform. */
function fileNameOf(filePath: string): string {
	return filePath.split(/[\\/]/).pop() || filePath;
}

function revealExportedFile(filePath: string): void {
	void window.electronAPI
		?.revealInFolder?.(filePath)
		.then((result) => {
			if (!result?.success) {
				console.warn("[export] could not open the exported file's folder:", result?.error);
			}
		})
		.catch((err) => {
			console.warn("[export] failed to reveal the file in its folder:", err);
		});
}

/** Maps the document's timeline to the native multiclip export contract: ordered,
 *  trim-narrowed clips (`resolveVisibleClips` — shared with `buildSceneDescription` and
 *  `NativeCompositorOverlay`, so export/preview/scene all see the exact same clip stream),
 *  each with its asset's screen file + camera file (falls back to the screen when a clip has
 *  no camera — the no-webcam layout is a later step) and its source trim. */
function buildNativeClipList(document: AxcutDocument): CompositorClipInput[] {
	const assetById = new Map(document.assets.map((a) => [a.id, a]));
	return resolveVisibleClips(document).flatMap((clip) => {
		const asset = assetById.get(clip.assetId);
		if (!asset?.originalPath) {
			return [];
		}
		const camera = assetCameraSource(asset);
		// sourceEndSec is optional in the schema (unknown until probed) — fall back through
		// the single canonical precedence used by every consumer (clip.probe → asset.duration
		// → timeline-length guess). See `resolveClipSourceEndSec` for the full order.
		const sourceEndSec = resolveClipSourceEndSec(clip, asset);
		// ponytail: `hasAudio` stays optimistic for the same reason as in
		// `buildSceneDescription` — nothing populates `asset.audio` yet, and the
		// native side degrades cleanly on a stream-less file.
		return [
			{
				screenPath: asset.originalPath,
				webcamPath: camera.path,
				sourceStartSec: clip.sourceStartSec,
				sourceEndSec,
				webcamOffsetSec: camera.offsetSec,
				hasAudio: true,
			},
		];
	});
}

const QUALITY_OPTIONS: Array<{
	value: ExportQuality;
	labelKey: string;
}> = [
	{ value: "medium", labelKey: "exportQuality.low" },
	{ value: "good", labelKey: "exportQuality.medium" },
	{ value: "source", labelKey: "exportQuality.high" },
];

interface ExportDialogProps {
	open: boolean;
	onClose: () => void;
	/** Reopens the dialog from the minimized pill. Without it the pill is not rendered,
	 *  and closing mid-export keeps its old meaning of "no way back". */
	onReopen?: () => void;
	document: AxcutDocument | null;
}

export function ExportDialog({ open, onClose, onReopen, document }: ExportDialogProps) {
	const t = useScopedT("editor");
	const ts = useScopedT("settings");
	const td = useScopedT("dialogs");
	// No usable GPU: the export still applies every effect (output is identical), it
	// just runs on the software encoder and takes minutes instead of seconds.
	const cpuCompositor = useIsCpuCompositor();
	const [format, setFormat] = useState<ExportFormat>("mp4");
	const [quality, setQuality] = useState<ExportQuality>("good");
	const [fps, setFps] = useState<24 | 30 | 60>(60);
	const [codec, setCodec] = useState<ExportVideoCodec>("h264");
	const [gifFrameRate, setGifFrameRate] = useState<GifFrameRate>(15);
	const [gifSize, setGifSize] = useState<GifSizePreset>("medium");
	const [gifLoop, setGifLoop] = useState(true);
	// Off by default, matching `GifExportParams::default()` — Floyd-Steinberg roughly
	// doubles the per-frame cost and screen content quantizes cleanly without it. It
	// earns its keep on gradients and camera footage, which is why it is a choice.
	const [gifDither, setGifDither] = useState(false);
	// Null means "follow the document" — the ratio the timeline is set to, which is what
	// a single-ratio export has always used. Only a tick in the ratio list makes this an
	// explicit set, so opening the dialog and pressing Export is unchanged behaviour.
	const [ratios, setRatios] = useState<AspectRatio[] | null>(null);
	// Which file of how many is rendering. Null outside a run and for a single-file
	// export, where "1 of 1" would be noise.
	const [batch, setBatch] = useState<{ index: number; total: number; ratio: AspectRatio } | null>(
		null,
	);
	const [phase, setPhase] = useState<Phase>("idle");
	const [progress, setProgress] = useState<ExportProgress | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [savedPath, setSavedPath] = useState<string | null>(null);
	// Latched between "user asked to cancel" and the export promise actually rejecting —
	// a frame's worth of time, but enough for a second click to fire a second request.
	const [cancelling, setCancelling] = useState(false);

	// (Old behavior: the native compositor overlay used to be a top-level OS window outside the
	//  Chromium surface, so we'd hide it here to put this modal in front. The compositor now
	//  streams into a normal `<canvas>` inside the DOM — CSS z-index handles stacking naturally
	//  and there's no OS window to hide. The hide/show dance is now dead code; removed.)

	// Source dimensions come straight off `asset.video`. This dialog used to probe missing ones
	// into local state as a fallback for recordings that were never probed; `useTimeline` now
	// backfills them on editor load (before this dialog can open) and persists them, so every
	// consumer reads the one populated source instead of each re-probing on its own.
	const primaryAsset = useMemo(
		() =>
			document
				? (document.assets.find((a) => a.id === document.project.primaryAssetId) ??
					document.assets[0])
				: null,
		[document],
	);

	// Per-clip EFFECTIVE (post-crop) dims — single source of truth for both the "largest"
	// and "smallest" picks below, computed once instead of two near-identical hand-rolled
	// reduce+fallback loops. Crop is per-clip, so this must iterate clips, not assets: the
	// same recording can be cropped differently in two different clips on the timeline.
	const effectiveClipDims = useMemo<Dims[]>(
		() => (document ? collectEffectiveClipDims(document) : []),
		[document],
	);
	// (The "largest clip" pick lived here for the old renderer-side GIF path, which
	// sized to the best available footage independently of the quality tier. GIF now
	// goes through the same native exporter as MP4 and shares its sizing, so only the
	// smallest-clip pick below is still needed.)

	// Smallest clip's true (cropped) footprint on the timeline — a multiclip timeline can mix
	// crops/resolutions, so this is what "Source" quality actually targets: sizing to the
	// SMALLEST clip's own resolution means no clip on the timeline is ever upscaled past its
	// true footprint by picking Source. It also feeds the upscale badge on the fixed
	// 720p/1080p tiers, which can still genuinely upscale a small clip.
	const smallestSource = useMemo(
		() => pickExtremeDims(effectiveClipDims, "smallest"),
		[effectiveClipDims],
	);

	// The ratio the document is set to, and the default selection. Read through
	// `getEditorSettings` — the same typed façade the ratio dropdown writes through and
	// `buildSceneDescription` reads — so this dialog can't drift from the compositor if the
	// storage ever moves. Kept as STORED — legacy
	// "native" included — so a single-ratio export renders through exactly the same path it
	// does today, with no re-resolution that could shift the frame by a pixel.
	const documentAspect = useMemo<AspectRatio>(
		() => getEditorSettings(document).aspectRatio,
		[document],
	);
	const selectedRatios = ratios ?? [documentAspect];

	// The presets, plus the document's own shape when it is not one of them (a native
	// capture ratio, or legacy "native"). Order is the picker's, so the list reads the
	// same here as in the ratio dropdown.
	const ratioOptions = useMemo<AspectRatio[]>(() => {
		const presets = [...ASPECT_RATIO_PRESETS] as AspectRatio[];
		return presets.includes(documentAspect) ? presets : [documentAspect, ...presets];
	}, [documentAspect]);

	// Filenames are suffixed from a concrete `W:H` token — `batchExportPaths` in the main
	// process names a file after two parsed integers and refuses anything else, so legacy
	// "native" has to be resolved to the shape it actually renders at before it can name
	// one. Only the FILENAME uses this; the render still uses the token as selected.
	const concreteToken = (ratio: AspectRatio): AspectRatio => {
		if (ratio !== "native" || !document) return ratio;
		const dims = pickOutputDims(document, "native");
		return toAspectRatioToken(dims.width, dims.height) ?? "16:9";
	};

	const dimsForRatio = (value: ExportQuality, ratio: AspectRatio) =>
		smallestSource
			? calculateMp4ExportSettings({
					quality: value,
					sourceWidth: smallestSource.width,
					sourceHeight: smallestSource.height,
					aspectRatioValue: resolveAspectRatioValue(document, ratio),
				})
			: null;

	// Output dimensions the export will produce for a given tier, from the (crop-aware)
	// SMALLEST clip on the timeline — see `smallestSource` above for why. Only "Source"
	// quality actually uses these as its target size; 720p/1080p target a fixed short side
	// regardless (`calculateDimensionsForShortSide`), so this only changes what "Source"
	// resolves to.
	// GIF is 8-bit indexed and grows fast with area, so the size preset caps the
	// output height rather than following the quality tier. `original` keeps the
	// tier's dims; the native side falls back to its own defaults when undefined.
	const gifOutputDims = (
		preset: GifSizePreset,
		tierDims: { width: number; height: number } | null,
	): { width?: number; height?: number } => {
		if (!tierDims) return {};
		const maxHeight = GIF_SIZE_PRESETS[preset].maxHeight;
		if (!Number.isFinite(maxHeight) || tierDims.height <= maxHeight) {
			return { width: tierDims.width, height: tierDims.height };
		}
		const scale = maxHeight / tierDims.height;
		// Even dimensions: the compositor rasterises to this size and the readback
		// assumes a tightly-packed RGBA buffer.
		const even = (n: number) => Math.max(2, Math.round(n * scale) & ~1);
		return { width: even(tierDims.width), height: even(tierDims.height) };
	};

	// The size badges on the quality cards describe the FIRST file a run writes. With one
	// ratio ticked that is the whole export; with several, the rest differ by shape and the
	// ratio list is where the user reads that.
	const tierOutputDims = (value: ExportQuality) => dimsForRatio(value, selectedRatios[0]);

	// Deliberately NOT reset when `open` goes false. Closing mid-export now means
	// "minimize": the dialog component itself never unmounts (`NewEditorShell` renders it
	// unconditionally), so keeping the state here is all it takes for the floating pill to
	// go on reporting a run the user has clicked away from.

	const handleClose = () => {
		// A finished or failed run is cleared on the way out, so the next open starts on the
		// form. Skipping this would also strand the pill: it renders for any non-idle phase,
		// so a "done" state closed but not cleared would reopen and re-minimize forever.
		if (phase === "done" || phase === "error") {
			setPhase("idle");
			setProgress(null);
			setError(null);
			setSavedPath(null);
		}
		onClose();
	};

	// Asks the native side to stop; the export's own promise is what actually settles, so
	// the phase is left alone here and moved back to idle in `handleStart`'s catch.
	const handleCancel = () => {
		setCancelling(true);
		void window.electronAPI?.exportCancel?.();
	};

	const handleStart = async () => {
		if (!document) return;
		const asset = primaryAsset;
		if (!asset) {
			setError(t("exportDialog.addVideoBeforeExporting"));
			setPhase("error");
			return;
		}

		const safeName = (document.project.title || "Capturia")
			.replace(/[^a-z0-9-_]+/gi, "_")
			.replace(/^_+|_+$/g, "")
			.slice(0, 60);
		const suggested = `${safeName || "export"}${format === "gif" ? ".gif" : ".mp4"}`;

		setPhase("configuring");
		setCancelling(false);
		setError(null);
		setProgress(null);
		setSavedPath(null);
		setBatch(null);

		const exportRatios = selectedRatios;
		if (exportRatios.length === 0) {
			setError(t("exportDialog.pickAnAspectRatio"));
			setPhase("error");
			return;
		}

		// One dialog for the whole run. With several ratios ticked the user names ONE file
		// and the main process derives a sibling per ratio beside it, approves each, and
		// hands the list back — see `batchExportPaths` in electron/exportPolicy.ts. The
		// paths are used exactly as returned: re-deriving them here would be a second copy
		// of that rule, and a path the policy did not register is refused *quietly* on the
		// write route, so the only symptom of a drift would be a file that never appears.
		let destinations: string[];
		try {
			const picker = await window.electronAPI?.pickExportSavePath?.(
				suggested,
				undefined,
				exportRatios.length > 1 ? exportRatios.map(concreteToken) : undefined,
			);
			if (!picker || picker.canceled) {
				setPhase("idle");
				return;
			}
			if (picker.success === false) {
				setError(picker.message ?? t("exportDialog.exportFailedGeneric"));
				setPhase("error");
				return;
			}
			destinations = picker.paths?.length ? picker.paths : picker.path ? [picker.path] : [];
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setPhase("error");
			return;
		}
		if (destinations.length === 0) {
			setPhase("idle");
			return;
		}

		// Both formats go through the native D3D exporter — same clips, same scene,
		// same frame walk in the compositor crate; only the container differs. There
		// is no CPU/web fallback: that path silently regressed to an ultra-slow CPU
		// render once, which is exactly the failure mode a flag-gated fallback
		// invites. Background/layout/webcam/cursor/effects come from the same scene
		// as the live preview, so an export can no longer disagree with what the
		// user previewed.
		{
			setPhase("rendering");
			// Render the real timeline when there are clips; else fall back to the fixture.
			const clips = buildNativeClipList(document);
			if (clips.length === 0) {
				setError(t("exportDialog.nothingToExport"));
				setPhase("error");
				return;
			}
			// GIF runs at its own frame rate, so the progress total has to use it.
			const outFps = format === "gif" ? gifFrameRate : fps;
			// Total frames the encoder will produce, known upfront from the timeline — the
			// native side only reports frames AFTER composing one (onNativeExportProgress),
			// it doesn't know or send a total, so this is computed here to turn that raw
			// count into a percentage.
			//
			// It has to count SPEED-ADJUSTED frames, not source seconds: a clip under a 1.25x
			// region emits 80% of `duration * fps`, which is where the "frozen at ~80%" of
			// OpenScreen#371 came from — the bar climbed to 80% and the export finished
			// there. `outputFrameCount` mirrors the compositor's own span arithmetic.
			//
			// Aspect changes the FRAME SIZE, never the frame COUNT, so one total covers every
			// file in a batch and the bar is per-file rather than across the run.
			const totalFrames = outputFrameCount(
				clips,
				buildSceneDescription(document).speedRegions,
				outFps,
			);
			// Reassigned per file so the ETA describes the file on screen, not the run.
			let fileStartedAt = Date.now();
			const unsubscribeProgress = window.electronAPI?.onNativeExportProgress?.((frames) => {
				const elapsedS = (Date.now() - fileStartedAt) / 1000;
				const fractionDone = Math.min(1, frames / totalFrames);
				const estimatedTimeRemaining = fractionDone > 0 ? elapsedS / fractionDone - elapsedS : 0;
				setProgress({
					currentFrame: frames,
					totalFrames,
					percentage: fractionDone * 100,
					estimatedTimeRemaining,
				});
			});

			// A box, not a bare `let`: TypeScript resets the narrowing of a `let` that is
			// assigned inside a callback, so reading it after the batch would type as `null`.
			const lastStats: { current: { videoDurationS: number; wallS: number } | null } = {
				current: null,
			};
			try {
				// The webcam background effect is applied by the compositor from the scene,
				// so the clip list needs no pre-rendering pass.
				const exportClips = clips;
				const result = await runBatchExport(destinations, async (destination, index) => {
					const ratio = exportRatios[index];
					setBatch({ index: index + 1, total: destinations.length, ratio });
					setProgress(null);
					fileStartedAt = Date.now();

					// Aspect is not a crop here — it is the shape of the output frame, and the
					// scene's layout is derived from it (caption column, webcam rect, padding
					// box, corner radius all resolve against `pickOutputDims`). So a ratio needs
					// its OWN scene, not the same scene rasterised at different dimensions;
					// reusing one would lay the frame out for 16:9 and then encode it at 9:16.
					// Patching the setting is how the document says "render as this shape", and
					// an unchanged ratio patches nothing so the single-file path is untouched.
					const docForRatio =
						ratio === documentAspect
							? document
							: patchEditorSettings(document, { aspectRatio: ratio });
					const sceneJson = JSON.stringify(buildSceneDescription(docForRatio));
					const outDims = dimsForRatio(quality, ratio);

					lastStats.current =
						format === "gif"
							? await exportGifNative(exportClips, destination, sceneJson, {
									// GIF is 256-colour and grows fast; cap the long edge at the
									// chosen preset rather than exporting at source size.
									...gifOutputDims(gifSize, outDims),
									fps: gifFrameRate,
									// 0 = infinite, the historical GIF default; 1 = play once.
									loopCount: gifLoop ? 0 : 1,
									dither: gifDither,
								})
							: await exportMultiNative(exportClips, destination, sceneJson, {
									width: outDims?.width,
									height: outDims?.height,
									fps,
									codec,
								});
					// Cues and timings do not depend on the output shape, so every file in a
					// batch gets the same subtitles beside it — under its own stem, which the
					// approval above already registered.
					await writeSubtitleSidecars(document, destination);
				});

				if (!result.failure) {
					const finished = result.completed[result.completed.length - 1];
					setSavedPath(finished);
					setPhase("done");
					const stats = lastStats.current;
					toast.success(t("exportDialog.exportedVideo"), {
						description:
							result.completed.length > 1
								? t("exportDialog.batchExportedCount", { count: result.completed.length })
								: `${finished}${stats ? ` · ${formatHms(stats.videoDurationS)} ${t("exportDialog.exportedVideoOf")} ${formatHms(stats.wallS)}` : ""}`,
						action: {
							label: t("exportDialog.showInFolder"),
							// The toast is gone in five seconds; the done panel below keeps the same
							// action around for as long as the dialog is open.
							onClick: () => revealExportedFile(finished),
						},
					});
				} else if (result.failure.kind === "cancelled") {
					// A cancel is a user decision, not a failure: back to the form, no error
					// panel. The partial file is already gone — the compositor's cleanup facade
					// removes it on any `Err`, including this one — so anything already finished
					// is the complete list of what survives, and the toast names how many.
					setPhase("idle");
					setProgress(null);
					setSavedPath(null);
					if (result.completed.length > 0) {
						toast.info(t("exportDialog.batchCancelledAfter", { count: result.completed.length }));
					}
				} else {
					// Name the file that failed and the ones that did not run, so a folder with
					// two of three files in it is not something the user has to decode.
					setError(
						result.completed.length > 0
							? `${result.failure.message} — ${t("exportDialog.batchPartial", {
									count: result.completed.length,
									files: result.completed.map(fileNameOf).join(", "),
								})}`
							: result.failure.message,
					);
					setPhase("error");
					toast.error(t("exportDialog.exportFailed"), { description: result.failure.message });
				}
			} catch (err) {
				// `runBatchExport` reports a job's rejection rather than rethrowing, so reaching
				// here means the batch machinery itself broke — kept so it cannot fail silently.
				const message = err instanceof Error ? err.message : String(err);
				setError(message);
				setPhase("error");
				toast.error(t("exportDialog.exportFailed"), { description: message });
			} finally {
				setCancelling(false);
				setBatch(null);
				unsubscribeProgress?.();
			}
			return;
		}
	};

	const isBusy = phase === "rendering" || phase === "writing" || phase === "configuring";
	const pct = progress?.percentage ?? 0;
	const gifSizeLabel = GIF_SIZE_PRESETS[gifSize].label;

	// The minimized form, rendered INSTEAD of the modal: `ModalShell` renders nothing while
	// closed, and "closed" is exactly when the pill has to be on screen. Safe as an early
	// return because every hook above it has already run — none follow.
	// No `onReopen` means the host has nowhere to reopen to, so there is no pill.
	if (!open && onReopen && phase !== "idle") {
		return (
			<ExportProgressFloat phase={phase} progress={progress} format={format} onClick={onReopen} />
		);
	}

	return (
		<ModalShell
			open={open}
			onClose={handleClose}
			title={t("exportDialog.title")}
			subtitle={t("exportDialog.subtitle")}
		>
			<div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
				<div
					style={{
						display: "grid",
						gridTemplateColumns: "1fr 1fr",
						gap: 8,
					}}
				>
					<FormatToggle
						active={format === "mp4"}
						label={ts("exportFormat.mp4")}
						icon={<FileVideo size={18} />}
						onClick={() => setFormat("mp4")}
						disabled={isBusy}
					/>
					<FormatToggle
						active={format === "gif"}
						label={ts("exportFormat.gif")}
						icon={<Download size={18} />}
						onClick={() => setFormat("gif")}
						disabled={isBusy}
					/>
				</div>

				<section>
					<div
						style={{
							font: "500 11px/1 var(--font-body)",
							textTransform: "uppercase",
							letterSpacing: "0.06em",
							color: "var(--muted)",
							marginBottom: 8,
						}}
					>
						{t("exportDialog.aspectRatios")}
					</div>
					<div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
						{ratioOptions.map((r) => {
							const on = selectedRatios.includes(r);
							return (
								<button
									type="button"
									key={r}
									role="checkbox"
									aria-checked={on}
									disabled={isBusy}
									onClick={() =>
										setRatios(
											on
												? selectedRatios.filter((entry) => entry !== r)
												: // Keep the picker's order, not click order, so the files come out
													// in the order the list reads.
													ratioOptions.filter(
														(entry) => entry === r || selectedRatios.includes(entry),
													),
										)
									}
									style={segStyle(on)}
								>
									{getAspectRatioLabel(r)}
								</button>
							);
						})}
					</div>
					<div
						style={{
							marginTop: 6,
							font: "400 11px/1.4 var(--font-body)",
							color: "var(--muted)",
						}}
					>
						{selectedRatios.length > 1
							? t("exportDialog.aspectRatiosBatchHint", { count: selectedRatios.length })
							: t("exportDialog.aspectRatiosHint")}
					</div>
				</section>

				{format === "mp4" ? (
					<section>
						<div
							style={{
								font: "500 11px/1 var(--font-body)",
								textTransform: "uppercase",
								letterSpacing: "0.06em",
								color: "var(--muted)",
								marginBottom: 8,
							}}
						>
							{t("exportDialog.quality")}
						</div>
						<div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
							{QUALITY_OPTIONS.map((q) => (
								<button
									type="button"
									key={q.value}
									disabled={isBusy}
									onClick={() => setQuality(q.value)}
									style={{
										display: "flex",
										flexDirection: "column",
										gap: 2,
										padding: "10px 12px",
										border: `1px solid ${quality === q.value ? "var(--accent)" : "var(--border)"}`,
										borderRadius: 10,
										background: quality === q.value ? "var(--accent-wash)" : "var(--surface)",
										color: "var(--fg-2)",
										cursor: "pointer",
										font: "500 13px/1 var(--font-body)",
									}}
								>
									<span style={{ color: "var(--fg)", fontWeight: 600 }}>{ts(q.labelKey)}</span>
									{(() => {
										const dims = tierOutputDims(q.value);
										if (!dims) return null;
										// Downscale badge removed everywhere — restated what picking a lower
										// tier already means, not actionable. The upscale badge asks whether
										// the clip has to be STRETCHED to fill this frame (`wouldUpscale`),
										// which is a contain-fit question: a short-side compare read the
										// letterbox rows a non-16:9 source gets in a 16:9 project as if they
										// were stretched pixels, and flagged "1080p" on the very frame
										// "Source" produced unflagged. No "Source" special case any more —
										// its frame is the source's long side at the project ratio, so its
										// contain scale is never above 1 and the general test covers it.
										const isUpscale = smallestSource !== null && wouldUpscale(dims, smallestSource);
										return (
											<span
												style={{
													font: "500 11px var(--font-body)",
													color: isUpscale ? "var(--warn)" : "var(--muted)",
												}}
											>
												{dims.width} × {dims.height}
												{isUpscale ? ` · ${t("exportDialog.qualityUpscaleWarning")}` : ""}
											</span>
										);
									})()}
								</button>
							))}
						</div>
						<div
							style={{
								display: "grid",
								gridTemplateColumns: "1fr 1fr",
								gap: 12,
								marginTop: 12,
							}}
						>
							<div>
								<div
									style={{
										font: "500 11px/1 var(--font-body)",
										textTransform: "uppercase",
										letterSpacing: "0.06em",
										color: "var(--muted)",
										marginBottom: 8,
									}}
								>
									{t("exportDialog.frameRate")}
								</div>
								<div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
									{([24, 30, 60] as const).map((r) => (
										<button
											type="button"
											key={r}
											disabled={isBusy}
											onClick={() => setFps(r)}
											style={segStyle(fps === r)}
										>
											{r}
										</button>
									))}
								</div>
							</div>
							<div>
								<div
									style={{
										font: "500 11px/1 var(--font-body)",
										textTransform: "uppercase",
										letterSpacing: "0.06em",
										color: "var(--muted)",
										marginBottom: 8,
									}}
								>
									{t("exportDialog.codec")}
								</div>
								<div
									style={{
										display: "grid",
										gridTemplateColumns: "repeat(2, 1fr)",
										gap: 6,
									}}
								>
									{(
										[
											["h264", "H.264"],
											["h265", "H.265"],
											// VP9 has no AMF hardware encoder on this GPU — the native pipeline
											// (the only MP4 export path now) rejects it outright (tested: a
											// software libvpx-vp9 fallback worked but was too slow to ship).
											// Hidden here rather than left selectable-then-erroring.
										] as Array<[ExportVideoCodec, string]>
									).map(([value, label]) => (
										<button
											type="button"
											key={value}
											disabled={isBusy}
											onClick={() => setCodec(value)}
											style={segStyle(codec === value)}
											title={
												value === "h264"
													? t("exportDialog.codecBestCompatibility")
													: t("exportDialog.codecMaySupportVary")
											}
										>
											{label}
										</button>
									))}
								</div>
							</div>
						</div>
					</section>
				) : (
					<section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
						<div>
							<div
								style={{
									font: "500 11px/1 var(--font-body)",
									textTransform: "uppercase",
									letterSpacing: "0.06em",
									color: "var(--muted)",
									marginBottom: 8,
								}}
							>
								{t("exportDialog.frameRate")}
							</div>
							<div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6 }}>
								{GIF_FRAME_RATES.map((r) => (
									<button
										type="button"
										key={r.value}
										disabled={isBusy}
										onClick={() => setGifFrameRate(r.value)}
										style={segStyle(gifFrameRate === r.value)}
									>
										{r.value} FPS
									</button>
								))}
							</div>
						</div>
						<div>
							<div
								style={{
									font: "500 11px/1 var(--font-body)",
									textTransform: "uppercase",
									letterSpacing: "0.06em",
									color: "var(--muted)",
									marginBottom: 8,
								}}
							>
								{t("exportDialog.size")}
							</div>
							<div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
								{(Object.keys(GIF_SIZE_PRESETS) as GifSizePreset[]).map((s) => (
									<button
										type="button"
										key={s}
										disabled={isBusy}
										onClick={() => setGifSize(s)}
										style={segStyle(gifSize === s)}
									>
										{GIF_SIZE_PRESETS[s].label}
									</button>
								))}
							</div>
						</div>
						<div className={styles.paneRow} style={{ margin: 0 }}>
							<span className={styles.label}>{t("exportDialog.loopGif")}</span>
							<button
								type="button"
								className={`${styles.toggle} ${gifLoop ? styles.isOn : ""}`}
								aria-pressed={gifLoop}
								disabled={isBusy}
								onClick={() => setGifLoop((v) => !v)}
							/>
						</div>
						<div className={styles.paneRow} style={{ margin: 0 }}>
							<span className={styles.label} title={t("exportDialog.ditherGifHint")}>
								{t("exportDialog.ditherGif")}
							</span>
							<button
								type="button"
								className={`${styles.toggle} ${gifDither ? styles.isOn : ""}`}
								aria-label={t("exportDialog.ditherGif")}
								aria-pressed={gifDither}
								disabled={isBusy}
								onClick={() => setGifDither((v) => !v)}
							/>
						</div>
						<div
							style={{
								font: "500 11px/1.4 var(--font-mono)",
								color: "var(--muted)",
								letterSpacing: "0.04em",
							}}
						>
							{gifFrameRate} FPS · {gifSizeLabel} ·{" "}
							{gifLoop ? t("exportDialog.loopOn") : t("exportDialog.loopOff")}
						</div>
					</section>
				)}

				{batch && batch.total > 1 && (
					<div
						data-testid="export-batch-progress"
						style={{
							font: "500 12px/1 var(--font-body)",
							color: "var(--muted)",
						}}
					>
						{t("exportDialog.batchProgress", {
							current: batch.index,
							total: batch.total,
							ratio: getAspectRatioLabel(batch.ratio),
						})}
					</div>
				)}

				<ProgressBlock
					phase={phase}
					progress={progress}
					error={error}
					pct={pct}
					savedPath={savedPath}
				/>

				{cpuCompositor && phase !== "done" && (
					// Placed next to the export button, not in a toast: it has to land while
					// the user is still deciding. A CPU export renders every effect correctly
					// but takes minutes rather than seconds, and an unexplained ten-minute
					// wait reads as a hang.
					<p
						data-testid="export-cpu-warning"
						style={{
							margin: "0 0 4px",
							fontSize: "0.8125rem",
							lineHeight: 1.4,
							color: "var(--text-muted, rgb(0 0 0 / 0.65))",
						}}
					>
						{t("cpuCompositor.exportWarning")}
					</p>
				)}

				<div
					style={{
						display: "flex",
						justifyContent: "flex-end",
						gap: 8,
						paddingTop: 12,
						borderTop: "1px solid var(--border-soft)",
					}}
				>
					<button
						type="button"
						className={`${styles.btn} ${styles.btnSecondary}`}
						// Enabled during the render — being unable to stop a running export was
						// the whole defect. Only a cancel already in flight disables it.
						onClick={isBusy ? handleCancel : handleClose}
						disabled={isBusy && cancelling}
					>
						{isBusy
							? td("export.cancelExport")
							: phase === "done"
								? t("exportDialog.close")
								: t("exportDialog.cancel")}
					</button>
					<button
						type="button"
						className={`${styles.btn} ${styles.btnPrimary}`}
						onClick={handleStart}
						disabled={isBusy || !document}
					>
						{isBusy ? (
							<>
								<Loader2 size={14} className="animate-spin" />
								{phase === "rendering"
									? t("exportDialog.rendering")
									: phase === "writing"
										? t("exportDialog.saving")
										: t("exportDialog.starting")}
							</>
						) : (
							<>
								<Download size={14} />
								{format === "gif" ? t("exportDialog.exportGif") : t("exportDialog.exportMp4")}
							</>
						)}
					</button>
				</div>
			</div>
		</ModalShell>
	);
}

function FormatToggle({
	active,
	label,
	icon,
	onClick,
	disabled,
}: {
	active: boolean;
	label: string;
	icon: React.ReactNode;
	onClick: () => void;
	disabled?: boolean;
}) {
	return (
		<button
			type="button"
			disabled={disabled}
			onClick={onClick}
			style={{
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				gap: 8,
				padding: "12px 16px",
				border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
				borderRadius: 10,
				background: active ? "var(--accent-wash)" : "var(--surface)",
				// Selection is conveyed by border + wash background (like the quality
				// cards below), not by swapping text color -- `--accent-on` is meant
				// for text on a SOLID accent fill, and paired with the near-transparent
				// `--accent-wash` it read as near-invisible dark-on-dark text.
				color: "var(--fg)",
				cursor: "pointer",
				font: "600 14px/1 var(--font-body)",
			}}
		>
			{icon}
			{label}
		</button>
	);
}

function ProgressBlock({
	phase,
	progress,
	error,
	pct,
	savedPath,
}: {
	phase: Phase;
	progress: ExportProgress | null;
	error: string | null;
	pct: number;
	savedPath: string | null;
}) {
	const t = useScopedT("editor");
	if (phase === "idle" || phase === "configuring") {
		return (
			<div
				style={{
					padding: "16px",
					border: "1px solid var(--border)",
					borderRadius: 10,
					background: "var(--surface-1)",
					color: "var(--muted)",
					font: "500 12px var(--font-body)",
					textAlign: "center",
				}}
			>
				{t("exportDialog.pickFormatAndExport")}
			</div>
		);
	}
	if (phase === "done") {
		return (
			<div
				style={{
					padding: "16px",
					border: "1px solid var(--brand)",
					borderRadius: 10,
					background: "var(--success-soft)",
					color: "var(--fg-2)",
					font: "500 12px var(--font-body)",
					display: "flex",
					flexDirection: "column",
					alignItems: "flex-start",
					gap: 12,
				}}
			>
				<div>
					{t("exportDialog.savedTo")}{" "}
					<span style={{ fontFamily: "var(--font-mono)" }}>{savedPath}</span>
				</div>
				{savedPath ? (
					<button
						type="button"
						data-testid="export-show-in-folder"
						className={`${styles.btn} ${styles.btnSecondary}`}
						onClick={() => revealExportedFile(savedPath)}
					>
						<FolderOpen size={14} />
						{t("exportDialog.showInFolder")}
					</button>
				) : null}
			</div>
		);
	}
	if (phase === "error") {
		return (
			<div
				style={{
					padding: "16px",
					border: "1px solid var(--danger)",
					borderRadius: 10,
					background: "var(--danger-soft)",
					color: "var(--danger)",
					font: "500 12px var(--font-body)",
				}}
			>
				{error ?? t("exportDialog.exportFailedGeneric")}
			</div>
		);
	}
	const current = progress?.currentFrame ?? 0;
	const total = progress?.totalFrames ?? 0;
	const eta = progress?.estimatedTimeRemaining ?? 0;
	return (
		<div
			style={{
				padding: "12px 14px",
				border: "1px solid var(--border)",
				borderRadius: 10,
				background: "var(--surface-1)",
				display: "flex",
				flexDirection: "column",
				gap: 8,
			}}
		>
			<div
				style={{
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
				}}
			>
				<span style={{ font: "500 12px var(--font-body)", color: "var(--fg-2)" }}>
					{phase === "writing" ? t("exportDialog.writingFile") : t("exportDialog.renderingFrames")}
				</span>
				<span
					style={{
						font: "500 12px/1 var(--font-mono)",
						color: "var(--brand)",
					}}
				>
					{Math.round(pct)}%
				</span>
			</div>
			<div
				style={{
					position: "relative",
					height: 8,
					background: "var(--surface-3)",
					borderRadius: 999,
					overflow: "hidden",
				}}
			>
				<div
					style={{
						position: "absolute",
						inset: 0,
						width: `${Math.max(0, Math.min(100, pct))}%`,
						background: "var(--brand)",
						transition: "width 200ms var(--ease)",
					}}
				/>
			</div>
			<div
				style={{
					font: "500 11px/1.4 var(--font-mono)",
					color: "var(--muted)",
					letterSpacing: "0.04em",
				}}
			>
				{total > 0
					? t("exportDialog.framesEta", { current, total, eta: Math.max(0, Math.round(eta)) })
					: t("exportDialog.preparingEncoder")}
			</div>
		</div>
	);
}

function segStyle(active: boolean): React.CSSProperties {
	return {
		padding: "8px 10px",
		border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
		borderRadius: 8,
		background: active ? "var(--brand)" : "var(--bg)",
		color: active ? "var(--accent-on)" : "var(--fg-2)",
		cursor: "pointer",
		font: "500 12px/1 var(--font-body)",
	};
}
