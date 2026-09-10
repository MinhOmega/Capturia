import { Component, type ErrorInfo, type ReactNode } from "react";
import { toastText } from "@/i18n/toastText";
import { buildIssueReportUrl } from "@/lib/supportLinks";
import { openReportUrl, reportUserActionError } from "@/lib/userErrorFeedback";

// React unmounts the whole tree when a render throws and nothing catches it, so
// the failure the user actually sees is a blank window -- no message, no way to
// report it, and no clue that reloading would fix it. This is the wall that
// turns that into a screen.
//
// It deliberately does NOT use `useScopedT`: a class component cannot, and more
// to the point an error screen should not depend on React context still being
// intact. `toastText` reads the stored locale directly and cannot fail.

type Props = { children: ReactNode };
type State = { error: Error | null; errorId: string };

export class AppErrorBoundary extends Component<Props, State> {
	state: State = { error: null, errorId: "" };

	static getDerivedStateFromError(error: Error): Partial<State> {
		return { error };
	}

	componentDidCatch(error: Error, info: ErrorInfo) {
		// Not deduped: a render error unmounts the tree, so it cannot repeat until
		// the user acts, and swallowing the second one would hide a failed reload.
		const errorId = reportUserActionError({
			error,
			context: "renderer.react.render",
			details: { componentStack: info.componentStack ?? "unavailable" },
		});
		this.setState({ errorId });
	}

	private handleReport = () => {
		const { error, errorId } = this.state;
		void openReportUrl(
			buildIssueReportUrl({
				title: "[Bug] renderer.react.render",
				bodyLines: [
					"## Summary",
					toastText("common", "errors.unexpected"),
					"",
					"## Reference",
					`- Error ID: ${errorId}`,
					`- User agent: ${window.navigator.userAgent}`,
					"",
					"## Error message",
					error?.message ?? "Unknown error",
					...(error?.stack ? ["", "## Stack", "```", error.stack, "```"] : []),
				],
			}),
		);
	};

	render() {
		const { error, errorId } = this.state;
		if (!error) return this.props.children;

		return (
			<div className="flex flex-col items-center justify-center gap-4 h-screen bg-[var(--bg)] p-8 text-center">
				<h1 className="text-lg font-semibold text-[var(--fg)]">
					{toastText("common", "errors.unexpected")}
				</h1>
				<p className="max-w-md text-sm text-[var(--muted)]">
					{toastText("common", "errors.unexpectedBody")}
				</p>
				{errorId ? (
					<p className="font-mono text-xs text-[var(--muted)]">
						{toastText("common", "errors.reference", { id: errorId })}
					</p>
				) : null}
				<div className="flex gap-3">
					<button
						type="button"
						onClick={() => window.location.reload()}
						className="rounded-md bg-[var(--brand)] px-4 py-2 text-sm font-medium text-white"
					>
						{toastText("common", "actions.reload")}
					</button>
					<button
						type="button"
						onClick={this.handleReport}
						className="rounded-md border border-[var(--border)] px-4 py-2 text-sm text-[var(--fg)]"
					>
						{toastText("settings", "support.reportBug")}
					</button>
				</div>
			</div>
		);
	}
}
