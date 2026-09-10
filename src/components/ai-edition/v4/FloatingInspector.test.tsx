// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/contexts/I18nContext", () => ({
	useScopedT: (scope: string) => (key: string) => `${scope}.${key}`,
}));

vi.mock("../RightPanes", () => ({
	AudioPane: () => <div data-testid="audio-pane">AudioPane</div>,
	AudioTrackPane: ({ onClose }: { onClose?: () => void }) => (
		<div data-testid="audio-track-pane">
			AudioTrackPane
			{onClose ? (
				<button type="button" aria-label="common.actions.close" onClick={onClose}>
					close
				</button>
			) : null}
		</div>
	),
	CursorPane: () => <div data-testid="cursor-pane">CursorPane</div>,
	LayoutPane: () => <div data-testid="layout-pane">LayoutPane</div>,
	SliderCell: ({ label }: { label: string }) => <div data-testid="slider-cell">{label}</div>,
	Toggle: () => <div data-testid="toggle">Toggle</div>,
	TranscriptPane: () => <div data-testid="transcript-pane">TranscriptPane</div>,
	VideoEffectsPane: () => <div data-testid="effects-pane">VideoEffectsPane</div>,
}));

vi.mock("../CaptionsPane", () => ({
	CaptionsPane: () => <div data-testid="captions-pane">CaptionsPane</div>,
}));

import { FloatingInspector } from "./FloatingInspector";

describe("FloatingInspector", () => {
	const defaultProps: React.ComponentProps<typeof FloatingInspector> = {
		facet: "layout" as const,
		open: true,
		onFacetChange: vi.fn(),
		onToggleOpen: vi.fn(),
		clips: [],
		onEditClip: vi.fn(),
		transcriptProps: {} as unknown as React.ComponentProps<
			typeof FloatingInspector
		>["transcriptProps"],
		tl: {
			selection: null,
			clearSelection: vi.fn(),
			selectedAudioTrackId: null,
			selectAudioTrack: vi.fn(),
		} as unknown as React.ComponentProps<typeof FloatingInspector>["tl"],
	};

	it("renders layout facet button on rail with camera icon and settings.layout.title", () => {
		render(<FloatingInspector {...defaultProps} />);
		const layoutBtn = screen.getByRole("button", { name: "settings.layout.title" });
		expect(layoutBtn).toBeInTheDocument();
		// lucide Camera icon renders an svg with class lucide-camera
		const svg = layoutBtn.querySelector("svg");
		expect(svg?.classList.contains("lucide-camera")).toBe(true);
	});

	it("renders collapse button with editor.inspector.collapseInspector and collapses inspector when clicked", () => {
		const onToggleOpen = vi.fn();
		render(<FloatingInspector {...defaultProps} facet="audio" onToggleOpen={onToggleOpen} />);
		const collapseBtn = screen.getByRole("button", { name: "editor.inspector.collapseInspector" });
		expect(collapseBtn).toBeInTheDocument();
		const svg = collapseBtn.querySelector("svg");
		expect(svg?.classList.contains("lucide-chevron-right")).toBe(true);

		fireEvent.click(collapseBtn);
		expect(onToggleOpen).toHaveBeenCalledTimes(1);
	});

	it("renders close button on AudioTrackPane when audio track is selected and deselects on click", () => {
		const clearSelection = vi.fn();
		const tl = {
			...defaultProps.tl,
			selectedAudioTrackId: "audio-1",
			clearSelection,
		};
		render(<FloatingInspector {...defaultProps} tl={tl} />);
		expect(screen.getByTestId("audio-track-pane")).toBeInTheDocument();
		const closeBtn = screen.getByRole("button", { name: "common.actions.close" });
		fireEvent.click(closeBtn);
		expect(clearSelection).toHaveBeenCalledTimes(1);
	});

	// Le pane d'annotation : chaque contrôle doit ÉCRIRE (updateAnnotationLive) puis
	// ENREGISTRER (commitAnnotationChange), sinon l'annulation ne voit pas le changement.
	const annotationProps = (region: Record<string, unknown>) => ({
		...defaultProps,
		tl: {
			...defaultProps.tl,
			selection: { kind: "annotation", id: "ann-1" },
			// `style` n'est pas optionnel dans le schéma, et le pane le lit avant même de
			// regarder le type (`hasTextBackground`) : un fixture sans style ne testerait pas
			// une annotation que le produit peut réellement fabriquer.
			annotationRegions: [{ id: "ann-1", style: { backgroundColor: "transparent" }, ...region }],
			updateAnnotationLive: vi.fn(),
			commitAnnotationChange: vi.fn(),
			removeRegion: vi.fn(),
		} as unknown as React.ComponentProps<typeof FloatingInspector>["tl"],
	});

	it("writes and commits text alignment and font family for a text annotation", () => {
		const props = annotationProps({
			type: "text",
			content: "hi",
			style: { backgroundColor: "transparent", fontSize: 32 },
		});
		render(<FloatingInspector {...props} />);

		fireEvent.change(screen.getByDisplayValue("Inter"), { target: { value: "Geist" } });
		expect(props.tl.updateAnnotationLive).toHaveBeenCalledWith("ann-1", {
			style: { backgroundColor: "transparent", fontSize: 32, fontFamily: "Geist" },
		});

		// Le seul <select> dont la valeur vaut "center" : l'alignement, sur son défaut.
		const alignSelect = screen
			.getAllByRole("combobox")
			.find((el) => (el as HTMLSelectElement).value === "center") as HTMLSelectElement;
		fireEvent.change(alignSelect, { target: { value: "right" } });
		expect(props.tl.updateAnnotationLive).toHaveBeenCalledWith("ann-1", {
			style: { backgroundColor: "transparent", fontSize: 32, textAlign: "right" },
		});
		expect(props.tl.commitAnnotationChange).toHaveBeenCalled();
	});

	it("shows only the blur setting that the compositor reads for the current blur type", () => {
		const { unmount } = render(
			<FloatingInspector {...annotationProps({ type: "blur", blurData: { type: "blur" } })} />,
		);
		expect(screen.getByText("settings.annotation.blurIntensity")).toBeInTheDocument();
		expect(screen.queryByText("settings.annotation.mosaicBlockSize")).toBeNull();
		// La teinte ne s'applique qu'à la mosaïque (`tinted = 0` pour le flou côté natif).
		expect(screen.queryByText("settings.annotation.blurColor")).toBeNull();
		unmount();

		render(
			<FloatingInspector {...annotationProps({ type: "blur", blurData: { type: "mosaic" } })} />,
		);
		expect(screen.getByText("settings.annotation.mosaicBlockSize")).toBeInTheDocument();
		expect(screen.getByText("settings.annotation.blurColor")).toBeInTheDocument();
		expect(screen.queryByText("settings.annotation.blurIntensity")).toBeNull();
	});
});
