import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureModels, isModelPresent, modelPath, STT_MODELS } from "./modelManager";

describe("modelManager", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(path.join(tmpdir(), "stt-models-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("pins every model to one GGML file with a SHA-256, and keeps small as balanced", () => {
		expect(STT_MODELS.balanced.files[0].name).toBe("ggml-small-q8_0.bin");
		for (const model of Object.values(STT_MODELS)) {
			expect(model.cacheDir).toBe("whisper-ggml");
			expect(model.repoId).toBe("ggerganov/whisper.cpp");
			expect(model.files.length).toBe(1);
			for (const f of model.files) {
				expect(f.expectedSha256).toMatch(/^[0-9a-f]{64}$/i);
				expect(f.approximateBytes).toBeGreaterThan(0);
				expect(f.url).toContain("huggingface.co");
				// Pinned to an immutable commit: resolving through `main` would let a
				// re-upload invalidate every cached model in the field at once.
				expect(f.url).toMatch(/\/resolve\/[0-9a-f]{40}\//);
			}
		}
	});

	it("modelPath places the GGML file under the cache directory", () => {
		const file = modelPath(dir, "balanced");
		expect(file).toBe(path.join(dir, "whisper-ggml", "ggml-small-q8_0.bin"));
	});

	it("isModelPresent returns false when the model file is missing", async () => {
		expect(await isModelPresent(dir, "balanced")).toBe(false);
	});

	it("isModelPresent returns true once the GGML file is present", async () => {
		const file = modelPath(dir, "balanced");
		await mkdir(path.dirname(file), { recursive: true });
		expect(await isModelPresent(dir, "balanced")).toBe(false);
		await writeFile(file, "dummy-ggml");
		expect(await isModelPresent(dir, "balanced")).toBe(true);
	});

	it("ensureModels succeeds when the file is already present (cache hit)", async () => {
		const file = modelPath(dir, "balanced");
		await mkdir(path.dirname(file), { recursive: true });
		const cached = Buffer.from("dummy-ggml");
		await writeFile(file, cached);
		const originalSha = STT_MODELS.balanced.files[0].expectedSha256;
		STT_MODELS.balanced.files[0].expectedSha256 = createHash("sha256").update(cached).digest("hex");
		let fetches = 0;
		const fetcher: typeof fetch = async () => {
			fetches++;
			return new Response("should not be reached", { status: 200 });
		};
		try {
			await ensureModels({
				baseDir: dir,
				only: ["balanced"],
				fetcher,
				onProgress: () => undefined,
			});
			expect(fetches).toBe(0);
		} finally {
			STT_MODELS.balanced.files[0].expectedSha256 = originalSha;
		}
	});

	it("re-downloads a non-empty cached model when its checksum is wrong", async () => {
		const file = modelPath(dir, "balanced");
		await mkdir(path.dirname(file), { recursive: true });
		await writeFile(file, "corrupt-cache");
		const replacement = Buffer.from("verified-ggml-weights");
		const originalSha = STT_MODELS.balanced.files[0].expectedSha256;
		STT_MODELS.balanced.files[0].expectedSha256 = createHash("sha256")
			.update(replacement)
			.digest("hex");
		let fetches = 0;
		const fetcher: typeof fetch = async () => {
			fetches++;
			return new Response(replacement, { status: 200 });
		};

		try {
			await ensureModels({ baseDir: dir, only: ["balanced"], fetcher });
			expect(fetches).toBe(1);
			expect(await readFile(file)).toEqual(replacement);
			// The stale copy is displaced by the atomic rename, not quarantined
			// beside it: a `.bad` sibling would strand 264 MB nothing ever reaps.
			expect(existsSync(`${file}.bad`)).toBe(false);
			expect(existsSync(`${file}.partial`)).toBe(false);
		} finally {
			STT_MODELS.balanced.files[0].expectedSha256 = originalSha;
		}
	});

	it("never lets a mismatching download occupy the live model path", async () => {
		const file = modelPath(dir, "balanced");
		const originalSha = STT_MODELS.balanced.files[0].expectedSha256;
		STT_MODELS.balanced.files[0].expectedSha256 = createHash("sha256")
			.update("the-weights-we-asked-for")
			.digest("hex");
		const served = Buffer.from("truncated-or-tampered-weights");
		const fetcher: typeof fetch = async () => new Response(served, { status: 200 });

		try {
			await expect(ensureModels({ baseDir: dir, only: ["balanced"], fetcher })).rejects.toThrow(
				/SHA-256 mismatch/,
			);
			expect(existsSync(file)).toBe(false);
			expect(existsSync(`${file}.partial`)).toBe(false);
		} finally {
			STT_MODELS.balanced.files[0].expectedSha256 = originalSha;
		}
	});

	it("keeps the cached model when the replacement download also mismatches", async () => {
		const file = modelPath(dir, "balanced");
		await mkdir(path.dirname(file), { recursive: true });
		await writeFile(file, "the-only-copy-the-user-has");
		const originalSha = STT_MODELS.balanced.files[0].expectedSha256;
		STT_MODELS.balanced.files[0].expectedSha256 = createHash("sha256")
			.update("the-weights-we-asked-for")
			.digest("hex");
		const fetcher: typeof fetch = async () =>
			new Response(Buffer.from("also-wrong"), { status: 200 });

		try {
			await expect(ensureModels({ baseDir: dir, only: ["balanced"], fetcher })).rejects.toThrow(
				/SHA-256 mismatch/,
			);
			expect(await readFile(file, "utf8")).toBe("the-only-copy-the-user-has");
		} finally {
			STT_MODELS.balanced.files[0].expectedSha256 = originalSha;
		}
	});

	it("ensureModels downloads the missing GGML file with progress", async () => {
		const file = modelPath(dir, "balanced");
		const originalSha = STT_MODELS.balanced.files[0].expectedSha256;
		STT_MODELS.balanced.files[0].expectedSha256 = null;

		const progressCalls: Array<{
			id: string;
			file: string;
			bytes: number;
		}> = [];
		let fetches = 0;

		const fetcher: typeof fetch = async (input) => {
			fetches++;
			// ensureModels passes a plain string URL, but a `typeof fetch` stub has to
			// honour the whole signature (string | URL | Request).
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			const content = Buffer.from(`content-for-${url.split("/").pop()}`);
			return new Response(content, { status: 200 });
		};

		try {
			await ensureModels({
				baseDir: dir,
				only: ["balanced"],
				fetcher,
				onProgress: (ev) => {
					progressCalls.push({
						id: ev.id,
						file: ev.file,
						bytes: ev.downloadedBytes,
					});
				},
			});

			expect(fetches).toBe(1);
			const s = await stat(file);
			expect(s.size).toBeGreaterThan(0);
			expect(progressCalls.length).toBeGreaterThanOrEqual(1);
			expect(progressCalls[0].file).toBe("ggml-small-q8_0.bin");
		} finally {
			STT_MODELS.balanced.files[0].expectedSha256 = originalSha;
		}
	});

	it("ensureModels surfaces 4xx errors immediately instead of retrying", async () => {
		let fetches = 0;
		const fetcher: typeof fetch = async () => {
			fetches++;
			return new Response("auth required", {
				status: 401,
				statusText: "Unauthorized",
			});
		};

		await expect(
			ensureModels({
				baseDir: dir,
				only: ["balanced"],
				fetcher,
				onProgress: () => undefined,
			}),
		).rejects.toThrow(/HTTP 401/);

		expect(fetches).toBe(1);
	});

	it("ensureModels retries transient 5xx errors with bounded backoff", async () => {
		const originalSha = STT_MODELS.balanced.files[0].expectedSha256;
		STT_MODELS.balanced.files[0].expectedSha256 = null;
		const attempts: number[] = [];
		const fetcher: typeof fetch = async () => {
			attempts.push(attempts.length + 1);
			if (attempts.length <= 1) {
				return new Response("busy", {
					status: 503,
					statusText: "Service Unavailable",
				});
			}
			return new Response(Buffer.from("ggml weights"), { status: 200 });
		};

		try {
			await ensureModels({
				baseDir: dir,
				only: ["balanced"],
				fetcher,
				onProgress: () => undefined,
			});
			expect(attempts).toHaveLength(2);
		} finally {
			STT_MODELS.balanced.files[0].expectedSha256 = originalSha;
		}
	});
});
