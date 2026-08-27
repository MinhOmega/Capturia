import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";
import {
	COMPLETE_LOCALES,
	DEFAULT_LOCALE,
	type I18nNamespace,
	LOCALE_STORAGE_KEY,
	type Locale,
} from "@/i18n/config";
import { getAvailableLocales, isAvailableLocale, type TranslateVars, translate } from "@/i18n/loader";

interface I18nContextValue {
	locale: Locale;
	setLocale: (locale: Locale) => void;
	/** `t("namespace.key", vars)` - the namespace is the first dotted segment. */
	t: (qualifiedKey: string, vars?: TranslateVars) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function useI18n(): I18nContextValue {
	const ctx = useContext(I18nContext);
	if (!ctx) throw new Error("useI18n must be used within I18nProvider");
	return ctx;
}

/** A `t` bound to one namespace: `const t = useScopedT("timeline"); t("addZoom")`. */
export function useScopedT(namespace: I18nNamespace) {
	const { locale } = useI18n();
	return useCallback(
		(key: string, vars?: TranslateVars): string => translate(locale, namespace, key, vars),
		[locale, namespace],
	);
}

const TRADITIONAL_CHINESE_TAG = /^zh[-_](hant|tw|hk|mo)\b/i;

/**
 * Map a language tag to one of `candidates` (default: every available locale):
 * exact tag, then case-insensitive tag, then Chinese by script (`zh-TW`,
 * `zh-HK`, `zh-Hant*` -> zh-TW when it is a candidate, otherwise zh-CN; any
 * other `zh*` -> zh-CN), then base language (`fr-CA` -> `fr`), else the
 * default locale.
 */
export function normalizeLocale(
	input: string | null | undefined,
	candidates: readonly Locale[] = getAvailableLocales(),
): Locale {
	const raw = (input ?? "").trim();
	if (!raw) return DEFAULT_LOCALE;
	if (candidates.includes(raw)) return raw;
	const lower = raw.toLowerCase();
	const exact = candidates.find((locale) => locale.toLowerCase() === lower);
	if (exact) return exact;
	const base = lower.split(/[-_]/)[0];
	if (base === "zh") {
		if (TRADITIONAL_CHINESE_TAG.test(raw) && candidates.includes("zh-TW")) return "zh-TW";
		if (candidates.includes("zh-CN")) return "zh-CN";
	}
	const baseMatch = candidates.find((locale) => locale.toLowerCase().split("-")[0] === base);
	if (baseMatch) return baseMatch;
	return DEFAULT_LOCALE;
}

/**
 * First-launch detection (no stored preference): only COMPLETE_LOCALES are
 * candidates, so a French OS lands on `en` rather than the partial `fr`.
 * The manual picker can still select any available locale.
 */
export function detectSystemLocale(tag: string | null | undefined): Locale {
	return normalizeLocale(tag, COMPLETE_LOCALES.filter(isAvailableLocale));
}

export function getLocaleFromStorage(): Locale {
	try {
		const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
		if (stored) return normalizeLocale(stored);
		return detectSystemLocale(window.navigator.language);
	} catch {
		return DEFAULT_LOCALE;
	}
}

export function I18nProvider({ children }: { children: ReactNode }) {
	const [locale, setLocaleState] = useState<Locale>(getLocaleFromStorage);

	const setLocale = useCallback((next: Locale) => {
		setLocaleState(normalizeLocale(next));
	}, []);

	useEffect(() => {
		try {
			window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
		} catch {
			// localStorage may be unavailable
		}
		document.documentElement.lang = locale;
		void window.electronAPI?.setLocale?.(locale);
	}, [locale]);

	const t = useCallback(
		(qualifiedKey: string, vars?: TranslateVars): string => {
			const dotIndex = qualifiedKey.indexOf(".");
			if (dotIndex === -1) return qualifiedKey;
			const namespace = qualifiedKey.slice(0, dotIndex) as I18nNamespace;
			const key = qualifiedKey.slice(dotIndex + 1);
			return translate(locale, namespace, key, vars);
		},
		[locale],
	);

	const value = useMemo<I18nContextValue>(() => ({ locale, setLocale, t }), [locale, setLocale, t]);

	return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
