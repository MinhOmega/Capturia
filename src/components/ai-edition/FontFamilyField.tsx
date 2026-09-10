// The font family control, shared by the captions pane and the annotation
// inspector. Both write `style.fontFamily`, both are rasterised by the same three
// native backends, so both need the same list and the same guard -- a component
// rather than a hook precisely so the guard cannot be left out of one of them.

import type { CSSProperties } from "react";
import { useId, useMemo, useState } from "react";
import { listSystemFontFamilies } from "@/lib/systemFonts";

/**
 * The two families this app BUNDLES, always offered. The field also offers every
 * font installed on the machine -- see `listSystemFontFamilies` in
 * `src/lib/systemFonts.ts` -- so this is the floor of the list, not the list.
 * Inter is bundled in `src/styles/annotation-fonts.css`, Geist in
 * `styles/fonts.css`.
 *
 * The two halves have OPPOSITE export behaviour, and it is the bundled half that
 * is the weak one:
 *
 *   - An installed family is safe. Export text is rasterised natively and all
 *     three backends resolve a family name against the system font collection:
 *     `text_windows.rs` calls `CreateTextFormat(family, None, ...)` where the
 *     `None` is the `IDWriteFontCollection` and NULL means the system one;
 *     `text_macos.rs` calls `CTFontCreateWithName`; `text_linux.rs` builds
 *     `FontSystem::new()`, whose fontdb calls `load_system_fonts()`. What the OS
 *     has, the compositor can resolve.
 *   - The bundled two are NOT safe, and shipping them is what makes them unsafe.
 *     Bundling a font reaches the DOM, and the DOM is only the PREVIEW; none of
 *     the three can load a file we ship (nothing calls
 *     `CTFontManagerRegisterFontsForURL`, `fontdb::load_font_data`, or builds a
 *     DirectWrite custom collection), and the bundled woff2 is a web-only
 *     container none of them could parse anyway. Neither Inter nor Geist is a
 *     system font on Windows, macOS or a stock Linux desktop, so BOTH are still
 *     substituted at export on a machine that lacks them.
 *
 * An unresolvable family never fails loudly. All three backends substitute
 * silently -- DirectWrite and CoreText fall back internally, and cosmic-text
 * builds its match list from every installed face, so an unmatched name leaves
 * that list unreordered and shapes against another face. Text always renders, in
 * the wrong type, with nothing raised. That is the whole reason this field
 * commits only a family it enumerated: a bad name is invisible until someone
 * watches the export.
 */
export const BUNDLED_FONTS = ["Inter", "Geist"] as const;

interface FontFamilyFieldProps {
	value: string;
	/** Called only with a family the compositor can resolve. */
	onChange: (family: string) => void;
	/** Names the input; the row's own label is a span, not a <label>. */
	label: string;
	disabled?: boolean;
	style?: CSSProperties;
}

export function FontFamilyField({ value, onChange, label, disabled, style }: FontFamilyFieldProps) {
	// Both panes can be mounted at once, so the list needs an id of its own.
	const listId = useId();
	const [systemFonts, setSystemFonts] = useState<readonly string[]>([]);
	// What the user has typed while it does not yet name a family we can resolve.
	// Null means "show the stored value".
	const [draft, setDraft] = useState<string | null>(null);

	const options = useMemo(
		() => [...new Set<string>([...BUNDLED_FONTS, ...systemFonts])],
		[systemFonts],
	);

	// Enumerated on first focus rather than on mount, because the Local Font
	// Access permission prompt needs a user gesture -- a pane that asked as it
	// opened would be refused, and the user would never see the wider list.
	const loadSystemFonts = () => {
		if (systemFonts.length > 0) return;
		void listSystemFontFamilies().then(setSystemFonts);
	};

	return (
		<>
			{/* A datalist, not a select: the installed set runs to hundreds of entries
			    on a normal machine and the native control filters as you type. The
			    input renders in the chosen family, which is the preview the
			    per-option styling used to give. */}
			<input
				list={listId}
				aria-label={label}
				value={draft ?? value}
				disabled={disabled}
				onFocus={loadSystemFonts}
				onChange={(e) => {
					const next = e.target.value;
					// Only a family the compositor can resolve is ever written out.
					// Anything else stays local until it matches or is abandoned.
					if (options.includes(next)) {
						setDraft(null);
						onChange(next);
					} else {
						setDraft(next);
					}
				}}
				onBlur={() => setDraft(null)}
				style={{ ...style, fontFamily: value }}
			/>
			<datalist id={listId}>
				{options.map((font) => (
					<option key={font} value={font} />
				))}
			</datalist>
		</>
	);
}
