// The recording's flagged moments, as timeline positions.
//
// Two halves, deliberately split: the sidecar read is keyed on the ASSET PATH
// and so runs once per project load, while the timeline conversion is keyed on
// the clips, trims and speed regions and so re-runs on every edit. Loading the
// file on every edit would re-read it hundreds of times during a drag; caching
// the converted positions would leave markers stuck where the content used to
// be. Source time in, live positions out — see
// `src/lib/ai-edition/timeline/recordingMarkers.ts`.

import { useEffect, useMemo, useState } from "react";
import {
	type ResolvedRecordingMarker,
	resolveRecordingMarkers,
} from "../timeline/recordingMarkers";
import { useProjectStore } from "./projectStore";

/**
 * The asset markers belong to: the recording the project was built around.
 *
 * Markers are written beside ONE file by the recorder, so there is exactly one
 * asset that can carry them. `primaryAssetId` is what `addAsset` claims for the
 * first asset in a project, which for a recorded project is the screen capture.
 */
function primaryVideoAsset(document: ReturnType<typeof useProjectStore.getState>["document"]) {
	if (!document) return undefined;
	const byId = document.assets.find((asset) => asset.id === document.project.primaryAssetId);
	return byId ?? document.assets.find((asset) => asset.kind !== "audio");
}

export function useRecordingMarkers(): ResolvedRecordingMarker[] {
	const document = useProjectStore((state) => state.document);
	const asset = primaryVideoAsset(document);
	const assetId = asset?.id;
	const originalPath = asset?.originalPath;
	const [markersMs, setMarkersMs] = useState<number[]>([]);

	useEffect(() => {
		let cancelled = false;
		if (!originalPath) {
			setMarkersMs([]);
			return;
		}

		void window.electronAPI
			?.getRecordingMarkers?.(originalPath)
			.then((result) => {
				if (!cancelled) setMarkersMs(result?.markers ?? []);
			})
			.catch((error: unknown) => {
				// A recording with no sidecar is the normal case, so this is only
				// reached when the IPC itself failed. Nothing to show, nothing to say.
				console.warn("Failed to load recording markers:", error);
				if (!cancelled) setMarkersMs([]);
			});

		return () => {
			cancelled = true;
		};
	}, [originalPath]);

	return useMemo(
		() => resolveRecordingMarkers(document, assetId, markersMs),
		[document, assetId, markersMs],
	);
}
