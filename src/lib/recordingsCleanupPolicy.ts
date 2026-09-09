/**
 * What may be deleted from the recordings directory, and in what order.
 *
 * Nothing sweeps it today: every take a user ever started is still there, plus
 * the sidecars and scratch files of the ones that were discarded or died. The
 * directory grows without bound until the disk does the deciding — which is the
 * other half of the problem `recordingDiskSpace.ts` guards against.
 *
 * Pure, and pure on purpose: this decides, `electron/recordingsCleanup.ts` does.
 * Every rule below is a boundary someone will want to argue with, and arguing
 * with it should not require a filesystem.
 */

/** Every artefact of one take shares this stem, webcam file included. */
const RECORDING_GROUP = String.raw`(recording-\d+)`;
const VIDEO_EXTENSIONS = new Set(["webm", "mp4", "mov", "m4v", "mkv", "avi"]);
const VIDEO_FILE_PATTERN = new RegExp(`^${RECORDING_GROUP}(?:-webcam)?\\.([a-z0-9]+)$`, "i");
/** `<video>.cursor.json` / `<video>.markers.json` — suffixed onto the FULL name. */
const SIDECAR_PATTERN = new RegExp(
	`^${RECORDING_GROUP}(?:-webcam)?\\.[a-z0-9]+\\.(cursor|markers)\\.json$`,
	"i",
);
/** `recording-<id>.session.json`, which replaces the extension rather than appending. */
const SESSION_PATTERN = new RegExp(`^${RECORDING_GROUP}\\.session\\.json$`, "i");
/**
 * Scratch files of the two on-disk container repairs
 * (`electron/recording/webm-duration.ts`, `webm-seek-index.ts`). Both write a
 * sibling and rename it over the recording, so one of these still lying around
 * means the process died mid-repair: it is never useful and never referenced.
 */
const SCRATCH_PATTERN = new RegExp(
	`^${RECORDING_GROUP}(?:-webcam)?\\.[a-z0-9]+\\.(duration-patch|reindex)\\.tmp$`,
	"i",
);

export interface RecordingArtifactEntry {
	name: string;
	size: number;
	mtimeMs: number;
}

export interface RecordingCleanupPolicy {
	maxTotalBytes: number;
	targetTotalBytes: number;
	maxVideoAgeMs: number;
	minKeepVideoGroups: number;
	orphanSidecarAgeMs: number;
}

export interface RecordingCleanupPlan {
	filesToDelete: string[];
	managedTotalBytes: number;
	managedGroupCount: number;
	estimatedBytesFreed: number;
}

type ManagedKind = "video" | "sidecar" | "session" | "scratch";

interface RecordingGroup {
	key: string;
	files: RecordingArtifactEntry[];
	/** Leftover repair scratch; never useful once the repair is over. */
	scratchFiles: RecordingArtifactEntry[];
	hasVideo: boolean;
	totalBytes: number;
	latestMtimeMs: number;
}

export const DEFAULT_RECORDING_CLEANUP_POLICY: RecordingCleanupPolicy = {
	maxTotalBytes: 8 * 1024 * 1024 * 1024,
	targetTotalBytes: Math.floor(8 * 1024 * 1024 * 1024 * 0.8),
	maxVideoAgeMs: 30 * 24 * 60 * 60 * 1000,
	minKeepVideoGroups: 20,
	orphanSidecarAgeMs: 3 * 24 * 60 * 60 * 1000,
};

function clampInteger(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.max(min, Math.min(max, Math.floor(value)));
}

function normalizePolicy(input?: Partial<RecordingCleanupPolicy>): RecordingCleanupPolicy {
	const merged = { ...DEFAULT_RECORDING_CLEANUP_POLICY, ...input };
	const maxTotalBytes = clampInteger(merged.maxTotalBytes, 1, 512 * 1024 * 1024 * 1024);
	return {
		maxTotalBytes,
		targetTotalBytes: clampInteger(
			Math.min(merged.targetTotalBytes, maxTotalBytes),
			0,
			maxTotalBytes,
		),
		maxVideoAgeMs: clampInteger(merged.maxVideoAgeMs, 0, 10 * 365 * 24 * 60 * 60 * 1000),
		minKeepVideoGroups: clampInteger(merged.minKeepVideoGroups, 1, 1_000),
		orphanSidecarAgeMs: clampInteger(merged.orphanSidecarAgeMs, 0, 365 * 24 * 60 * 60 * 1000),
	};
}

/**
 * Which take a file belongs to, or null when this cleanup does not own it.
 *
 * Anything unrecognised is left alone — `media-links.registry.json`, a file a
 * user dropped in the folder, whatever a future feature writes there. A sweeper
 * that deletes what it cannot name is how you lose someone's work.
 */
function parseManagedArtifactName(fileName: string): { key: string; kind: ManagedKind } | null {
	const scratch = SCRATCH_PATTERN.exec(fileName);
	if (scratch) return { key: scratch[1], kind: "scratch" };

	const sidecar = SIDECAR_PATTERN.exec(fileName);
	if (sidecar) return { key: sidecar[1], kind: "sidecar" };

	const session = SESSION_PATTERN.exec(fileName);
	if (session) return { key: session[1], kind: "session" };

	const video = VIDEO_FILE_PATTERN.exec(fileName);
	if (!video || !VIDEO_EXTENSIONS.has(video[2].toLowerCase())) return null;
	return { key: video[1], kind: "video" };
}

export function recordingGroupKeyFromFileName(fileName: string): string | null {
	return parseManagedArtifactName(fileName)?.key ?? null;
}

export function isManagedRecordingArtifactName(fileName: string): boolean {
	return parseManagedArtifactName(fileName) !== null;
}

export function createRecordingCleanupPolicy(
	input?: Partial<RecordingCleanupPolicy>,
): RecordingCleanupPolicy {
	return normalizePolicy(input);
}

function toValidEntry(entry: RecordingArtifactEntry): RecordingArtifactEntry | null {
	if (typeof entry.name !== "string" || entry.name.trim().length === 0) return null;
	const size = Number(entry.size);
	const mtimeMs = Number(entry.mtimeMs);
	if (!Number.isFinite(size) || size < 0) return null;
	if (!Number.isFinite(mtimeMs) || mtimeMs < 0) return null;
	return { name: entry.name.trim(), size: Math.floor(size), mtimeMs };
}

function groupManagedArtifacts(entries: RecordingArtifactEntry[]): RecordingGroup[] {
	const byKey = new Map<string, RecordingGroup>();

	for (const entry of entries) {
		const managed = parseManagedArtifactName(entry.name);
		if (!managed) continue;

		const group = byKey.get(managed.key) ?? {
			key: managed.key,
			files: [],
			scratchFiles: [],
			hasVideo: false,
			totalBytes: 0,
			latestMtimeMs: 0,
		};

		group.files.push(entry);
		if (managed.kind === "scratch") group.scratchFiles.push(entry);
		group.hasVideo ||= managed.kind === "video";
		group.totalBytes += entry.size;
		group.latestMtimeMs = Math.max(group.latestMtimeMs, entry.mtimeMs);
		byKey.set(managed.key, group);
	}

	return [...byKey.values()];
}

export interface RecordingCleanupPlanOptions {
	nowMs?: number;
	policy?: Partial<RecordingCleanupPolicy>;
	/**
	 * File names in the recordings dir a saved project still points at. The whole
	 * take is kept regardless of age or budget: a project whose media is gone is
	 * not a freed gigabyte, it is lost work. Resolving which paths those are
	 * belongs to the caller (`electron/recordingsCleanup.ts`); this stays a pure
	 * name set.
	 */
	protectedFileNames?: Iterable<string>;
}

/**
 * The files to delete, in three passes over whole takes:
 *
 *   1. takes older than `maxVideoAgeMs`,
 *   2. oldest-first until the directory is back under `targetTotalBytes`,
 *   3. groups with no video left at all — sidecars, manifests and scratch that
 *      outlived their recording — once they are past `orphanSidecarAgeMs`.
 *
 * Whole takes, never individual files: deleting a video and leaving its cursor
 * sidecar, or the reverse, produces exactly the orphans pass 3 then has to clean
 * up. The newest `minKeepVideoGroups` takes and anything a project references
 * are exempt from all three.
 */
export function planRecordingCleanup(
	entries: RecordingArtifactEntry[],
	options?: RecordingCleanupPlanOptions,
): RecordingCleanupPlan {
	const normalizedEntries = entries
		.map(toValidEntry)
		.filter((entry): entry is RecordingArtifactEntry => Boolean(entry));
	const policy = normalizePolicy(options?.policy);
	const nowMs = Number.isFinite(options?.nowMs) ? Number(options?.nowMs) : Date.now();
	const groups = groupManagedArtifacts(normalizedEntries);
	const managedTotalBytes = groups.reduce((sum, group) => sum + group.totalBytes, 0);

	const protectedFileNames = new Set(options?.protectedFileNames ?? []);
	const protectedKeys = new Set<string>();
	for (const fileName of protectedFileNames) {
		const key = recordingGroupKeyFromFileName(fileName);
		if (key) protectedKeys.add(key);
	}

	const groupsByNewest = [...groups].sort((a, b) => b.latestMtimeMs - a.latestMtimeMs);
	const videoGroupsByNewest = groupsByNewest.filter((group) => group.hasVideo);
	const recentVideoKeys = new Set(
		videoGroupsByNewest.slice(0, policy.minKeepVideoGroups).map((group) => group.key),
	);
	const isExempt = (key: string) => recentVideoKeys.has(key) || protectedKeys.has(key);

	const deletedKeys = new Set<string>();

	const ageThreshold = nowMs - policy.maxVideoAgeMs;
	for (const group of videoGroupsByNewest) {
		if (group.latestMtimeMs >= ageThreshold) continue;
		if (isExempt(group.key)) continue;
		deletedKeys.add(group.key);
	}

	const remainingVideoGroups = videoGroupsByNewest
		.filter((group) => !deletedKeys.has(group.key))
		.sort((a, b) => a.latestMtimeMs - b.latestMtimeMs);

	let remainingVideoBytes = remainingVideoGroups.reduce((sum, g) => sum + g.totalBytes, 0);
	if (remainingVideoBytes > policy.maxTotalBytes) {
		for (const group of remainingVideoGroups) {
			if (remainingVideoBytes <= policy.targetTotalBytes) break;
			if (isExempt(group.key) || deletedKeys.has(group.key)) continue;
			deletedKeys.add(group.key);
			remainingVideoBytes -= group.totalBytes;
		}
	}

	const orphanThreshold = nowMs - policy.orphanSidecarAgeMs;
	for (const group of groupsByNewest) {
		if (group.hasVideo) continue;
		if (group.latestMtimeMs > orphanThreshold) continue;
		if (protectedKeys.has(group.key)) continue;
		deletedKeys.add(group.key);
	}

	const filesToDelete: string[] = [];
	let estimatedBytesFreed = 0;
	for (const group of groupsByNewest) {
		if (deletedKeys.has(group.key)) {
			for (const file of group.files) {
				// Belt and braces: a referenced file never leaves, even if some future
				// rule put its group in the delete set.
				if (protectedFileNames.has(file.name)) continue;
				filesToDelete.push(file.name);
				estimatedBytesFreed += file.size;
			}
			continue;
		}
		// Repair scratch next to a KEPT video is an orphan in its own right: the
		// repair either finished (renamed over the video) or died. The orphan age
		// still applies, so a repair in flight on a take that just finished is
		// never raced.
		for (const file of group.scratchFiles) {
			if (file.mtimeMs > orphanThreshold) continue;
			if (protectedFileNames.has(file.name)) continue;
			filesToDelete.push(file.name);
			estimatedBytesFreed += file.size;
		}
	}

	filesToDelete.sort((a, b) => a.localeCompare(b));

	return {
		filesToDelete,
		managedTotalBytes,
		managedGroupCount: groups.length,
		estimatedBytesFreed,
	};
}
