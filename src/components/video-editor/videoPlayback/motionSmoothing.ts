import { spring } from 'motion'

/**
 * Frame-stepped spring on top of `motion`'s analytical spring generator: each
 * step re-seeds a generator from the current value/velocity and samples it at
 * the (clamped) delta, so the target may move every frame. The
 * `spring({ keyframes, velocity, ... }).next(ms)` shape this relies on is
 * verified against motion 12.23.24.
 */

export interface SpringState {
  value: number
  velocity: number
  initialized: boolean
}

export interface SpringConfig {
  stiffness: number
  damping: number
  mass: number
  restDelta?: number
  restSpeed?: number
}

export function createSpringState(initialValue = 0): SpringState {
  return {
    value: initialValue,
    velocity: 0,
    initialized: false,
  }
}

export function resetSpringState(state: SpringState, initialValue?: number) {
  if (typeof initialValue === 'number') {
    state.value = initialValue
  }

  state.velocity = 0
  state.initialized = false
}

export function clampDeltaMs(deltaMs: number, fallbackMs = 1000 / 60) {
  if (!Number.isFinite(deltaMs) || deltaMs <= 0) {
    return fallbackMs
  }

  return Math.min(80, Math.max(1, deltaMs))
}

export function stepSpringValue(
  state: SpringState,
  target: number,
  deltaMs: number,
  config: SpringConfig,
) {
  const safeDeltaMs = clampDeltaMs(deltaMs)

  if (!state.initialized || !Number.isFinite(state.value)) {
    state.value = target
    state.velocity = 0
    state.initialized = true
    return state.value
  }

  const restDelta = config.restDelta ?? 0.0005
  const restSpeed = config.restSpeed ?? 0.02

  if (Math.abs(target - state.value) <= restDelta && Math.abs(state.velocity) <= restSpeed) {
    state.value = target
    state.velocity = 0
    return state.value
  }

  const previousValue = state.value
  const generator = spring({
    keyframes: [state.value, target],
    velocity: state.velocity,
    stiffness: config.stiffness,
    damping: config.damping,
    mass: config.mass,
    restDelta,
    restSpeed,
  })

  const result = generator.next(safeDeltaMs)
  state.value = result.done ? target : result.value
  state.velocity = ((state.value - previousValue) / safeDeltaMs) * 1000

  if (result.done) {
    state.velocity = 0
  }

  return state.value
}

export function getZoomSpringConfig(): SpringConfig {
  return {
    stiffness: 320,
    damping: 40,
    mass: 0.92,
    restDelta: 0.0005,
    restSpeed: 0.015,
  }
}
