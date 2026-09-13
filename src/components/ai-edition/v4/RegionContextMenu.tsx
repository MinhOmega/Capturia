// The timeline's right-click menu: Copy, Paste at playhead, Paste attributes and Delete on a
// region pill, Split at playhead on a clip. The Menu key and Shift+F10 open it too, for the
// selected pill.
//
// It owns no editing logic. Every entry calls the function its keyboard shortcut calls —
// handed down from the editor shell, or `tl.splitAtPlayhead` — and shows that shortcut's
// live binding, so the menu and the keys cannot come to disagree.

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useEffect } from "react";
import { useScopedT } from "@/contexts/I18nContext";
import { useShortcuts } from "@/contexts/ShortcutsContext";
import { isModalOpen } from "@/lib/ai-edition/modalGuard";
import { useRegionClipboard } from "@/lib/ai-edition/store/regionClipboard";
import type { useTimeline } from "@/lib/ai-edition/store/useTimeline";
import { formatBinding, isTextEditingTarget, type ShortcutBinding } from "@/lib/shortcuts";
import styles from "./EditorShellV4.module.css";

export interface RegionMenuTarget {
	kind: "zoom" | "trim" | "annotation" | "speed" | "cameraFullscreen" | "audio" | "clip";
	id: string;
	/** Viewport point the menu opens at. */
	x: number;
	y: number;
}

export function RegionContextMenu({
	target,
	onTargetChange,
	tl,
	onCopy,
	onPaste,
	onPasteAttributes,
	onDelete,
}: {
	target: RegionMenuTarget | null;
	onTargetChange: (target: RegionMenuTarget | null) => void;
	tl: ReturnType<typeof useTimeline>;
	onCopy?: () => void;
	onPaste?: () => void;
	onPasteAttributes?: () => void;
	onDelete?: () => void;
}) {
	const t = useScopedT("timeline");
	const tc = useScopedT("common");
	const { shortcuts, isMac } = useShortcuts();
	const clipboard = useRegionClipboard();

	// The keyboard way in. Pills are selected by pointerdown, which does not focus them, so
	// this keys off the SELECTION rather than off focus, and opens the menu under that pill.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "ContextMenu" && !(e.shiftKey && e.key === "F10")) return;
			if (isTextEditingTarget(e.target) || isModalOpen()) return;
			const selected =
				tl.selection ??
				(tl.selectedAudioTrackId ? { kind: "audio" as const, id: tl.selectedAudioTrackId } : null);
			const pill =
				selected && document.querySelector(`[data-pill-id="${CSS.escape(selected.id)}"]`);
			if (!selected || !pill) return;
			e.preventDefault();
			const rect = pill.getBoundingClientRect();
			onTargetChange({ kind: selected.kind, id: selected.id, x: rect.left, y: rect.bottom });
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [tl, onTargetChange]);

	const items: Array<{
		label: string;
		binding: ShortcutBinding;
		onSelect: () => void;
		disabled?: boolean;
	}> =
		target?.kind === "clip"
			? [
					{
						label: t("buttons.splitAtPlayhead"),
						binding: shortcuts.splitAtPlayhead,
						onSelect: () => void tl.splitAtPlayhead(),
					},
				]
			: [
					{
						label: tc("actions.copy"),
						binding: shortcuts.copySelected,
						onSelect: () => onCopy?.(),
						// Copy reads the FOCUSED selection, like Ctrl+C. Right-clicking a pill that
						// is only a passenger in a multi-selection would copy a different pill.
						disabled:
							target?.kind === "audio"
								? tl.selectedAudioTrackId !== target.id
								: tl.selection?.id !== target?.id,
					},
					{
						// Paste makes a NEW region at the playhead, like Ctrl+V; it never writes
						// onto the pill that was clicked, so the label says where it lands and
						// the clicked pill's kind does not gate it. The entry below is the one
						// that writes onto the clicked pill — two verbs on one clipboard, which
						// is why this label has to name the playhead.
						label: t("buttons.pasteAtPlayhead"),
						binding: shortcuts.paste,
						onSelect: () => onPaste?.(),
						disabled: !clipboard.hasContent,
					},
					// Absent, not greyed, on the two kinds that are a bare span: a trim and a
					// full-camera region have no attributes, so there is nothing a paste could
					// write and nothing a disabled entry could promise for later.
					...(target?.kind === "trim" || target?.kind === "cameraFullscreen"
						? []
						: [
								{
									label: t("buttons.pasteAttributes"),
									binding: shortcuts.pasteAttributes,
									onSelect: () => onPasteAttributes?.(),
									// Attributes only mean anything WITHIN a kind — a zoom's depth is
									// not an annotation's anything — and a mixed multi-selection is
									// refused whole rather than applied to the pills that happen to
									// match, which would change some of what the user picked with
									// nothing on screen saying which.
									disabled:
										!clipboard.hasContent ||
										clipboard.kind !== target?.kind ||
										tl.multiSelection.some((h) => h.kind !== clipboard.kind),
								},
							]),
					{
						label: tc("actions.delete"),
						binding: shortcuts.deleteSelected,
						onSelect: () => onDelete?.(),
					},
				];

	return (
		<DropdownMenu.Root
			open={target !== null}
			onOpenChange={(open) => !open && onTargetChange(null)}
		>
			<DropdownMenu.Trigger asChild>
				<span
					aria-hidden
					style={{
						position: "fixed",
						left: target?.x ?? 0,
						top: target?.y ?? 0,
						width: 0,
						height: 0,
					}}
				/>
			</DropdownMenu.Trigger>
			<DropdownMenu.Portal>
				<DropdownMenu.Content
					align="start"
					sideOffset={2}
					className={styles.recMenu}
					style={{ position: "relative", bottom: "auto", zIndex: 50 }}
					// The shell's shortcuts listen on window. Without this, Space on a menu item
					// would pick the item AND toggle playback, and a letter typed to jump between
					// items would also add a region.
					onKeyDown={(e) => e.nativeEvent.stopPropagation()}
				>
					{items.map((item) => (
						<DropdownMenu.Item
							key={item.label}
							className={styles.recMenuRow}
							disabled={item.disabled}
							onSelect={item.onSelect}
						>
							{item.label}
							<kbd className={styles.recMenuKey}>{formatBinding(item.binding, isMac)}</kbd>
						</DropdownMenu.Item>
					))}
				</DropdownMenu.Content>
			</DropdownMenu.Portal>
		</DropdownMenu.Root>
	);
}
