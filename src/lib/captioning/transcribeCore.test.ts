import { describe, expect, it, vi } from 'vitest'
import {
  MIN_TRANSCRIBE_SLICE_SAMPLES,
  TRANSCRIBE_SAMPLE_RATE,
  TRANSCRIBE_SLICE_SAMPLES,
  extractChunksFromAsrResult,
  runTranscription,
  segmentsFromTranscriberChunks,
  type TranscriberFn,
} from './transcribeCore'

type Chunk = { timestamp: [number | null, number | null]; text: string }

function asr(chunks: Chunk[], text = chunks.map((c) => c.text).join(' ')) {
  return { text, chunks }
}

function silentSeconds(seconds: number): Float32Array {
  return new Float32Array(Math.round(seconds * TRANSCRIBE_SAMPLE_RATE))
}

describe('runTranscription', () => {
  it('returns word granularity when the word pass yields chunks', async () => {
    const transcriber: TranscriberFn = vi.fn(async (_audio, opts) => {
      if (opts.return_timestamps === 'word') {
        return asr([
          { timestamp: [0.1, 0.4], text: 'hello' },
          { timestamp: [0.5, 0.9], text: 'world' },
        ])
      }
      return asr([{ timestamp: [0, 1], text: 'hello world' }])
    })

    const result = await runTranscription(transcriber, silentSeconds(2), [])

    expect(result.granularity).toBe('word')
    expect(result.segments.map((s) => s.text)).toEqual(['hello', 'world'])
    expect(transcriber).toHaveBeenCalledTimes(1)
  })

  it('falls back to phrase timestamps when word passes fail or return nothing', async () => {
    const calls: Array<Record<string, unknown>> = []
    const transcriber: TranscriberFn = async (_audio, opts) => {
      calls.push(opts)
      if (opts.return_timestamps === 'word') {
        throw new Error('output_attentions not available')
      }
      return asr([{ timestamp: [0, 1.5], text: 'hello world' }])
    }

    const result = await runTranscription(transcriber, silentSeconds(2), [])

    expect(result.granularity).toBe('phrase')
    expect(result.segments).toEqual([{ startSec: 0, endSec: 1.5, text: 'hello world' }])
    // word (force full) -> word (no force) -> phrase (force full) succeeds.
    expect(calls.map((c) => [c.return_timestamps, c.force_full_sequences])).toEqual([
      ['word', true],
      ['word', false],
      [true, true],
    ])
  })

  it('passes language and task to the pipeline when a language is known', async () => {
    const transcriber: TranscriberFn = vi.fn(async () => asr([{ timestamp: [0, 1], text: 'hi' }]))

    await runTranscription(transcriber, silentSeconds(1), [], { language: 'vi' })

    const opts = (transcriber as ReturnType<typeof vi.fn>).mock.calls[0]![1] as Record<
      string,
      unknown
    >
    expect(opts.language).toBe('vi')
    expect(opts.task).toBe('transcribe')
    expect(opts.chunk_length_s).toBeUndefined()
  })

  it('chunks clips longer than 30 s and omits language when unknown', async () => {
    const transcriber: TranscriberFn = vi.fn(async () => asr([{ timestamp: [0, 1], text: 'hi' }]))

    await runTranscription(transcriber, silentSeconds(45), [])

    const opts = (transcriber as ReturnType<typeof vi.fn>).mock.calls[0]![1] as Record<
      string,
      unknown
    >
    expect(opts.chunk_length_s).toBe(30)
    expect(opts.stride_length_s).toBe(5)
    expect('language' in opts).toBe(false)
  })

  it('slices long audio and shifts timestamps back onto the full timeline', async () => {
    const sliceSec = TRANSCRIBE_SLICE_SAMPLES / TRANSCRIBE_SAMPLE_RATE
    const seen: number[] = []
    const transcriber: TranscriberFn = async (audio, opts) => {
      if (opts.return_timestamps === 'word') return asr([])
      seen.push(audio.length)
      return asr([{ timestamp: [1, 2], text: `slice ${seen.length}` }])
    }

    // 12 min + 10 s: two slices, the second one short but longer than the padding floor.
    const total = silentSeconds(sliceSec + 10)
    const result = await runTranscription(transcriber, total, [])

    expect(seen).toEqual([TRANSCRIBE_SLICE_SAMPLES, 10 * TRANSCRIBE_SAMPLE_RATE])
    expect(result.granularity).toBe('phrase')
    expect(result.segments).toEqual([
      { startSec: 1, endSec: 2, text: 'slice 1' },
      { startSec: sliceSec + 1, endSec: sliceSec + 2, text: 'slice 2' },
    ])
  })

  it('pads a tiny tail slice and clamps its timestamps to the real duration', async () => {
    const sliceSec = TRANSCRIBE_SLICE_SAMPLES / TRANSCRIBE_SAMPLE_RATE
    const lengths: number[] = []
    const transcriber: TranscriberFn = async (audio, opts) => {
      if (opts.return_timestamps === 'word') return asr([])
      lengths.push(audio.length)
      return asr([{ timestamp: [0, 5], text: 'tail' }])
    }

    const tailSamples = 100
    const total = new Float32Array(TRANSCRIBE_SLICE_SAMPLES + tailSamples)
    const result = await runTranscription(transcriber, total, [])

    expect(lengths[1]).toBe(MIN_TRANSCRIBE_SLICE_SAMPLES)
    const tail = result.segments[1]!
    expect(tail.startSec).toBeCloseTo(sliceSec, 5)
    // 100 samples = 6.25 ms of real audio, so the segment must not extend past it.
    expect(tail.endSec).toBeLessThanOrEqual(sliceSec + tailSamples / TRANSCRIBE_SAMPLE_RATE + 1e-9)
  })

  it('drops segments overlapping trim regions and retries ignoring trims when everything was trimmed', async () => {
    const passes: Array<[unknown, boolean]> = []
    const transcriber: TranscriberFn = async (_audio, opts) => {
      passes.push([opts.return_timestamps, Boolean(opts.force_full_sequences)])
      if (opts.return_timestamps === 'word') return asr([])
      return asr([
        { timestamp: [0, 1], text: 'cut me' },
        { timestamp: [2, 3], text: 'keep me' },
      ])
    }

    const withPartialTrim = await runTranscription(transcriber, silentSeconds(4), [
      { id: 't1', startMs: 0, endMs: 1_500 },
    ])
    expect(withPartialTrim.segments.map((s) => s.text)).toEqual(['keep me'])

    passes.length = 0
    const everythingTrimmed = await runTranscription(transcriber, silentSeconds(4), [
      { id: 't1', startMs: 0, endMs: 4_000 },
    ])
    // All passes drop everything (trim covers the clip), including the trim-ignoring retries.
    expect(everythingTrimmed.segments).toEqual([])
    expect(passes.length).toBe(8)
  })

  it('returns an empty phrase result when every pass fails', async () => {
    const transcriber: TranscriberFn = async () => {
      throw new Error('boom')
    }
    const result = await runTranscription(transcriber, silentSeconds(1), [])
    expect(result).toEqual({ segments: [], granularity: 'phrase' })
  })
})

describe('segmentsFromTranscriberChunks', () => {
  it('fills open-ended timestamps from the next chunk or the audio end and dedupes repeats', () => {
    const segments = segmentsFromTranscriberChunks(
      [
        { timestamp: [2, null], text: 'second' },
        { timestamp: [null, 1], text: '  first  ' },
        { timestamp: [1, 2], text: 'first' },
        { timestamp: [5, 4], text: 'inverted' },
        { timestamp: [6, 7], text: '   ' },
      ],
      10,
      [],
      8,
    )

    expect(segments).toEqual([
      { startSec: 10, endSec: 12, text: 'first' },
      { startSec: 12, endSec: 15, text: 'second' },
      { startSec: 15, endSec: 15.25, text: 'inverted' },
    ])
  })
})

describe('extractChunksFromAsrResult', () => {
  it('flattens batched results and synthesises one chunk from bare text', () => {
    expect(
      extractChunksFromAsrResult([
        { chunks: [{ timestamp: [0, 1], text: 'a' }] },
        { chunks: [{ timestamp: [1, 2], text: 'b' }] },
      ]),
    ).toHaveLength(2)
    expect(extractChunksFromAsrResult({ text: ' only text ' })).toEqual([
      { timestamp: [0, null], text: 'only text' },
    ])
    expect(extractChunksFromAsrResult(null)).toEqual([])
  })
})
