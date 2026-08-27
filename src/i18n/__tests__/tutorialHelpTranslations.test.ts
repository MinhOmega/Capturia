import { describe, expect, it } from "vitest";
import { COMPLETE_LOCALES } from "@/i18n/config";
import { getAvailableLocales, getMessageValue, getMessages } from "@/i18n/loader";

/** Every key TutorialHelp.tsx renders (dialogs.tutorial.*). */
const tutorialHelpKeys = [
	"trigger",
	"title",
	"desc",
	"explain",
	"visualExample",
	"part",
	"removed",
	"kept",
	"finalVideo",
	"step1",
	"step1desc",
	"step2",
	"step2desc",
] as const;

describe("TutorialHelp translations", () => {
	it("defines every tutorial help key for each complete locale", () => {
		for (const locale of COMPLETE_LOCALES) {
			const dialogs = getMessages(locale, "dialogs");
			for (const key of tutorialHelpKeys) {
				const label = `${locale} dialogs.tutorial.${key}`;
				const message = getMessageValue(dialogs, `tutorial.${key}`);
				expect(message, label).toEqual(expect.any(String));
				expect((message as string).trim().length, label).toBeGreaterThan(0);
			}
		}
	});

	it("never ships an empty tutorial string in a partial locale", () => {
		const complete = new Set<string>(COMPLETE_LOCALES);
		for (const locale of getAvailableLocales()) {
			if (complete.has(locale)) continue;
			const tutorial = getMessages(locale, "dialogs").tutorial;
			if (!tutorial || typeof tutorial !== "object") continue;
			for (const [key, message] of Object.entries(tutorial as Record<string, unknown>)) {
				const label = `${locale} dialogs.tutorial.${key}`;
				expect(message, label).toEqual(expect.any(String));
				expect((message as string).trim().length, label).toBeGreaterThan(0);
			}
		}
	});
});
