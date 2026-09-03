import { describe, expect, it } from 'vitest'
import {
  getTextAnimationState,
  normalizeTextAnimation,
  TEXT_ANIMATION_DURATION_MS,
  TEXT_ANIMATION_OPTIONS,
} from './annotationTextAnimation'

describe('annotation text animations', () => {
  it('normalizes unknown animation values to none', () => {
    expect(normalizeTextAnimation('rise')).toBe('rise')
    expect(normalizeTextAnimation('not-real')).toBe('none')
    expect(normalizeTextAnimation(undefined)).toBe('none')
  })

  it('returns a settled state when animation is disabled', () => {
    expect(
      getTextAnimationState(
        {
          startMs: 1000,
          style: { textAnimation: 'none' },
        },
        1000,
      ),
    ).toEqual({
      opacity: 1,
      scale: 1,
      translateX: 0,
      translateY: 0,
      revealProgress: 1,
    })
  })

  it('eases rise animations into place over time', () => {
    const initial = getTextAnimationState(
      {
        startMs: 1000,
        style: { textAnimation: 'rise' },
      },
      1000,
    )
    const settled = getTextAnimationState(
      {
        startMs: 1000,
        style: { textAnimation: 'rise' },
      },
      2000,
    )

    expect(initial.opacity).toBe(0)
    expect(initial.translateY).toBeGreaterThan(0)
    expect(settled.opacity).toBe(1)
    expect(settled.translateY).toBe(0)
  })

  it('reveals typewriter text progressively and fully after the duration', () => {
    const annotation = { startMs: 500, style: { textAnimation: 'typewriter' as const } }
    expect(getTextAnimationState(annotation, 500).revealProgress).toBe(0)
    expect(
      getTextAnimationState(annotation, 500 + TEXT_ANIMATION_DURATION_MS / 2).revealProgress,
    ).toBeCloseTo(0.5)
    expect(getTextAnimationState(annotation, 500 + TEXT_ANIMATION_DURATION_MS).revealProgress).toBe(
      1,
    )
  })

  it('treats time before startMs as the beginning of the animation', () => {
    const state = getTextAnimationState({ startMs: 1000, style: { textAnimation: 'fade' } }, 0)
    expect(state.opacity).toBe(0)
  })

  it('settles every preset once the animation has finished', () => {
    for (const { value } of TEXT_ANIMATION_OPTIONS) {
      const state = getTextAnimationState(
        { startMs: 0, style: { textAnimation: value } },
        TEXT_ANIMATION_DURATION_MS * 2,
      )
      expect(state.opacity).toBe(1)
      expect(state.translateX).toBeCloseTo(0, 10)
      expect(state.translateY).toBeCloseTo(0, 10)
      expect(state.revealProgress).toBe(1)
      expect(state.scale).toBeCloseTo(1, 5)
    }
  })
})
