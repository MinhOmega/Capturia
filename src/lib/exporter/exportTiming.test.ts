import { describe, expect, it } from 'vitest'
import { buildExportTimingSummary, formatExportClock } from './exportTiming'

describe('formatExportClock', () => {
  it.each([
    [0, '0s'],
    [0.4, '0s'],
    [0.6, '1s'],
    [9, '9s'],
    [59, '59s'],
    [59.6, '1m 00s'],
    [60, '1m 00s'],
    [65, '1m 05s'],
    [3599, '59m 59s'],
    [3600, '1h 00m'],
    [3720, '1h 02m'],
  ])('formats %ss as %s', (seconds, expected) => {
    expect(formatExportClock(seconds)).toBe(expected)
  })

  it.each([[-5], [Number.NaN], [Number.POSITIVE_INFINITY]])(
    'reads %j as zero rather than printing nonsense',
    (value) => {
      expect(formatExportClock(value)).toBe('0s')
    },
  )
})

describe('buildExportTimingSummary', () => {
  it('produces the two strings the success toast interpolates', () => {
    expect(buildExportTimingSummary(12_000, 3_000)).toEqual({ video: '12s', elapsed: '3s' })
  })

  it('handles an export slower than real time', () => {
    expect(buildExportTimingSummary(12_000, 95_000)).toEqual({ video: '12s', elapsed: '1m 35s' })
  })

  it('handles a source-copy export that finished almost instantly', () => {
    expect(buildExportTimingSummary(600_000, 400)).toEqual({ video: '10m 00s', elapsed: '0s' })
  })
})
