import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { SttModelId } from "./transcriptionContract";

export type { SttModelId } from "./transcriptionContract";

/**
 * Manages the lifetime of the on-disk model artifacts used by the STT stack.
 *
 * Each model is a single GGML file downloaded from HuggingFace
 * (`ggerganov/whisper.cpp` — the model-file repo predates and is separate
 * from the `ggml-org` GitHub org the engine itself now lives under;
 * `ggml-org/whisper.cpp` on HuggingFace is a different, access-gated repo
 * and returns 401 on every file including README.md — confirmed by curl).
 * whisper.cpp bakes precision into the file, so there is no runtime `--int8`
 * flag. The user picks one of three in AI settings; `balanced`, the q8_0
 * quantized `small` multilingual model, is the default and what every install
 * before the choice existed was running.
 *
 * Every file is verified by SHA-256 and written atomically (via .partial rename)
 * to prevent partial downloads from being treated as complete.
 *
 * Word timestamps come from whisper.cpp's native DTW token timestamps, so no
 * separate VAD model is required. See `technical-documentation/architecture/transcription-and-captions.md`.
 */

export interface SttModelFile {
	/** Relative path within the model directory (e.g. "ggml-small-q8_0.bin"). */
	name: string;
	/** HuggingFace resolve URL for this file. */
	url: string;
	/** Expected SHA-256 hex digest; null to skip verification. */
	expectedSha256: string | null;
	/** Approximate download size in bytes (for progress reporting). */
	approximateBytes: number;
}

export interface SttModelDescriptor {
	/** Display + cache directory name. */
	cacheDir: string;
	/** HuggingFace repo identifier (e.g. "ggerganov/whisper.cpp"). */
	repoId: string;
	/**
	 * The helper's `--dtw-preset`: which model family's alignment heads DTW reads.
	 * It has to match the file — a mismatched preset makes whisper_init fail.
	 */
	dtwPreset: "base" | "small" | "large-v3-turbo";
	/** List of model files to download (currently a single GGML file). */
	files: SttModelFile[];
}

const MODEL_BASE = "https://huggingface.co";
// ponytail: this is deliberately NOT "ggml-org/whisper.cpp" — that HF repo
// (matching the GitHub org the engine now lives under) is access-gated and
// returns 401 Unauthorized on every file, confirmed by curl. whisper.cpp's
// own models/download-ggml-model.sh pulls from ggerganov/whisper.cpp, the
// long-standing public model-file repo that never moved when the engine's
// GitHub org was renamed.
const MODEL_REPO = "ggerganov/whisper.cpp";
// Pinned to a commit rather than `main` so `expectedSha256` is an invariant and
// not a bet: `main` is a mutable branch pointer, and a re-upload under it would
// now invalidate every cache in the field at once instead of merely breaking new
// installs. Every digest below was computed by downloading the file from this
// revision and hashing it, and matches the LFS oid HuggingFace's paths-info API
// reports for it.
const MODEL_REVISION = "5359861c739e955e79d9a303bcbc70fb988958b1";

function ggmlFile(name: string, expectedSha256: string, bytes: number): SttModelFile {
	return {
		name,
		url: `${MODEL_BASE}/${MODEL_REPO}/resolve/${MODEL_REVISION}/${name}`,
		expectedSha256,
		approximateBytes: bytes,
	};
}

// Sizes are the exact byte counts of the pinned files. q8_0 for the two small
// models, where the saving from a coarser quantization is tens of MB and the
// accuracy cost is not; q5_0 for turbo, a large model that tolerates it and
// where q8_0 would add 300 MB.
export const STT_MODELS: Record<SttModelId, SttModelDescriptor> = {
	fast: {
		cacheDir: "whisper-ggml",
		repoId: MODEL_REPO,
		dtwPreset: "base",
		files: [
			ggmlFile(
				"ggml-base-q8_0.bin",
				"c577b9a86e7e048a0b7eada054f4dd79a56bbfa911fbdacf900ac5b567cbb7d9",
				81_768_585,
			),
		],
	},
	balanced: {
		cacheDir: "whisper-ggml",
		repoId: MODEL_REPO,
		dtwPreset: "small",
		files: [
			ggmlFile(
				"ggml-small-q8_0.bin",
				"49C8FB02B65E6049D5FA6C04F81F53B867B5EC9540406812C643F177317F779F",
				264_464_607,
			),
		],
	},
	accurate: {
		cacheDir: "whisper-ggml",
		repoId: MODEL_REPO,
		dtwPreset: "large-v3-turbo",
		files: [
			ggmlFile(
				"ggml-large-v3-turbo-q5_0.bin",
				"394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
				574_041_195,
			),
		],
	},
};

/** The model a fresh install runs, and the one every install ran before the choice existed. */
export const DEFAULT_STT_MODEL: SttModelId = "balanced";

export function isSttModelId(value: unknown): value is SttModelId {
	return typeof value === "string" && (Object.keys(STT_MODELS) as string[]).includes(value);
}

export function modelPath(baseDir: string, id: SttModelId): string {
	const { cacheDir, files } = STT_MODELS[id];
	return path.join(baseDir, cacheDir, files[0].name);
}

/**
 * True when the model's GGML file exists and is non-empty. Only ever a final,
 * verified file can sit at that path (see `ensureFile`), and `ensureModels`
 * re-verifies it before any run loads it.
 */
export async function isModelPresent(baseDir: string, id: SttModelId): Promise<boolean> {
	try {
		const s = await stat(modelPath(baseDir, id));
		return s.isFile() && s.size > 0;
	} catch {
		return false;
	}
}

const ACTIVE_MODEL_FILE = "active-model.json";

/** The model transcription loads. Anything unreadable falls back to the default. */
export async function readActiveModel(baseDir: string): Promise<SttModelId> {
	try {
		const raw = JSON.parse(await readFile(path.join(baseDir, ACTIVE_MODEL_FILE), "utf8")) as {
			id?: unknown;
		};
		return isSttModelId(raw.id) ? raw.id : DEFAULT_STT_MODEL;
	} catch {
		return DEFAULT_STT_MODEL;
	}
}

export async function writeActiveModel(baseDir: string, id: SttModelId): Promise<void> {
	await mkdir(baseDir, { recursive: true });
	await writeFile(path.join(baseDir, ACTIVE_MODEL_FILE), `${JSON.stringify({ id })}\n`, "utf8");
}

/** Verify SHA-256 of a file in 64 KiB chunks; resolves to the lowercase hex digest. */
export async function sha256OfFile(filePath: string): Promise<string> {
	const hash = createHash("sha256");
	await pipeline(createReadStream(filePath), hash);
	return hash.digest("hex");
}

const MAX_ATTEMPTS = 6;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt: number, retryAfter: string | null): number {
	if (retryAfter) {
		const secs = Number(retryAfter);
		if (Number.isFinite(secs)) return Math.min(60_000, secs * 1000);
		const at = Date.parse(retryAfter);
		if (!Number.isNaN(at)) return Math.min(60_000, Math.max(0, at - Date.now()));
	}
	return Math.min(60_000, 2_000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 1000);
}

async function fetchWithRetry(url: string, fetcher: typeof fetch): Promise<Response> {
	let lastErr: unknown;
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		try {
			const res = await fetcher(url, {
				headers: { "user-agent": "openscreen-stt" },
			});
			if (res.ok && res.body) return res;
			if (res.status >= 400 && res.status < 500 && !RETRYABLE_STATUS.has(res.status)) {
				throw new Error(`Failed to download ${url}: HTTP ${res.status} ${res.statusText}`);
			}
			if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_ATTEMPTS) {
				await sleep(backoffMs(attempt, res.headers.get("retry-after")));
				continue;
			}
			throw new Error(`Failed to download ${url}: HTTP ${res.status} ${res.statusText}`);
		} catch (err) {
			lastErr = err;
			if (err instanceof Error && err.message.startsWith("Failed to download")) {
				throw err;
			}
			if (attempt >= MAX_ATTEMPTS) throw err;
			await sleep(backoffMs(attempt, null));
		}
	}
	throw lastErr;
}

export interface DownloadOptions {
	/** Called with cumulative bytes for progress reporting. */
	onProgress?: (bytes: number) => void;
	/** Override fetch (for tests); defaults to `globalThis.fetch`. */
	fetcher?: typeof fetch;
}

/**
 * Stream a model file to disk atomically (<filename>.partial → rename on
 * success), optionally verify the SHA-256.
 *
 * If the file already exists, is non-empty, and matches the expected hash,
 * skips the download; otherwise a replacement is fetched and the stale copy is
 * only displaced once that replacement has itself been verified.
 */
async function ensureFile(
	filePath: string,
	fileUrl: string,
	expectedSha256: string | null,
	options: DownloadOptions = {},
): Promise<void> {
	if (existsSync(filePath)) {
		const s = await stat(filePath);
		if (s.isFile() && s.size > 0) {
			if (!expectedSha256) return;
			const actual = await sha256OfFile(filePath);
			if (actual.toLowerCase() === expectedSha256.toLowerCase()) return;
			// Deliberately leave the stale file where it is. Moving it aside now
			// would buy nothing — the rename at the end of this function is already
			// atomic, so there is no window to close — while costing the user their
			// only model if the replacement never lands (offline, HF 5xx, ENOSPC)
			// and stranding 264 MB that nothing ever cleans up.
		}
	}

	await mkdir(path.dirname(filePath), { recursive: true });

	const fetcher = options.fetcher ?? fetch;
	const res = await fetchWithRetry(fileUrl, fetcher);
	const tmp = `${filePath}.partial`;
	let downloaded = 0;

	const source = Readable.fromWeb(res.body as never);
	source.on("data", (chunk: Buffer | Uint8Array) => {
		downloaded += chunk.length;
		options.onProgress?.(downloaded);
	});
	const { createWriteStream } = await import("node:fs");
	try {
		await pipeline(source, createWriteStream(tmp));
	} catch (error) {
		// A dropped connection must not strand hundreds of MB of `.partial`. It
		// could never pass as the model anyway — only the rename below creates
		// that name, and only after the digest matched.
		await rm(tmp, { force: true }).catch(() => undefined);
		throw error;
	}

	if (expectedSha256) {
		const actual = await sha256OfFile(tmp);
		if (actual.toLowerCase() !== expectedSha256.toLowerCase()) {
			// Drop the bad download and keep whatever was already on disk: when both
			// copies mismatch, the bytes the user has been running are exactly the
			// ones worth diagnosing. The cleanup is guarded because a Windows AV
			// scanner still holding the handle raises EPERM/EBUSY, and that bare
			// errno would escape in place of the mismatch message below.
			await rm(tmp, { force: true }).catch(() => undefined);
			throw new Error(
				`SHA-256 mismatch for ${path.basename(filePath)}: expected ${expectedSha256}, got ${actual}`,
			);
		}
	}
	await rename(tmp, filePath);
}

export interface EnsureModelsOptions {
	baseDir: string;
	/** Models to ensure; defaults to `DEFAULT_STT_MODEL`. */
	only?: SttModelId[];
	onProgress?: (event: {
		id: SttModelId;
		file: string;
		downloadedBytes: number;
		totalBytes: number;
	}) => void;
	fetcher?: typeof fetch;
}

/** Ensure the GGML model files are present locally; downloads with progress + retry. */
export async function ensureModels(opts: EnsureModelsOptions): Promise<void> {
	const targets = (opts.only ?? [DEFAULT_STT_MODEL]).map((id) => ({
		id,
		descriptor: STT_MODELS[id],
		filePath: modelPath(opts.baseDir, id),
	}));

	for (const { id, descriptor, filePath } of targets) {
		await mkdir(path.dirname(filePath), { recursive: true });

		const file = descriptor.files[0];
		await ensureFile(filePath, file.url, file.expectedSha256, {
			onProgress: (bytes) =>
				opts.onProgress?.({
					id,
					file: file.name,
					downloadedBytes: bytes,
					totalBytes: file.approximateBytes,
				}),
			fetcher: opts.fetcher,
		});
	}
}
