import { Keyboard, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { useScopedT } from "@/contexts/I18nContext";
import { useShortcuts } from "@/contexts/ShortcutsContext";
import {
	DEFAULT_SEEK_STEP,
	loadSeekStep,
	SEEK_STEPS,
	type SeekStep,
	saveSeekStep,
} from "@/lib/ai-edition/timeline/transport";
import {
	DEFAULT_SHORTCUTS,
	FIXED_SHORTCUTS,
	findConflict,
	formatBinding,
	GLOBAL_SHORTCUT_ACTIONS,
	isGlobalShortcutAction,
	isGlobalShortcutLive,
	SHORTCUT_ACTIONS,
	type ShortcutAction,
	type ShortcutBinding,
	type ShortcutConflict,
	type ShortcutsConfig,
} from "@/lib/shortcuts";

const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta"]);

export function ShortcutsConfigDialog() {
	const {
		shortcuts,
		isMac,
		isConfigOpen,
		openConfig,
		closeConfig,
		setShortcuts,
		persistShortcuts,
		globalShortcutStatuses,
	} = useShortcuts();
	void openConfig;
	const t = useScopedT("shortcuts");
	const tc = useScopedT("common");

	const [draft, setDraft] = useState<ShortcutsConfig>(shortcuts);
	// How far the arrow keys move the playhead. Not a BINDING — the keys are fixed — so it
	// is not part of `draft`, but it rides the same open/Save/Cancel lifecycle: a select
	// that took effect immediately would be the one control in this dialog that Cancel
	// could not undo.
	const [seekStep, setSeekStep] = useState<SeekStep>(DEFAULT_SEEK_STEP);
	const [captureFor, setCaptureFor] = useState<ShortcutAction | null>(null);
	const [conflict, setConflict] = useState<{
		forAction: ShortcutAction;
		pending: ShortcutBinding;
		conflictWith: ShortcutConflict;
	} | null>(null);

	useEffect(() => {
		if (isConfigOpen) {
			setDraft(shortcuts);
			setSeekStep(loadSeekStep());
			setCaptureFor(null);
			setConflict(null);
		}
	}, [isConfigOpen, shortcuts]);

	useEffect(() => {
		if (!captureFor) return;

		const handleCapture = (e: KeyboardEvent) => {
			e.preventDefault();
			e.stopPropagation();

			if (e.key === "Escape") {
				setCaptureFor(null);
				return;
			}

			if (MODIFIER_KEYS.has(e.key)) return;

			const binding: ShortcutBinding = {
				key: e.key.toLowerCase(),
				...(e.ctrlKey || e.metaKey ? { ctrl: true } : {}),
				...(e.shiftKey ? { shift: true } : {}),
				...(e.altKey ? { alt: true } : {}),
			};

			const found = findConflict(binding, captureFor, draft);
			setCaptureFor(null);

			if (found?.type === "fixed") {
				toast.error(t("reservedShortcut", { label: found.label }));
				return;
			}

			if (found?.type === "configurable") {
				setConflict({ forAction: captureFor, pending: binding, conflictWith: found });
				return;
			}

			setDraft((prev: ShortcutsConfig) => ({ ...prev, [captureFor]: binding }));
		};

		window.addEventListener("keydown", handleCapture, { capture: true });
		return () => window.removeEventListener("keydown", handleCapture, { capture: true });
	}, [captureFor, draft, t]);

	const handleSwap = useCallback(() => {
		if (!conflict || conflict.conflictWith.type !== "configurable") return;
		const { forAction, pending, conflictWith } = conflict;
		setDraft((prev: ShortcutsConfig) => ({
			...prev,
			[forAction]: pending,
			[conflictWith.action]: prev[forAction],
		}));
		setConflict(null);
	}, [conflict]);

	const handleCancelConflict = useCallback(() => setConflict(null), []);

	const handleSave = useCallback(async () => {
		saveSeekStep(seekStep);
		const statuses = await persistShortcuts(draft);
		const outcomes = GLOBAL_SHORTCUT_ACTIONS.map((action) => statuses[action]);

		// Only a conflict is the user's to fix, so only a conflict holds the dialog
		// open. On a session with no global shortcuts at all there is no key that
		// would work, and refusing to close would trap them in a dialog whose advice
		// cannot be followed — every non-global shortcut saved fine, so say what
		// happened and let them out.
		//
		// One dead global hotkey is enough to report: staying silent because the
		// OTHER one registered is how a user ends up pressing a key that does nothing.
		if (outcomes.includes("conflict")) {
			toast.error(t("registrationFailed"));
			return;
		}

		setShortcuts(draft);
		if (outcomes.includes("unavailable")) toast.warning(t("globalShortcutUnavailable"));
		else toast.success(t("savedToast"));
		closeConfig();
	}, [draft, seekStep, setShortcuts, persistShortcuts, closeConfig, t]);

	const handleReset = useCallback(() => {
		setDraft({ ...DEFAULT_SHORTCUTS });
		toast.info(t("resetToast"));
	}, [t]);

	const handleClose = useCallback(() => {
		setCaptureFor(null);
		setConflict(null);
		closeConfig();
	}, [closeConfig]);

	return (
		<Dialog
			open={isConfigOpen}
			onOpenChange={(open: boolean) => {
				if (!open) handleClose();
			}}
		>
			<DialogContent className="bg-[var(--surface-1)] border-[var(--border)] text-[var(--fg)] max-w-[420px] max-h-[85vh] flex flex-col">
				<DialogHeader className="shrink-0">
					<DialogTitle className="flex items-center gap-2 text-sm">
						<Keyboard className="w-4 h-4 text-[var(--brand)]" />
						{t("title")}
					</DialogTitle>
				</DialogHeader>

				<div className="flex-1 min-h-0 overflow-y-auto pr-1 -mr-1">
					<div className="space-y-0.5">
						<p className="text-[10px] text-[var(--muted)] mb-2 uppercase tracking-wide font-semibold">
							{t("configurable")}
						</p>
						{SHORTCUT_ACTIONS.map((action) => {
							const isCapturing = captureFor === action;
							const hasConflict = conflict?.forAction === action;
							// Only the OS-owned shortcuts can be taken away by the session or by
							// another app; the rest are renderer keydowns and always work.
							const isDead =
								isGlobalShortcutAction(action) &&
								!isGlobalShortcutLive(globalShortcutStatuses[action]);
							return (
								<div key={action}>
									<div className="flex items-center justify-between py-1.5 px-1 border-b border-[var(--border-soft)]">
										<span
											className={
												isDead ? "text-sm text-[var(--muted)]" : "text-sm text-[var(--fg-2)]"
											}
										>
											{t(`actions.${action}`)}
										</span>
										<button
											type="button"
											disabled={isDead}
											onClick={() => {
												setConflict(null);
												setCaptureFor(isCapturing ? null : action);
											}}
											title={
												isDead
													? t("globalShortcutUnavailable")
													: isCapturing
														? t("pressEscToCancel")
														: t("clickToChange")
											}
											className={[
												"px-2 py-1 rounded text-xs font-mono border transition-all min-w-[90px] text-center select-none",
												isDead
													? "bg-[var(--surface-2)] border-[var(--border)] text-[var(--muted)] line-through opacity-60 cursor-not-allowed"
													: isCapturing
														? "bg-[var(--brand-soft)] border-[var(--brand)] text-[var(--brand)] animate-pulse"
														: hasConflict
															? "bg-[var(--warn-soft)] border-[var(--warn)] text-[var(--warn)]"
															: "bg-[var(--surface-2)] border-[var(--border)] text-[var(--fg-2)] hover:border-[var(--brand)] hover:text-[var(--brand)] cursor-pointer",
											].join(" ")}
										>
											{isCapturing ? t("pressKey") : formatBinding(draft[action], isMac)}
										</button>
									</div>
									{isDead && (
										<p className="px-1 pb-1.5 text-[10px] leading-snug text-[var(--muted)]">
											{t("globalShortcutUnavailable")}
										</p>
									)}
									{hasConflict && conflict?.conflictWith.type === "configurable" && (
										<div className="flex items-center justify-between px-1 py-1.5 mb-0.5 bg-[var(--warn-soft)] border border-[var(--warn)] rounded text-xs">
											<span className="text-[var(--warn)]">
												⚠{" "}
												{t("alreadyUsedBy", {
													action: t(`actions.${conflict.conflictWith.action}`),
												})}
											</span>
											<div className="flex gap-1.5">
												<button
													type="button"
													onClick={handleSwap}
													className="px-2 py-0.5 bg-[var(--warn-soft)] hover:bg-[color-mix(in_srgb,var(--warn)_28%,transparent)] border border-[var(--warn)] rounded text-[var(--warn)] font-medium transition-colors"
												>
													{t("swap")}
												</button>
												<button
													type="button"
													onClick={handleCancelConflict}
													className="px-2 py-0.5 bg-[var(--surface-2)] hover:bg-[var(--surface-3)] border border-[var(--border)] rounded text-[var(--muted)] transition-colors"
												>
													{tc("actions.cancel")}
												</button>
											</div>
										</div>
									)}
								</div>
							);
						})}
					</div>

					<div className="space-y-0.5 mt-2">
						<p className="text-[10px] text-[var(--muted)] mb-2 uppercase tracking-wide font-semibold">
							{t("fixed")}
						</p>
						{FIXED_SHORTCUTS.map(({ i18nKey, label, display }) => (
							<div
								key={i18nKey}
								className="flex items-center justify-between py-1.5 px-1 border-b border-[var(--border-soft)] last:border-0"
							>
								<span className="text-sm text-[var(--muted)]">
									{t(`fixedActions.${i18nKey}`, { defaultValue: label })}
								</span>
								<kbd className="px-2 py-1 bg-[var(--surface-2)] border border-[var(--border)] rounded text-xs font-mono text-[var(--muted)] min-w-[90px] text-center">
									{display}
								</kbd>
							</div>
						))}
					</div>

					<div className="space-y-0.5 mt-2">
						<p className="text-[10px] text-[var(--muted)] mb-2 uppercase tracking-wide font-semibold">
							{t("options")}
						</p>
						<div className="flex items-center justify-between py-1.5 px-1">
							<span className="text-sm text-[var(--fg-2)]">{t("seekStep.label")}</span>
							{/* A native select rather than a custom menu: three options, no search, no
							    multi-select — the platform control is already keyboard- and
							    screen-reader-correct and needs no code to stay that way. */}
							<select
								value={seekStep}
								onChange={(e) => setSeekStep(e.target.value as SeekStep)}
								aria-label={t("seekStep.label")}
								className="px-2 py-1 rounded text-xs border bg-[var(--surface-2)] border-[var(--border)] text-[var(--fg-2)] min-w-[90px] hover:border-[var(--brand)] cursor-pointer"
							>
								{SEEK_STEPS.map((step) => (
									<option key={step} value={step}>
										{t(`seekStep.${step}`)}
									</option>
								))}
							</select>
						</div>
					</div>

					<p className="text-[10px] text-[var(--muted)] mt-1">{t("helpText")}</p>
				</div>

				<DialogFooter className="shrink-0 flex gap-2 sm:justify-between mt-2">
					<Button
						variant="ghost"
						size="sm"
						className="text-[var(--muted)] gap-1.5"
						onClick={handleReset}
					>
						<RotateCcw className="w-3 h-3" />
						{t("resetToDefaults")}
					</Button>
					<div className="flex gap-2">
						<Button variant="ghost" size="sm" onClick={handleClose}>
							{tc("actions.cancel")}
						</Button>
						<Button
							size="sm"
							className="bg-[var(--brand)] hover:bg-[var(--brand-lo)] text-[var(--accent-on)]"
							onClick={handleSave}
						>
							{tc("actions.save")}
						</Button>
					</div>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
