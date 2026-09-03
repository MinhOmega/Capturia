// Dependency-free message loader.
//
// Every `locales/<locale>/<namespace>.json` is bundled eagerly via
// `import.meta.glob`. Lookup order for `translate(locale, ns, key)`:
//   requested locale -> DEFAULT_LOCALE -> the literal `${ns}.${key}` marker.
// Nothing here touches localStorage: the stored preference is owned by
// I18nContext, which guards its access.

import { DEFAULT_LOCALE, I18N_NAMESPACES, type I18nNamespace, type Locale } from './config'

export type MessageMap = Record<string, unknown>
export type TranslateVars = Record<string, string | number>

type LocaleValidationError = {
  locale: string
  missingNamespaces: I18nNamespace[]
}

const modules = import.meta.glob('./locales/**/*.json', { eager: true }) as Record<
  string,
  { default: MessageMap }
>

const messages: Record<string, Record<string, MessageMap>> = {}

for (const [modulePath, mod] of Object.entries(modules)) {
  // modulePath looks like "./locales/en/common.json"
  const parts = modulePath.replace('./locales/', '').replace('.json', '').split('/')
  const locale = parts[0]
  const namespace = parts[1]
  if (!messages[locale]) messages[locale] = {}
  messages[locale][namespace] = mod.default
}

const REQUIRED_NAMESPACES = new Set<string>(I18N_NAMESPACES)

const localeValidationErrors: LocaleValidationError[] = Object.keys(messages)
  .map((locale) => {
    const localeMessages = messages[locale] ?? {}
    const missingNamespaces = I18N_NAMESPACES.filter((namespace) => !localeMessages[namespace])
    return { locale, missingNamespaces }
  })
  .filter((entry) => entry.missingNamespaces.length > 0)

const invalidLocales = new Set(localeValidationErrors.map((entry) => entry.locale))

const availableLocales = Object.keys(messages)
  .filter((locale) => REQUIRED_NAMESPACES.size > 0 && hasRequiredNamespaces(messages[locale]))
  .filter((locale) => !invalidLocales.has(locale))
  .sort((a, b) => {
    if (a === DEFAULT_LOCALE) return -1
    if (b === DEFAULT_LOCALE) return 1
    return a.localeCompare(b)
  })

if (localeValidationErrors.length > 0) {
  console.error('[i18n] Incomplete locale folders were excluded:')
  for (const entry of localeValidationErrors) {
    console.error(
      `[i18n] ${entry.locale}: missing ${entry.missingNamespaces.map((ns) => `${ns}.json`).join(', ')}`,
    )
  }
}

function hasRequiredNamespaces(localeMessages: Record<string, MessageMap> | undefined): boolean {
  if (!localeMessages) return false
  for (const namespace of REQUIRED_NAMESPACES) {
    if (!localeMessages[namespace]) return false
  }
  return true
}

// Not a type predicate: `Locale` is `string`, so a guard would narrow the
// negative branch to `never`.
export function isAvailableLocale(locale: string): boolean {
  return availableLocales.includes(locale)
}

export function getAvailableLocales(): Locale[] {
  if (availableLocales.length === 0) {
    return [DEFAULT_LOCALE]
  }
  return availableLocales
}

export function getLocaleValidationErrors(): LocaleValidationError[] {
  return localeValidationErrors
}

/**
 * Resolve a dotted key inside a message object. Files are nested JSON, but a
 * key that is both a leaf and a branch (`launch.shape` + `launch.shape.rounded`)
 * keeps the branch as dotted keys next to the leaf, so at every level the full
 * remaining path is tried as a direct property before descending one segment.
 * Only string leaves count: a branch object yields undefined so the caller
 * falls through to the `namespace.key` marker instead of rendering "[object Object]".
 */
export function getMessageValue(obj: unknown, dotPath: string): string | undefined {
  if (obj == null || typeof obj !== 'object') return undefined
  const record = obj as Record<string, unknown>
  const direct = record[dotPath]
  if (typeof direct === 'string') return direct
  const dotIndex = dotPath.indexOf('.')
  if (dotIndex === -1) return undefined
  return getMessageValue(record[dotPath.slice(0, dotIndex)], dotPath.slice(dotIndex + 1))
}

export function interpolate(str: string, vars?: TranslateVars): string {
  if (!vars) return str
  return str.replace(/\{\{(\w+)\}\}/g, (_, key: string) => String(vars[key] ?? `{{${key}}}`))
}

export function getMessages(locale: Locale, namespace: I18nNamespace): MessageMap {
  const resolvedLocale = isAvailableLocale(locale) ? locale : DEFAULT_LOCALE
  return messages[resolvedLocale]?.[namespace] ?? {}
}

/** Native display name of a locale (`common.locale.name`), e.g. "Tiếng Việt". */
export function getLocaleName(locale: Locale): string {
  const resolvedLocale = isAvailableLocale(locale) ? locale : DEFAULT_LOCALE
  return getMessageValue(messages[resolvedLocale]?.common, 'locale.name') ?? locale
}

export function getLocaleShort(locale: Locale): string {
  const resolvedLocale = isAvailableLocale(locale) ? locale : DEFAULT_LOCALE
  return getMessageValue(messages[resolvedLocale]?.common, 'locale.short') ?? locale
}

export function translate(
  locale: Locale,
  namespace: I18nNamespace,
  key: string,
  vars?: TranslateVars,
): string {
  const value =
    getMessageValue(
      messages[isAvailableLocale(locale) ? locale : DEFAULT_LOCALE]?.[namespace],
      key,
    ) ?? getMessageValue(messages[DEFAULT_LOCALE]?.[namespace], key)

  if (value == null) return `${namespace}.${key}`
  return interpolate(value, vars)
}
