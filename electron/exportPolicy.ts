import nodePath from "node:path";
import { PROJECT_FILE_EXTENSION_PATTERN } from "../src/lib/projectFileExtension";

/**
 * Where an export may be written.
 *
 * `write-export-to-path` takes an absolute path from the renderer and writes the
 * buffer there, creating parent directories on the way. It used to check only
 * that the path was absolute and ended in `.mp4`/`.gif` — "the renderer is
 * trusted (contextIsolation on), but a stale-state bug shouldn't be able to
 * clobber arbitrary files". With `webSecurity: false` and model-generated
 * content in the editor, a stale-state bug is no longer the worst case, and an
 * extension check is not a destination check: `~/.ssh/config.mp4` passes it.
 *
 * A destination becomes writable only when the user named it:
 *
 *  - the exact path a save dialog returned (`pick-export-save-path`), or
 *  - the exact path the user typed on the command line (`openscreen export
 *    --out …`), including the path the CLI derives from the project file when
 *    `--out` is omitted.
 *
 * Nothing here is inferred from the renderer's own claims, and no directory is
 * approved wholesale: the GUI names one file per export, and so does the CLI.
 *
 * Pure on purpose — no `electron` import, no `app.getPath` — so it unit-tests
 * under plain Node and can be offered upstream on its own.
 */

export type PlatformPath = typeof nodePath;

/** Containers `write-export-to-path` may produce. */
export const ALLOWED_EXPORT_EXTENSIONS: ReadonlySet<string> = new Set([".mp4", ".gif"]);

/**
 * Sidecars the export writes beside its video. Approved *with* a destination and
 * never on their own: a subtitle file is not something the renderer may name, it
 * is something that follows from a video the user already named.
 */
export const SIDECAR_EXPORT_EXTENSIONS: ReadonlySet<string> = new Set([".srt", ".vtt"]);

function canonicalize(filePath: string, platformPath: PlatformPath): string {
	const resolved = platformPath.resolve(filePath);
	// Windows paths are case-insensitive; comparing them case-sensitively would
	// reject a destination the user just picked.
	return platformPath === nodePath.win32 ? resolved.toLowerCase() : resolved;
}

export function hasAllowedExportExtension(
	filePath: string,
	platformPath: PlatformPath = nodePath,
): boolean {
	return ALLOWED_EXPORT_EXTENSIONS.has(platformPath.extname(filePath).toLowerCase());
}

/** Exact export destinations the user chose, keyed by canonical path. */
export class ApprovedExportPaths {
	private readonly files = new Set<string>();
	private readonly platformPath: PlatformPath;

	constructor(platformPath: PlatformPath = nodePath) {
		this.platformPath = platformPath;
	}

	/** Record a destination. Returns the resolved path, or null if it is not one we would ever write. */
	approve(filePath: unknown): string | null {
		if (typeof filePath !== "string" || filePath.trim().length === 0) return null;
		const trimmed = filePath.trim();
		if (!this.platformPath.isAbsolute(trimmed)) return null;
		const extension = this.platformPath.extname(trimmed).toLowerCase();
		// Only a video is approvable as a destination; the sidecars come with it.
		if (!ALLOWED_EXPORT_EXTENSIONS.has(extension)) return null;
		this.files.add(canonicalize(trimmed, this.platformPath));
		const withoutExtension = trimmed.slice(0, trimmed.length - extension.length);
		for (const sidecar of SIDECAR_EXPORT_EXTENSIONS) {
			this.files.add(canonicalize(withoutExtension + sidecar, this.platformPath));
		}
		return this.platformPath.resolve(trimmed);
	}

	isApproved(filePath: unknown): boolean {
		if (typeof filePath !== "string" || filePath.trim().length === 0) return false;
		const trimmed = filePath.trim();
		if (!this.platformPath.isAbsolute(trimmed)) return false;
		// No extension gate here on purpose. The set only ever holds what `approve`
		// registered -- a video the user named, plus its sidecars -- so membership is
		// already the stronger statement. Re-testing the extension would also drag
		// sidecar extensions into `hasAllowedExportExtension`, whose other caller is
		// the save-dialog append gate: widening it there makes a typed `demo.srt`
		// skip the `.mp4` append and then fail approval outright.
		return this.files.has(canonicalize(trimmed, this.platformPath));
	}
}

/** Process-wide registry behind `write-export-to-path`. */
export const approvedExportPaths = new ApprovedExportPaths();

/**
 * Every destination a CLI export could legitimately write.
 *
 * With `--out` the path is exactly what the user typed. Without it the runner
 * derives one from the project file, and the extension depends on a format that
 * is only resolved renderer-side (it can come from the project itself), so both
 * candidates are approved rather than duplicating that resolution here.
 *
 * In lock-step with `replaceExtension` in `src/cli/CliExportRunner.tsx` by
 * construction — both strip `PROJECT_FILE_EXTENSION_PATTERN` and nothing else,
 * so `path.parse` (which would strip any final extension) is deliberately not
 * used. A destination this misses is one the export cannot write, which is why
 * the pattern is shared rather than copied.
 */
export function cliExportDestinations(request: {
	readonly projectPath?: string | null;
	readonly outPath?: string | null;
}): string[] {
	if (request.outPath) return [request.outPath];
	const projectPath = request.projectPath;
	if (!projectPath) return [];
	const stem = projectPath.replace(PROJECT_FILE_EXTENSION_PATTERN, "");
	if (!stem) return [];
	return [...ALLOWED_EXPORT_EXTENSIONS].map((extension) => `${stem}${extension}`);
}
