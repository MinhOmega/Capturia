/**
 * Matching a device the user picked in the renderer against one a native
 * capture API can open.
 *
 * The two sides name the same hardware differently: Chromium reports the driver
 * name and often appends the USB vendor:product pair ("Logitech StreamCam
 * (046d:0893)"), while AVFoundation reports `localizedName`. The match therefore
 * cannot be plain equality. It can be *decisive*: every real pairing observed is
 * one name equal to the other, or one name containing the other as whole words,
 * and nothing weaker is trusted.
 *
 * Substring containment is deliberately not a tier. "Logi Capture" and
 * "Logitech StreamCam" are two different devices that share no word, yet "logi"
 * is inside "logitech"; "Micro Studio" is inside "Microphone (Logitech PRO X)".
 * Both picked a device nobody asked for, and a wrong pick is worse than "not
 * found" because the caller cannot fall back to its default.
 *
 * `sck-recorder.swift` (`DeviceNameMatching`) carries the same rules in Swift;
 * keep the two in step. Lives under `electron/recording/` because the IPC
 * handler modules call `app.getPath()` at import time and cannot be loaded from
 * a test.
 */

export const DEVICE_NAME_MATCH_EXACT = 1000
/** Equal once Chromium's "(vid:pid)" suffix is dropped from the requested name. */
export const DEVICE_NAME_MATCH_EXACT_WITHOUT_USB_IDS = 950
/** One name is the other plus decoration, on word boundaries. */
export const DEVICE_NAME_MATCH_WORDS = 900
/** The requested name only appears in the device's stable identifier. */
export const DEVICE_NAME_MATCH_IDENTIFIER = 800
export const DEVICE_NAME_NO_MATCH = 0

const USB_ID_SUFFIX = /\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i

/**
 * Lowercase, letters/marks/digits only, single-spaced: the shape both sides
 * compare in. Unicode-aware on purpose, so non-Latin names keep their letters
 * (a Japanese "カメラ A" must not collapse to "a" and match every other "… A").
 */
export function normalizeDeviceName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .trim()
}

/** Chromium's "Name (046d:0893)" without the USB pair; unchanged when absent. */
export function stripUsbIdSuffix(value: string): string {
  return value.replace(USB_ID_SUFFIX, '')
}

/**
 * Does `needle` appear in `haystack` as whole words? Both are normalized, so a
 * boundary is the start of the string, its end, or a space.
 */
export function containsAsWords(haystack: string, needle: string): boolean {
  if (!haystack || !needle) return false
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    const startsOnBoundary = at === 0 || haystack[at - 1] === ' '
    const after = at + needle.length
    const endsOnBoundary = after === haystack.length || haystack[after] === ' '
    if (startsOnBoundary && endsOnBoundary) return true
  }
  return false
}

/**
 * How well a candidate answers a requested name, or 0 for "not this one" which
 * callers must treat as a real answer rather than a weak match.
 *
 * @param candidateName The device's own name as the platform reports it.
 * @param candidateId Its stable identifier, which sometimes carries the model
 *   name when the friendly name does not.
 * @param requestedName What the user picked, as the browser labelled it.
 */
export function scoreDeviceNameMatch(
  candidateName: string,
  candidateId: string,
  requestedName?: string | null,
): number {
  const requestedRaw = requestedName ?? ''
  const requested = normalizeDeviceName(requestedRaw)
  if (!requested) return DEVICE_NAME_NO_MATCH

  const candidate = normalizeDeviceName(candidateName)
  if (candidate === requested) return DEVICE_NAME_MATCH_EXACT

  const requestedWithoutUsbIds = normalizeDeviceName(stripUsbIdSuffix(requestedRaw))
  if (
    requestedWithoutUsbIds &&
    requestedWithoutUsbIds !== requested &&
    candidate === requestedWithoutUsbIds
  ) {
    return DEVICE_NAME_MATCH_EXACT_WITHOUT_USB_IDS
  }

  if (containsAsWords(candidate, requested) || containsAsWords(requested, candidate)) {
    return DEVICE_NAME_MATCH_WORDS
  }

  const id = normalizeDeviceName(candidateId)
  if (containsAsWords(id, requested) || containsAsWords(requested, id)) {
    return DEVICE_NAME_MATCH_IDENTIFIER
  }

  return DEVICE_NAME_NO_MATCH
}

export type NamedDevice = { name: string; id: string }

/**
 * The best-scoring candidate for `requestedName`, or `undefined` when none
 * scores above 0. Ties keep the earlier candidate (platform order).
 */
export function pickDeviceByName<T extends NamedDevice>(
  candidates: readonly T[],
  requestedName?: string | null,
): T | undefined {
  let best: T | undefined
  let bestScore = DEVICE_NAME_NO_MATCH
  for (const candidate of candidates) {
    const score = scoreDeviceNameMatch(candidate.name, candidate.id, requestedName)
    if (score > bestScore) {
      best = candidate
      bestScore = score
    }
  }
  return best
}
