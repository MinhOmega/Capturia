#!/usr/bin/env node
/**
 * Translation health check.
 *
 * 1. Key parity against `en` for every locale folder and namespace.
 *    - Complete locales (COMPLETE_LOCALES, parsed from src/i18n/config.ts so
 *      the two lists cannot drift) fail the check on any missing or extra key.
 *    - Every other locale is *partial* on purpose: only the keys that have
 *      actually been translated exist, the rest fall back to en at runtime. For those,
 *      missing keys are reported as warnings; extra keys (not in en) are still
 *      errors because they can never be reached.
 * 2. Placeholder parity: every `{{var}}` in en must appear in the translation.
 * 3. Call-site check: every `t("ns.key")` literal under `src/` (plus data keys
 *    such as `labelKey: "shortcuts.addZoom"`) must resolve to an en string.
 *    Test files are skipped. Template literals (`launch.permission.row${x}Title`)
 *    only need their static prefix to exist.
 *
 * Usage:
 *   node scripts/i18n-check.mjs              # strict for STRICT_LOCALES, warn for the rest
 *   node scripts/i18n-check.mjs --strict     # treat every locale as complete
 *   node scripts/i18n-check.mjs --strict=fr,es
 *   node scripts/i18n-check.mjs --quiet      # hide partial-locale warnings
 */
import fs from 'node:fs'
import path from 'node:path'

const LOCALES_DIR = path.resolve('src/i18n/locales')
const SRC_DIR = path.resolve('src')
const BASE_LOCALE = 'en'
const CONFIG_FILE = path.resolve('src/i18n/config.ts')

/** Locales with a complete translation: COMPLETE_LOCALES from src/i18n/config.ts (parsed, not duplicated). */
function readCompleteLocales() {
  const source = fs.readFileSync(CONFIG_FILE, 'utf-8')
  const match = source.match(/COMPLETE_LOCALES\s*=\s*\[([^\]]*)\]/)
  if (!match) throw new Error(`COMPLETE_LOCALES not found in ${CONFIG_FILE}`)
  return [...match[1].matchAll(/["']([^"']+)["']/g)].map((m) => m[1])
}
const STRICT_LOCALES = readCompleteLocales().filter((locale) => locale !== BASE_LOCALE)

const argv = process.argv.slice(2)
const quiet = argv.includes('--quiet')
const strictArg = argv.find((a) => a.startsWith('--strict'))

function getKeys(obj, prefix = '') {
  const keys = []
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      keys.push(...getKeys(value, fullKey))
    } else {
      keys.push(fullKey)
    }
  }
  return keys.sort()
}

function getValue(obj, dotPath) {
  if (obj == null || typeof obj !== 'object') return undefined
  if (typeof obj[dotPath] === 'string') return obj[dotPath]
  const i = dotPath.indexOf('.')
  if (i === -1) return undefined
  return getValue(obj[dotPath.slice(0, i)], dotPath.slice(i + 1))
}

const placeholders = (s) =>
  [...String(s).matchAll(/\{\{(\w+)\}\}/g)]
    .map((m) => m[1])
    .sort()
    .join()

let errors = 0
let warnings = 0
const fail = (msg) => {
  errors++
  console.error(`ERROR ${msg}`)
}
const warn = (msg) => {
  warnings++
  if (!quiet) console.warn(`warn  ${msg}`)
}

const baseDir = path.join(LOCALES_DIR, BASE_LOCALE)
const namespaces = fs
  .readdirSync(baseDir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.replace('.json', ''))
  .sort()

const compareLocales = fs
  .readdirSync(LOCALES_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((locale) => locale !== BASE_LOCALE)
  .sort((a, b) => a.localeCompare(b))

const strictLocales = new Set(
  strictArg === '--strict'
    ? compareLocales
    : strictArg
      ? strictArg.slice('--strict='.length).split(',')
      : STRICT_LOCALES,
)

const baseData = {}
for (const namespace of namespaces) {
  baseData[namespace] = JSON.parse(
    fs.readFileSync(path.join(baseDir, `${namespace}.json`), 'utf-8'),
  )
}

// 1 + 2: parity and placeholders
const missingPerLocale = {}
for (const locale of compareLocales) {
  const isStrict = strictLocales.has(locale)
  missingPerLocale[locale] = 0
  for (const namespace of namespaces) {
    const localePath = path.join(LOCALES_DIR, locale, `${namespace}.json`)
    if (!fs.existsSync(localePath)) {
      // The loader excludes a locale folder that lacks any namespace file.
      fail(`${locale}/${namespace}.json does not exist`)
      continue
    }
    const localeData = JSON.parse(fs.readFileSync(localePath, 'utf-8'))
    const baseKeys = getKeys(baseData[namespace])
    const localeKeys = getKeys(localeData)
    const localeKeySet = new Set(localeKeys)
    const baseKeySet = new Set(baseKeys)

    const missing = baseKeys.filter((k) => !localeKeySet.has(k))
    const extra = localeKeys.filter((k) => !baseKeySet.has(k))

    missingPerLocale[locale] += missing.length
    if (missing.length > 0 && isStrict) {
      fail(`MISSING in ${locale}/${namespace}.json:`)
      for (const key of missing) console.error(`  - ${key}`)
    }
    if (extra.length > 0) {
      fail(`EXTRA in ${locale}/${namespace}.json:`)
      for (const key of extra) console.error(`  + ${key}`)
    }
    for (const key of localeKeys) {
      if (!baseKeySet.has(key)) continue
      const baseValue = getValue(baseData[namespace], key)
      const localeValue = getValue(localeData, key)
      if (typeof localeValue !== 'string') {
        fail(`${locale}/${namespace}.json ${key} is not a string`)
        continue
      }
      if (placeholders(baseValue) !== placeholders(localeValue)) {
        fail(`placeholders differ for ${locale}/${namespace}.json ${key}: "${localeValue}"`)
      }
    }
  }
  if (!strictLocales.has(locale) && missingPerLocale[locale] > 0) {
    warn(`${locale}: ${missingPerLocale[locale]} keys fall back to ${BASE_LOCALE} (partial locale)`)
  }
}

// 3: call sites. Any string literal that looks like "<namespace>.<path>" must exist in en.
const namespaceSet = new Set(namespaces)
const literalRe = new RegExp(`(["'\`])((?:${namespaces.join('|')})\\.[A-Za-z0-9_.$]+)\\1`, 'g')
/** Non-key literals that happen to look like keys. */
const IGNORED_LITERALS = new Set([])
let callSites = 0
const unknownKeys = new Map()

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (full === path.join(SRC_DIR, 'i18n', 'locales')) continue
      walk(full)
      continue
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue
    // Tests may use deliberately unknown keys to exercise the fallback path.
    if (/\.test\.tsx?$/.test(entry.name) || full.includes(`${path.sep}__tests__${path.sep}`))
      continue
    const source = fs.readFileSync(full, 'utf-8')
    for (const match of source.matchAll(literalRe)) {
      const literal = match[2]
      if (IGNORED_LITERALS.has(literal)) continue
      // Template literals with `${...}` are dynamic: check that the static prefix resolves to a branch.
      const staticPart = literal.includes('$') ? literal.slice(0, literal.indexOf('$')) : literal
      const dot = staticPart.indexOf('.')
      const namespace = staticPart.slice(0, dot)
      const key = staticPart.slice(dot + 1)
      if (!namespaceSet.has(namespace)) continue
      callSites++
      const exists =
        literal === staticPart
          ? getValue(baseData[namespace], key) !== undefined
          : getKeys(baseData[namespace]).some((k) => k.startsWith(key))
      if (!exists) {
        const where = `${path.relative(process.cwd(), full)}:${source.slice(0, match.index).split('\n').length}`
        unknownKeys.set(literal, [...(unknownKeys.get(literal) ?? []), where])
      }
    }
  }
}
walk(SRC_DIR)
for (const [literal, locations] of unknownKeys) {
  fail(`unknown key "${literal}" used at ${locations.join(', ')}`)
}

const enTotal = namespaces.reduce((n, ns) => n + getKeys(baseData[ns]).length, 0)
if (errors > 0) {
  console.error(`\ni18n check FAILED - ${errors} error(s), ${warnings} warning(s).`)
  process.exit(1)
}
console.log(
  `i18n check PASSED - ${enTotal} en keys across ${namespaces.length} namespaces; ` +
    `${[...strictLocales].join(', ')} in parity; ` +
    `${compareLocales.filter((l) => !strictLocales.has(l)).length} partial locale(s) with ${warnings} warning(s); ` +
    `${callSites} key literals in src/ resolve.`,
)
