// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ShortcutsProvider } from "@/contexts/ShortcutsContext";

// Echo keys: the prose is translated in 13 locales and drifts with copy edits, so
// asserting against it would test the copy rather than the component. What is worth
// asserting is the one value the dialog COMPUTES — the trim shortcut.
vi.mock("@/contexts/I18nContext", () => ({
	useI18n: () => ({ locale: "en", setLocale: () => {} }),
	useScopedT: () => (key: string) => key,
}));

import { TutorialHelp } from "./TutorialHelp";

function renderTutorial() {
	render(
		<ShortcutsProvider>
			<TutorialHelp onClose={() => {}} />
		</ShortcutsProvider>,
	);
}

describe("TutorialHelp", () => {
	it("shows the default trim shortcut when nothing is rebound", async () => {
		renderTutorial();
		expect(await screen.findByText("T")).toBeInTheDocument();
	});

	// The regression this file exists for. Capturia's dialog hardcoded the key because
	// that build had no rebinding; this shell ships `ShortcutsConfigDialog`, so a literal
	// "T" would tell a user who rebound `addTrim` to press the wrong key — and the dialog
	// whose whole job is explaining the tool would be the thing lying about it.
	it("reads the live addTrim binding rather than hardcoding T", async () => {
		vi.stubGlobal("electronAPI", {
			getShortcuts: () => Promise.resolve({ addTrim: { key: "z", ctrl: true } }),
		});
		try {
			renderTutorial();
			expect(await screen.findByText("Ctrl + Z")).toBeInTheDocument();
			expect(screen.queryByText("T")).not.toBeInTheDocument();
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
