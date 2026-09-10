import { afterEach, describe, expect, it } from "vitest";
import { listSystemFontFamilies } from "./systemFonts";

type Global = { queryLocalFonts?: unknown };

afterEach(() => {
	delete (globalThis as Global).queryLocalFonts;
});

describe("listSystemFontFamilies", () => {
	it("returns nothing when the runtime has no Local Font Access API", async () => {
		expect(await listSystemFontFamilies()).toEqual([]);
	});

	it("deduplicates families, since one family reports once per face", async () => {
		(globalThis as Global).queryLocalFonts = async () => [
			{ family: "Fira Sans" },
			{ family: "Fira Sans" },
			{ family: "Fira Sans" },
		];
		expect(await listSystemFontFamilies()).toEqual(["Fira Sans"]);
	});

	it("sorts for display", async () => {
		(globalThis as Global).queryLocalFonts = async () => [
			{ family: "Ubuntu" },
			{ family: "Arial" },
			{ family: "Menlo" },
		];
		expect(await listSystemFontFamilies()).toEqual(["Arial", "Menlo", "Ubuntu"]);
	});

	// A refusal must cost the wider list and nothing else: the caller still has the
	// bundled families, which is what it offered before this existed.
	it("degrades to an empty list when the permission is refused", async () => {
		(globalThis as Global).queryLocalFonts = async () => {
			throw new Error("NotAllowedError");
		};
		expect(await listSystemFontFamilies()).toEqual([]);
	});
});
