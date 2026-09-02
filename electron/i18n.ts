// Lightweight i18n for the Electron main process (ported from OpenScreen v1.7.0).
// Imports the same JSON translation files the renderer uses, restricted to the
// namespaces main needs (tray, native dialogs, runtime-error box).
//
// The current locale follows the renderer: I18nContext calls the `set-locale`
// IPC whenever the user picks a language, and `mainT(undefined, ...)` uses it.
// Handlers that receive an explicit locale from the renderer pass it through.

import commonAr from '../src/i18n/locales/ar/common.json'
import dialogsAr from '../src/i18n/locales/ar/dialogs.json'
import commonEn from '../src/i18n/locales/en/common.json'
import dialogsEn from '../src/i18n/locales/en/dialogs.json'
import commonEs from '../src/i18n/locales/es/common.json'
import dialogsEs from '../src/i18n/locales/es/dialogs.json'
import commonFr from '../src/i18n/locales/fr/common.json'
import dialogsFr from '../src/i18n/locales/fr/dialogs.json'
import commonIt from '../src/i18n/locales/it/common.json'
import dialogsIt from '../src/i18n/locales/it/dialogs.json'
import commonJa from '../src/i18n/locales/ja-JP/common.json'
import dialogsJa from '../src/i18n/locales/ja-JP/dialogs.json'
import commonKo from '../src/i18n/locales/ko-KR/common.json'
import dialogsKo from '../src/i18n/locales/ko-KR/dialogs.json'
import commonPtBr from '../src/i18n/locales/pt-BR/common.json'
import dialogsPtBr from '../src/i18n/locales/pt-BR/dialogs.json'
import commonRu from '../src/i18n/locales/ru/common.json'
import dialogsRu from '../src/i18n/locales/ru/dialogs.json'
import commonTr from '../src/i18n/locales/tr/common.json'
import dialogsTr from '../src/i18n/locales/tr/dialogs.json'
import commonVi from '../src/i18n/locales/vi/common.json'
import dialogsVi from '../src/i18n/locales/vi/dialogs.json'
import commonZh from '../src/i18n/locales/zh-CN/common.json'
import dialogsZh from '../src/i18n/locales/zh-CN/dialogs.json'
import commonZhTw from '../src/i18n/locales/zh-TW/common.json'
import dialogsZhTw from '../src/i18n/locales/zh-TW/dialogs.json'

export type MainLocale =
  | 'en'
  | 'ar'
  | 'es'
  | 'fr'
  | 'it'
  | 'ja-JP'
  | 'ko-KR'
  | 'pt-BR'
  | 'ru'
  | 'tr'
  | 'vi'
  | 'zh-CN'
  | 'zh-TW'
type Namespace = 'common' | 'dialogs'
type MessageMap = Record<string, unknown>

const messages: Record<MainLocale, Record<Namespace, MessageMap>> = {
  en: { common: commonEn, dialogs: dialogsEn },
  ar: { common: commonAr, dialogs: dialogsAr },
  es: { common: commonEs, dialogs: dialogsEs },
  fr: { common: commonFr, dialogs: dialogsFr },
  it: { common: commonIt, dialogs: dialogsIt },
  'ja-JP': { common: commonJa, dialogs: dialogsJa },
  'ko-KR': { common: commonKo, dialogs: dialogsKo },
  'pt-BR': { common: commonPtBr, dialogs: dialogsPtBr },
  ru: { common: commonRu, dialogs: dialogsRu },
  tr: { common: commonTr, dialogs: dialogsTr },
  vi: { common: commonVi, dialogs: dialogsVi },
  'zh-CN': { common: commonZh, dialogs: dialogsZh },
  'zh-TW': { common: commonZhTw, dialogs: dialogsZhTw },
}

const MAIN_LOCALES = Object.keys(messages) as MainLocale[]

let currentLocale: MainLocale = 'en'

function isMainLocale(value: string): value is MainLocale {
  return (MAIN_LOCALES as string[]).includes(value)
}

/**
 * Map a language tag to a bundled locale: exact, case-insensitive, `zh*` ->
 * zh-CN, base language (`fr-CA` -> `fr`), else "en". Mirrors the renderer's
 * `normalizeLocale` so both processes agree on what a tag means.
 */
export function resolveMainLocale(input?: string | null): MainLocale {
  const raw = (input ?? '').trim()
  if (!raw) return currentLocale
  if (isMainLocale(raw)) return raw
  const lower = raw.toLowerCase()
  const exact = MAIN_LOCALES.find((locale) => locale.toLowerCase() === lower)
  if (exact) return exact
  const base = lower.split(/[-_]/)[0]
  if (base === 'zh') return 'zh-CN'
  const baseMatch = MAIN_LOCALES.find((locale) => locale.toLowerCase().split('-')[0] === base)
  return baseMatch ?? 'en'
}

export function setMainLocale(locale: string): void {
  currentLocale = resolveMainLocale(locale)
}

export function getMainLocale(): MainLocale {
  return currentLocale
}

function getMessageValue(obj: unknown, dotPath: string): string | undefined {
  if (obj == null || typeof obj !== 'object') return undefined
  const record = obj as Record<string, unknown>
  const direct = record[dotPath]
  if (typeof direct === 'string') return direct
  const dotIndex = dotPath.indexOf('.')
  if (dotIndex === -1) return undefined
  return getMessageValue(record[dotPath.slice(0, dotIndex)], dotPath.slice(dotIndex + 1))
}

function interpolate(str: string, vars?: Record<string, string | number>): string {
  if (!vars) return str
  return str.replace(/\{\{(\w+)\}\}/g, (_, key: string) => String(vars[key] ?? `{{${key}}}`))
}

/**
 * Translate a qualified `namespace.key` (namespaces: common, dialogs).
 * `locale` undefined/empty means "the locale the renderer last announced".
 * Falls back to en, then to the key itself.
 */
export function mainT(
  locale: string | null | undefined,
  qualifiedKey: string,
  vars?: Record<string, string | number>,
): string {
  const dotIndex = qualifiedKey.indexOf('.')
  if (dotIndex === -1) return qualifiedKey
  const namespace = qualifiedKey.slice(0, dotIndex) as Namespace
  const key = qualifiedKey.slice(dotIndex + 1)
  const resolved = resolveMainLocale(locale)
  const value =
    getMessageValue(messages[resolved]?.[namespace], key) ??
    getMessageValue(messages.en?.[namespace], key)

  if (value == null) return qualifiedKey
  return interpolate(value, vars)
}
