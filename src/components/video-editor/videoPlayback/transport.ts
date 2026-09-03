/**
 * J / K / L transport for the preview.
 *
 * The editing convention: K pauses, L plays forward and steps the speed up on
 * every further press, J steps it back down. Capturia's preview is an
 * `HTMLMediaElement`, which cannot play backwards at all — `playbackRate` must
 * be positive — so J does what it can instead: down to half speed, and one
 * more press pauses. Reverse would need a decoded-frame cache the preview does
 * not keep; see `frameStepPreview.ts` for the machinery that already exists at
 * the *fast* end.
 *
 * A DOM-free reducer so the key handler stays a two-liner and the ladder can be
 * checked directly.
 */

import { MAX_NATIVE_PLAYBACK_RATE, MIN_NATIVE_PLAYBACK_RATE } from './frameStepPreview'

/** Rungs J steps down through; L uses the same list from 1x up. */
export const TRANSPORT_RATE_LADDER = [0.5, 1, 2, 4] as const

/** The normal rung L starts from when the preview is paused. */
export const TRANSPORT_PLAY_RATE = 1

export type TransportKey = 'j' | 'k' | 'l'

export interface TransportState {
  /** Preview rate multiplier (`previewPlaybackRate`). */
  rate: number
  /** False when the preview is paused. */
  playing: boolean
}

/**
 * The fastest rung the element will actually honour. `frameStepPreview` can
 * drive speeds above the element's cap by stepping frames, but the transport
 * deliberately stays inside native playback: J/K/L is a review tool and a
 * frame-stepped preview is silent.
 */
export function maxTransportRate(nativeCap: number = MAX_NATIVE_PLAYBACK_RATE): number {
  const cap = Number.isFinite(nativeCap) && nativeCap > 0 ? nativeCap : MAX_NATIVE_PLAYBACK_RATE
  const top = TRANSPORT_RATE_LADDER[TRANSPORT_RATE_LADDER.length - 1]
  return Math.max(MIN_NATIVE_PLAYBACK_RATE, Math.min(top, cap))
}

/** The rungs available with this cap, slowest first; always at least one. */
function availableRungs(nativeCap: number): number[] {
  const max = maxTransportRate(nativeCap)
  const rungs = TRANSPORT_RATE_LADDER.filter((rate) => rate <= max + 1e-9)
  return rungs.length > 0 ? rungs : [max]
}

/**
 * The transport state after one J / K / L press.
 *
 * - `k` pauses and keeps the rate, so resuming plays at the same speed.
 * - `l` starts a paused preview at 1x, and otherwise climbs the ladder up to
 *   the cap; at the top it stays there rather than wrapping around.
 * - `j` steps down the ladder and pauses once it is below the slowest rung.
 *   A paused preview stays paused: it is already as slow as it goes.
 *
 * A rate that is not on the ladder (the speed menu offers 3x, 8x, 32x too) is
 * treated as its position on the ladder, so the first press lands on a rung
 * rather than doing nothing.
 */
export function stepTransport(
  state: TransportState,
  key: TransportKey,
  nativeCap: number = MAX_NATIVE_PLAYBACK_RATE,
): TransportState {
  const rungs = availableRungs(nativeCap)
  const fastest = rungs[rungs.length - 1]
  const rate = Number.isFinite(state.rate) && state.rate > 0 ? state.rate : TRANSPORT_PLAY_RATE

  if (key === 'k') {
    return state.playing ? { rate: state.rate, playing: false } : state
  }

  if (key === 'l') {
    if (!state.playing) {
      return { rate: Math.min(TRANSPORT_PLAY_RATE, fastest), playing: true }
    }
    const next = rungs.find((rung) => rung > rate + 1e-9)
    if (next === undefined) {
      return rate > fastest + 1e-9 ? { rate: fastest, playing: true } : state
    }
    return { rate: next, playing: true }
  }

  // 'j'
  if (!state.playing) return state
  const slower = [...rungs].reverse().find((rung) => rung < rate - 1e-9)
  // Nothing slower than the slowest rung: the only step left is a pause.
  if (slower === undefined) return { rate: state.rate, playing: false }
  return { rate: slower, playing: true }
}
