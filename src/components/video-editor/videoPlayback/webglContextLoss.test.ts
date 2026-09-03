import { describe, expect, it, vi } from 'vitest'
import { createContextLossRecovery } from './webglContextLoss'

const noop = () => undefined
const silentLog = { warn: noop, error: noop, info: noop }

function harness(overrides: Partial<Parameters<typeof createContextLossRecovery>[0]> = {}) {
  let clock = 0
  const timers: Array<{ fn: () => void; at: number; cancelled: boolean }> = []
  const regenerate = vi.fn()
  const onGiveUp = vi.fn()
  const recovery = createContextLossRecovery({
    regenerate,
    onGiveUp,
    now: () => clock,
    schedule: (fn, delayMs) => {
      const timer = { fn, at: clock + delayMs, cancelled: false }
      timers.push(timer)
      return timer
    },
    cancel: (handle) => {
      ;(handle as { cancelled: boolean }).cancelled = true
    },
    log: silentLog,
    ...overrides,
  })
  const advance = (ms: number) => {
    clock += ms
    for (const timer of timers.splice(0)) {
      if (!timer.cancelled && timer.at <= clock) timer.fn()
      else if (!timer.cancelled) timers.push(timer)
    }
  }
  const lostEvent = () => ({ preventDefault: vi.fn() })
  return { recovery, regenerate, onGiveUp, advance, lostEvent, timers }
}

describe('createContextLossRecovery', () => {
  it('opts in to restoration with preventDefault and asks the host to rebuild', () => {
    const { recovery, regenerate, lostEvent } = harness()
    const event = lostEvent()

    expect(recovery.handleContextLost(event)).toBe('rebuild')

    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(regenerate).toHaveBeenCalledOnce()
    expect(recovery.state).toMatchObject({ generation: 1, pendingRebuild: true, failures: 0 })
  })

  it('ignores a second loss while the rebuild is pending (double fire guard)', () => {
    const { recovery, regenerate, lostEvent } = harness()
    recovery.handleContextLost(lostEvent())
    const second = lostEvent()

    expect(recovery.handleContextLost(second)).toBe('ignored')

    // preventDefault is still called: the browser must be told every time.
    expect(second.preventDefault).toHaveBeenCalledOnce()
    expect(regenerate).toHaveBeenCalledOnce()
  })

  it('accepts a new loss once the rebuilt stage has been up for a while', () => {
    const { recovery, regenerate, onGiveUp, advance, lostEvent } = harness()
    recovery.handleContextLost(lostEvent())
    recovery.rebuildSucceeded()
    advance(10_000)

    expect(recovery.handleContextLost(lostEvent())).toBe('rebuild')

    expect(regenerate).toHaveBeenCalledTimes(2)
    expect(onGiveUp).not.toHaveBeenCalled()
    expect(recovery.state.failures).toBe(0)
  })

  it('retries once after a rebuild that threw, then gives up on the second failure', () => {
    const { recovery, regenerate, onGiveUp, advance, lostEvent, timers } = harness()
    recovery.handleContextLost(lostEvent())

    expect(recovery.rebuildFailed(new Error('no webgl'))).toBe('retry')
    expect(regenerate).toHaveBeenCalledOnce()
    expect(timers).toHaveLength(1)

    advance(1000)
    expect(regenerate).toHaveBeenCalledTimes(2)
    expect(recovery.state.pendingRebuild).toBe(true)

    expect(recovery.rebuildFailed(new Error('still no webgl'))).toBe('gave-up')
    expect(onGiveUp).toHaveBeenCalledOnce()
    expect(onGiveUp).toHaveBeenCalledWith('rebuild-failed')
    expect(recovery.state.gaveUp).toBe(true)

    // Nothing else is attempted afterwards, but the browser still gets preventDefault.
    const late = lostEvent()
    expect(recovery.handleContextLost(late)).toBe('gave-up')
    expect(late.preventDefault).toHaveBeenCalledOnce()
    expect(regenerate).toHaveBeenCalledTimes(2)
    expect(onGiveUp).toHaveBeenCalledOnce()
  })

  it('treats a loss right after a successful rebuild as a failed rebuild (flapping context)', () => {
    const { recovery, regenerate, onGiveUp, advance, lostEvent } = harness()
    recovery.handleContextLost(lostEvent())
    recovery.rebuildSucceeded()
    advance(500)

    // First flap: still worth one more rebuild.
    expect(recovery.handleContextLost(lostEvent())).toBe('rebuild')
    expect(recovery.state.failures).toBe(1)
    recovery.rebuildSucceeded()
    advance(500)

    // Second flap inside the stable window: stop.
    expect(recovery.handleContextLost(lostEvent())).toBe('gave-up')
    expect(regenerate).toHaveBeenCalledTimes(2)
    expect(onGiveUp).toHaveBeenCalledWith('context-flapping')
  })

  it('a stable stage between two flaps resets the streak', () => {
    const { recovery, onGiveUp, advance, lostEvent } = harness()
    recovery.handleContextLost(lostEvent())
    recovery.rebuildSucceeded()
    advance(500)
    recovery.handleContextLost(lostEvent())
    recovery.rebuildSucceeded()
    advance(60_000)

    expect(recovery.handleContextLost(lostEvent())).toBe('rebuild')
    expect(recovery.state.failures).toBe(0)
    expect(onGiveUp).not.toHaveBeenCalled()
  })

  it('dispose cancels a pending retry so an unmounted host is not regenerated', () => {
    const { recovery, regenerate, advance, lostEvent, timers } = harness()
    recovery.handleContextLost(lostEvent())
    recovery.rebuildFailed(new Error('boom'))
    recovery.dispose()

    expect(timers[0].cancelled).toBe(true)
    advance(5000)
    expect(regenerate).toHaveBeenCalledOnce()
  })

  it('honours a custom failure budget', () => {
    const { recovery, onGiveUp, lostEvent } = harness({ maxFailures: 1 })
    recovery.handleContextLost(lostEvent())

    expect(recovery.rebuildFailed(new Error('boom'))).toBe('gave-up')
    expect(onGiveUp).toHaveBeenCalledOnce()
  })

  it('logs the restored event without changing state', () => {
    const info = vi.fn()
    const { recovery, lostEvent } = harness({ log: { ...silentLog, info } })
    recovery.handleContextLost(lostEvent())
    recovery.handleContextRestored()

    expect(info).toHaveBeenCalledOnce()
    expect(recovery.state.pendingRebuild).toBe(true)
  })
})
