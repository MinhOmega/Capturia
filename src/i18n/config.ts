export const DEFAULT_LOCALE = "en" as const;

/**
 * Locales that ship a folder under `src/i18n/locales/`. A locale only becomes
 * selectable when all `I18N_NAMESPACES` files exist for it (see loader.ts);
 * keys missing inside a file fall back to `en` at lookup time.
 */
export const SUPPORTED_LOCALES = [
	"en",
	"ar",
	"es",
	"fr",
	"it",
	"ja-JP",
	"ko-KR",
	"ru",
	"tr",
	"vi",
	"pt-BR",
	"zh-CN",
	"zh-TW",
] as const;

/**
 * Locales whose translation is complete and therefore parity-checked by
 * `scripts/i18n-check.mjs`. The others are partial and fall back to `en`.
 */
export const COMPLETE_LOCALES = ["en", "zh-CN", "vi"] as const;

export const I18N_NAMESPACES = [
	"common",
	"dialogs",
	"editor",
	"launch",
	"settings",
	"shortcuts",
	"timeline",
] as const;

export type Locale = string;
export type I18nNamespace = (typeof I18N_NAMESPACES)[number];

/** localStorage key for the user's language choice. Pre-dates this layout; do not rename. */
export const LOCALE_STORAGE_KEY = "capturia.locale";
