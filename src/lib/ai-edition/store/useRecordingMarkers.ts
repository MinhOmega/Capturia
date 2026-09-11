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
	primaryVideoAsset,
	type ResolvedRecordingMarker,
	resolveRecordingMarkers,
} from "../timeline/recordingMarkers";
import { useProjectStore } from "./projectStore";

/**
 * `markers` for drawing; `markersMs` — the stored source times — for a caller that
 * has to resolve them again later against a document that has moved on since.
 */
export function useRecordingMarkers(): {
	markers: ResolvedRecordingMarker[];
	markersMs: number[];
} {
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

	const markers = useMemo(
		() => resolveRecordingMarkers(document, assetId, markersMs),
		[document, assetId, markersMs],
	);
	return { markers, markersMs };
}
