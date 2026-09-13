// @vitest-environment jsdom
// Its own file: `installBrowserShims` patches the real `nativeBridgeClient` in
// place and cannot be undone, so the refusal has to be checked in a module
// registry where nothing has installed it (browserShim.test.ts installs once in
// its `beforeAll`).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installBrowserShims } from "./browserShim";

beforeEach(() => {
	// What a packaged editor window whose preload failed to attach looks like.
	window.history.replaceState(null, "", "/?windowType=editor");
	delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("installBrowserShims in a packaged build", () => {
	/**
	 * The shim only ever meant "this is a plain browser tab, let the UI render".
	 * Installed in a release it hid a broken preload: saves went to localStorage,
	 * Export resolved `{ canceled: true }` and did nothing, and every step looked
	 * like it had worked.
	 */
	it("does not stand in for a missing preload", () => {
		vi.stubEnv("DEV", false);
		const error = vi.spyOn(console, "error").mockImplementation(() => {
			/* the message is asserted, not printed */
		});

		installBrowserShims();

		expect((window as unknown as { electronAPI?: unknown }).electronAPI).toBeUndefined();
		// And says why, so the report from the error screen carries the cause.
		expect(error).toHaveBeenCalled();
	});

	it("still installs in dev, which is the only thing it is for", () => {
		vi.stubEnv("DEV", true);

		installBrowserShims();

		expect((window as unknown as { electronAPI?: unknown }).electronAPI).toBeDefined();
	});
});
