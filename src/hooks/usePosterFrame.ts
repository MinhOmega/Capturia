import { useEffect, useState } from "react";

/**
 * Poster frame of a project (by id) or a media file (by path, at `atSec`), as a
 * `data:` URL. Null until it arrives, and for good when there is none — the
 * caller keeps its placeholder. Never holds up a render: the frame is grabbed
 * and cached by the main process (electron/media/posterFrames.ts). A changed
 * request keeps showing the previous poster until the new answer lands, so it
 * never flashes back to the placeholder in between.
 */
export function usePosterFrame(
	source: "project" | "media",
	id: string | null,
	atSec = 0,
): string | null {
	const [poster, setPoster] = useState<string | null>(null);
	useEffect(() => {
		const api = window.electronAPI;
		if (!id || !api?.getProjectPoster || !api.getMediaPoster) {
			setPoster(null);
			return;
		}
		let live = true;
		const request = source === "project" ? api.getProjectPoster(id) : api.getMediaPoster(id, atSec);
		request.then(
			(url) => {
				if (live) setPoster(url);
			},
			() => undefined,
		);
		return () => {
			live = false;
		};
	}, [source, id, atSec]);
	return poster;
}
