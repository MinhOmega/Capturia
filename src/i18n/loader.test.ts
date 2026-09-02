import { describe, expect, it } from 'vitest'
import { detectSystemLocale, normalizeLocale } from '@/contexts/I18nContext'
import { COMPLETE_LOCALES, DEFAULT_LOCALE, type I18nNamespace, SUPPORTED_LOCALES } from './config'
import {
  getAvailableLocales,
  getLocaleName,
  getLocaleShort,
  getLocaleValidationErrors,
  getMessageValue,
  interpolate,
  translate,
} from './loader'

describe('i18n loader', () => {
  it('bundles every supported locale with all namespaces, en first', () => {
    const available = getAvailableLocales()
    expect(available[0]).toBe(DEFAULT_LOCALE)
    expect([...available].sort()).toEqual([...SUPPORTED_LOCALES].sort())
    expect(getLocaleValidationErrors()).toEqual([])
  })

  it('translates in the requested locale', () => {
    expect(translate('en', 'common', 'cancel')).toBe('Cancel')
    expect(translate('zh-CN', 'common', 'cancel')).toBe('取消')
    expect(translate('vi', 'common', 'cancel')).toBe('Hủy')
  })

  it('falls back to en for a key missing in a partial locale', () => {
    // Capturia-only key: no upstream twin, so fr has no value.
    expect(translate('fr', 'launch', 'captureProfile.balanced')).toBe('Smooth 30')
    // but a translated key still resolves in fr
    expect(translate('fr', 'timeline', 'addZoom')).toBe('Ajouter un zoom (Z)')
  })

  it('falls back to en for an unknown locale', () => {
    expect(translate('xx-YY', 'common', 'close')).toBe('Close')
  })

  it('returns the qualified key marker for an unknown key or namespace', () => {
    expect(translate('en', 'common', 'does.not.exist')).toBe('common.does.not.exist')
    expect(translate('vi', 'common', 'does.not.exist')).toBe('common.does.not.exist')
    expect(translate('en', 'nope' as I18nNamespace, 'x')).toBe('nope.x')
  })

  it('returns the marker for a branch key instead of rendering an object (8e0a6268)', () => {
    expect(translate('en', 'launch', 'captureProfile')).toBe('launch.captureProfile')
    expect(translate('en', 'common', 'app')).toBe('common.app')
  })

  it('resolves keys that are both a leaf and a branch', () => {
    expect(translate('en', 'launch', 'shape')).toBe('Shape')
    expect(translate('en', 'launch', 'shape.rounded')).toBe('Rounded')
    expect(translate('en', 'settings', 'font.failed')).toBe('Failed to add font')
    expect(translate('en', 'settings', 'font.failed.timeout')).toMatch(/^Font took too long/)
  })

  it('interpolates {{vars}} and leaves unknown placeholders in place', () => {
    expect(translate('en', 'common', 'error.reference', { id: 'abc' })).toBe('Reference: abc')
    expect(translate('en', 'common', 'error.reference')).toBe('Reference: {{id}}')
    expect(interpolate('{{a}}-{{b}}', { a: 1, b: 'x' })).toBe('1-x')
  })

  it('getMessageValue walks nested and dotted shapes', () => {
    const obj = { a: { b: 'nested' }, 'c.d': 'dotted', e: { f: {} } }
    expect(getMessageValue(obj, 'a.b')).toBe('nested')
    expect(getMessageValue(obj, 'c.d')).toBe('dotted')
    expect(getMessageValue(obj, 'e.f')).toBeUndefined()
    expect(getMessageValue(obj, 'missing')).toBeUndefined()
    expect(getMessageValue(null, 'a')).toBeUndefined()
  })

  it('exposes native locale names for the picker', () => {
    expect(getLocaleName('en')).toBe('English')
    expect(getLocaleName('zh-CN')).toBe('简体中文')
    expect(getLocaleName('vi')).toBe('Tiếng Việt')
    expect(getLocaleShort('vi')).toBe('VI')
    for (const locale of getAvailableLocales()) {
      expect(getLocaleName(locale), locale).not.toBe(locale)
    }
  })

  it('complete locales carry every en key', () => {
    for (const locale of COMPLETE_LOCALES) {
      expect(getAvailableLocales()).toContain(locale)
    }
  })
})

describe('normalizeLocale', () => {
  it('keeps available tags and maps variants to the closest locale', () => {
    expect(normalizeLocale('en')).toBe('en')
    expect(normalizeLocale('zh-CN')).toBe('zh-CN')
    expect(normalizeLocale('zh-cn')).toBe('zh-CN')
    expect(normalizeLocale('zh-Hans-CN')).toBe('zh-CN')
    expect(normalizeLocale('zh')).toBe('zh-CN')
    expect(normalizeLocale('vi-VN')).toBe('vi')
    expect(normalizeLocale('fr-CA')).toBe('fr')
    expect(normalizeLocale('ja')).toBe('ja-JP')
  })

  it('maps Traditional Chinese tags to zh-TW when it is a candidate', () => {
    expect(normalizeLocale('zh-TW')).toBe('zh-TW')
    expect(normalizeLocale('zh-HK')).toBe('zh-TW')
    expect(normalizeLocale('zh-Hant-TW')).toBe('zh-TW')
    expect(normalizeLocale('zh-Hans-CN')).toBe('zh-CN')
  })

  it('falls back to the default locale', () => {
    expect(normalizeLocale('xx')).toBe(DEFAULT_LOCALE)
    expect(normalizeLocale('')).toBe(DEFAULT_LOCALE)
    expect(normalizeLocale(null)).toBe(DEFAULT_LOCALE)
    expect(normalizeLocale(undefined)).toBe(DEFAULT_LOCALE)
  })
})

describe('detectSystemLocale (first launch, no stored preference)', () => {
  it('only lands on complete locales', () => {
    expect(COMPLETE_LOCALES).toEqual(['en', 'zh-CN', 'vi'])
    expect(detectSystemLocale('en-GB')).toBe('en')
    expect(detectSystemLocale('vi-VN')).toBe('vi')
    expect(detectSystemLocale('zh-CN')).toBe('zh-CN')
    expect(detectSystemLocale('zh-Hans-CN')).toBe('zh-CN')
  })

  it('sends partial-locale systems to en even though the picker offers them', () => {
    expect(getAvailableLocales()).toContain('fr')
    expect(detectSystemLocale('fr')).toBe('en')
    expect(detectSystemLocale('fr-FR')).toBe('en')
    expect(detectSystemLocale('ja-JP')).toBe('en')
    expect(detectSystemLocale('pt-BR')).toBe('en')
    expect(normalizeLocale('fr-FR')).toBe('fr')
  })

  it('maps Traditional Chinese to zh-CN while zh-TW is partial', () => {
    expect(getAvailableLocales()).toContain('zh-TW')
    expect(detectSystemLocale('zh-TW')).toBe('zh-CN')
    expect(detectSystemLocale('zh-HK')).toBe('zh-CN')
    expect(detectSystemLocale('zh-Hant')).toBe('zh-CN')
    // manual selection still reaches zh-TW
    expect(normalizeLocale('zh-TW')).toBe('zh-TW')
  })

  it('falls back to the default locale', () => {
    expect(detectSystemLocale('xx')).toBe(DEFAULT_LOCALE)
    expect(detectSystemLocale(null)).toBe(DEFAULT_LOCALE)
  })
})
