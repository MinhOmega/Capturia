// Explains the one thing about this editor that reads backwards.
//
// In every mainstream NLE the selection is what you KEEP. Here a trim range is
// what you LOSE, and the timeline says so with colour and lane position alone —
// `V4Timeline`'s trim pill is labelled with its duration and nothing else. A
// user who reaches for the tool expecting "select the good bit" silently deletes
// the good bit.
//
// Every string here already shipped, translated, in all thirteen locales
// (`dialogs.tutorial.*`, guarded by `i18n/__tests__/tutorialHelpTranslations.test.ts`)
// — the dialog that consumed them did not survive the rebaseline. Nothing new is
// added: the diagram is drawn from the same design tokens the real trim lane uses
// (`--danger` / `--danger-soft`, cf. `.laneTrim`), so it stays honest in both
// themes instead of hardcoding the dark palette the way the original did.

import { SplitSquareHorizontal } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { useScopedT } from "@/contexts/I18nContext";
import { useShortcuts } from "@/contexts/ShortcutsContext";
import { formatBinding } from "@/lib/shortcuts";
import { ModalShell } from "../Modals";

/** The three kept parts and two removed spans, as percentages of the strip. The
 *  numbers only have to READ as "two bites taken out of a recording"; they are a
 *  diagram, not a document. */
const REMOVED_SPANS: ReadonlyArray<{ left: number; width: number }> = [
	{ left: 22, width: 18 },
	{ left: 64, width: 14 },
];

/** Keyed by translation key rather than by rendered text: two locales are free to
 *  translate "Part 1" and "Part 2" to the same string, and React keys are not. */
const KEPT_PARTS = ["part1", "part2", "part3"] as const;

/** Mounting IS opening. The caller gates the mount rather than passing `open`,
 *  which keeps `useShortcuts` — and its "must be used within <ShortcutsProvider>"
 *  throw — off the top bar's render path until someone asks for the dialog. */
export function TutorialHelp({ onClose }: { onClose: () => void }) {
	const t = useScopedT("dialogs");
	const { shortcuts, isMac } = useShortcuts();
	// Read, never hardcoded: `ShortcutsConfigDialog` lets the user rebind `addTrim`,
	// so a literal "T" here would be wrong for anyone who has.
	const trimKey = formatBinding(shortcuts.addTrim, isMac);

	return (
		<ModalShell
			open
			onClose={onClose}
			title={t("tutorial.title")}
			subtitle={t("tutorial.description")}
			wide
		>
			<div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
				<p style={{ margin: 0, font: "400 13px/1.6 var(--font-body)", color: "var(--fg)" }}>
					{t("tutorial.explanationBefore")} <strong>{t("tutorial.remove")}</strong>
					{t("tutorial.explanationMiddle")} <strong>{t("tutorial.covered")}</strong>{" "}
					{t("tutorial.explanationAfter")}
				</p>

				<section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
					<div style={sectionLabelStyle}>{t("tutorial.visualExample")}</div>

					{/* The recording, with the trimmed spans over it. `aria-hidden` because the
					    prose above already says everything this shows — a screen reader gets the
					    explanation, not a wall of positional labels. */}
					<div aria-hidden style={stripStyle}>
						{REMOVED_SPANS.map((span) => (
							<div
								key={span.left}
								style={{
									position: "absolute",
									top: 0,
									bottom: 0,
									left: `${span.left}%`,
									width: `${span.width}%`,
									display: "grid",
									placeItems: "center",
									background: "var(--danger-soft)",
									border: "1px solid var(--danger)",
									borderRadius: "var(--r-sm)",
									font: "600 9px/1 var(--font-body)",
									letterSpacing: "0.06em",
									color: "var(--danger)",
									overflow: "hidden",
								}}
							>
								{t("tutorial.removed")}
							</div>
						))}
						<span style={stripCaptionStyle}>{t("tutorial.kept")}</span>
					</div>

					{/* What is left once those spans are gone: the same three parts, closed up.
					    This is the half the prose cannot show. */}
					<div aria-hidden style={{ display: "flex", alignItems: "center", gap: 6 }}>
						<span style={{ ...stripCaptionStyle, position: "static", minWidth: 64 }}>
							{t("tutorial.finalVideo")}
						</span>
						{KEPT_PARTS.map((part) => (
							<div key={part} style={keptPartStyle}>
								{t(`tutorial.${part}`)}
							</div>
						))}
					</div>
				</section>

				<section style={{ display: "grid", gap: 10 }}>
					<Step title={t("tutorial.step1Title")}>
						{t("tutorial.step1DescriptionBefore")}
						<kbd style={kbdStyle}>{trimKey}</kbd>
						{/* The timeline toolbar's own icon, so the sentence points at something the
						    user can actually find. The translated string says "scissors" — that is
						    the trim PILL's icon; the button that creates one is this. Worth
						    correcting in a translation pass, not worth invalidating 13 locales for. */}
						<SplitSquareHorizontal
							size={13}
							style={{ verticalAlign: "-2px", margin: "0 3px" }}
							aria-hidden
						/>
						{t("tutorial.step1DescriptionAfter")}
					</Step>
					<Step title={t("tutorial.step2Title")}>{t("tutorial.step2Description")}</Step>
				</section>
			</div>
		</ModalShell>
	);
}

function Step({ title, children }: { title: string; children: ReactNode }) {
	return (
		<div
			style={{
				padding: "10px 12px",
				background: "var(--surface-warm)",
				border: "1px solid var(--border)",
				borderRadius: "var(--r-md)",
			}}
		>
			<div style={{ font: "600 12px/1.4 var(--font-body)", color: "var(--fg)" }}>{title}</div>
			<div style={{ marginTop: 3, font: "400 12px/1.5 var(--font-body)", color: "var(--muted)" }}>
				{children}
			</div>
		</div>
	);
}

const sectionLabelStyle: CSSProperties = {
	font: "500 11px/1 var(--font-body)",
	textTransform: "uppercase",
	letterSpacing: "0.06em",
	color: "var(--muted)",
};

const stripStyle: CSSProperties = {
	position: "relative",
	height: 40,
	background: "var(--accent-soft)",
	border: "1px solid var(--accent-border)",
	borderRadius: "var(--r-md)",
};

const stripCaptionStyle: CSSProperties = {
	position: "absolute",
	left: 8,
	top: "50%",
	transform: "translateY(-50%)",
	font: "500 10px/1 var(--font-body)",
	color: "var(--muted)",
};

const keptPartStyle: CSSProperties = {
	flex: 1,
	height: 28,
	display: "grid",
	placeItems: "center",
	background: "var(--accent-soft)",
	border: "1px solid var(--accent-border)",
	borderRadius: "var(--r-sm)",
	font: "500 10px/1 var(--font-body)",
	color: "var(--muted)",
};

const kbdStyle: CSSProperties = {
	padding: "1px 6px",
	background: "var(--surface)",
	border: "1px solid var(--border-hi)",
	borderRadius: "var(--r-sm)",
	font: "500 11px/1.4 var(--font-mono)",
	color: "var(--fg)",
};
