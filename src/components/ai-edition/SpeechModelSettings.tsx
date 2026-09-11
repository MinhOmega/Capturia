// AI settings' Speech model section: pick the whisper model transcription loads.
//
// Switching downloads and verifies the new model first; only then does it become
// active, so a failed or interrupted download leaves the old one running (see
// `SttManager.setModel`). Existing transcripts are untouched — Regenerate uses
// whichever model is active when it runs.

import { AlertTriangle, Check, Loader2, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useScopedT } from "@/contexts/I18nContext";
import { formatBytes } from "@/utils/formatBytes";
import type { SttModelId, SttModelsSnapshot } from "../../../electron/stt/transcriptionContract";
import styles from "./NewEditorShell.module.css";

/** Read per call, not held in a hook dependency: the bridge object is not promised to be stable. */
const sttBridge = () => window.electronAPI?.stt;

export function SpeechModelSettings() {
	const te = useScopedT("editor");
	const [snapshot, setSnapshot] = useState<SttModelsSnapshot | null>(null);
	/** The model being downloaded, and how far along it is (0-1). */
	const [pending, setPending] = useState<{ id: SttModelId; fraction: number } | null>(null);

	const refresh = useCallback(async () => {
		const stt = sttBridge();
		if (stt?.listModels) setSnapshot(await stt.listModels().catch(() => null));
	}, []);
	useEffect(() => {
		void refresh();
	}, [refresh]);
	useEffect(
		() =>
			sttBridge()?.onModelProgress?.(({ id, downloadedBytes, totalBytes }) =>
				setPending({ id, fraction: totalBytes > 0 ? downloadedBytes / totalBytes : 0 }),
			),
		[],
	);

	const stt = sttBridge();
	// No STT bridge (browser preview, tests): nothing to choose between.
	if (!stt || !snapshot) return null;

	const use = async (id: SttModelId) => {
		setPending({ id, fraction: 0 });
		try {
			await stt.setModel(id);
		} catch (err) {
			toast.error(te("speechModel.switchFailed"), {
				description: err instanceof Error ? err.message : String(err),
			});
		} finally {
			setPending(null);
			await refresh();
		}
	};

	const remove = async (id: SttModelId) => {
		try {
			await stt.deleteModel(id);
		} catch (err) {
			toast.error(te("speechModel.deleteFailed"), {
				description: err instanceof Error ? err.message : String(err),
			});
		}
		await refresh();
	};

	return (
		<section style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 8 }}>
			<h3 style={{ margin: 0, font: "600 14px var(--font-body)", color: "var(--fg)" }}>
				{te("speechModel.title")}
			</h3>
			<p style={{ margin: 0, font: "400 12px/1.4 var(--font-body)", color: "var(--muted)" }}>
				{te("speechModel.hint")}
			</p>
			<div
				className={styles.providerGrid}
				style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}
			>
				{snapshot.models.map((model) => {
					const isActive = model.id === snapshot.active;
					const isPending = pending?.id === model.id;
					return (
						<div
							key={model.id}
							className={`${styles.providerCard} ${isActive ? styles.active : ""}`}
							style={{ cursor: "default" }}
						>
							<div className={styles.head}>
								<span className={styles.label}>{te(`speechModel.${model.id}`)}</span>
								{isActive ? (
									<span className={`${styles.statusPill} ${styles.ready}`}>
										<Check size={10} />
										{te("speechModel.active")}
									</span>
								) : isPending ? (
									<span className={`${styles.statusPill} ${styles.auth}`}>
										{Math.round((pending?.fraction ?? 0) * 100)}%
									</span>
								) : model.downloaded ? (
									<span className={`${styles.statusPill} ${styles.idle}`}>
										{te("speechModel.downloaded")}
									</span>
								) : null}
							</div>
							<span style={{ font: "500 11px var(--font-mono)", color: "var(--muted)" }}>
								{formatBytes(model.bytes)}
							</span>
							<span style={{ font: "400 12px/1.35 var(--font-body)", color: "var(--fg-2)" }}>
								{te(`speechModel.${model.id}Note`)}
							</span>
							{model.id === "accurate" && snapshot.cpuOnly ? (
								<span
									style={{ font: "500 11px/1.35 var(--font-body)", color: "var(--warn)" }}
									role="note"
								>
									<AlertTriangle size={11} style={{ verticalAlign: "-1px", marginRight: 4 }} />
									{te("speechModel.cpuWarning")}
								</span>
							) : null}
							{isActive ? null : (
								<div style={{ display: "flex", gap: 6, marginTop: 4 }}>
									<button
										type="button"
										className={`${styles.btn} ${styles.btnSecondary}`}
										onClick={() => void use(model.id)}
										disabled={pending !== null}
									>
										{isPending ? <Loader2 size={14} className="animate-spin" /> : null}
										{te("speechModel.use")}
									</button>
									{model.downloaded ? (
										<button
											type="button"
											className={styles.iconBtn}
											onClick={() => void remove(model.id)}
											disabled={pending !== null}
											title={te("speechModel.delete")}
											aria-label={te("speechModel.delete")}
										>
											<Trash2 size={14} />
										</button>
									) : null}
								</div>
							)}
						</div>
					);
				})}
			</div>
		</section>
	);
}
