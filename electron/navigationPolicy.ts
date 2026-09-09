/**
 * What an OpenScreen window may navigate to.
 *
 * Every window is a single document that never navigates: the main process
 * loads `index.html` (or the dev server) once with a `windowType` query and the
 * renderer routes inside React from there. So any main-frame navigation after
 * that first load came from page content — a link, a `location.href =`, a
 * `window.open`, an HTTP redirect — and the only one the app wants is a reload
 * of the same document (Vite's HMR full reload, `Cmd+R` in development).
 *
 * The stake is high because the editor and the CLI runner windows run with
 * `webSecurity: false` (they have to, to read recording media back over
 * `file://`), and the editor now renders model-generated content. A page that
 * managed to navigate one of those windows somewhere else would run with no
 * same-origin policy at all.
 *
 * The rules, in order:
 *
 *  - the exact trusted document (same protocol, host, port, path *and* query)
 *    is allowed: that is a reload;
 *  - anything on the trusted origin that is not that document is denied rather
 *    than externalised — a page that talks its way to another path of the app's
 *    own origin is not a link the user asked to follow. This is also what makes
 *    a `history.replaceState` spoof pointless, since the trusted document is
 *    the URL the main process loaded, not whatever the page claims it is;
 *  - `windowType` is part of the identity of the document on purpose: it
 *    decides which UI a window is, and per-window media permissions key on it
 *    (see `windowPermissions.ts`), so the editor must not be able to reload
 *    itself as the recorder HUD;
 *  - a host that merely resembles the trusted host (`localhost.example.com`
 *    against `localhost`) is denied, not opened in a browser: that is a spoof,
 *    not a link;
 *  - a credential-free `http(s)`/`mailto` URL elsewhere is handed to the
 *    system browser through the same allowlist `open-external-url` uses;
 *  - everything else is denied: `javascript:`, `data:`, `blob:`, `file:`
 *    outside the app document, `about:blank`, and any URL carrying
 *    `user:password@`.
 */

/**
 * Protocols that may be handed to `shell.openExternal`.
 *
 * `shell.openExternal` passes the string to the OS handler, so `file:`,
 * `ms-msdt:`, a UNC path, or any registered custom scheme is a launch
 * primitive. http/https/mailto is everything the renderer ever needs to open.
 *
 * Main-process code that opens a settings pane (`x-apple.systempreferences:`,
 * `ms-settings:`) deliberately calls `shell.openExternal` directly: those URLs
 * are built by us from a fixed table, never supplied by a renderer, so they are
 * not subject to this allowlist. See `windowPermissions.ts`.
 */
export const EXTERNAL_URL_PROTOCOLS: ReadonlySet<string> = new Set([
	"http:",
	"https:",
	"mailto:",
]);

/** Parse and allowlist a renderer-supplied external URL. Returns the serialized URL or null. */
export function normalizeExternalUrl(rawUrl: unknown): string | null {
	if (typeof rawUrl !== "string") return null;
	const trimmed = rawUrl.trim();
	if (!trimmed) return null;
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		return null;
	}
	if (!EXTERNAL_URL_PROTOCOLS.has(parsed.protocol)) return null;
	return parsed.toString();
}

export type NavigationVerdict =
	| { readonly action: "allow"; readonly reason: AllowReason }
	| { readonly action: "external"; readonly url: string; readonly reason: "externalised" }
	| { readonly action: "deny"; readonly reason: DenyReason };

export type AllowReason = "same-document" | "devtools";

export type DenyReason =
	| "no-trusted-document"
	| "unparsable-target"
	| "unparsable-trusted-document"
	| "embedded-credentials"
	| "trusted-origin-other-document"
	| "lookalike-host"
	| "unsupported-scheme";

export interface NavigationDecisionInput {
	/** The URL the main process loaded into this window; null before the first commit. */
	readonly trustedUrl: string | null | undefined;
	/** Where the page wants to go. */
	readonly targetUrl: string;
	/** File paths are case-insensitive on Windows. Defaults to `process.platform`. */
	readonly platform?: NodeJS.Platform;
}

/** Schemes a main frame can actually be a document in. */
const DOCUMENT_SCHEMES: ReadonlySet<string> = new Set(["http:", "https:", "file:"]);

function parse(rawUrl: string): URL | null {
	try {
		return new URL(rawUrl);
	} catch {
		return null;
	}
}

function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
	let left = a;
	let right = b;
	try {
		left = decodeURIComponent(a);
		right = decodeURIComponent(b);
	} catch {
		// Keep the raw form: an undecodable path only ever compares equal to itself.
	}
	if (platform === "win32") return left.toLowerCase() === right.toLowerCase();
	return left === right;
}

/**
 * True when the hosts are different but one reads as the other — the shape a
 * spoof takes (`localhost.attacker.test`, `openscreen.example.com.evil.test`).
 */
function isLookalikeHost(targetHost: string, trustedHost: string): boolean {
	if (!targetHost || !trustedHost) return false;
	const target = targetHost.toLowerCase();
	const trusted = trustedHost.toLowerCase();
	if (target === trusted) return false;
	return target.includes(trusted) || trusted.includes(target);
}

/** Pure navigation decision. No Electron, no I/O — see the module comment. */
export function decideNavigation(input: NavigationDecisionInput): NavigationVerdict {
	const platform = input.platform ?? process.platform;
	const target = parse(input.targetUrl);
	if (!target) return { action: "deny", reason: "unparsable-target" };

	// `javascript:` and friends never reach the origin comparison below.
	if (target.username || target.password) {
		return { action: "deny", reason: "embedded-credentials" };
	}

	if (!input.trustedUrl) return { action: "deny", reason: "no-trusted-document" };
	const trusted = parse(input.trustedUrl);
	if (!trusted) return { action: "deny", reason: "unparsable-trusted-document" };

	// DevTools drives its own WebContents; there is no app policy to apply there.
	if (trusted.protocol === "devtools:") {
		return target.protocol === "devtools:"
			? { action: "allow", reason: "devtools" }
			: { action: "deny", reason: "unsupported-scheme" };
	}

	const sameDocument =
		target.protocol === trusted.protocol &&
		target.host === trusted.host &&
		samePath(target.pathname, trusted.pathname, platform) &&
		target.search === trusted.search;
	if (sameDocument) return { action: "allow", reason: "same-document" };

	// Schemes that can carry a document get the origin comparison. Opaque
	// schemes (`javascript:`, `mailto:`, `data:`) have an empty host and must not
	// be mistaken for the app's own file:// origin.
	if (DOCUMENT_SCHEMES.has(target.protocol)) {
		// Any local file, and any other port or scheme on the trusted host: the
		// app's own ground, reached by something other than the load main did.
		if (target.protocol === "file:" || target.hostname === trusted.hostname) {
			return { action: "deny", reason: "trusted-origin-other-document" };
		}
		if (isLookalikeHost(target.hostname, trusted.hostname)) {
			return { action: "deny", reason: "lookalike-host" };
		}
	}

	const externalUrl = normalizeExternalUrl(input.targetUrl);
	if (externalUrl) return { action: "external", url: externalUrl, reason: "externalised" };

	return { action: "deny", reason: "unsupported-scheme" };
}

/** The Electron surface `attachNavigationPolicy` needs, narrowed for tests. */
export interface NavigablePreventable {
	preventDefault(): void;
}

export interface NavigableWebContents {
	getURL(): string;
	on(
		event: "will-navigate" | "will-redirect",
		listener: (event: NavigablePreventable, url: string) => void,
	): unknown;
	on(event: "did-navigate", listener: (event: unknown, url: string) => void): unknown;
	setWindowOpenHandler(handler: (details: { url: string }) => { action: "deny" }): unknown;
}

export interface NavigationPolicyHooks {
	/** Hands an allowlisted URL to the system browser. */
	openExternal: (url: string) => Promise<unknown> | unknown;
	/** Called with the first document the main process commits. See `windowPermissions.ts`. */
	onTrustedDocument?: (url: string) => void;
	log?: Pick<Console, "warn">;
	platform?: NodeJS.Platform;
}

/**
 * Apply the policy to one WebContents: `will-navigate`, `will-redirect` and
 * `setWindowOpenHandler`.
 *
 * The trusted document is whatever the main process last committed, captured
 * from `did-navigate`. That event does not fire for `history.pushState` /
 * `replaceState` (those are `did-navigate-in-page`), so a page cannot move its
 * own goalposts. The first load is main-process-initiated and never reaches
 * `will-navigate`, so nothing here can lock a window out of booting.
 */
export function attachNavigationPolicy(
	contents: NavigableWebContents,
	hooks: NavigationPolicyHooks,
): void {
	const log = hooks.log ?? console;
	let trustedUrl: string = contents.getURL() || "";
	if (trustedUrl) hooks.onTrustedDocument?.(trustedUrl);

	contents.on("did-navigate", (_event: unknown, url: string) => {
		if (!url) return;
		trustedUrl = url;
		hooks.onTrustedDocument?.(url);
	});

	const applyVerdict = (targetUrl: string, source: string): NavigationVerdict => {
		const verdict = decideNavigation({
			trustedUrl: trustedUrl || null,
			targetUrl,
			platform: hooks.platform,
		});
		if (verdict.action === "external") {
			void Promise.resolve(hooks.openExternal(verdict.url)).catch((error) => {
				log.warn("[navigation] could not open the URL in the browser:", verdict.url, error);
			});
		} else if (verdict.action === "deny") {
			log.warn(`[navigation] denied (${source}, ${verdict.reason}):`, targetUrl);
		}
		return verdict;
	};

	const onNavigate = (source: "will-navigate" | "will-redirect") => {
		return (event: NavigablePreventable, targetUrl: string) => {
			if (applyVerdict(targetUrl, source).action !== "allow") {
				event.preventDefault();
			}
		};
	};

	contents.on("will-navigate", onNavigate("will-navigate"));
	contents.on("will-redirect", onNavigate("will-redirect"));

	// The app never opens a second Electron window from page content; an
	// allowlisted URL goes to the system browser instead.
	contents.setWindowOpenHandler(({ url }) => {
		applyVerdict(url, "window-open");
		return { action: "deny" };
	});
}
