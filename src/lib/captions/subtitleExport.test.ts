import { describe, expect, it } from 'vitest'
import type { SubtitleCue } from '@/lib/analysis/types'
import type { VideoSegment } from '@/components/video-editor/types'
import {
  buildSubtitleSidecar,
  cuesToSrt,
  cuesToVtt,
  escapeVttText,
  formatSrtTimestamp,
  formatVttTimestamp,
  isSubtitleSidecarFormat,
  mapCuesToExportTime,
} from './subtitleExport'

function cue(overrides: Partial<SubtitleCue> = {}): SubtitleCue {
  return {
    id: 'subtitle-1',
    startMs: 0,
    endMs: 1000,
    text: 'hello world',
    source: 'asr',
    ...overrides,
  }
}

function segment(overrides: Partial<VideoSegment> = {}): VideoSegment {
  return { id: 'seg-1', startMs: 0, endMs: 1000, deleted: false, speed: 1, ...overrides }
}

describe('formatSrtTimestamp', () => {
  it('uses a comma before the milliseconds', () => {
    expect(formatSrtTimestamp(0)).toBe('00:00:00,000')
    expect(formatSrtTimestamp(1)).toBe('00:00:00,001')
    expect(formatSrtTimestamp(1234)).toBe('00:00:01,234')
    expect(formatSrtTimestamp(61_000)).toBe('00:01:01,000')
    expect(formatSrtTimestamp(3_661_009)).toBe('01:01:01,009')
  })

  it('does not wrap the hours', () => {
    expect(formatSrtTimestamp(100 * 3_600_000)).toBe('100:00:00,000')
  })

  it('clamps a negative or non-finite time to zero', () => {
    expect(formatSrtTimestamp(-5)).toBe('00:00:00,000')
    expect(formatSrtTimestamp(Number.NaN)).toBe('00:00:00,000')
  })
})

describe('formatVttTimestamp', () => {
  it('uses a dot before the milliseconds', () => {
    expect(formatVttTimestamp(3_661_009)).toBe('01:01:01.009')
    expect(formatVttTimestamp(1234)).toBe('00:00:01.234')
  })

  it('differs from the SRT form only in that separator', () => {
    expect(formatVttTimestamp(987_654).replace('.', ',')).toBe(formatSrtTimestamp(987_654))
  })
})

describe('escapeVttText', () => {
  it('escapes the three markup characters', () => {
    expect(escapeVttText('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d')
  })

  it('turns a literal arrow into something a parser cannot mistake for a timing', () => {
    expect(escapeVttText('a --> b')).toBe('a --&gt; b')
  })

  it('escapes the ampersand first, so an escape is not double-escaped', () => {
    expect(escapeVttText('&lt;')).toBe('&amp;lt;')
  })
})

describe('isSubtitleSidecarFormat', () => {
  it('accepts srt and vtt only', () => {
    expect(isSubtitleSidecarFormat('srt')).toBe(true)
    expect(isSubtitleSidecarFormat('vtt')).toBe(true)
    expect(isSubtitleSidecarFormat('ass')).toBe(false)
    expect(isSubtitleSidecarFormat(null)).toBe(false)
  })
})

describe('cuesToSrt', () => {
  it('numbers cues from one and separates blocks with a blank line', () => {
    const output = cuesToSrt([
      cue({ id: 'a', startMs: 0, endMs: 1000, text: 'first' }),
      cue({ id: 'b', startMs: 1500, endMs: 2500, text: 'second' }),
    ])
    expect(output).toBe(
      [
        '1',
        '00:00:00,000 --> 00:00:01,000',
        'first',
        '',
        '2',
        '00:00:01,500 --> 00:00:02,500',
        'second',
        '',
      ].join('\n'),
    )
  })

  it('keeps a multi-line payload as separate lines', () => {
    expect(cuesToSrt([cue({ text: 'line one\nline two' })])).toContain('line one\nline two')
  })

  it('drops blank lines inside a payload, which would end the cue early', () => {
    expect(cuesToSrt([cue({ text: 'one\n\n\ntwo' })])).toContain('one\ntwo')
  })

  it('renumbers after skipping an empty cue', () => {
    const output = cuesToSrt([
      cue({ id: 'a', startMs: 0, endMs: 1000, text: 'kept' }),
      cue({ id: 'b', startMs: 1000, endMs: 2000, text: '   ' }),
      cue({ id: 'c', startMs: 2000, endMs: 3000, text: 'also kept' }),
    ])
    expect(output).toContain('1\n00:00:00,000')
    expect(output).toContain('2\n00:00:02,000')
    expect(output).not.toContain('3\n')
  })

  it('rejects a zero-length cue', () => {
    expect(cuesToSrt([cue({ startMs: 500, endMs: 500 })])).toBe('')
    expect(cuesToSrt([cue({ startMs: 500, endMs: 400 })])).toBe('')
  })

  it('is empty for an empty track', () => {
    expect(cuesToSrt([])).toBe('')
  })
})

describe('cuesToVtt', () => {
  it('starts with the WEBVTT signature and a blank line', () => {
    const output = cuesToVtt([cue({ text: 'hi' })])
    expect(output.startsWith('WEBVTT\n\n')).toBe(true)
    expect(output).toContain('00:00:00.000 --> 00:00:01.000')
  })

  it('escapes the payload', () => {
    expect(cuesToVtt([cue({ text: '5 < 6 & 7 > 6' })])).toContain('5 &lt; 6 &amp; 7 &gt; 6')
  })

  it('is just the signature for an empty track', () => {
    expect(cuesToVtt([])).toBe('WEBVTT\n\n')
  })
})

describe('mapCuesToExportTime', () => {
  it('passes cues through untouched when nothing was cut', () => {
    const cues = [cue({ startMs: 100, endMs: 900 })]
    expect(mapCuesToExportTime(cues)).toEqual(cues)
  })

  it('pulls cues back past a deleted segment', () => {
    const segments = [
      segment({ id: 'a', startMs: 0, endMs: 1000 }),
      segment({ id: 'b', startMs: 1000, endMs: 2000, deleted: true }),
      segment({ id: 'c', startMs: 2000, endMs: 3000 }),
    ]
    const mapped = mapCuesToExportTime([cue({ startMs: 2200, endMs: 2600 })], { segments })
    expect(mapped[0]).toMatchObject({ startMs: 1200, endMs: 1600 })
  })

  it('drops a cue that lived entirely inside a deleted segment', () => {
    const segments = [
      segment({ id: 'a', startMs: 0, endMs: 1000 }),
      segment({ id: 'b', startMs: 1000, endMs: 2000, deleted: true }),
    ]
    expect(mapCuesToExportTime([cue({ startMs: 1200, endMs: 1800 })], { segments })).toEqual([])
  })

  it('shortens a cue that straddles a deleted segment', () => {
    const segments = [
      segment({ id: 'a', startMs: 0, endMs: 1000 }),
      segment({ id: 'b', startMs: 1000, endMs: 2000, deleted: true }),
      segment({ id: 'c', startMs: 2000, endMs: 3000 }),
    ]
    const mapped = mapCuesToExportTime([cue({ startMs: 800, endMs: 2400 })], { segments })
    expect(mapped[0]).toMatchObject({ startMs: 800, endMs: 1400 })
  })

  it('compresses cues that sit in a sped-up segment', () => {
    const segments = [segment({ startMs: 0, endMs: 4000, speed: 2 })]
    const mapped = mapCuesToExportTime([cue({ startMs: 1000, endMs: 3000 })], { segments })
    expect(mapped[0]).toMatchObject({ startMs: 500, endMs: 1500 })
  })

  it('falls back to trim regions when a project has no segments', () => {
    const mapped = mapCuesToExportTime([cue({ startMs: 2200, endMs: 2600 })], {
      trimRegions: [{ startMs: 1000, endMs: 2000 }],
      totalDurationMs: 3000,
    })
    expect(mapped[0]).toMatchObject({ startMs: 1200, endMs: 1600 })
  })

  it('drops blank cues and sorts the result', () => {
    const mapped = mapCuesToExportTime([
      cue({ id: 'b', startMs: 2000, endMs: 3000, text: 'second' }),
      cue({ id: 'blank', startMs: 500, endMs: 900, text: '  ' }),
      cue({ id: 'a', startMs: 0, endMs: 1000, text: 'first' }),
    ])
    expect(mapped.map((entry) => entry.id)).toEqual(['a', 'b'])
  })
})

describe('buildSubtitleSidecar', () => {
  const segments = [
    segment({ id: 'a', startMs: 0, endMs: 1000 }),
    segment({ id: 'b', startMs: 1000, endMs: 2000, deleted: true }),
    segment({ id: 'c', startMs: 2000, endMs: 3000 }),
  ]

  it('writes SRT against the exported timeline, not the recording', () => {
    const content = buildSubtitleSidecar(
      [cue({ startMs: 2200, endMs: 2600, text: 'after the cut' })],
      'srt',
      { segments },
    )
    expect(content).toContain('00:00:01,200 --> 00:00:01,600')
    expect(content).not.toContain('00:00:02,200')
  })

  it('writes WebVTT against the same mapping', () => {
    const content = buildSubtitleSidecar(
      [cue({ startMs: 2200, endMs: 2600, text: 'after the cut' })],
      'vtt',
      { segments },
    )
    expect(content?.startsWith('WEBVTT')).toBe(true)
    expect(content).toContain('00:00:01.200 --> 00:00:01.600')
  })

  it('returns null when every cue was cut away', () => {
    expect(buildSubtitleSidecar([cue({ startMs: 1200, endMs: 1800 })], 'srt', { segments })).toBe(
      null,
    )
    expect(buildSubtitleSidecar([cue({ startMs: 1200, endMs: 1800 })], 'vtt', { segments })).toBe(
      null,
    )
  })

  it('returns null for an empty track', () => {
    expect(buildSubtitleSidecar([], 'srt')).toBe(null)
    expect(buildSubtitleSidecar([], 'vtt')).toBe(null)
  })
})
