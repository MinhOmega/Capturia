// The minimized form of `ExportDialog`: a small pill, bottom-right, that keeps the
// running export visible while the user goes back to editing. Clicking it reopens
// the dialog.
//
// It is deliberately a dumb presenter — it owns no export state. `ExportDialog`
// stays mounted for the editor's whole lifetime (see `NewEditorShell`), so the
// export state simply lives on there while the modal itself is hidden; nothing had
// to be hoisted into a store to make progress survive a close.
//
// Rebuilt rather than lifted from the pre-rewrite `video-editor/ExportProgressFloat`:
// that one was Tailwind, on an older `useI18n`, and read `ExportProgress` fields
// (`phase`, `renderProgress`, `batchProgress`) that the native exporter no longer
// produces. Only the layout idea survives.

import { CheckCircle2, ChevronUp, Loader2, XCircle } from "lucide-react";
import { useScopedT } from "@/contexts/I18nContext";
import type { ExportProgress } from "@/lib/exporter";

/** Terminal states get a static icon; anything else is still working. */
export type ExportFloatPhase = "configuring" | "rendering" | "writing" | "done" | "error";

interface ExportProgressFloatProps {
	phase: ExportFloatPhase;
	progress: ExportProgress | null;
	format: "mp4" | "gif";
	onClick: () => void;
}

/** `m:ss`, floored and clamped — a negative ETA is an arithmetic artefact, not a time. */
function formatEta(seconds: number): string {
	const safe = Math.max(0, Math.floor(seconds));
	return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
}

export function ExportProgressFloat({
	phase,
	progress,
	format,
	onClick,
}: ExportProgressFloatProps) {
	const t = useScopedT("dialogs");
	const done = phase === "done";
	const failed = phase === "error";
	const formatLabel = format === "gif" ? "GIF" : "MP4";

	const title = failed
		? t("export.failed")
		: done
			? t("export.complete")
			: phase === "rendering"
				? t("export.renderingFrames")
				: t("export.exportingFormat", { format: formatLabel });

	// Frame counts beat an ETA that has not stabilised, and both beat "Processing…".
	const detail = failed
		? t("export.tryAgain")
		: done
			? t("export.yourFormatReady", { format: formatLabel })
			: progress && progress.estimatedTimeRemaining > 0
				? `ETA ${formatEta(progress.estimatedTimeRemaining)}`
				: progress
					? `${progress.currentFrame} / ${progress.totalFrames}`
					: t("export.takeMoment");

	const pct = done ? 100 : Math.min(100, progress?.percentage ?? 0);
	const barColor = failed ? "var(--danger, #f87171)" : "var(--accent, #34b27b)";

	return (
		<button
			type="button"
			onClick={onClick}
			title={t("export.status")}
			style={{
				position: "fixed",
				right: 24,
				bottom: 24,
				zIndex: 40,
				display: "flex",
				flexDirection: "column",
				gap: 8,
				width: 280,
				padding: "12px 14px",
				textAlign: "left",
				cursor: "pointer",
				borderRadius: 12,
				border: "1px solid var(--border-soft)",
				background: "var(--surface-raised, #0a0a0c)",
				boxShadow: "0 12px 32px rgba(0, 0, 0, 0.45)",
			}}
		>
			<div style={{ display: "flex", alignItems: "center", gap: 10 }}>
				{failed ? (
					<XCircle size={18} style={{ color: "var(--danger, #f87171)", flexShrink: 0 }} />
				) : done ? (
					<CheckCircle2 size={18} style={{ color: barColor, flexShrink: 0 }} />
				) : (
					<Loader2 size={18} className="animate-spin" style={{ color: barColor, flexShrink: 0 }} />
				)}
				<span style={{ flex: 1, minWidth: 0 }}>
					<span
						style={{
							display: "block",
							fontSize: 13,
							fontWeight: 500,
							color: "var(--text-primary)",
							overflow: "hidden",
							textOverflow: "ellipsis",
							whiteSpace: "nowrap",
						}}
					>
						{title}
					</span>
					<span style={{ display: "block", fontSize: 11, color: "var(--text-muted)" }}>
						{detail}
					</span>
				</span>
				<ChevronUp size={16} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
			</div>
			<span
				style={{
					display: "block",
					height: 5,
					borderRadius: 999,
					overflow: "hidden",
					background: "var(--border-soft)",
				}}
			>
				<span
					style={{
						display: "block",
						height: "100%",
						width: `${pct}%`,
						borderRadius: 999,
						background: barColor,
						transition: "width 300ms ease-out",
					}}
				/>
			</span>
		</button>
	);
}
