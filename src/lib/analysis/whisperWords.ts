import type { CaptionSegment, CaptionTimestampGranularity } from '@/lib/captioning/transcribe'
import type { TranscriptWord } from './types'

/**
 * Adapts in-browser Whisper output (`CaptionSegment[]`) to the `TranscriptWord[]`
 * shape that `buildVideoAnalysisResult` consumes.
 *
 * - `word` granularity: one segment is one word; timestamps are real.
 * - `phrase` granularity: Whisper only timed whole phrases, so each phrase is split
 *   into pseudo-words whose boundaries are interpolated by character weight
 *   (`expandPhraseSegmentToPseudoWords` below). Those words carry
 *   `synthetic: true` + `phraseIndex` so `roughCutEngine` never reads a gap
 *   between them as silence.
 */

/** Smallest span a pseudo-word may occupy (seconds). */
const WORD_SPLIT_MIN_SPAN_SEC = 0.02

/**
 * Splits one phrase into per-word spans proportional to word length, keeping the
 * spans contiguous and inside `[startSec, endSec]`.
 */
export function expandPhraseSegmentToPseudoWords(segment: CaptionSegment): CaptionSegment[] {
  const words = segment.text.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return []
  if (words.length === 1) {
    return [{ startSec: segment.startSec, endSec: segment.endSec, text: words[0]! }]
  }

  const { startSec, endSec } = segment
  const dur = Math.max(endSec - startSec, 0.05)
  const weights = words.map((w) => Math.max(1, w.length))
  const totalW = weights.reduce((a, b) => a + b, 0)

  const result: CaptionSegment[] = []
  let prevEnd = startSec
  let weightBefore = 0
  for (let i = 0; i < words.length; i++) {
    const ws = weights[i]!
    let s = startSec + (weightBefore / totalW) * dur
    let e = startSec + ((weightBefore + ws) / totalW) * dur
    weightBefore += ws
    s = Math.max(s, prevEnd)
    e = Math.max(s + WORD_SPLIT_MIN_SPAN_SEC, e)
    e = Math.min(e, endSec)
    if (e <= s) {
      e = Math.min(endSec, s + WORD_SPLIT_MIN_SPAN_SEC)
    }
    prevEnd = e
    result.push({ startSec: s, endSec: e, text: words[i]! })
  }

  result[result.length - 1]!.endSec = endSec
  for (let i = 0; i < result.length - 1; i++) {
    if (result[i]!.endSec > result[i + 1]!.startSec + 0.002) {
      result[i]!.endSec = Math.max(result[i]!.startSec + 1e-4, result[i + 1]!.startSec)
    }
  }
  return result
}

function toWord(segment: CaptionSegment): TranscriptWord | null {
  const text = segment.text.trim()
  const startMs = Math.max(0, Math.round(segment.startSec * 1000))
  let endMs = Math.max(0, Math.round(segment.endSec * 1000))
  if (!text) return null
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null
  // Sub-millisecond pseudo-words would be dropped by the pipeline normaliser; give
  // them the smallest representable duration instead of losing the text.
  if (endMs <= startMs) endMs = startMs + 1
  return { text, startMs, endMs }
}

export function captionSegmentsToTranscriptWords(
  segments: CaptionSegment[],
  granularity: CaptionTimestampGranularity,
): TranscriptWord[] {
  const words: TranscriptWord[] = []

  if (granularity === 'word') {
    for (const segment of segments) {
      const word = toWord(segment)
      if (word) words.push(word)
    }
  } else {
    segments.forEach((segment, phraseIndex) => {
      for (const pseudo of expandPhraseSegmentToPseudoWords(segment)) {
        const word = toWord(pseudo)
        if (!word) continue
        word.synthetic = true
        word.phraseIndex = phraseIndex
        words.push(word)
      }
    })
  }

  return words.sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs)
}
