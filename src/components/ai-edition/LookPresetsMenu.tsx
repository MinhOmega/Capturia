// Saved looks, reachable from the header of every style pane. The logic lives in
// `lookPresets.ts`; this is the list and the save form.

import { Palette, Pencil, Star, Trash2 } from "lucide-react";
import { type CSSProperties, useState } from "react";
import { toast } from "sonner";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useScopedT } from "@/contexts/I18nContext";
import { createId } from "@/lib/ai-edition/document/ids";
import {
	applyLook,
	type LookPreset,
	type LookPresetState,
	loadLookPresets,
	lookFromDocument,
	saveLookPresets,
	withAvailableAssets,
} from "@/lib/ai-edition/store/lookPresets";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import styles from "./NewEditorShell.module.css";

const INPUT_STYLE: CSSProperties = {
	flex: 1,
	minWidth: 0,
	padding: "6px 8px",
	font: "400 var(--fs-app-sm) var(--font-body)",
	color: "var(--fg-2)",
	background: "var(--surface)",
	border: "1px solid var(--border)",
	borderRadius: 6,
};

export function LookPresetsMenu() {
	const ts = useScopedT("settings");
	const tc = useScopedT("common");
	const hasDocument = useProjectStore((s) => s.document !== null);
	const [open, setOpen] = useState(false);
	const [state, setState] = useState<LookPresetState>({ presets: [], defaultId: null });
	const [name, setName] = useState("");
	const [withAspectRatio, setWithAspectRatio] = useState(false);
	const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);

	const persist = (next: LookPresetState) => {
		if (saveLookPresets(next)) setState(next);
		else toast.error(ts("looks.saveFailed"));
	};

	const saveCurrent = () => {
		const doc = useProjectStore.getState().document;
		const trimmed = name.trim();
		if (!doc || !trimmed) return;
		const preset: LookPreset = {
			id: createId("look"),
			name: trimmed,
			...lookFromDocument(doc, withAspectRatio),
		};
		persist({ ...state, presets: [...state.presets, preset] });
		setName("");
	};

	const apply = async (preset: LookPreset) => {
		setOpen(false);
		const look = await withAvailableAssets(preset);
		// Read after the await: the document the look lands on is the one on screen now.
		const doc = useProjectStore.getState().document;
		if (doc) await useProjectStore.getState().saveDocument(applyLook(doc, look), { history: true });
	};

	const commitRename = () => {
		if (!renaming) return;
		const trimmed = renaming.name.trim();
		setRenaming(null);
		if (!trimmed) return;
		persist({
			...state,
			presets: state.presets.map((p) => (p.id === renaming.id ? { ...p, name: trimmed } : p)),
		});
	};

	return (
		<Popover
			open={open}
			onOpenChange={(next) => {
				// Re-read on every open: another pane's menu may have changed the list.
				if (next) setState(loadLookPresets());
				setRenaming(null);
				setOpen(next);
			}}
		>
			<PopoverTrigger asChild>
				<button
					type="button"
					className={styles.iconBtn}
					title={ts("looks.title")}
					aria-label={ts("looks.title")}
				>
					<Palette size={14} />
				</button>
			</PopoverTrigger>
			<PopoverContent
				align="end"
				sideOffset={6}
				collisionPadding={12}
				animated={false}
				className="w-auto border-0 bg-transparent p-0 shadow-none"
			>
				<div className={styles.actionMenu} style={{ width: 264 }}>
					<div className={styles.actionMenuGroup}>{ts("looks.title")}</div>
					{state.presets.length === 0 ? (
						<p
							style={{
								margin: 0,
								padding: "4px 8px 8px",
								font: "400 12px var(--font-body)",
								color: "var(--muted)",
							}}
						>
							{ts("looks.empty")}
						</p>
					) : null}
					{state.presets.map((preset) => {
						const isDefault = state.defaultId === preset.id;
						return (
							<div
								key={preset.id}
								className={styles.actionMenuRow}
								style={{ alignItems: "center", gap: 2, cursor: "default" }}
							>
								{renaming?.id === preset.id ? (
									<input
										autoFocus
										aria-label={ts("looks.rename")}
										value={renaming.name}
										maxLength={60}
										style={INPUT_STYLE}
										onChange={(e) => setRenaming({ id: preset.id, name: e.target.value })}
										onBlur={commitRename}
										onKeyDown={(e) => {
											if (e.key === "Enter") commitRename();
										}}
									/>
								) : (
									<button
										type="button"
										className={styles.actionMenuMain}
										style={{
											flex: 1,
											minWidth: 0,
											overflow: "hidden",
											textOverflow: "ellipsis",
											whiteSpace: "nowrap",
											textAlign: "left",
											border: 0,
											background: "none",
											color: "inherit",
											cursor: hasDocument ? "pointer" : "default",
										}}
										disabled={!hasDocument}
										onClick={() => void apply(preset)}
									>
										{preset.name}
									</button>
								)}
								<button
									type="button"
									className={styles.iconBtn}
									title={ts("looks.defaultForNew")}
									aria-label={ts("looks.defaultForNew")}
									aria-pressed={isDefault}
									onClick={() => persist({ ...state, defaultId: isDefault ? null : preset.id })}
								>
									<Star size={12} fill={isDefault ? "currentColor" : "none"} />
								</button>
								<button
									type="button"
									className={styles.iconBtn}
									title={ts("looks.rename")}
									aria-label={ts("looks.rename")}
									onClick={() => setRenaming({ id: preset.id, name: preset.name })}
								>
									<Pencil size={12} />
								</button>
								<button
									type="button"
									className={styles.iconBtn}
									title={tc("actions.delete")}
									aria-label={tc("actions.delete")}
									onClick={() =>
										persist({
											presets: state.presets.filter((p) => p.id !== preset.id),
											defaultId: isDefault ? null : state.defaultId,
										})
									}
								>
									<Trash2 size={12} />
								</button>
							</div>
						);
					})}
					<div className={styles.actionMenuGroup}>{ts("looks.saveAs")}</div>
					<form
						style={{ display: "grid", gap: 6, padding: "0 8px 6px" }}
						onSubmit={(e) => {
							e.preventDefault();
							saveCurrent();
						}}
					>
						<input
							aria-label={ts("looks.namePlaceholder")}
							placeholder={ts("looks.namePlaceholder")}
							value={name}
							maxLength={60}
							disabled={!hasDocument}
							style={INPUT_STYLE}
							onChange={(e) => setName(e.target.value)}
						/>
						<label
							style={{
								display: "flex",
								alignItems: "center",
								gap: 6,
								font: "400 12px var(--font-body)",
								color: "var(--fg-2)",
							}}
						>
							<input
								type="checkbox"
								checked={withAspectRatio}
								disabled={!hasDocument}
								onChange={(e) => setWithAspectRatio(e.target.checked)}
							/>
							{ts("looks.includeAspectRatio")}
						</label>
						<button
							type="submit"
							className={styles.rowAction}
							style={{ justifyContent: "center" }}
							disabled={!hasDocument || !name.trim()}
						>
							{tc("actions.save")}
						</button>
					</form>
				</div>
			</PopoverContent>
		</Popover>
	);
}
