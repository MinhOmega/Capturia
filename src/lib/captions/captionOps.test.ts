import { describe, expect, it } from 'vitest'
import type { SubtitleCue } from '@/lib/analysis/types'
import {
  cueWordSeparator,
  splitCueWords,
  deleteCue,
  mergeCueWithNext,
  mergeCueWithPrevious,
  mergeCues,
  MIN_CUE_DURATION_MS,
  nearestWordBoundaryIndex,
  nextCueId,
  retimeCue,
  splitCueAtTime,
  splitCueAtWord,
  updateCueText,
  wordBoundaryMs,
} from './captionOps'

function cue(overrides: Partial<SubtitleCue> = {}): SubtitleCue {
  return {
    id: 'subtitle-1',
    startMs: 1000,
    endMs: 3000,
    text: 'one two three four',
    source: 'asr',
    ...overrides,
  }
}

/** Three evenly spaced cues with a gap between the second and the third. */
function track(): SubtitleCue[] {
  return [
    cue({ id: 'subtitle-1', startMs: 0, endMs: 1000, text: 'first cue here' }),
    cue({ id: 'subtitle-2', startMs: 1000, endMs: 2000, text: 'second cue here' }),
    cue({ id: 'subtitle-3', startMs: 3000, endMs: 4000, text: 'third cue here' }),
  ]
}

describe('nextCueId', () => {
  it('continues the subtitle-<n> sequence', () => {
    expect(nextCueId(track())).toBe('subtitle-4')
  })

  it('ignores ids that are not in the sequence', () => {
    expect(nextCueId([cue({ id: 'imported-a' }), cue({ id: 'subtitle-7' })])).toBe('subtitle-8')
  })

  it('starts at one for an empty track', () => {
    expect(nextCueId([])).toBe('subtitle-1')
  })
})

describe('splitCueWords', () => {
  it('splits latin text on whitespace', () => {
    expect(splitCueWords(' one   two  three ')).toEqual(['one', 'two', 'three'])
  })

  it('keeps a space-free latin word whole', () => {
    expect(splitCueWords('solo')).toEqual(['solo'])
  })

  it('splits a space-free cjk cue per character', () => {
    expect(splitCueWords('这是字幕')).toEqual(['这', '是', '字', '幕'])
  })

  it('returns nothing for blank text', () => {
    expect(splitCueWords('   ')).toEqual([])
  })
})

describe('cueWordSeparator', () => {
  it('is a space for latin text and empty for cjk', () => {
    expect(cueWordSeparator('hello world')).toBe(' ')
    expect(cueWordSeparator('这是字幕')).toBe('')
    expect(cueWordSeparator('  ')).toBe('')
  })
})

describe('wordBoundaryMs', () => {
  it('shares the duration out by word length', () => {
    const words = ['aa', 'bb']
    expect(wordBoundaryMs(words, 0, 1000, 0)).toBe(0)
    expect(wordBoundaryMs(words, 0, 1000, 1)).toBe(500)
    expect(wordBoundaryMs(words, 0, 1000, 2)).toBe(1000)
  })

  it('gives a longer word a longer slice', () => {
    expect(wordBoundaryMs(['a', 'bbb'], 0, 1000, 1)).toBe(250)
  })

  it('clamps an out-of-range index to the cue bounds', () => {
    expect(wordBoundaryMs(['a', 'b'], 500, 1500, -5)).toBe(500)
    expect(wordBoundaryMs(['a', 'b'], 500, 1500, 99)).toBe(1500)
  })
})

describe('nearestWordBoundaryIndex', () => {
  it('picks the closest interior boundary', () => {
    const words = ['aa', 'bb', 'cc', 'dd']
    expect(nearestWordBoundaryIndex(words, 0, 4000, 100)).toBe(1)
    expect(nearestWordBoundaryIndex(words, 0, 4000, 1900)).toBe(2)
    expect(nearestWordBoundaryIndex(words, 0, 4000, 3900)).toBe(3)
  })

  it('has no boundary for a single-word cue', () => {
    expect(nearestWordBoundaryIndex(['solo'], 0, 1000, 500)).toBe(-1)
    expect(nearestWordBoundaryIndex([], 0, 1000, 500)).toBe(-1)
  })
})

describe('updateCueText', () => {
  it('rewrites the text and marks the cue manual', () => {
    const next = updateCueText([cue()], 'subtitle-1', '  hello   there  ')
    expect(next[0].text).toBe('hello there')
    expect(next[0].source).toBe('manual')
  })

  it('keeps cjk punctuation tight', () => {
    const next = updateCueText([cue({ text: '原文' })], 'subtitle-1', '这是 ， 一个字幕')
    expect(next[0].text).toBe('这是，一个字幕')
  })

  it('is a no-op for blank text, an unchanged text and an unknown id', () => {
    const cues = [cue()]
    expect(updateCueText(cues, 'subtitle-1', '   ')).toBe(cues)
    expect(updateCueText(cues, 'subtitle-1', 'one two three four')).toBe(cues)
    expect(updateCueText(cues, 'nope', 'anything')).toBe(cues)
  })

  it('leaves the other cues untouched by identity', () => {
    const cues = track()
    const next = updateCueText(cues, 'subtitle-2', 'edited')
    expect(next[0]).toBe(cues[0])
    expect(next[2]).toBe(cues[2])
    expect(next[1]).not.toBe(cues[1])
  })
})

describe('splitCueAtWord', () => {
  it('splits latin text at the word boundary', () => {
    const next = splitCueAtWord([cue({ text: 'aa bb' })], 'subtitle-1', 1)
    expect(next).toHaveLength(2)
    expect(next[0]).toMatchObject({ id: 'subtitle-1', startMs: 1000, endMs: 2000, text: 'aa' })
    expect(next[1]).toMatchObject({ id: 'subtitle-2', startMs: 2000, endMs: 3000, text: 'bb' })
    expect(next[1].source).toBe('manual')
  })

  it('splits cjk text per character with no separator', () => {
    const next = splitCueAtWord([cue({ text: '一二三四' })], 'subtitle-1', 2)
    expect(next.map((entry) => entry.text)).toEqual(['一二', '三四'])
    expect(next[0].endMs).toBe(2000)
  })

  it('keeps the cues in place around the split', () => {
    const cues = track()
    const next = splitCueAtWord(cues, 'subtitle-2', 1)
    expect(next.map((entry) => entry.id)).toEqual([
      'subtitle-1',
      'subtitle-2',
      'subtitle-4',
      'subtitle-3',
    ])
  })

  it('rejects an index that is not an interior boundary', () => {
    const cues = [cue({ text: 'aa bb cc' })]
    expect(splitCueAtWord(cues, 'subtitle-1', 0)).toBe(cues)
    expect(splitCueAtWord(cues, 'subtitle-1', 3)).toBe(cues)
    expect(splitCueAtWord(cues, 'subtitle-1', -1)).toBe(cues)
    expect(splitCueAtWord(cues, 'subtitle-1', Number.NaN)).toBe(cues)
  })

  it('rejects a single-word cue and an unknown id', () => {
    const cues = [cue({ text: 'solo' })]
    expect(splitCueAtWord(cues, 'subtitle-1', 1)).toBe(cues)
    expect(splitCueAtWord(cues, 'nope', 1)).toBe(cues)
  })

  it('rejects a split that would leave a half below the minimum duration', () => {
    const cues = [cue({ startMs: 0, endMs: MIN_CUE_DURATION_MS * 2 - 2, text: 'aa bb' })]
    expect(splitCueAtWord(cues, 'subtitle-1', 1)).toBe(cues)
  })
})

describe('splitCueAtTime', () => {
  it('snaps to the nearest word boundary', () => {
    const next = splitCueAtTime(
      [cue({ startMs: 0, endMs: 4000, text: 'aa bb cc dd' })],
      'subtitle-1',
      1900,
    )
    expect(next.map((entry) => entry.text)).toEqual(['aa bb', 'cc dd'])
    expect(next[0].endMs).toBe(2000)
  })

  it('still snaps when the time is outside the cue', () => {
    const next = splitCueAtTime(
      [cue({ startMs: 0, endMs: 4000, text: 'aa bb cc dd' })],
      'subtitle-1',
      -500,
    )
    expect(next[0].text).toBe('aa')
  })

  it('rejects a cue with no interior boundary', () => {
    const cues = [cue({ text: 'solo' })]
    expect(splitCueAtTime(cues, 'subtitle-1', 1500)).toBe(cues)
  })
})

describe('mergeCues', () => {
  it('joins two adjacent cues into the earlier one', () => {
    const next = mergeCues(track(), 'subtitle-1', 'subtitle-2')
    expect(next).toHaveLength(2)
    expect(next[0]).toMatchObject({
      id: 'subtitle-1',
      startMs: 0,
      endMs: 2000,
      text: 'first cue here second cue here',
      source: 'manual',
    })
  })

  it('accepts the two ids in either order', () => {
    expect(mergeCues(track(), 'subtitle-2', 'subtitle-1')).toEqual(
      mergeCues(track(), 'subtitle-1', 'subtitle-2'),
    )
  })

  it('spans the gap between two cues that are not touching', () => {
    const next = mergeCues(track(), 'subtitle-2', 'subtitle-3')
    expect(next[1]).toMatchObject({ startMs: 1000, endMs: 4000 })
  })

  it('refuses cues that are not neighbours', () => {
    const cues = track()
    expect(mergeCues(cues, 'subtitle-1', 'subtitle-3')).toBe(cues)
  })

  it('refuses the same cue twice and unknown ids', () => {
    const cues = track()
    expect(mergeCues(cues, 'subtitle-1', 'subtitle-1')).toBe(cues)
    expect(mergeCues(cues, 'subtitle-1', 'nope')).toBe(cues)
  })

  it('joins cjk cues without inserting a space', () => {
    const cues = [
      cue({ id: 'subtitle-1', startMs: 0, endMs: 1000, text: '这是' }),
      cue({ id: 'subtitle-2', startMs: 1000, endMs: 2000, text: '字幕' }),
    ]
    expect(mergeCues(cues, 'subtitle-1', 'subtitle-2')[0].text).toBe('这是字幕')
  })

  it('sorts an out-of-order track before deciding adjacency', () => {
    const cues = [track()[2], track()[0], track()[1]]
    const next = mergeCues(cues, 'subtitle-1', 'subtitle-2')
    expect(next.map((entry) => entry.id)).toEqual(['subtitle-1', 'subtitle-3'])
  })
})

describe('mergeCueWithNext / mergeCueWithPrevious', () => {
  it('merges forward and backward to the same result', () => {
    expect(mergeCueWithNext(track(), 'subtitle-1')).toEqual(
      mergeCueWithPrevious(track(), 'subtitle-2'),
    )
  })

  it('is a no-op at the ends of the track', () => {
    const cues = track()
    expect(mergeCueWithNext(cues, 'subtitle-3')).toBe(cues)
    expect(mergeCueWithPrevious(cues, 'subtitle-1')).toBe(cues)
    expect(mergeCueWithNext(cues, 'nope')).toBe(cues)
    expect(mergeCueWithPrevious(cues, 'nope')).toBe(cues)
  })
})

describe('retimeCue', () => {
  it('moves a cue inside the room its neighbours leave', () => {
    const next = retimeCue(track(), 'subtitle-2', 1200, 2200)
    expect(next[1]).toMatchObject({ startMs: 1200, endMs: 2200 })
  })

  it('clamps the start to the previous cue', () => {
    const next = retimeCue(track(), 'subtitle-2', 500, 1800)
    expect(next[1]).toMatchObject({ startMs: 1000, endMs: 1800 })
  })

  it('clamps the end to the next cue', () => {
    const next = retimeCue(track(), 'subtitle-2', 1200, 5000)
    expect(next[1]).toMatchObject({ startMs: 1200, endMs: 3000 })
  })

  it('clamps the first cue to zero', () => {
    const next = retimeCue(track(), 'subtitle-1', -500, 800)
    expect(next[0]).toMatchObject({ startMs: 0, endMs: 800 })
  })

  it('lets the last cue extend past the track', () => {
    const next = retimeCue(track(), 'subtitle-3', 3000, 99_000)
    expect(next[2].endMs).toBe(99_000)
  })

  it('keeps the minimum duration when a drag collapses the cue', () => {
    const next = retimeCue(track(), 'subtitle-2', 1900, 1900)
    expect(next[1].endMs - next[1].startMs).toBe(MIN_CUE_DURATION_MS)
  })

  it('pushes the start back when only the start moved', () => {
    const next = retimeCue(track(), 'subtitle-2', 2000, 2000)
    expect(next[1]).toMatchObject({ startMs: 2000 - MIN_CUE_DURATION_MS, endMs: 2000 })
  })

  it('rounds fractional drag positions', () => {
    const next = retimeCue(track(), 'subtitle-2', 1200.4, 1800.6)
    expect(next[1]).toMatchObject({ startMs: 1200, endMs: 1801 })
  })

  it('is a no-op when nothing moved, for non-finite input and for an unknown id', () => {
    const cues = track()
    expect(retimeCue(cues, 'subtitle-2', 1000, 2000)).toBe(cues)
    expect(retimeCue(cues, 'subtitle-2', Number.NaN, 2000)).toBe(cues)
    expect(retimeCue(cues, 'nope', 0, 100)).toBe(cues)
  })

  it('refuses to move a cue whose neighbours leave no room', () => {
    const cues = [
      cue({ id: 'subtitle-1', startMs: 0, endMs: 1000 }),
      cue({ id: 'subtitle-2', startMs: 1000, endMs: 1010 }),
      cue({ id: 'subtitle-3', startMs: 1010, endMs: 2000 }),
    ]
    expect(retimeCue(cues, 'subtitle-2', 900, 1100)).toBe(cues)
  })
})

describe('deleteCue', () => {
  it('removes the cue and keeps the rest by identity', () => {
    const cues = track()
    const next = deleteCue(cues, 'subtitle-2')
    expect(next.map((entry) => entry.id)).toEqual(['subtitle-1', 'subtitle-3'])
    expect(next[0]).toBe(cues[0])
  })

  it('is a no-op for an unknown id', () => {
    const cues = track()
    expect(deleteCue(cues, 'nope')).toBe(cues)
  })

  it('empties a single-cue track', () => {
    expect(deleteCue([cue()], 'subtitle-1')).toEqual([])
  })
})
