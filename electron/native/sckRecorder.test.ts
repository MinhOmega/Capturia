import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AckWaiters,
  NO_NATIVE_RECORDER_CAPABILITIES,
  getNativeMacRecorderCapabilities,
  parseCapsLine,
  parsePauseAckLine,
  pauseNativeMacRecorder,
  resumeNativeMacRecorder,
} from './sckRecorder'

vi.mock('electron', async () => (await import('../ipc/__tests__/ipcTestKit')).createElectronMock())

describe('sck-recorder stdout protocol', () => {
  it('parses the capability line and ignores unknown names', () => {
    expect(parseCapsLine('SCK_RECORDER_CAPS pause')).toEqual({ pause: true })
    expect(parseCapsLine('SCK_RECORDER_CAPS   pause  future-thing')).toEqual({ pause: true })
    expect(parseCapsLine('SCK_RECORDER_CAPS')).toEqual({ pause: false })
    expect(parseCapsLine('SCK_RECORDER_CAPS something-else')).toEqual({ pause: false })
    expect(parseCapsLine('SCK_RECORDER_READY width=1 height=1 fps=60 source=display')).toBeNull()
    expect(parseCapsLine('[log] SCK_RECORDER_CAPS pause')).toBeNull()
  })

  it('parses pause / resume acks only', () => {
    expect(parsePauseAckLine('SCK_RECORDER_PAUSED')).toBe('paused')
    expect(parsePauseAckLine('  sck_recorder_resumed ')).toBe('resumed')
    expect(parsePauseAckLine('SCK_RECORDER_DONE frames=1')).toBeNull()
    expect(parsePauseAckLine('SCK_RECORDER_PAUSED extra')).toBeNull()
  })
})

describe('AckWaiters', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves a waiter when its ack arrives and rejects the others on timeout', async () => {
    vi.useFakeTimers()
    const waiters = new AckWaiters()
    const paused = waiters.wait('paused', 1_000)
    const resumed = waiters.wait('resumed', 1_000)
    expect(waiters.pendingCount).toBe(2)

    expect(waiters.settle('paused')).toBe(true)
    await expect(paused).resolves.toBe(true)
    expect(waiters.settle('paused')).toBe(false)

    vi.advanceTimersByTime(1_000)
    await expect(resumed).resolves.toBe(false)
    expect(waiters.pendingCount).toBe(0)
  })

  it('shares one ack between two identical pending commands', async () => {
    vi.useFakeTimers()
    const waiters = new AckWaiters()
    const first = waiters.wait('paused', 1_000)
    const second = waiters.wait('paused', 1_000)
    expect(waiters.pendingCount).toBe(1)
    waiters.settle('paused')
    await expect(Promise.all([first, second])).resolves.toEqual([true, true])
  })

  it('abortAll fails every pending waiter', async () => {
    vi.useFakeTimers()
    const waiters = new AckWaiters()
    const paused = waiters.wait('paused', 1_000)
    waiters.abortAll()
    await expect(paused).resolves.toBe(false)
    expect(waiters.pendingCount).toBe(0)
  })
})

describe('pause / resume without a helper', () => {
  it('reports unsupported when no native session is active', async () => {
    expect(getNativeMacRecorderCapabilities()).toEqual(NO_NATIVE_RECORDER_CAPABILITIES)
    await expect(pauseNativeMacRecorder()).resolves.toMatchObject({
      success: false,
      supported: false,
    })
    await expect(resumeNativeMacRecorder()).resolves.toMatchObject({
      success: false,
      supported: false,
    })
  })
})
