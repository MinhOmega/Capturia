// Per-region copy/paste clipboard. Backed by module-level state so Cmd+C in
// one component can be picked up by Cmd+V in another. Mirrors the legacy
// regionClipboard pattern but keeps it focused on zoom/annotation/speed
// regions (skip is stored in the timeline directly, so it doesn't go through
// this path).

import { useCallback, useEffect, useState } from "react";

export type RegionSnapshot =
	| { kind: "zoom"; region: Record<string, unknown> }
	| { kind: "annotation"; region: Record<string, unknown> }
	| { kind: "speed"; region: Record<string, unknown> }
	| { kind: "cameraFullscreen"; region: Record<string, unknown> }
	// An audio track copies its whole payload (asset, gain, fades, loop) so a
	// paste is a second placement of the same audio, like every other kind. The
	// snapshot is the COLLAPSED pill, never a stored fragment.
	| { kind: "audio"; region: Record<string, unknown> }
	// A trim carries no user-visible properties, so all there is to copy is how
	// LONG it was — `{ durationSec }`. That is not a special case so much as the
	// general one made obvious: every paste keeps the copied properties and takes
	// its start from the playhead, so a zoom's start/end already change too. A
	// trim just has nothing left once you remove position.
	| { kind: "trim"; region: { durationSec: number } };

/**
 * Per kind, what "paste attributes" writes onto an EXISTING region of that kind.
 *
 * An allow-list rather than a strip-list. Where a region SITS — its id, span, clip
 * anchor, an annotation's `position`, an audio track's `assetId` — is what the target
 * keeps; everything else here is what the clipboard imposes. Allow-listing means a
 * field added to a schema later does not start leaking onto other people's pills the
 * moment it exists: somebody has to come here and say it is an attribute.
 *
 * Empty for `trim` and `cameraFullscreen`: both are a bare span, so there is nothing
 * to paste and the menu entry hides rather than offering a no-op.
 */
const PASTEABLE_KEYS: Record<RegionSnapshot["kind"], readonly string[]> = {
	zoom: ["depth", "focus", "focusMode", "rotationPreset"],
	// `textContent` / `imageContent` are PARKING slots, filled when a type conversion
	// sets the live `content` aside — not attributes. Carrying them would overwrite
	// what the TARGET parked, which is the one thing a conversion exists to protect.
	annotation: ["type", "content", "style", "size", "figureData", "blurData"],
	speed: ["speed"],
	// No `assetId`: the target keeps playing its own file. A clipboard outlives the
	// project it was filled in, so an imposed asset reference is a pill that plays
	// nothing (see the missing-asset guard on create-paste).
	audio: ["gainDb", "fadeInMs", "fadeOutMs", "loop", "muted", "label"],
	cameraFullscreen: [],
	trim: [],
};

/**
 * The copied region reduced to the fields a paste-attributes may write.
 *
 * Pure, and returns `{}` for the kinds that carry nothing — which is also the signal
 * the menu reads to hide the entry, so "has attributes" is one question with one
 * answer instead of a kind list repeated at every call site.
 */
export function pickPasteableAttributes(snap: RegionSnapshot): Record<string, unknown> {
	const region = snap.region as Record<string, unknown>;
	const picked: Record<string, unknown> = {};
	for (const key of PASTEABLE_KEYS[snap.kind]) {
		// `undefined` means the source never had it; writing it would clear the
		// target's own value rather than copy anything.
		if (region[key] !== undefined) picked[key] = region[key];
	}
	return picked;
}

let clipboard: RegionSnapshot | null = null;
const listeners = new Set<() => void>();
function notify() {
	for (const fn of listeners) fn();
}
export function copyRegion(snap: RegionSnapshot) {
	clipboard = { ...snap };
	notify();
}
export function pasteClipboard(): RegionSnapshot | null {
	return clipboard;
}
/** Empty it. What the user copied LAST is what Ctrl+V must paste, so copying a
 *  clip has to retire whatever region sat here — otherwise both clipboards stay
 *  loaded at once and paste is left guessing between them. */
export function clearRegionClipboard() {
	clipboard = null;
	notify();
}
export function useRegionClipboard() {
	const [, force] = useState(0);
	useEffect(() => {
		const fn = () => force((n) => n + 1);
		listeners.add(fn);
		return () => {
			listeners.delete(fn);
		};
	}, []);
	return {
		hasContent: clipboard !== null,
		kind: clipboard?.kind ?? null,
		read: () => clipboard,
	};
}

// React-friendly hook for components to use a stable callback reference.
export function useCopyRegion() {
	return useCallback((snap: RegionSnapshot) => copyRegion(snap), []);
}
