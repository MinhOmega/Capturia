import { describe, expect, it } from 'vitest'
import {
  contentRangeHeader,
  parseRangeHeader,
  type RangeRequest,
  unsatisfiableContentRangeHeader,
} from './rangeRequests'

const SIZE = 1000

describe('parseRangeHeader', () => {
  const cases: ReadonlyArray<{
    name: string
    header: string | null | undefined
    size?: number
    expected: RangeRequest
  }> = [
    { name: 'no header serves the whole file', header: null, expected: { kind: 'full' } },
    { name: 'an empty header serves the whole file', header: '', expected: { kind: 'full' } },
    {
      name: 'a closed range is served as asked',
      header: 'bytes=100-199',
      expected: { kind: 'partial', start: 100, end: 199, length: 100 },
    },
    {
      name: 'a single byte is a range of one',
      header: 'bytes=0-0',
      expected: { kind: 'partial', start: 0, end: 0, length: 1 },
    },
    {
      name: 'an open-ended range stops at the last byte',
      header: 'bytes=900-',
      expected: { kind: 'partial', start: 900, end: 999, length: 100 },
    },
    {
      name: 'the probe a video element opens with covers the whole file',
      header: 'bytes=0-',
      expected: { kind: 'partial', start: 0, end: 999, length: 1000 },
    },
    {
      name: 'an end past the file is clamped to the last byte',
      header: 'bytes=990-100000',
      expected: { kind: 'partial', start: 990, end: 999, length: 10 },
    },
    {
      name: 'a suffix range counts back from the end',
      header: 'bytes=-50',
      expected: { kind: 'partial', start: 950, end: 999, length: 50 },
    },
    {
      name: 'a suffix longer than the file is the whole file',
      header: 'bytes=-5000',
      expected: { kind: 'partial', start: 0, end: 999, length: 1000 },
    },
    {
      name: 'a zero-length suffix is unsatisfiable',
      header: 'bytes=-0',
      expected: { kind: 'unsatisfiable' },
    },
    {
      name: 'a start at the end of the file is unsatisfiable',
      header: 'bytes=1000-1100',
      expected: { kind: 'unsatisfiable' },
    },
    {
      name: 'a start past the end of the file is unsatisfiable',
      header: 'bytes=5000-',
      expected: { kind: 'unsatisfiable' },
    },
    {
      name: 'a reversed range is invalid, so the header is ignored',
      header: 'bytes=500-100',
      expected: { kind: 'full' },
    },
    {
      name: 'a unit other than bytes is ignored',
      header: 'frames=1-10',
      expected: { kind: 'full' },
    },
    {
      name: 'a multi-range request is ignored rather than refused',
      header: 'bytes=0-99,200-299',
      expected: { kind: 'full' },
    },
    {
      name: 'a garbled header is ignored',
      header: 'bytes=abc-def',
      expected: { kind: 'full' },
    },
    {
      name: 'bytes=- with neither end is ignored',
      header: 'bytes=-',
      expected: { kind: 'full' },
    },
    {
      name: 'surrounding whitespace does not matter',
      header: '  bytes=10-19  ',
      expected: { kind: 'partial', start: 10, end: 19, length: 10 },
    },
    {
      name: 'every range of an empty file is unsatisfiable',
      header: 'bytes=0-',
      size: 0,
      expected: { kind: 'unsatisfiable' },
    },
    {
      name: 'a suffix of an empty file is unsatisfiable',
      header: 'bytes=-10',
      size: 0,
      expected: { kind: 'unsatisfiable' },
    },
    {
      name: 'the whole of a one-byte file is a range of one',
      header: 'bytes=0-',
      size: 1,
      expected: { kind: 'partial', start: 0, end: 0, length: 1 },
    },
  ]

  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(parseRangeHeader(testCase.header, testCase.size ?? SIZE)).toEqual(testCase.expected)
    })
  }

  it('never reports a length that runs past the end of the file', () => {
    const size = 4096
    for (const header of ['bytes=0-', 'bytes=4095-', 'bytes=0-999999', 'bytes=-99999']) {
      const parsed = parseRangeHeader(header, size)
      expect(parsed.kind).toBe('partial')
      if (parsed.kind !== 'partial') continue
      expect(parsed.end).toBeLessThan(size)
      expect(parsed.start).toBeGreaterThanOrEqual(0)
      expect(parsed.length).toBe(parsed.end - parsed.start + 1)
    }
  })
})

describe('content range headers', () => {
  it('formats a satisfied range', () => {
    expect(contentRangeHeader(0, 999, 1000)).toBe('bytes 0-999/1000')
  })

  it('formats an unsatisfiable range', () => {
    expect(unsatisfiableContentRangeHeader(1000)).toBe('bytes */1000')
  })
})
