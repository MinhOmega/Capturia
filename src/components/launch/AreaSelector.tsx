import {
	type CSSProperties,
	type PointerEvent as ReactPointerEvent,
	useEffect,
	useState,
} from "react";
import { useScopedT } from "@/contexts/I18nContext";
import { type AreaRect, toPhysicalArea } from "@/lib/recordingArea";

// The last area, per display, in CSS pixels. The overlay's own storage rather than the
// main process: it is a preference of this screen, and it outlives a restart.
const STORAGE_KEY = `capturia.recordArea.${new URLSearchParams(window.location.search).get("displayId")}`;

type Edges = { left?: boolean; top?: boolean; right?: boolean; bottom?: boolean };

const HANDLES: Array<[Edges, CSSProperties]> = [
	[
		{ left: true, top: true },
		{ left: -5, top: -5, cursor: "nwse-resize" },
	],
	[
		{ right: true, top: true },
		{ right: -5, top: -5, cursor: "nesw-resize" },
	],
	[
		{ left: true, bottom: true },
		{ left: -5, bottom: -5, cursor: "nesw-resize" },
	],
	[
		{ right: true, bottom: true },
		{ right: -5, bottom: -5, cursor: "nwse-resize" },
	],
	[{ top: true }, { left: "50%", top: -5, marginLeft: -5, cursor: "ns-resize" }],
	[{ bottom: true }, { left: "50%", bottom: -5, marginLeft: -5, cursor: "ns-resize" }],
	[{ left: true }, { top: "50%", left: -5, marginTop: -5, cursor: "ew-resize" }],
	[{ right: true }, { top: "50%", right: -5, marginTop: -5, cursor: "ew-resize" }],
];

function rememberedArea(): AreaRect | null {
	try {
		return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
	} catch {
		return null;
	}
}

/**
 * The "record an area" overlay: one display, dimmed, with a rectangle to drag out, move
 * and resize. Enter confirms, Esc dismisses. The display is still recorded whole; the
 * rectangle becomes the crop the clip opens with.
 */
export function AreaSelector() {
	const t = useScopedT("launch");
	const [rect, setRect] = useState<AreaRect | null>(rememberedArea);

	// Drawn through the very clamp the main process applies, so what is on screen and in
	// the readout is exactly what will be cropped: whole physical pixels, inside the
	// display, at least the crop minimum.
	const scale = window.devicePixelRatio || 1;
	const view = { width: window.innerWidth, height: window.innerHeight };
	const area = rect ? toPhysicalArea(rect, view, scale) : null;
	const shown = area && {
		x: area.x / scale,
		y: area.y / scale,
		width: area.width / scale,
		height: area.height / scale,
	};

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") window.close();
			if (event.key === "Enter" && shown) {
				localStorage.setItem(STORAGE_KEY, JSON.stringify(shown));
				void window.electronAPI.finishAreaSelection(shown);
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [shown]);

	// Every gesture is edges following the pointer from where it went down: drawing is a
	// zero-size rectangle growing its bottom-right corner, moving is all four edges.
	const startGesture = (edges: Edges | "move" | "draw") => (event: ReactPointerEvent) => {
		event.preventDefault();
		event.stopPropagation();
		const originX = event.clientX;
		const originY = event.clientY;
		const start =
			edges === "draw" || !shown ? { x: originX, y: originY, width: 0, height: 0 } : shown;
		const moving: Edges | "move" = edges === "draw" ? { right: true, bottom: true } : edges;
		const onMove = (moveEvent: PointerEvent) => {
			const dx = moveEvent.clientX - originX;
			const dy = moveEvent.clientY - originY;
			if (moving === "move") {
				setRect({
					...start,
					x: Math.min(Math.max(0, start.x + dx), view.width - start.width),
					y: Math.min(Math.max(0, start.y + dy), view.height - start.height),
				});
				return;
			}
			const x0 = start.x + (moving.left ? dx : 0);
			const x1 = start.x + start.width + (moving.right ? dx : 0);
			const y0 = start.y + (moving.top ? dy : 0);
			const y1 = start.y + start.height + (moving.bottom ? dy : 0);
			setRect({
				x: Math.min(x0, x1),
				y: Math.min(y0, y1),
				width: Math.abs(x1 - x0),
				height: Math.abs(y1 - y0),
			});
		};
		const onUp = () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
	};

	return (
		<div
			className="fixed inset-0 select-none"
			style={{ cursor: "crosshair", background: shown ? "transparent" : "rgba(0, 0, 0, 0.45)" }}
			onPointerDown={startGesture("draw")}
		>
			{shown && area ? (
				<div
					style={{
						position: "absolute",
						left: shown.x,
						top: shown.y,
						width: shown.width,
						height: shown.height,
						outline: "1.5px solid #ffffff",
						boxShadow: "0 0 0 9999px rgba(0, 0, 0, 0.45)",
						cursor: "move",
					}}
					onPointerDown={startGesture("move")}
				>
					{HANDLES.map(([edges, position]) => (
						<div
							key={JSON.stringify(edges)}
							onPointerDown={startGesture(edges)}
							style={{
								position: "absolute",
								width: 10,
								height: 10,
								borderRadius: 3,
								background: "#ffffff",
								border: "1px solid rgba(0, 0, 0, 0.6)",
								...position,
							}}
						/>
					))}
					<div
						className="absolute left-0 rounded-md bg-black/75 px-2 py-1 font-mono text-xs text-white tabular-nums"
						style={shown.y > 32 ? { top: -30 } : { bottom: -30 }}
					>
						{area.width} × {area.height}
					</div>
				</div>
			) : null}
			<div className="pointer-events-none absolute left-1/2 top-6 -translate-x-1/2 rounded-lg bg-black/75 px-3 py-2 text-sm text-white">
				{t("areaSelector.hint")}
			</div>
		</div>
	);
}
