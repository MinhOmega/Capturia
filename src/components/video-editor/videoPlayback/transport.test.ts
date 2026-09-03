import { describe, expect, it } from 'vitest'

import { MAX_NATIVE_PLAYBACK_RATE } from './frameStepPreview'
import {
  maxTransportRate,
  stepTransport,
  TRANSPORT_RATE_LADDER,
  type TransportState,
} from './transport'

const paused = (rate = 1): TransportState => ({ rate, playing: false })
const playing = (rate: number): TransportState => ({ rate, playing: true })

describe('stepTransport', () => {
  it('K pauses and keeps the rate so resuming plays at the same speed', () => {
    expect(stepTransport(playing(2), 'k')).toEqual({ rate: 2, playing: false })
  })

  it('K on a paused preview changes nothing', () => {
    const state = paused(2)
    expect(stepTransport(state, 'k')).toBe(state)
  })

  it('L starts a paused preview at 1x and then climbs 1x, 2x, 4x', () => {
    expect(stepTransport(paused(0.25), 'l')).toEqual({ rate: 1, playing: true })
    expect(stepTransport(playing(1), 'l')).toEqual({ rate: 2, playing: true })
    expect(stepTransport(playing(2), 'l')).toEqual({ rate: 4, playing: true })
  })

  it('L stays at the top rung instead of wrapping round', () => {
    const top = playing(4)
    expect(stepTransport(top, 'l')).toBe(top)
  })

  it('J steps down to half speed and then pauses', () => {
    expect(stepTransport(playing(4), 'j')).toEqual({ rate: 2, playing: true })
    expect(stepTransport(playing(2), 'j')).toEqual({ rate: 1, playing: true })
    expect(stepTransport(playing(1), 'j')).toEqual({ rate: 0.5, playing: true })
    expect(stepTransport(playing(0.5), 'j')).toEqual({ rate: 0.5, playing: false })
  })

  it('J on a paused preview changes nothing: it is already as slow as it goes', () => {
    const state = paused(1)
    expect(stepTransport(state, 'j')).toBe(state)
  })

  it('J and L are inverses in the middle of the ladder', () => {
    for (const rate of [1, 2]) {
      expect(stepTransport(stepTransport(playing(rate), 'l'), 'j')).toEqual(playing(rate))
    }
  })

  it('lands on a rung from a speed the menu offers that is not on the ladder', () => {
    expect(stepTransport(playing(3), 'j')).toEqual({ rate: 2, playing: true })
    expect(stepTransport(playing(3), 'l')).toEqual({ rate: 4, playing: true })
    expect(stepTransport(playing(0.25), 'l')).toEqual({ rate: 0.5, playing: true })
    expect(stepTransport(playing(0.25), 'j')).toEqual({ rate: 0.25, playing: false })
  })

  it('never climbs past what the media element accepts', () => {
    expect(stepTransport(playing(1), 'l', 2)).toEqual({ rate: 2, playing: true })
    const capped = playing(2)
    expect(stepTransport(capped, 'l', 2)).toBe(capped)
    // A rate above the cap (a frame-stepped segment speed) comes back down to it.
    expect(stepTransport(playing(32), 'l', 4)).toEqual({ rate: 4, playing: true })
    // Below every rung: the only rung left is the cap itself.
    expect(stepTransport(paused(1), 'l', 0.25)).toEqual({ rate: 0.25, playing: true })
  })

  it('falls back to the native cap for a nonsense limit', () => {
    expect(maxTransportRate(Number.NaN)).toBe(4)
    expect(maxTransportRate(0)).toBe(4)
    expect(maxTransportRate(MAX_NATIVE_PLAYBACK_RATE)).toBe(4)
    expect(maxTransportRate(2)).toBe(2)
    expect(TRANSPORT_RATE_LADDER).toEqual([0.5, 1, 2, 4])
  })

  it('treats a nonsense current rate as normal speed', () => {
    expect(stepTransport({ rate: Number.NaN, playing: true }, 'l')).toEqual({
      rate: 2,
      playing: true,
    })
  })
})
