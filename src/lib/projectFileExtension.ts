// The one place that knows what a project file is called.
//
// The extension has been renamed twice — `.axcut` -> `.openscreen` ->
// `.capturia` — and every rename is a data-loss hazard: a build that only looks
// for the newest spelling cannot see the projects the user already saved, and
// `recordingsCleanup` would read "no project references this recording" and
// delete the media out from under them. So the old spellings are never dropped,
// only demoted, and every site that matches on the extension reads this list
// instead of spelling it out again.
//
// It was spelled out in seven files before this one: two constants in
// `document-service.ts`, a list in `recordingsCleanup.ts`, a dotless copy in
// `ipc/handlers.ts`, an `endsWith` each in `cli/args.ts` and
// `EditorEmptyState.tsx`, and a regex duplicated across the process boundary
// between `electron/exportPolicy.ts` and `src/cli/CliExportRunner.tsx` with a
// comment asking the next person to keep the two in step by hand. Under
// `src/lib` because both trees already import from here (see `cliContracts.ts`).

/** What new projects are written as. */
export const PROJECT_FILE_EXTENSION = ".capturia";

/**
 * Spellings older builds wrote, newest first.
 *
 * Order is load-bearing: `DocumentService` migrates legacy files to the
 * canonical name in this order and lets an already-migrated file win, so a
 * project id that somehow has several spellings on disk resolves to the newest
 * one deterministically rather than by readdir order.
 */
export const LEGACY_PROJECT_FILE_EXTENSIONS = [".openscreen", ".axcut"];

/** Everything openable, canonical first. */
export const PROJECT_FILE_EXTENSIONS = [PROJECT_FILE_EXTENSION, ...LEGACY_PROJECT_FILE_EXTENSIONS];

/**
 * True for any spelling the app still opens. Case-insensitive: Windows and
 * macOS both hand back paths in whatever case the user typed them.
 */
export function isProjectFilePath(filePath: string): boolean {
	const lower = filePath.toLowerCase();
	return PROJECT_FILE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/**
 * Trailing project extension, or the `.json` a hand-saved project uses.
 *
 * Anchored and enumerated on purpose: `path.parse` would strip any final
 * extension, so `my.demo.capturia` would lose `.demo` and the CLI would derive
 * an output path the export policy never approved. Used by BOTH
 * `electron/exportPolicy.ts` (which approves the destination) and
 * `src/cli/CliExportRunner.tsx` (which computes it) — they have to agree
 * exactly, and sharing the pattern is the only way that stays true.
 *
 * Built from the list rather than written out, so a future spelling added above
 * cannot be forgotten here.
 */
export const PROJECT_FILE_EXTENSION_PATTERN = new RegExp(
	`\\.(${[...PROJECT_FILE_EXTENSIONS.map((extension) => extension.slice(1)), "json"].join("|")})$`,
	"i",
);
