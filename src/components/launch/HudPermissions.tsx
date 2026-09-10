import { useCallback, useEffect, useState } from "react";
import type {
	CapturePermissionKey,
	CapturePermissionRow,
} from "../../../electron/permissions/capturePermissions";
import { useScopedT } from "../../contexts/I18nContext";
import styles from "./LaunchWindow.module.css";

/**
 * Every capture permission this OS can actually be asked about, with what it
 * answered and the one button that changes it.
 *
 * The rows come from the main process already decided — status AND action —
 * because only it can call `systemPreferences`, and a second copy of that
 * decision here is a second thing to keep true. This component renders what it
 * is handed and never infers a grant from anything else: no rows means the
 * platform gates none of this (Linux), and the section disappears rather than
 * showing four lines of "unknown".
 */
export function HudPermissions() {
	const t = useScopedT("launch");
	const [rows, setRows] = useState<CapturePermissionRow[] | null>(null);
	const [busyKey, setBusyKey] = useState<CapturePermissionKey | null>(null);

	const refresh = useCallback(async () => {
		if (!window.electronAPI?.getCapturePermissions) return;
		try {
			setRows(await window.electronAPI.getCapturePermissions());
		} catch {
			// Leave the last known rows up. Replacing them with an optimistic
			// placeholder is exactly the lie this panel exists to avoid.
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	// A grant made in System Settings lands while this window is in the
	// background, so the answer is stale by the time the user looks back at it.
	useEffect(() => {
		const onFocus = () => void refresh();
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, [refresh]);

	const act = useCallback(
		async (row: CapturePermissionRow) => {
			if (!window.electronAPI?.requestCapturePermission) return;
			setBusyKey(row.key);
			try {
				const result = await window.electronAPI.requestCapturePermission(row.key);
				// A settings pane takes longer to land than an in-process prompt, and
				// the focus listener above catches whatever this poll misses.
				window.setTimeout(() => void refresh(), result.openedSettings ? 700 : 350);
			} finally {
				setBusyKey(null);
			}
		},
		[refresh],
	);

	if (!rows || rows.length === 0) return null;

	const needsRelaunch = rows.some((row) => row.key === "screen" && row.status !== "granted");

	return (
		<>
			<div className={styles.hudMenuSectionLabel}>{t("permissions.title")}</div>
			{rows.map((row) => (
				<div
					key={row.key}
					className={styles.hudModalAboutRow}
					data-testid={`permission-${row.key}`}
				>
					<span className={styles.hudModalMeterLabel}>
						{t(`permissions.row.${row.key}`)}
						{row.requiredForRecording ? ` · ${t("permissions.required")}` : ""}
					</span>
					<button
						type="button"
						onClick={() => void act(row)}
						disabled={row.action === "granted" || busyKey === row.key}
						className={styles.hudModalAboutAction}
					>
						{t(`permissions.status.${row.status}`)}
						{row.action === "granted" ? "" : ` · ${t(`permissions.action.${row.action}`)}`}
					</button>
				</div>
			))}
			{/* macOS hands a fresh Screen Recording grant to the next launch, not to
			    the running process — the source picker says the same thing at
			    `sourceSelector.emptyDescription`. */}
			{needsRelaunch ? (
				<div className={styles.hudModalHint}>{t("permissions.relaunchHint")}</div>
			) : null}
		</>
	);
}
