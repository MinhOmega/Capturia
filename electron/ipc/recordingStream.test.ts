import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IpcMain } from "electron";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RecordingStreamRegistry, registerRecordingStreamHandlers } from "./recordingStream";

describe("RecordingStreamRegistry", () => {
	let dir: string;
	const pathFor = (name: string) => path.join(dir, name);

	beforeEach(async () => {
		dir = await mkdtemp(path.join(tmpdir(), "openscreen-stream-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("streams chunks to disk in order and reports streamed on finalize", async () => {
		const registry = new RecordingStreamRegistry();
		await registry.open("rec.webm", pathFor("rec.webm"));
		await registry.append("rec.webm", Buffer.from("hello "));
		await registry.append("rec.webm", Buffer.from("world"));

		const streamed = await registry.finalize("rec.webm");

		expect(streamed).toBe(true);
		expect(await readFile(pathFor("rec.webm"), "utf8")).toBe("hello world");
		// A second finalize has nothing to close.
		expect(await registry.finalize("rec.webm")).toBe(false);
	});

	it("reports not-streamed when no stream was opened", async () => {
		const registry = new RecordingStreamRegistry();
		expect(await registry.finalize("missing.webm")).toBe(false);
		expect(registry.has("missing.webm")).toBe(false);
	});

	it("rejects open when the target path is not writable (open is awaited, not assumed)", async () => {
		const registry = new RecordingStreamRegistry();
		// Parent directory does not exist, so createWriteStream emits 'error' on open.
		await expect(
			registry.open("rec.webm", path.join(dir, "does-not-exist", "rec.webm")),
		).rejects.toThrow();
		// A failed open must not register a stream the renderer would treat as live.
		expect(registry.has("rec.webm")).toBe(false);
	});

	it("rejects append when no stream is open", async () => {
		const registry = new RecordingStreamRegistry();
		await expect(registry.append("rec.webm", Buffer.from("x"))).rejects.toThrow(
			/No active recording stream/,
		);
	});

	it("discard closes the stream and removes the partial file", async () => {
		const registry = new RecordingStreamRegistry();
		await registry.open("rec.webm", pathFor("rec.webm"));
		await registry.append("rec.webm", Buffer.from("partial"));

		await registry.discard("rec.webm", pathFor("rec.webm"));

		expect(registry.has("rec.webm")).toBe(false);
		await expect(stat(pathFor("rec.webm"))).rejects.toThrow();
		// Nothing left to finalize after a discard.
		expect(await registry.finalize("rec.webm")).toBe(false);
	});

	it("discard tolerates a missing file", async () => {
		const registry = new RecordingStreamRegistry();
		await expect(registry.discard("never.webm", pathFor("never.webm"))).resolves.toBeUndefined();
	});

	it("opening the same file twice replaces the prior stream", async () => {
		const registry = new RecordingStreamRegistry();
		await registry.open("rec.webm", pathFor("rec.webm"));
		await registry.append("rec.webm", Buffer.from("first"));
		await registry.open("rec.webm", pathFor("rec.webm"));
		await registry.append("rec.webm", Buffer.from("second"));
		await registry.finalize("rec.webm");

		expect(await readFile(pathFor("rec.webm"), "utf8")).toBe("second");
	});

	// A take that started while the chosen drive was unplugged streams into the default
	// folder; the drive coming back mid-take moves where a fresh resolve points. Stop and
	// discard must still find the file where it was opened.
	describe("after the recordings folder changes mid-take", () => {
		async function takeWithMovingFolder() {
			await mkdir(pathFor("default"));
			await mkdir(pathFor("chosen"));
			let takeDir = pathFor("default");
			const resolve = (name: string) => path.join(takeDir, name);
			const registry = new RecordingStreamRegistry();
			const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
			const ipc = {
				handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown>) => {
					handlers.set(channel, fn);
				},
			} as unknown as IpcMain;
			registerRecordingStreamHandlers(ipc, registry, resolve);
			const call = (channel: string, ...args: unknown[]) =>
				handlers.get(channel)?.({}, ...args) as Promise<{ success: boolean }>;

			expect(await call("open-recording-stream", "recording-1.webm")).toEqual({ success: true });
			await call("append-recording-chunk", "recording-1.webm", new TextEncoder().encode("take"));
			takeDir = pathFor("chosen");
			return { registry, call };
		}

		it("finalizes at the path captured when the stream opened", async () => {
			const { registry } = await takeWithMovingFolder();
			const opened = path.join(pathFor("default"), "recording-1.webm");

			expect(registry.pathOf("recording-1.webm")).toBe(opened);
			expect(await registry.finalize("recording-1.webm")).toBe(true);
			expect(await readFile(opened, "utf8")).toBe("take");
			await expect(stat(path.join(pathFor("chosen"), "recording-1.webm"))).rejects.toThrow();
		});

		it("discards the file it opened, not one at the new folder", async () => {
			const { registry, call } = await takeWithMovingFolder();

			expect(await call("close-recording-stream", "recording-1.webm")).toEqual({ success: true });
			expect(registry.has("recording-1.webm")).toBe(false);
			await expect(stat(path.join(pathFor("default"), "recording-1.webm"))).rejects.toThrow();
		});
	});
});
