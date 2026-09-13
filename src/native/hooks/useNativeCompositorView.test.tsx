// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import type { RefObject } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const createCompositorView = vi.hoisted(() => vi.fn());
const destroyCompositorView = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../compositorViewClient", () => ({
	createCompositorView,
	destroyCompositorView,
	readCompositorFrame: vi.fn(async () => null),
	setCompositorParam: vi.fn(async () => undefined),
	setCompositorPlaying: vi.fn(async () => undefined),
	setCompositorRect: vi.fn(async () => undefined),
}));

import { useNativeCompositorView } from "./useNativeCompositorView";

beforeAll(() => {
	globalThis.ResizeObserver = class {
		observe() {
			/* jsdom has none and the rect is stubbed anyway */
		}
		unobserve() {
			/* noop */
		}
		disconnect() {
			/* noop */
		}
	} as unknown as typeof ResizeObserver;
});

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(console, "warn").mockImplementation(() => {
		/* the hook warns on every swallowed bridge failure */
	});
});

/** The hook only ever reads `canvasRef.current`, so a detached canvas is enough. */
function canvasRef(): RefObject<HTMLCanvasElement> {
	return { current: document.createElement("canvas") };
}

describe("useNativeCompositorView", () => {
	/**
	 * The cleanup destroys the view but used to leave its id published, so while the
	 * next `createCompositorView` was in flight — or forever, if it rejected — the
	 * overlay kept pushing scene/param/time at a destroyed view. Native answers
	 * `Ok(None)` for an unknown id, so the failure was a black canvas and no message.
	 */
	it("drops the destroyed view's id when the source changes", async () => {
		createCompositorView.mockResolvedValueOnce({ id: 7 });
		const ref = canvasRef();
		const { result, rerender } = renderHook(
			({ screenPath }: { screenPath: string }) =>
				useNativeCompositorView(ref, { sources: { screenPath } }),
			{ initialProps: { screenPath: "a.mp4" } },
		);
		await waitFor(() => expect(result.current.viewId).toBe(7));

		// Opening another project on a host where the view cannot be created.
		createCompositorView.mockRejectedValueOnce(new Error("no D3D11 device"));
		rerender({ screenPath: "b.mp4" });

		expect(destroyCompositorView).toHaveBeenCalledWith(7);
		expect(result.current.viewId).toBeNull();
		// And it stays null: nothing ever republishes the dead id.
		await waitFor(() => expect(createCompositorView).toHaveBeenCalledTimes(2));
		expect(result.current.viewId).toBeNull();
	});
});
