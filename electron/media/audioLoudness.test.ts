import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.fn();
const resolveFfmpegMock = vi.fn<() => string | null>();

vi.mock("node:child_process", () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));
vi.mock("./audioPeaks", () => ({ resolveFfmpeg: () => resolveFfmpegMock() }));

const { measureAudioLoudness, parseIntegratedLufs } = await import("./audioLoudness");

/** A stand-in for the ffmpeg child: `ebur128` writes its summary to stderr. */
function fakeChild() {
	const child = new EventEmitter() as EventEmitter & {
		stderr: PassThrough;
		kill: ReturnType<typeof vi.fn>;
	};
	child.stderr = new PassThrough();
	child.kill = vi.fn();
	return child;
}

/** What ffmpeg actually prints: progress lines carrying a running `I:`, then the
 *  summary whose `I:` is the integrated loudness of the whole file. */
const SUMMARY = `
[Parsed_ebur128_0 @ 0x55] t: 1.0  M: -19.4 S: -20.1 I: -30.2 LUFS  LRA: 2.1 LU
[Parsed_ebur128_0 @ 0x55] t: 2.0  M: -18.9 S: -19.7 I: -27.4 LUFS  LRA: 2.4 LU
[Parsed_ebur128_0 @ 0x55] Summary:

  Integrated loudness:
    I:         -26.3 LUFS
    Threshold: -36.4 LUFS

  Loudness range:
    LRA:         3.2 LU
`;

beforeEach(() => {
	vi.clearAllMocks();
	resolveFfmpegMock.mockReturnValue("/usr/bin/ffmpeg");
});

describe("parseIntegratedLufs", () => {
	it("takes the summary's integrated value, not a progress line's", () => {
		expect(parseIntegratedLufs(SUMMARY)).toBe(-26.3);
	});

	it("returns null for a silent track (-inf) — no gain makes silence −16 LUFS", () => {
		expect(parseIntegratedLufs("    I:         -inf LUFS\n")).toBeNull();
	});

	it("returns null when ffmpeg printed no measurement at all", () => {
		expect(parseIntegratedLufs("Output file does not contain any stream\n")).toBeNull();
	});
});

describe("measureAudioLoudness", () => {
	it("pins the input protocol and asks ffmpeg for ebur128 with no output file", async () => {
		const child = fakeChild();
		spawnMock.mockReturnValue(child);

		const promise = measureAudioLoudness("C:\\takes\\a.mp4");
		child.stderr.end(SUMMARY);
		child.emit("close", 0);
		await promise;

		const args = spawnMock.mock.calls[0][1] as string[];
		// `file:` or a Windows path reads as a protocol specifier ("C:" → protocol "C").
		expect(args[args.indexOf("-i") + 1]).toBe("file:C:\\takes\\a.mp4");
		expect(args.join(" ")).toContain("-af ebur128");
		expect(args.join(" ")).toContain("-f null");
		expect(args).toContain("-vn");
	});

	it("resolves the integrated loudness ffmpeg measured", async () => {
		const child = fakeChild();
		spawnMock.mockReturnValue(child);

		const promise = measureAudioLoudness("/tmp/a.mp4");
		child.stderr.end(SUMMARY);
		child.emit("close", 0);

		expect(await promise).toBe(-26.3);
	});

	it("rejects with ffmpeg's reason when the file has no audio track", async () => {
		const child = fakeChild();
		spawnMock.mockReturnValue(child);

		const promise = measureAudioLoudness("/tmp/silent-capture.mp4");
		child.stderr.end("Stream map 'a' matches no streams.\n");
		child.emit("close", 1);

		await expect(promise).rejects.toThrow(/matches no streams/);
	});

	it("rejects a run that exited cleanly with nothing to measure", async () => {
		const child = fakeChild();
		spawnMock.mockReturnValue(child);

		const promise = measureAudioLoudness("/tmp/a.mp4");
		child.stderr.end("    I:         -inf LUFS\n");
		child.emit("close", 0);

		await expect(promise).rejects.toThrow(/No integrated loudness/);
	});

	it("returns null — not an error — when there is no ffmpeg to measure with", async () => {
		resolveFfmpegMock.mockReturnValue(null);

		expect(await measureAudioLoudness("/tmp/a.mp4")).toBeNull();
		expect(spawnMock).not.toHaveBeenCalled();
	});
});
