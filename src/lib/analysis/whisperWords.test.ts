import { describe, expect, it } from 'vitest'
import { generateRoughCutSuggestions } from './roughCutEngine'
import { buildVideoAnalysisResult } from './videoAnalysisPipeline'
import { captionSegmentsToTranscriptWords, expandPhraseSegmentToPseudoWords } from './whisperWords'

describe('captionSegmentsToTranscriptWords', () => {
  it('maps word granularity 1:1 with rounded millisecond timestamps and no confidence', () => {
    const words = captionSegmentsToTranscriptWords(
      [
        { startSec: 0.1004, endSec: 0.4996, text: ' hello ' },
        { startSec: 0.5, endSec: 0.9, text: 'world' },
      ],
      'word',
    )

    expect(words).toEqual([
      { text: 'hello', startMs: 100, endMs: 500 },
      { text: 'world', startMs: 500, endMs: 900 },
    ])
    expect(words.every((w) => w.confidence === undefined && !w.synthetic)).toBe(true)
  })

  it('splits phrases into contiguous synthetic pseudo-words tagged with their phrase index', () => {
    const words = captionSegmentsToTranscriptWords(
      [
        { startSec: 0, endSec: 1, text: 'hello big world' },
        { startSec: 2, endSec: 2.5, text: 'bye' },
      ],
      'phrase',
    )

    expect(words.map((w) => w.text)).toEqual(['hello', 'big', 'world', 'bye'])
    expect(words.map((w) => w.phraseIndex)).toEqual([0, 0, 0, 1])
    expect(words.every((w) => w.synthetic === true)).toBe(true)

    // Character-weighted split: hello(5) big(3) world(5) over 1000 ms.
    expect(words[0]).toMatchObject({ startMs: 0, endMs: 385 })
    expect(words[1]).toMatchObject({ startMs: 385, endMs: 615 })
    expect(words[2]).toMatchObject({ startMs: 615, endMs: 1000 })
    expect(words[3]).toMatchObject({ startMs: 2000, endMs: 2500 })
  })

  it('drops empty segments and keeps zero-length pseudo-words representable', () => {
    const words = captionSegmentsToTranscriptWords(
      [
        { startSec: 1, endSec: 1, text: 'a b' },
        { startSec: 3, endSec: 4, text: '   ' },
      ],
      'phrase',
    )
    expect(words.map((w) => w.text)).toEqual(['a', 'b'])
    expect(words.every((w) => w.endMs > w.startMs)).toBe(true)
  })
})

describe('expandPhraseSegmentToPseudoWords', () => {
  it('returns the phrase itself for single words and nothing for blank text', () => {
    expect(expandPhraseSegmentToPseudoWords({ startSec: 1, endSec: 2, text: '  one ' })).toEqual([
      { startSec: 1, endSec: 2, text: 'one' },
    ])
    expect(expandPhraseSegmentToPseudoWords({ startSec: 1, endSec: 2, text: ' ' })).toEqual([])
  })

  it('keeps spans ordered, non-overlapping and ending exactly at the phrase end', () => {
    const spans = expandPhraseSegmentToPseudoWords({
      startSec: 10,
      endSec: 10.03,
      text: 'a bb ccc dddd',
    })
    expect(spans).toHaveLength(4)
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i]!.startSec).toBeGreaterThanOrEqual(spans[i - 1]!.endSec - 1e-9)
    }
    expect(spans[spans.length - 1]!.endSec).toBe(10.03)
  })
})

describe('synthetic words through the analysis pipeline', () => {
  it('never reports a silence between pseudo-words of the same phrase, only between phrases', () => {
    const words = captionSegmentsToTranscriptWords(
      [
        { startSec: 0, endSec: 1, text: 'first phrase here' },
        { startSec: 3, endSec: 4, text: 'second phrase' },
      ],
      'phrase',
    )
    // Force an artificial gap inside phrase 0 to prove the guard (not the contiguity) is what protects it.
    words[0]!.endMs = 100

    const suggestions = generateRoughCutSuggestions(words, 5_000, {
      minSilenceMs: 200,
      minFillerDurationMs: 260,
      fillerWords: [],
    })

    expect(suggestions).toHaveLength(1)
    expect(suggestions[0]).toMatchObject({ reason: 'silence', startMs: 1000, endMs: 3000 })
  })

  it('buildVideoAnalysisResult keeps the synthetic markers so the guard survives normalisation', () => {
    const words = captionSegmentsToTranscriptWords(
      [{ startSec: 0, endSec: 2, text: 'hello there world' }],
      'phrase',
    )
    words[0]!.endMs = 50 // 1.2 s gap inside the phrase

    const analysis = buildVideoAnalysisResult(words, {
      durationMs: 2_000,
      videoWidth: 1920,
      subtitleWidthRatio: 0.82,
      locale: 'en-US',
    })

    expect(analysis.transcript.words.every((w) => w.synthetic && w.phraseIndex === 0)).toBe(true)
    expect(analysis.roughCutSuggestions).toEqual([])
    expect(analysis.subtitleCues.length).toBeGreaterThan(0)
    expect(analysis.transcript.text).toBe('hello there world')
  })
})
