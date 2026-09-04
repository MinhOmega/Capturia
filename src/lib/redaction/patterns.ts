/**
 * Sensitive-string patterns for on-screen redaction.
 *
 * Capturia's blur regions (`BlurData`, `src/lib/blurEffects.ts`) are placed by
 * hand today. The redaction feature wants to propose them automatically from
 * text read off the recording, so this module answers one narrow question:
 * *given a run of text, which substrings look like something the user would not
 * want on a shared video, and where are they?*
 *
 * It is deliberately independent of how the text was obtained. The OCR spike
 * (`ocrSpike.browser.test.ts`) feeds it words read from video frames, but the
 * same function is what a future "scan the notes panel" or "scan the clipboard"
 * path would call, and it is a plain string API so it unit-tests in the node
 * lane without a canvas.
 *
 * Two ideas run through the design:
 *
 * 1. **Anchors beat payloads.** OCR mangles random characters but keeps
 *    structure: `@`, `.com`, `sk-`, `AKIA`, `eyJ`, digit grouping. Every
 *    detector keys off an anchor the reader is likely to get right, and treats
 *    the high-entropy body as "some characters", so a misread key is still
 *    flagged. Blurring does not need the value, only the box.
 * 2. **Specific first, then generic, and never twice.** Detectors run in
 *    priority order over a shared "already claimed" map. A JWT is claimed as a
 *    JWT, so its base64 segments never resurface as generic tokens, and a
 *    `data:` URI payload is masked before anything generic runs.
 *
 * Generic high-entropy detectors carry `confidence: 'medium'`; everything with
 * a self-identifying prefix or a secret-ish label is `'high'`. A UI can offer
 * "blur everything" versus "blur only what is certainly a credential" from that
 * one field.
 */

/** What a match was recognised as. Stable enough to key UI copy off. */
export type SecretKind =
  | 'email'
  | 'phone'
  | 'jwt'
  | 'aws-access-key'
  | 'github-token'
  | 'npm-token'
  | 'openai-key'
  | 'stripe-key'
  | 'slack-token'
  | 'google-api-key'
  | 'private-key-block'
  | 'labelled-secret'
  | 'hex-token'
  | 'base64-token'

/**
 * `'high'` = self-identifying (a known prefix, or a value behind a secret-ish
 * label). `'medium'` = "this is a long random-looking string", which is right
 * far more often than not but is the only class that produces awkward false
 * positives.
 */
export type SecretConfidence = 'high' | 'medium'

export interface SecretMatch {
  readonly kind: SecretKind
  readonly confidence: SecretConfidence
  /** The matched substring, exactly as it appeared in the input. */
  readonly value: string
  /** Index of the first character of `value` in the input string. */
  readonly start: number
  /** Index one past the last character of `value` in the input string. */
  readonly end: number
}

export interface FindSecretsOptions {
  /**
   * Restrict the scan to these kinds. Omitted means every kind. Detectors that
   * are filtered out also stop claiming text, so a narrowed scan can surface a
   * generic token where a full scan would have reported a JWT.
   */
  readonly kinds?: readonly SecretKind[]
  /**
   * Drop `'medium'` results. Useful when a false blur is worse than a missed
   * one (an automated export, say) rather than when a human reviews the list.
   */
  readonly minConfidence?: SecretConfidence
  /**
   * Shortest run the generic hex/base64 detectors will consider. The default
   * of 32 is tuned for clean text; OCR output splits tokens, so the spike
   * lowers it. Below ~20 the false-positive rate stops being worth it.
   */
  readonly minTokenLength?: number
}

/** Character-run lengths that are almost always a digest, not a credential. */
const DIGEST_HEX_LENGTHS = new Set([32, 40, 56, 64, 96, 128])

const DEFAULT_MIN_TOKEN_LENGTH = 32

/** The generic detectors' own regexes stop here, so `minTokenLength` cannot go lower. */
const MIN_TOKEN_LENGTH_FLOOR = 16

/** Shannon entropy in bits per character. Random base64 lands near 5.0. */
export function shannonEntropy(value: string): number {
  if (value.length === 0) return 0
  const counts = new Map<string, number>()
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1)
  let entropy = 0
  for (const count of counts.values()) {
    const p = count / value.length
    entropy -= p * Math.log2(p)
  }
  return entropy
}

function hasLower(value: string): boolean {
  return /[a-z]/.test(value)
}

function hasUpper(value: string): boolean {
  return /[A-Z]/.test(value)
}

function hasDigit(value: string): boolean {
  return /[0-9]/.test(value)
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HEX_ONLY_RE = /^[0-9a-f]+$/i

/**
 * Subresource-integrity and checksum notation: the base64 after `sha256-` is a
 * digest of a public file, not a credential.
 */
const DIGEST_PREFIX_RE = /(?:sha1|sha256|sha384|sha512|md5)-$/i

/** `data:image/png;base64,...` — a picture, not a token. Masked before generics run. */
const DATA_URI_RE =
  /data:[a-z0-9.+-]+\/[a-z0-9.+-]+(?:;[a-z0-9-]+=[^;,]*)*;base64,[A-Za-z0-9+/=]+/gi

/**
 * Values that appear where a secret would but are not one: documentation
 * placeholders, masked UI output, and code that *reads* a secret from
 * somewhere else.
 */
const PLACEHOLDER_VALUE_RE =
  /^(?:your|my|our|the|xxx|yyy|zzz|abc123$|placeholder|example|changeme|change_me|redacted|hidden|masked|none$|null$|nil$|undefined$|true$|false$|todo|tbd|insert|replace|dummy|sample|test_?value|secret$|password$|token$)/i

/** Anything containing these is an expression, a template or a shell variable. */
const NON_LITERAL_VALUE_RE = /[<>(){}[\]$&|\\^%!?*]/

/** `process.env.X`, `os.environ[...]`, `System.getenv(...)` and friends. */
const CODE_REFERENCE_RE = /^(?:process|os|import|System|Deno|Bun|config|settings|self|this)\./i

interface DetectorContext {
  readonly text: string
  readonly minTokenLength: number
}

interface Detector {
  readonly kind: SecretKind
  readonly confidence: SecretConfidence
  readonly pattern: RegExp
  /**
   * Which capture group is the sensitive span. `0` (the default) means the
   * whole match; a labelled secret reports only the value so the blur box does
   * not cover the label that makes the screenshot readable.
   */
  readonly group?: number
  readonly accept?: (value: string, ctx: DetectorContext, matchStart: number) => boolean
}

/* ------------------------------------------------------------------ phones */

const PHONE_RE = new RegExp(
  [
    '(?<![\\p{L}\\p{N}_+.-])(?:',
    // +1 (415) 555-0132 / +44 20 7946 0958 / +84 912 345 678
    '\\+\\d{1,3}[ .-]?\\(?\\d{1,4}\\)?(?:[ .-]?\\d{2,5}){1,4}',
    // (415) 555-0132
    '|\\(\\d{3}\\)[ .-]?\\d{3}[ .-]\\d{4}',
    // 415-555-0132 / 415.555.0132 / 415 555 0132
    '|\\d{3}[ .-]\\d{3}[ .-]\\d{4}',
    // 020 7946 0958
    '|\\d{2,5} \\d{3,4} \\d{3,4}',
    ')(?![\\p{L}\\p{N}_-])',
  ].join(''),
  'gu',
)

/** `415.555.0132` is a phone number; `10.0.19045.3803` and `192.168.1.100` are not. */
const DOTTED_PHONE_RE = /^(?:\+\d{1,3}[ -]?)?\d{3}\.\d{3}\.\d{4}$/
const NANP_RE = /^\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}$/
const SPACE_GROUPED_RE = /^\d{2,5} \d{3,4} \d{3,4}$/

function acceptPhone(value: string): boolean {
  const digits = value.replace(/\D/g, '')
  if (value.startsWith('+')) {
    if (digits.length < 8 || digits.length > 15) return false
    // A dotted international number is only a phone number in the one shape
    // that cannot also be a version string or an address.
    if (value.includes('.') && !DOTTED_PHONE_RE.test(value)) return false
    return true
  }
  // Without a country code, only the grouped local shapes are safe to claim;
  // a bare run of digits is far more often an id, an amount or a build number.
  if (digits.length < 10 || digits.length > 11) return false
  return NANP_RE.test(value) || SPACE_GROUPED_RE.test(value)
}

/* -------------------------------------------------------------- api tokens */

const OPENAI_KNOWN_PREFIX_RE = /^(?:proj|ant|or|svcacct|admin|live|test)-/

function acceptOpenAiKey(value: string): boolean {
  const body = value.slice(3)
  if (OPENAI_KNOWN_PREFIX_RE.test(body)) return true
  // No recognised namespace: only claim it when the tail actually looks
  // random, so `sk-learn-classifier-notes` stays plain text.
  return hasDigit(body) && hasUpper(body) && hasLower(body)
}

/* ---------------------------------------------------------------- labelled */

const LABELLED_SECRET_RE = new RegExp(
  [
    // `PGPASSWORD`, `AWS_SECRET_ACCESS_KEY` and `VITE_API_KEY` are all the same
    // label wearing a namespace, so an alphanumeric/underscore prefix is
    // allowed in front of the word that actually carries the meaning.
    '(?<![A-Za-z0-9_-])[A-Za-z0-9_]{0,24}',
    // Longest alternatives first: ordered alternation would otherwise let
    // `secret` win against `SECRET_ACCESS_KEY` and lose the `=` that follows.
    '(?:password|passwd|pwd|secret[_-]?access[_-]?key|secret[_-]?key|',
    'client[_-]?secret|secret|api[_-]?key|apikey|access[_-]?token|',
    'auth[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?token|',
    'private[_-]?key|authorization|token)\\b',
    '\\s*(?:[:=]|=>)\\s*["\'`]?([^\\s"\'`,;]{8,200}?)["\'`]?(?=[\\s,;]|$)',
  ].join(''),
  'gi',
)

/** `Authorization: Bearer <token>`, `Basic <base64>`, and bare scheme-prefixed log lines. */
const BEARER_SECRET_RE = /\b(?:Bearer|Basic|Token)\s+([^\s"'`,;]{16,200})/g

function acceptLabelledValue(value: string): boolean {
  if (!/[A-Za-z0-9]/.test(value)) return false
  if (/^(.)\1*$/.test(value)) return false
  if (PLACEHOLDER_VALUE_RE.test(value)) return false
  if (NON_LITERAL_VALUE_RE.test(value)) return false
  if (CODE_REFERENCE_RE.test(value)) return false
  return true
}

/* ----------------------------------------------------------------- generic */

function acceptHexToken(value: string, ctx: DetectorContext): boolean {
  if (value.length < ctx.minTokenLength) return false
  // 32/40/64 hex is an md5/sha1/sha256 digest — a git SHA, an etag, a lockfile
  // integrity field. Public by nature, and far more common on a developer's
  // screen than a hex credential of the same length.
  if (DIGEST_HEX_LENGTHS.has(value.length)) return false
  if (/^\d+$/.test(value)) return false
  if (shannonEntropy(value) < 2.5) return false
  return true
}

function acceptBase64Token(value: string, ctx: DetectorContext, matchStart: number): boolean {
  if (value.length < ctx.minTokenLength) return false
  if (UUID_RE.test(value)) return false
  // Pure hex is the hex detector's business, including its digest exemption.
  if (HEX_ONLY_RE.test(value)) return false
  // A credential mixes the alphabet; prose, kebab-case flags, SCREAMING_CONSTS
  // and file paths do not.
  if (!(hasLower(value) && hasUpper(value) && hasDigit(value))) return false
  if (shannonEntropy(value) < 3.0) return false
  if (DIGEST_PREFIX_RE.test(ctx.text.slice(Math.max(0, matchStart - 8), matchStart))) return false
  return true
}

/* --------------------------------------------------------------- detectors */

/**
 * Priority order. Earlier detectors claim their characters, so a later, more
 * generic one cannot re-report the same span under a vaguer name.
 */
const DETECTORS: readonly Detector[] = [
  {
    kind: 'private-key-block',
    confidence: 'high',
    pattern: /-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/g,
  },
  {
    kind: 'jwt',
    confidence: 'high',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,})?/g,
  },
  {
    kind: 'github-token',
    confidence: 'high',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{40,255})\b/g,
  },
  { kind: 'npm-token', confidence: 'high', pattern: /\bnpm_[A-Za-z0-9]{30,60}\b/g },
  {
    kind: 'aws-access-key',
    confidence: 'high',
    pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g,
  },
  {
    kind: 'stripe-key',
    confidence: 'high',
    pattern: /\b[sprk]k_(?:live|test)_[A-Za-z0-9]{10,}\b/g,
  },
  {
    kind: 'openai-key',
    confidence: 'high',
    pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g,
    accept: acceptOpenAiKey,
  },
  { kind: 'slack-token', confidence: 'high', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'google-api-key', confidence: 'high', pattern: /\bAIza[0-9A-Za-z_-]{20,}\b/g },
  {
    kind: 'labelled-secret',
    confidence: 'high',
    pattern: LABELLED_SECRET_RE,
    group: 1,
    accept: acceptLabelledValue,
  },
  {
    kind: 'labelled-secret',
    confidence: 'high',
    pattern: BEARER_SECRET_RE,
    group: 1,
    accept: acceptLabelledValue,
  },
  {
    kind: 'email',
    confidence: 'high',
    pattern:
      /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}\b/g,
  },
  { kind: 'phone', confidence: 'high', pattern: PHONE_RE, accept: (value) => acceptPhone(value) },
  {
    kind: 'hex-token',
    confidence: 'medium',
    pattern: /\b[0-9a-fA-F]{16,}\b/g,
    accept: acceptHexToken,
  },
  {
    kind: 'base64-token',
    confidence: 'medium',
    pattern: /(?<![A-Za-z0-9+_=-])[A-Za-z0-9+_-]{16,}={0,2}(?![A-Za-z0-9+_=-])/g,
    accept: acceptBase64Token,
  },
]

const ALL_KINDS: readonly SecretKind[] = DETECTORS.map((detector) => detector.kind)

/** Every kind this module can report, in detector priority order, deduplicated. */
export const SECRET_KINDS: readonly SecretKind[] = Array.from(new Set(ALL_KINDS))

/**
 * Finds every sensitive-looking substring in `text`, in order of appearance and
 * without overlaps.
 *
 * `start`/`end` are indices into the string that was passed in, so a caller
 * holding per-character bounding boxes (OCR word boxes, a text layout) can map
 * a match straight onto a rectangle in source coordinates.
 */
export function findSecrets(text: string, options: FindSecretsOptions = {}): SecretMatch[] {
  if (!text) return []

  const minTokenLength = Math.max(
    MIN_TOKEN_LENGTH_FLOOR,
    options.minTokenLength ?? DEFAULT_MIN_TOKEN_LENGTH,
  )
  const wanted = options.kinds ? new Set(options.kinds) : null
  const ctx: DetectorContext = { text, minTokenLength }

  // One flag per character: set once a detector has claimed it. Cheaper and
  // clearer than interval arithmetic, and the strings involved are screenfuls
  // of text, not documents.
  const claimed = new Uint8Array(text.length)

  const claim = (start: number, end: number): void => {
    claimed.fill(1, start, end)
  }
  const isFree = (start: number, end: number): boolean => {
    for (let i = start; i < end; i += 1) if (claimed[i]) return false
    return true
  }

  // Mask embedded images before anything else: their base64 payload is long,
  // mixed-case and high entropy, i.e. exactly what a generic detector wants.
  DATA_URI_RE.lastIndex = 0
  for (let m = DATA_URI_RE.exec(text); m !== null; m = DATA_URI_RE.exec(text)) {
    claim(m.index, m.index + m[0].length)
  }

  const matches: SecretMatch[] = []

  for (const detector of DETECTORS) {
    if (wanted && !wanted.has(detector.kind)) continue
    const { pattern } = detector
    pattern.lastIndex = 0
    for (let m = pattern.exec(text); m !== null; m = pattern.exec(text)) {
      // Zero-width matches would spin the loop forever.
      if (m[0].length === 0) {
        pattern.lastIndex += 1
        continue
      }
      const groupIndex = detector.group ?? 0
      const value = m[groupIndex]
      if (value === undefined || value.length === 0) continue
      const start = groupIndex === 0 ? m.index : m.index + m[0].indexOf(value)
      const end = start + value.length
      if (!isFree(start, end)) continue
      if (detector.accept && !detector.accept(value, ctx, start)) continue
      claim(start, end)
      matches.push({ kind: detector.kind, confidence: detector.confidence, value, start, end })
    }
  }

  const filtered =
    options.minConfidence === 'high' ? matches.filter((m) => m.confidence === 'high') : matches

  return filtered.sort((a, b) => a.start - b.start)
}

/** `true` when `text` contains anything this module would redact. */
export function hasSecret(text: string, options: FindSecretsOptions = {}): boolean {
  return findSecrets(text, options).length > 0
}

/**
 * Replaces every match with `mask` repeated to the match's length, keeping the
 * surrounding text and the string length intact. Used by tests and by log
 * scrubbing; the video path blurs pixels instead.
 */
export function maskSecrets(text: string, options: FindSecretsOptions = {}, mask = '•'): string {
  const matches = findSecrets(text, options)
  if (matches.length === 0) return text
  let out = ''
  let cursor = 0
  for (const match of matches) {
    out += text.slice(cursor, match.start) + mask.repeat(match.end - match.start)
    cursor = match.end
  }
  return out + text.slice(cursor)
}
