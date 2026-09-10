// Writing the subtitle sidecars beside a finished export.
//
// Split from `subtitles.ts` so that module stays pure and unit-testable under plain node;
// everything that touches `window.electronAPI` lives here. Shared by the GUI export dialog
// and the headless CLI runner, which is the point: a CLI is the batch path, and "the GUI
// wrote subtitles but `openscreen export` did not" is exactly the asymmetry an automation
// user would hit and not report.
//
// BOTH formats are written, and there is no setting to choose between them. That is not
// laziness about a preference — it is the cheaper correct answer. A format toggle would
// need a field on `CaptionSettings` (which has none today: the `WEBVTT` mentions in
// settings.ts are prose about how formats state POSITION, not a stored preference), a
// control in the dialog, and a string in all thirteen locales — to make the user answer a
// question they cannot be expected to have an opinion on. Two text files cost a few KB and
// let them open whichever their tool wants. `ApprovedExportPaths.approve` already registers
// both `.srt` and `.vtt` as siblings of every approved video, so the policy was built for
// exactly this.

import type { AxcutDocument } from "../schema";
import { getCaptionSettings } from "./settings";
import { buildSubtitleSidecar, SUBTITLE_SIDECAR_FORMATS, subtitleSidecarPath } from "./subtitles";
import { getCaptionTranslations } from "./translations";

/**
 * Write `<export>.srt` and `<export>.vtt` next to `videoPath`, for a project with captions on.
 *
 * No control gates this: captions being enabled IS the request, and the sidecar carries the
 * same lines the compositor is burning in, in the one form a viewer can turn off or search.
 * `buildSubtitleSidecar` returns null when there is nothing to write, so a project without
 * captions gets no stray files.
 *
 * NEVER throws, and never reports failure. By the time this runs the video is on disk and,
 * in the GUI, the user has already been told the export succeeded; letting a sidecar turn a
 * finished render into an error would be a worse bug than the missing file it was added to
 * fix. Returns the paths actually written, which is what the callers log.
 */
export async function writeSubtitleSidecars(
	document: AxcutDocument | null | undefined,
	videoPath: string,
): Promise<string[]> {
	if (!document) return [];
	const written: string[] = [];
	try {
		const settings = getCaptionSettings(document);
		const translations = getCaptionTranslations(document);
		for (const format of SUBTITLE_SIDECAR_FORMATS) {
			const content = buildSubtitleSidecar(document, settings, translations, format);
			if (!content) continue;
			const target = subtitleSidecarPath(videoPath, format);
			const result = await window.electronAPI?.writeExportToPath?.(
				new TextEncoder().encode(content).buffer,
				target,
			);
			// A refusal here almost always means the derived path fell outside the export
			// policy's approved siblings, so say which path was rejected rather than just
			// that "something" failed — that is the one detail needed to diagnose it.
			if (result?.success) written.push(target);
			else console.error(`Subtitle sidecar refused: ${target}`, result?.message);
		}
	} catch (err) {
		console.error("Failed to write subtitle sidecars:", err);
	}
	return written;
}
