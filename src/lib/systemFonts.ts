// The installed-font set, for the caption font picker.
//
// Why the OS set and nothing but the OS set: caption text is rasterised by the
// native compositor, and all three backends resolve a family NAME against the
// system font collection -- `CreateTextFormat(family, None, ...)` on Windows
// (the `None` is the IDWriteFontCollection; NULL means the system one),
// `CTFontCreateWithName` on macOS, and cosmic-text's `FontSystem::new()`, whose
// fontdb calls `load_system_fonts()`, on Linux. A family the OS holds is
// therefore resolvable at export on every platform.
//
// A family the OS does NOT hold is not. `src/lib/customFonts.ts` pulls Google
// Fonts into the DOM with an @import; those faces live in Chromium's memory,
// which the compositor cannot see. Offering one here would preview correctly and
// then export in a substitute face, with nothing raised -- the old fork could do
// it safely because it exported through a canvas in the renderer, and this app
// cannot. That is why this module enumerates the OS and why nothing in it takes
// a URL.

/** The subset of the Local Font Access API's `FontData` we use. */
interface LocalFontData {
	readonly family: string;
}

type QueryLocalFonts = () => Promise<readonly LocalFontData[]>;

/**
 * Installed font families, deduplicated and sorted for display.
 *
 * Returns an empty list when the runtime has no Local Font Access API, when the
 * `local-fonts` permission is refused, or when the call lacks the user gesture
 * the permission prompt needs. The caller then offers the bundled families
 * alone, which is exactly what it offered before this existed -- a refusal costs
 * the user the wider list, never a broken picker.
 */
export async function listSystemFontFamilies(): Promise<string[]> {
	const query = (globalThis as { queryLocalFonts?: QueryLocalFonts }).queryLocalFonts;
	if (typeof query !== "function") return [];

	try {
		const fonts = await query();
		return [...new Set(fonts.map((font) => font.family))].sort((a, b) => a.localeCompare(b));
	} catch {
		return [];
	}
}
