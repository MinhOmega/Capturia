import type { SubtitleCue } from '@/lib/analysis/types'
import { normalizeSubtitleText } from '@/lib/analysis/subtitleEngine'

/**
 * Pure edits on a materialised cue list: retitle, split, merge, retime, delete.
 *
 * Capturia stores cues as data rather than deriving them from the transcript on
 * every render, so they can simply be rewritten. Every operation here returns a
 * new array when it changed something and the *same array reference* when it did
 * not, which is what the editor's undo stack compares on — one edit, one entry,
 * and a rejected edit costs nothing.
 *
 * Times are source time throughout (the same space the cues are stored in).
 */

/**
 * Scripts written without spaces, where a "word" for editing purposes is one
 * character. A latin word with no spaces around it stays one word — unlike the
 * line wrapper, which may break it mid-word to fit a line.
 */
const SCRIPTLESS_WORD_BREAK =
  /[\u3000-\u303F\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uAC00-\uD7AF]/

/**
 * A cue's text as the units split / merge / highlight operate on: whitespace-
 * separated words, or single characters for a space-free CJK cue.
 */
export function splitCueWords(inputText: string): string[] {
  const text = String(inputText ?? '')
    .trim()
    .replace(/\s+/g, ' ')
  if (!text) return []
  if (/\s/.test(text)) return text.split(' ')
  if (SCRIPTLESS_WORD_BREAK.test(text)) return Array.from(text)
  return [text]
}

/** Shortest cue the editor will produce; below this a cue is unreadable and unclickable. */
export const MIN_CUE_DURATION_MS = 50

/** Gap kept between two cues when retiming pushes one into its neighbour. */
export const MIN_CUE_GAP_MS = 0

function sortCues(cues: readonly SubtitleCue[]): SubtitleCue[] {
  return [...cues].sort((left, right) => left.startMs - right.startMs)
}

function indexOfCue(cues: readonly SubtitleCue[], cueId: string): number {
  return cues.findIndex((cue) => cue.id === cueId)
}

/** `subtitle-<n>` with an `n` no existing cue uses; deterministic, so tests can assert it. */
export function nextCueId(cues: readonly SubtitleCue[]): string {
  let max = 0
  for (const cue of cues) {
    const match = /^subtitle-(\d+)$/.exec(cue.id)
    if (match) max = Math.max(max, Number(match[1]))
  }
  return `subtitle-${max + 1}`
}

/** A space between latin words, nothing between CJK characters. */
export function cueWordSeparator(text: string): string {
  return /\s/.test(String(text ?? '').trim()) ? ' ' : ''
}

/**
 * Time of the boundary *before* word `wordIndex`, sharing the cue's duration out
 * over its words in proportion to their length — the same rule the current-word
 * highlight uses, so a split lands where the highlight would have moved.
 */
export function wordBoundaryMs(
  words: readonly string[],
  startMs: number,
  endMs: number,
  wordIndex: number,
): number {
  if (words.length === 0) return startMs
  const weights = words.map((word) => Math.max(1, Array.from(word).length))
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  const clampedIndex = Math.max(0, Math.min(words.length, Math.round(wordIndex)))
  const consumed = weights.slice(0, clampedIndex).reduce((sum, weight) => sum + weight, 0)
  return Math.round(startMs + ((endMs - startMs) * consumed) / total)
}

/**
 * The word boundary closest to `timeMs`, as an index into `words`. Only interior
 * boundaries count (1..words.length-1); returns -1 when the cue cannot be split.
 */
export function nearestWordBoundaryIndex(
  words: readonly string[],
  startMs: number,
  endMs: number,
  timeMs: number,
): number {
  if (words.length < 2) return -1
  let best = -1
  let bestDistance = Number.POSITIVE_INFINITY
  for (let index = 1; index < words.length; index += 1) {
    const distance = Math.abs(wordBoundaryMs(words, startMs, endMs, index) - timeMs)
    if (distance < bestDistance) {
      bestDistance = distance
      best = index
    }
  }
  return best
}

/**
 * Replace a cue's text. Whitespace is collapsed the same way generated cues are,
 * and the cue is marked `manual` so a later re-run of the transcriber is a
 * visible overwrite rather than a silent one. Blank text is rejected (deleting a
 * cue is `deleteCue`).
 */
export function updateCueText(
  cues: readonly SubtitleCue[],
  cueId: string,
  text: string,
): SubtitleCue[] {
  const index = indexOfCue(cues, cueId)
  if (index < 0) return cues as SubtitleCue[]
  const nextText = normalizeSubtitleText(String(text ?? ''))
  if (!nextText) return cues as SubtitleCue[]
  const cue = cues[index]
  if (cue.text === nextText) return cues as SubtitleCue[]
  const next = [...cues]
  next[index] = { ...cue, text: nextText, source: 'manual' }
  return next
}

/**
 * Split a cue in two at the boundary before word `wordIndex`. The first cue
 * keeps words `[0, wordIndex)`, the second the rest; the boundary time comes
 * from `wordBoundaryMs`. Rejected when the index is not an interior boundary or
 * either half would be shorter than `MIN_CUE_DURATION_MS`.
 */
export function splitCueAtWord(
  cues: readonly SubtitleCue[],
  cueId: string,
  wordIndex: number,
): SubtitleCue[] {
  const index = indexOfCue(cues, cueId)
  if (index < 0) return cues as SubtitleCue[]
  const cue = cues[index]
  const words = splitCueWords(cue.text)
  if (words.length < 2) return cues as SubtitleCue[]
  if (!Number.isFinite(wordIndex)) return cues as SubtitleCue[]
  const at = Math.round(wordIndex)
  if (at < 1 || at > words.length - 1) return cues as SubtitleCue[]

  const boundaryMs = wordBoundaryMs(words, cue.startMs, cue.endMs, at)
  if (
    boundaryMs - cue.startMs < MIN_CUE_DURATION_MS ||
    cue.endMs - boundaryMs < MIN_CUE_DURATION_MS
  ) {
    return cues as SubtitleCue[]
  }

  const separator = cueWordSeparator(cue.text)
  const firstText = words.slice(0, at).join(separator)
  const secondText = words.slice(at).join(separator)
  if (!firstText || !secondText) return cues as SubtitleCue[]

  const first: SubtitleCue = { ...cue, endMs: boundaryMs, text: firstText, source: 'manual' }
  const second: SubtitleCue = {
    ...cue,
    id: nextCueId(cues),
    startMs: boundaryMs,
    text: secondText,
    source: 'manual',
  }
  const next = [...cues]
  next.splice(index, 1, first, second)
  return next
}

/** Split at the word boundary nearest `timeMs`. Rejected exactly like `splitCueAtWord`. */
export function splitCueAtTime(
  cues: readonly SubtitleCue[],
  cueId: string,
  timeMs: number,
): SubtitleCue[] {
  const index = indexOfCue(cues, cueId)
  if (index < 0) return cues as SubtitleCue[]
  const cue = cues[index]
  const words = splitCueWords(cue.text)
  const at = nearestWordBoundaryIndex(words, cue.startMs, cue.endMs, timeMs)
  if (at < 0) return cues as SubtitleCue[]
  return splitCueAtWord(cues, cueId, at)
}

/**
 * Join two cues into one. Only cues that are neighbours *in time order* may be
 * merged, so a merge can never reorder the track or swallow a cue in between.
 * The result spans both, keeps the earlier cue's id and joins the texts with the
 * separator the first cue's script uses.
 */
export function mergeCues(
  cues: readonly SubtitleCue[],
  firstId: string,
  secondId: string,
): SubtitleCue[] {
  if (firstId === secondId) return cues as SubtitleCue[]
  const sorted = sortCues(cues)
  const firstIndex = indexOfCue(sorted, firstId)
  const secondIndex = indexOfCue(sorted, secondId)
  if (firstIndex < 0 || secondIndex < 0) return cues as SubtitleCue[]
  const low = Math.min(firstIndex, secondIndex)
  const high = Math.max(firstIndex, secondIndex)
  if (high - low !== 1) return cues as SubtitleCue[]

  const earlier = sorted[low]
  const later = sorted[high]
  const separator = cueWordSeparator(earlier.text) || cueWordSeparator(later.text)
  const text = normalizeSubtitleText(`${earlier.text}${separator}${later.text}`)
  if (!text) return cues as SubtitleCue[]

  const merged: SubtitleCue = {
    ...earlier,
    endMs: Math.max(earlier.endMs, later.endMs),
    text,
    source: 'manual',
  }
  const next = [...sorted]
  next.splice(low, 2, merged)
  return next
}

/** Merge a cue with the one that follows it in time. */
export function mergeCueWithNext(cues: readonly SubtitleCue[], cueId: string): SubtitleCue[] {
  const sorted = sortCues(cues)
  const index = indexOfCue(sorted, cueId)
  if (index < 0 || index === sorted.length - 1) return cues as SubtitleCue[]
  return mergeCues(cues, sorted[index].id, sorted[index + 1].id)
}

/** Merge a cue with the one that precedes it in time. */
export function mergeCueWithPrevious(cues: readonly SubtitleCue[], cueId: string): SubtitleCue[] {
  const sorted = sortCues(cues)
  const index = indexOfCue(sorted, cueId)
  if (index <= 0) return cues as SubtitleCue[]
  return mergeCues(cues, sorted[index - 1].id, sorted[index].id)
}

/**
 * Move / resize a cue, clamped so it stays inside its neighbours and keeps at
 * least `MIN_CUE_DURATION_MS`. A drag that would cross a neighbour stops at it
 * rather than being rejected, which is what a dragged timeline item should do.
 */
export function retimeCue(
  cues: readonly SubtitleCue[],
  cueId: string,
  startMsInput: number,
  endMsInput: number,
): SubtitleCue[] {
  const sorted = sortCues(cues)
  const index = indexOfCue(sorted, cueId)
  if (index < 0) return cues as SubtitleCue[]
  if (!Number.isFinite(startMsInput) || !Number.isFinite(endMsInput)) return cues as SubtitleCue[]

  const cue = sorted[index]
  const lowerBound = index > 0 ? sorted[index - 1].endMs + MIN_CUE_GAP_MS : 0
  const upperBound =
    index < sorted.length - 1 ? sorted[index + 1].startMs - MIN_CUE_GAP_MS : Number.MAX_SAFE_INTEGER

  // A neighbour can leave less room than one cue needs; then nothing moves.
  if (upperBound - lowerBound < MIN_CUE_DURATION_MS) return cues as SubtitleCue[]

  let startMs = Math.round(Math.max(lowerBound, startMsInput))
  let endMs = Math.round(Math.min(upperBound, endMsInput))
  if (endMs - startMs < MIN_CUE_DURATION_MS) {
    // Preserve whichever edge the caller kept still, then push the other out.
    if (startMs !== cue.startMs && endMs === cue.endMs) {
      startMs = endMs - MIN_CUE_DURATION_MS
    } else {
      endMs = startMs + MIN_CUE_DURATION_MS
    }
    startMs = Math.max(lowerBound, startMs)
    endMs = Math.min(upperBound, Math.max(endMs, startMs + MIN_CUE_DURATION_MS))
    if (endMs - startMs < MIN_CUE_DURATION_MS) return cues as SubtitleCue[]
  }

  if (startMs === cue.startMs && endMs === cue.endMs) return cues as SubtitleCue[]

  const next = [...sorted]
  next[index] = { ...cue, startMs, endMs }
  return next
}

/** Remove a cue. Unknown ids leave the list alone. */
export function deleteCue(cues: readonly SubtitleCue[], cueId: string): SubtitleCue[] {
  const index = indexOfCue(cues, cueId)
  if (index < 0) return cues as SubtitleCue[]
  return cues.filter((cue) => cue.id !== cueId)
}
