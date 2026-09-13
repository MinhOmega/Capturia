import { beforeEach, describe, expect, it, vi } from "vitest";

import { _resetSttManagerForTests, registerSttIpc } from "./index";

// The extractor is the thing the gate protects: it hands `sourcePath` to ffmpeg.
const extractMono16kPcm = vi.hoisted(() => vi.fn(async () => new Float32Array(0)));
vi.mock("./extractAudio", () => ({
	extractMono16kPcm,
	FfmpegUnavailableError: class extends Error {},
	NoAudioTrackError: class extends Error {},
}));
vi.mock("./whisperServer", () => ({ WhisperServerManager: class {} }));

function fakeIpcMain() {
	const handlers = new Map<string, (...args: never[]) => unknown>();
	return {
		handlers,
		handle: (channel: string, fn: (...args: never[]) => unknown) => handlers.set(channel, fn),
	};
}

const event = { sender: { id: 1, isDestroyed: () => false, send: () => undefined } };

describe("stt:transcribe source gate", () => {
	beforeEach(() => {
		_resetSttManagerForTests();
		extractMono16kPcm.mockClear();
	});

	it("refuses a sourcePath the approval set does not hold, without touching ffmpeg", async () => {
		const ipc = fakeIpcMain();
		registerSttIpc(ipc as never, () => null);

		await expect(
			ipc.handlers.get("stt:transcribe")?.(
				event as never,
				{ sourcePath: "/etc/hostname" } as never,
			),
		).rejects.toThrow(/not approved/);
		expect(extractMono16kPcm).not.toHaveBeenCalled();
	});
});
