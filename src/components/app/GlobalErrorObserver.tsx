import { useEffect } from "react";
import { reportUserActionError } from "@/lib/userErrorFeedback";

// Errors that reach `window` rather than a `try`/`catch`: a throw from an event
// handler, a rejected promise nobody awaited, a bug in a third-party callback.
// Before this they went to the console only, which in a packaged app is a
// console nobody has open -- the user saw a control that silently did nothing.

const IGNORED_ERROR_PATTERNS: RegExp[] = [
	// Fired by browsers when a ResizeObserver callback causes another resize.
	// Benign, non-actionable, and emitted in bursts by any layout that observes
	// itself -- a toast for it would be pure noise.
	/ResizeObserver loop limit exceeded/i,
	/ResizeObserver loop completed with undelivered notifications/i,
];

function shouldIgnoreMessage(input: string): boolean {
	const message = input.trim();
	if (!message) return false;
	return IGNORED_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

export function GlobalErrorObserver() {
	useEffect(() => {
		const onError = (event: ErrorEvent) => {
			if (shouldIgnoreMessage(event.message || "")) return;
			reportUserActionError({
				error: event.error ?? event.message,
				context: "renderer.window.error",
				details: { filename: event.filename, line: event.lineno, column: event.colno },
				// Keyed on the throw SITE, not the moment: the same line failing on
				// every animation frame is one report, two different bugs are two.
				dedupeKey: `window-error:${event.filename}:${event.lineno}:${event.colno}:${event.message}`,
				dedupeMs: 6_000,
			});
		};

		const onUnhandledRejection = (event: PromiseRejectionEvent) => {
			const reason = event.reason;
			const message = reason instanceof Error ? reason.message : String(reason ?? "");
			if (shouldIgnoreMessage(message)) return;
			reportUserActionError({
				error: reason,
				context: "renderer.window.unhandledrejection",
				dedupeKey: `unhandled-rejection:${message}`,
				dedupeMs: 6_000,
			});
		};

		window.addEventListener("error", onError);
		window.addEventListener("unhandledrejection", onUnhandledRejection);
		return () => {
			window.removeEventListener("error", onError);
			window.removeEventListener("unhandledrejection", onUnhandledRejection);
		};
	}, []);

	return null;
}
