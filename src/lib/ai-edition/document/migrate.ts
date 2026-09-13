// Migration from OpenScreen's v2 EditorProjectData to the current
// AxcutDocument. See technical-documentation/architecture/document-model.md
// for the field-by-field mapping. The migration is pure (no DOM, no fs, no
// network) — the renderer probes asset duration at runtime.
//
// ponytail: this is the only code path that produces v2->current documents
// today. Phase 1 adds direct writers (recording -> asset + clip) and the
// migration becomes the back-compat reader. Until then it is the front door
// for AI-edition. (schemaVersion 3->4 upgrades for already-existing v3
// documents are handled transparently inside documentSchema itself.)

import type { EditorProjectData } from "@/components/video-editor/projectPersistence";
import type {
	AnnotationRegion,
	SpeedRegion,
	TrimRegion,
	ZoomRegion,
} from "@/components/video-editor/types";
import {
	type AxcutAnnotationRegion,
	type AxcutDocument,
	type AxcutLegacyEditor,
	type AxcutTrimRange,
	type AxcutZoomRegion,
	documentSchema,
	migrateRawDocumentToCurrent,
} from "../schema";
import { createId } from "./ids";

const MS_TO_SEC = 1 / 1000;

interface MigrationOptions {
	projectId?: string;
	title?: string;
	createdAt?: string;
}

function msToSec(ms: number): number {
	return Math.round(ms * MS_TO_SEC * 1000) / 1000;
}

function clampSec(sec: number): number {
	if (!Number.isFinite(sec) || sec < 0) return 0;
	return Math.round(sec * 1000) / 1000;
}

/**
 * Re-exported from `../schema`, where the composer lives so the Electron main
 * process can import it without dragging this module's `@/`-aliased value
 * imports into a bundle that has no alias configured.
 *
 * v2 inputs are not handled by it — `migrateProjectDataToAxcutDocument` below
 * still owns the legacy EditorProjectData → AxcutDocument translation.
 */
export { migrateRawDocumentToCurrent } from "../schema";

/**
 * Migrate a v2 EditorProjectData into a v3 AxcutDocument. The single recording
 * becomes one asset + one clip spanning the source. trimRegions become
 * trimRanges on that asset (semantically identical: both are cuts).
 */
export function migrateProjectDataToAxcutDocument(
	input: EditorProjectData,
	options: MigrationOptions = {},
): AxcutDocument {
	const now = options.createdAt ?? new Date().toISOString();
	const projectId = options.projectId ?? createId("proj");
	const title = options.title ?? (input.editor?.wallpaper?.trim() || "Untitled Project");

	const screenPath =
		typeof input.media?.screenVideoPath === "string" && input.media.screenVideoPath
			? input.media.screenVideoPath
			: typeof input.videoPath === "string" && input.videoPath
				? input.videoPath
				: null;

	const webcamVideoPath = input.media?.webcamVideoPath;
	// Rounded for the same reason as the auto-link in `projectStore.addAsset`:
	// `cameraTrackSchema.offsetMs` is an integer, and the native capture paths
	// measure this with `performance.now()`. A legacy project carrying the raw
	// value would fail to parse — losing the whole document, not just its camera.
	const webcamOffsetMs = Math.round(input.media?.webcamOffsetMs ?? 0);

	const assets = screenPath
		? [
				{
					id: createId("asset"),
					kind: "video" as const,
					label: screenPath.split(/[\\/]/).pop() || "Recording",
					originalPath: screenPath,
					cameraTrack: webcamVideoPath
						? { sourcePath: webcamVideoPath, startMs: 0, offsetMs: webcamOffsetMs, visible: true }
						: null,
				},
			]
		: [];

	const primaryAssetId = assets[0]?.id;

	const trimRegions: TrimRegion[] = Array.isArray(input.editor?.trimRegions)
		? input.editor.trimRegions
		: [];
	const speedRegions: SpeedRegion[] = Array.isArray(input.editor?.speedRegions)
		? input.editor.speedRegions
		: [];
	const zoomRegions: ZoomRegion[] = Array.isArray(input.editor?.zoomRegions)
		? input.editor.zoomRegions
		: [];
	const annotationRegions: AnnotationRegion[] = Array.isArray(input.editor?.annotationRegions)
		? input.editor.annotationRegions
		: [];

	const clip = primaryAssetId
		? {
				id: createId("clip"),
				assetId: primaryAssetId,
				sourceStartSec: 0,
				timelineStartSec: 0,
				timelineEndSec: 0,
				wordRefs: [] as string[],
				origin: "system" as const,
				reason: "migrated from v2",
			}
		: null;

	// Anchored to `clip` right here rather than left to `upgradeV6DocumentToV7`: a v2
	// project has exactly one clip, so the clip is known and unambiguous, and the upgrader
	// could not do it anyway — the clip it mints has no source extent yet (the duration only
	// arrives once the renderer probes the file), and anchoring needs a real window.
	const trimRanges: AxcutTrimRange[] = primaryAssetId
		? trimRegions
				.filter((region) => region && typeof region.id === "string")
				.map((region) => {
					const startMs = Math.max(0, Math.min(region.startMs ?? 0, region.endMs ?? 0));
					const endMs = Math.max(startMs + 1, region.endMs ?? startMs + 1);
					return {
						id: createId("trim"),
						assetId: primaryAssetId,
						...(clip ? { clipId: clip.id } : {}),
						startSec: clampSec(msToSec(startMs)),
						endSec: clampSec(msToSec(endMs)),
						origin: "user" as const,
						reason: "migrated from v2 trimRegion",
					};
				})
		: [];

	// ponytail: speedRegions stay on the legacy editor envelope — axcut's
	// rangeSchema doesn't carry a speed value, and Phase 1 timeline rewrite is
	// when speed becomes a first-class timeline concept.
	const speedRanges = speedRegions.map((region) => ({
		startSec: clampSec(msToSec(Math.max(0, region.startMs ?? 0))),
		endSec: clampSec(msToSec(Math.max((region.startMs ?? 0) + 1, region.endMs ?? 0))),
		reason: "migrated from v2 speedRegion",
	}));

	// ponytail: annotations[] and zoomRanges[] mirror editor.annotationRegions
	// and editor.zoomRegions directly (same ms units) so the renderer can swap
	// them in/out without conversion. The timeline (trimRanges, speedRanges,
	// clip) uses axcut's seconds because the new timeline ops land there.
	const migratedZoomRanges: AxcutZoomRegion[] = zoomRegions
		.filter((region) => region && typeof region.id === "string")
		.map((region) => ({
			id: region.id,
			startMs: Math.max(0, region.startMs ?? 0),
			endMs: Math.max((region.startMs ?? 0) + 1, region.endMs ?? 0),
			depth: [1, 2, 3, 4, 5, 6].includes(region.depth) ? region.depth : 3,
			focus: {
				cx: Math.min(1, Math.max(0, region.focus?.cx ?? 0.5)),
				cy: Math.min(1, Math.max(0, region.focus?.cy ?? 0.5)),
			},
			...(region.focusMode === "auto" ? { focusMode: "auto" as const } : {}),
			...(region.rotationPreset ? { rotationPreset: region.rotationPreset } : {}),
			...(typeof region.customScale === "number" ? { customScale: region.customScale } : {}),
			...(region.source === "auto" || region.source === "manual" ? { source: region.source } : {}),
		}));

	const migratedAnnotations: AxcutAnnotationRegion[] = annotationRegions
		.filter((region) => region && typeof region.id === "string")
		.map((region) => ({
			id: region.id,
			startMs: Math.max(0, region.startMs ?? 0),
			endMs: Math.max((region.startMs ?? 0) + 1, region.endMs ?? 0),
			type: region.type,
			content: region.content ?? "",
			...(region.textContent ? { textContent: region.textContent } : {}),
			...(region.imageContent ? { imageContent: region.imageContent } : {}),
			position: region.position,
			size: region.size,
			style: region.style,
			zIndex: region.zIndex,
			...(region.annotationSource === "auto-caption"
				? { annotationSource: "auto-caption" as const }
				: {}),
			...(region.figureData ? { figureData: region.figureData } : {}),
			...(region.blurData ? { blurData: region.blurData } : {}),
		}));

	const legacyEditor: AxcutLegacyEditor = input.editor ? { ...input.editor } : null;

	// Emits the **v4** shape (per-asset cameraTrack + RAW-virtual-ms regions) and lets
	// `migrateRawDocumentToCurrent` perform the v4→v5 clip-anchoring, so the
	// modifier migration lives in exactly ONE place instead of being duplicated here.
	// Deliberately not `axcutSchemaVersion`: that would label the draft as already-v5
	// and the upgrader would skip anchoring, leaving v2-imported regions unanchored.
	// Untyped on purpose — this is the INPUT to `documentSchema.parse` (which
	// validates it), not an already-valid v5 document.
	const draft = {
		schemaVersion: 4,
		project: {
			id: projectId,
			title,
			createdAt: now,
			updatedAt: now,
			...(primaryAssetId ? { primaryAssetId } : {}),
		},
		assets,
		transcript: null,
		transcripts: [],
		timeline: {
			clips: clip ? [clip] : [],
			gaps: [],
			trimRanges,
			muteRanges: [],
			speedRanges,
			captionRanges: [],
		},
		annotations: migratedAnnotations,
		zoomRanges: migratedZoomRanges,
		legacyEditor,
	};

	return documentSchema.parse(migrateRawDocumentToCurrent(draft));
}
