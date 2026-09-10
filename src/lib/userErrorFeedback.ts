import { toast } from "sonner";
import { toastText } from "@/i18n/toastText";
import { buildIssueReportUrl } from "./supportLinks";

// Turn an error nobody planned for into something the user can act on: a toast
// that names it, a reference id that ties the toast to the console line, and a
// one-click prefilled issue. Nothing is sent anywhere -- the URL only opens when
// the user presses the button.

export type ReportUserActionErrorInput = {
	/** What the user reads. Defaults to the generic "something went wrong". */
	userMessage?: string;
	error?: unknown;
	/** Where it happened (`renderer.window.error`, ...). Names the issue title. */
	context: string;
	details?: Record<string, unknown>;
	/**
	 * Reports sharing this key within `dedupeMs` produce ONE toast. A render loop
	 * that throws every frame otherwise stacks a toast per frame and buries the
	 * app under its own error reporting.
	 */
	dedupeKey?: string;
	dedupeMs?: number;
};

const recentErrorsByKey = new Map<string, number>();

function normalizeErrorMessage(error: unknown): string {
	if (error instanceof Error && error.message.trim().length > 0) return error.message.trim();
	if (typeof error === "string" && error.trim().length > 0) return error.trim();
	if (error === null || error === undefined) return "Unknown error";
	try {
		return JSON.stringify(error);
	} catch {
		// Circular, or a getter that throws. `String` still says something.
		return String(error);
	}
}

function serializeDetails(details?: Record<string, unknown>): string {
	if (!details || Object.keys(details).length === 0) return "none";
	try {
		return JSON.stringify(details, null, 2);
	} catch {
		return String(details);
	}
}

function shouldDedupe(key: string | undefined, dedupeMs: number): boolean {
	const normalized = key?.trim() ?? "";
	if (!normalized) return false;

	const now = Date.now();
	const previousAt = recentErrorsByKey.get(normalized);
	if (previousAt !== undefined && now - previousAt < dedupeMs) return true;

	// ponytail: bounded by wholesale clear, not per-entry expiry. The map only
	// grows on DISTINCT error signatures, so 50 means the app is failing in fifty
	// different ways and one extra duplicate toast is not the problem. Switch to
	// pruning expired keys if a real workload ever gets near this.
	if (recentErrorsByKey.size > 50) recentErrorsByKey.clear();
	recentErrorsByKey.set(normalized, now);
	return false;
}

/** Open a prefilled issue in the user's browser. Exported for the error-boundary
 *  fallback, which outlives the toast and needs its own way back to the tracker. */
export async function openReportUrl(url: string): Promise<void> {
	try {
		// Optional at runtime even though the preload declares it: `browserShim`
		// installs a partial `electronAPI` for the browser-hosted dev harness.
		const openExternalUrl = window.electronAPI?.openExternalUrl;
		if (openExternalUrl) {
			const result = await openExternalUrl(url);
			if (result.success) return;
			throw new Error(result.error || "openExternalUrl returned an unsuccessful result");
		}
		window.open(url, "_blank", "noopener,noreferrer");
	} catch (error) {
		console.error("[support] failed to open the issue report URL:", error);
		toast.error(toastText("common", "errors.reportOpenFailed"));
	}
}

/**
 * Report an unexpected error to the user and return the reference id.
 *
 * Returns `""` when the report was deduplicated, so a caller can tell "reported
 * as <id>" from "already on screen" without reaching into the dedupe state.
 */
export function reportUserActionError(input: ReportUserActionErrorInput): string {
	if (shouldDedupe(input.dedupeKey, input.dedupeMs ?? 4_000)) return "";

	const now = Date.now();
	const errorId = `CAP-${now.toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
	const errorMessage = normalizeErrorMessage(input.error);
	const errorStack = input.error instanceof Error ? (input.error.stack ?? null) : null;
	const userMessage = input.userMessage ?? toastText("common", "errors.unexpected");

	const issueLines = [
		"## Summary",
		userMessage,
		"",
		"## Reference",
		`- Error ID: ${errorId}`,
		`- Context: ${input.context}`,
		`- Time: ${new Date(now).toISOString()}`,
		// No app version: the renderer only knows it through an async IPC call, and
		// making this whole function async to fetch it would buy nothing -- the
		// version is already in the Save Diagnostics bundle the issue asks for.
		`- User agent: ${window.navigator.userAgent}`,
		"",
		"## Error message",
		errorMessage,
		"",
		"## Extra details",
		serializeDetails(input.details),
	];
	if (errorStack) issueLines.push("", "## Stack", "```", errorStack, "```");

	const issueUrl = buildIssueReportUrl({
		title: `[Bug] ${input.context}`,
		bodyLines: issueLines,
	});

	toast.error(userMessage, {
		description: `${toastText("common", "errors.reference", { id: errorId })}\n${errorMessage}`,
		duration: 12_000,
		action: {
			label: toastText("settings", "support.reportBug"),
			onClick: () => {
				void openReportUrl(issueUrl);
			},
		},
	});

	// Logged as well as toasted, and with the same id: a toast is gone in twelve
	// seconds, and "it broke earlier" gets reported much later than that. The id
	// is what ties a screenshot of the toast to the line in Save Diagnostics.
	console.error(`[${errorId}] ${input.context}`, input.error);
	return errorId;
}
