import { beforeEach, describe, expect, it, vi } from "vitest";

import type { NativeBridgeContext } from "./nativeBridge";

const hoisted = vi.hoisted(() => ({
	handlers: new Map<string, (event: unknown, request: unknown) => Promise<unknown>>(),
	setActiveClip: vi.fn(),
	createView: vi.fn(() => 1),
	addAsset: vi.fn(async () => ({ assets: [{ id: "asset-1" }], project: {} })),
}));

vi.mock("electron", () => ({
	ipcMain: {
		handle: (channel: string, fn: (event: unknown, request: unknown) => Promise<unknown>) =>
			hoisted.handlers.set(channel, fn),
		removeHandler: vi.fn(),
	},
	app: { getPath: () => "/tmp/capturia-test" },
}));

vi.mock("../native-bridge/services/compositorViewService", () => ({
	CompositorViewService: class {
		setActiveClip = hoisted.setActiveClip;
		createView = hoisted.createView;
	},
}));

const { registerNativeBridgeHandlers } = await import("./nativeBridge");

const APPROVED = "/tmp/capturia-test/recordings/take.webm";

/** Only the fields these requests touch; the rest of the bridge is not under test. */
function buildContext(): NativeBridgeContext {
	return {
		getPlatform: () => "linux",
		readableApprovedPath: (filePath?: string | null) => (filePath === APPROVED ? APPROVED : null),
		getAiEditionDocuments: () => ({ addAsset: hoisted.addAsset }),
		getAiEditionLlmConfig: () => ({}),
		resolveVideoPath: (filePath?: string | null) => filePath ?? null,
	} as unknown as NativeBridgeContext;
}

function invoke(request: unknown) {
	return hoisted.handlers.get("native-bridge:invoke")?.(
		{ sender: { isDestroyed: () => false } },
		request,
	);
}

describe("native bridge media path gate", () => {
	beforeEach(() => {
		hoisted.handlers.clear();
		hoisted.setActiveClip.mockClear();
		hoisted.createView.mockClear();
		hoisted.addAsset.mockClear();
		registerNativeBridgeHandlers(buildContext());
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
	});

	it("refuses compositor.setActiveClip on a path the renderer was never granted", async () => {
		const response = await invoke({
			domain: "compositor",
			action: "setActiveClip",
			payload: {
				id: 1,
				screenPath: "/etc/passwd",
				webcamPath: "",
				webcamOffsetSec: 0,
				clipIndex: 0,
				sourceTimeSec: 0,
			},
		});

		expect(response).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
		expect(hoisted.setActiveClip).not.toHaveBeenCalled();
	});

	it("still lets an approved clip through, webcam slot empty", async () => {
		const response = await invoke({
			domain: "compositor",
			action: "setActiveClip",
			payload: {
				id: 1,
				screenPath: APPROVED,
				webcamPath: "",
				webcamOffsetSec: 0,
				clipIndex: 0,
				sourceTimeSec: 0,
			},
		});

		expect(response).toMatchObject({ ok: true });
		expect(hoisted.setActiveClip).toHaveBeenCalledOnce();
	});

	it("approves a cursor sidecar through the media it sits beside", async () => {
		const response = await invoke({
			domain: "compositor",
			action: "createView",
			payload: { rect: { x: 0, y: 0, width: 2, height: 2 }, cursorPath: `${APPROVED}.cursor.json` },
		});

		expect(response).toMatchObject({ ok: true });
		expect(hoisted.createView).toHaveBeenCalledOnce();
	});

	it("refuses document.addAsset before the path can reach the document", async () => {
		const response = await invoke({
			domain: "aiEdition",
			action: "document.addAsset",
			payload: { projectId: "p1", path: "/etc/passwd.mp4", label: "x" },
		});

		expect(response).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
		expect(hoisted.addAsset).not.toHaveBeenCalled();
	});
});
