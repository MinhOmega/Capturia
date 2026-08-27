// Entry point for renderer i18n. Import from "@/i18n"; see docs/i18n.md.
//
// Messages live in ./locales/<locale>/<namespace>.json and are resolved by
// ./loader.ts; the React binding is in src/contexts/I18nContext.tsx.

export {
	detectSystemLocale,
	getLocaleFromStorage,
	I18nProvider,
	normalizeLocale,
	useI18n,
	useScopedT,
} from "@/contexts/I18nContext";
export {
	COMPLETE_LOCALES,
	DEFAULT_LOCALE,
	I18N_NAMESPACES,
	type I18nNamespace,
	LOCALE_STORAGE_KEY,
	type Locale,
	SUPPORTED_LOCALES,
} from "./config";
export {
	getAvailableLocales,
	getLocaleName,
	getLocaleShort,
	getMessages,
	type TranslateVars,
	translate,
} from "./loader";
