// Settings → "Save recordings to": whether the saved folder is usable, and which folders a
// path from the renderer may name. The choice itself is persisted in recording-settings.ts.
//
// Choosing a folder decides where NEW takes are written. It does not move anything, and the
// default folder (`RECORDINGS_DIR`, under userData) never stops being a root, so every take
// recorded before the choice keeps working where it is.
//
// Node-pure, like `recordingsCleanup.ts`: no `electron` import, every directory is injected.

import { closeSync, lstatSync, openSync, realpathSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { recordingGroupKeyFromFileName } from "../src/lib/recordingsCleanupPolicy";

/**
 * Throws unless a file can really be created in `folder`.
 *
 * Not `access(W_OK)`: on Windows libuv answers W_OK for a directory without looking at its
 * ACL, so a read-only share or `C:\Program Files` passes — and a take then streams nowhere,
 * or buffers to the end and dies at the final write. Creating a file is the one answer that
 * holds on every platform.
 */
function probeWritable(folder: string): void {
	const probe = path.join(folder, `.capturia-probe-${process.pid}`);
	const fd = openSync(probe, "wx");
	try {
		closeSync(fd);
	} finally {
		unlinkSync(probe);
	}
}

/**
 * `folder` when it is an absolute path to an existing directory — and, with `writable`, one this
 * process can create files in — else null, which means "use the default folder".
 *
 * Asked on every use rather than once: a drive can be unplugged, or a permission revoked,
 * between two takes, and the saved file can say anything.
 */
export function validRecordingsFolder(
	folder: string | null,
	options: { writable?: boolean } = {},
): string | null {
	if (!folder || !path.isAbsolute(folder)) return null;
	try {
		if (!statSync(folder).isDirectory()) return null;
		if (options.writable) probeWritable(folder);
		return path.resolve(folder);
	} catch {
		return null;
	}
}

/** Lexical containment: rejects `..` traversal and sibling prefixes, does not look at links. */
export function isPathWithinDir(filePath: string, dirPath: string): boolean {
	const resolved = path.resolve(filePath);
	const resolvedDir = path.resolve(dirPath);
	return resolved === resolvedDir || resolved.startsWith(resolvedDir + path.sep);
}

/** `realpath`, except that a path with nothing behind it yet is judged by its parent directory. */
function realpathAllowingMissing(filePath: string): string {
	try {
		return realpathSync(filePath);
	} catch (error) {
		// A dangling link reports ENOENT too, and can still be written through, so only a path
		// that lstat cannot find either gets the parent's answer.
		if (
			(error as NodeJS.ErrnoException).code !== "ENOENT" ||
			lstatSync(filePath, { throwIfNoEntry: false })
		) {
			throw error;
		}
		return path.join(realpathSync(path.dirname(filePath)), path.basename(filePath));
	}
}

/**
 * Whether a renderer-supplied path may be read or written as a recording.
 *
 * The default folder is app-private and keeps exactly the lexical check it always had. The
 * chosen folder is the user's — `~/Videos`, a whole drive — so inside it only a file named like
 * a take counts (`recordingGroupKeyFromFileName`: Capturia's own names, nothing else in there),
 * and the path must still be inside once links are resolved: a symlink in that folder pointing
 * out of it is not a way out.
 */
export function isPathWithinRecordingRoots(
	filePath: string,
	defaultDir: string,
	chosenDir: string | null,
): boolean {
	if (isPathWithinDir(filePath, defaultDir)) return true;
	if (!chosenDir || !isPathWithinDir(filePath, chosenDir)) return false;
	if (recordingGroupKeyFromFileName(path.basename(filePath)) === null) return false;
	try {
		return isPathWithinDir(
			realpathAllowingMissing(path.resolve(filePath)),
			realpathSync(chosenDir),
		);
	} catch {
		return false;
	}
}

/**
 * Where a renderer-named take file goes: `fileName` inside `takeDir`, or a throw.
 *
 * The renderer names this file and main then creates, truncates or deletes it (the stream
 * handlers, the empty-take unlink), so it must be a bare name, one Capturia writes, and still
 * inside a recordings root once links are resolved — a `recording-5.mp4` in the chosen folder
 * that links out of it is refused, dangling or not.
 */
export function takeOutputPath(
	fileName: string,
	takeDir: string,
	defaultDir: string,
	chosenDir: string | null,
): string {
	const trimmed = fileName.trim();
	if (!trimmed) {
		throw new Error("Invalid recording file name");
	}

	const parsedPath = path.parse(trimmed);
	const hasTraversalSegments = trimmed.split(/[\\/]+/).some((segment) => segment === "..");
	const isNestedPath =
		parsedPath.dir !== "" ||
		path.isAbsolute(trimmed) ||
		trimmed.includes("/") ||
		trimmed.includes("\\");
	if (hasTraversalSegments || isNestedPath || parsedPath.base !== trimmed) {
		throw new Error("Recording file name must not contain path segments");
	}
	if (recordingGroupKeyFromFileName(parsedPath.base) === null) {
		throw new Error("Recording file name is not one Capturia writes");
	}

	const target = path.join(takeDir, parsedPath.base);
	if (!isPathWithinRecordingRoots(target, defaultDir, chosenDir)) {
		throw new Error("Recording file resolves outside the recordings folder");
	}
	return target;
}
