// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import { LOCALE_STORAGE_KEY } from "@/i18n/config";
import type { SttModelsSnapshot } from "../../../electron/stt/transcriptionContract";
import { SpeechModelSettings } from "./SpeechModelSettings";

afterEach(() => {
	cleanup();
	localStorage.clear();
	(window as { electronAPI?: unknown }).electronAPI = undefined;
});

const snapshot = (over: Partial<SttModelsSnapshot>): SttModelsSnapshot => ({
	active: "balanced",
	models: [
		{ id: "fast", bytes: 81_768_585, downloaded: true },
		{ id: "balanced", bytes: 264_464_607, downloaded: true },
		{ id: "accurate", bytes: 574_041_195, downloaded: false },
	],
	cpuOnly: false,
	inFlight: [],
	...over,
});

it("joins a switch an earlier mount started, and settles when it lands", async () => {
	// "Use Accurate", close AI settings, reopen: this mount did not start the
	// download, and main reports it in flight.
	let land: () => void = () => undefined;
	const setModel = vi.fn(
		() =>
			new Promise<void>((resolve) => {
				land = resolve;
			}),
	);
	const listModels = vi
		.fn()
		.mockResolvedValueOnce(snapshot({ inFlight: ["accurate"] }))
		.mockResolvedValue(snapshot({ active: "accurate" }));
	(window as { electronAPI?: unknown }).electronAPI = {
		stt: { listModels, setModel, deleteModel: vi.fn(), onModelProgress: () => () => undefined },
	};
	localStorage.setItem(LOCALE_STORAGE_KEY, "en");
	render(
		<I18nProvider>
			<SpeechModelSettings />
		</I18nProvider>,
	);

	// Held from the start, not from the next progress event, and waiting on the
	// in-flight switch rather than starting one.
	await waitFor(() => expect(setModel).toHaveBeenCalledWith("accurate"));
	expect(setModel).toHaveBeenCalledOnce();
	for (const use of screen.getAllByRole("button", { name: "Use" })) expect(use).toBeDisabled();

	land();

	// The card it switched to reads Active, and nothing is left disabled.
	const accurate = (await screen.findByText("Accurate")).closest("div")
		?.parentElement as HTMLElement;
	await waitFor(() => expect(within(accurate).getByText("Active")).toBeInTheDocument());
	for (const use of screen.getAllByRole("button", { name: "Use" })) expect(use).toBeEnabled();
});
