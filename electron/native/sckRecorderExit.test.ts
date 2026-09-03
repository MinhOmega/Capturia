import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('../ipc/__tests__/ipcTestKit')).createElectronMock())

const spawnMock = vi.fn()
vi.mock('node:child_process', () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }))

/**
 * A stand-in for the Swift helper: the pipes the recorder wires up, plus a
 * controllable `exit`. The real helper cannot be built or run here (it is
 * macOS-only Swift), so the exit path is exercised through this instead.
 */
class FakeHelperProcess extends EventEmitter {
  pid = 4242
  exitCode: number | null = null
  stdout = new PassThrough()
  stderr = new PassThrough()
  stdin = Object.assign(new PassThrough(), { destroyed: false, writable: true })
  kill = vi.fn()

  announceReady(): void {
    this.stdout.write('SCK_RECORDER_READY width=1920 height=1080 fps=60 source=display mic=0\n')
    this.stdout.write('SCK_RECORDER_CAPS pause\n')
  }

  end(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitCode = code
    this.emit('exit', code, signal)
  }
}

const REAL_PLATFORM = process.platform
function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

/** `ftyp` + `mdat` + optional `moov`, which is all the box walk looks at. */
function mp4Bytes(options: { withMoov: boolean }): Buffer {
  const box = (type: string, payload: number) => {
    const buffer = Buffer.alloc(8 + payload)
    buffer.writeUInt32BE(8 + payload, 0)
    buffer.write(type, 4, 'ascii')
    return buffer
  }
  const parts = [box('ftyp', 24), box('mdat', 4_096)]
  if (options.withMoov) parts.push(box('moov', 512))
  return Buffer.concat(parts)
}

describe('native recorder helper exit', () => {
  let dir: string
  let helper: FakeHelperProcess

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'capturia-sck-exit-'))
    // `ensureHelperBinary` returns early once the binary exists at this path.
    const binDir = path.join('/tmp/capturia-test/app', 'electron', 'native', 'bin')
    await mkdir(binDir, { recursive: true })
    await writeFile(path.join(binDir, 'sck-recorder'), '#!/bin/sh\n')

    setPlatform('darwin')
    vi.spyOn(os, 'release').mockReturnValue('23.0.0')
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    helper = new FakeHelperProcess()
    spawnMock.mockImplementation(() => {
      setImmediate(() => helper.announceReady())
      return helper
    })
    vi.resetModules()
  })

  afterEach(async () => {
    setPlatform(REAL_PLATFORM)
    vi.restoreAllMocks()
    spawnMock.mockReset()
    await rm(dir, { recursive: true, force: true })
  })

  async function startRecorder(outputPath: string) {
    const module = await import('./sckRecorder')
    const started = await module.startNativeMacRecorder({
      outputPath,
      cursorMode: 'always',
      frameRate: 60,
    })
    expect(started.success).toBe(true)
    return module
  }

  const POLL_INTERVAL_MS = 5
  /** Generous: only ever waited out in full when the assertion is about to fail. */
  const WAIT_TIMEOUT_MS = 2_000
  /**
   * How long an exit that should stay silent is given to speak up. The announce
   * path stats the output file first, so this has to outlast one file check on
   * a loaded machine - but a wrong announce is caught as soon as it lands.
   */
  const SILENCE_WINDOW_MS = 250

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  /**
   * Polls until `predicate` holds. The exit handler stats the output file
   * before announcing, and a fixed sleep long enough for that on an idle box
   * is not long enough on a loaded one - so wait for the outcome, not a clock.
   */
  async function waitFor(predicate: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + WAIT_TIMEOUT_MS
    while (!predicate()) {
      if (Date.now() >= deadline) {
        throw new Error(`timed out after ${WAIT_TIMEOUT_MS}ms waiting for ${what}`)
      }
      await sleep(POLL_INTERVAL_MS)
    }
  }

  /** Waits for the exit to reach the listener, then hands back what it got. */
  async function waitForExitInfo(onExit: ReturnType<typeof vi.fn>): Promise<unknown> {
    await waitFor(() => onExit.mock.calls.length > 0, 'the exit listener to be called')
    return onExit.mock.calls[0][0]
  }

  /**
   * Asserts the listener stays quiet, failing the moment it does not rather
   * than only at the end of the window.
   */
  async function expectNoExitAnnounced(onExit: ReturnType<typeof vi.fn>): Promise<void> {
    const deadline = Date.now() + SILENCE_WINDOW_MS
    while (Date.now() < deadline) {
      expect(onExit).not.toHaveBeenCalled()
      await sleep(POLL_INTERVAL_MS)
    }
    expect(onExit).not.toHaveBeenCalled()
  }

  it('announces an exit nobody asked for, with the file verdict attached', async () => {
    const outputPath = path.join(dir, 'recording-1.mp4')
    await writeFile(outputPath, mp4Bytes({ withMoov: true }))
    const module = await startRecorder(outputPath)

    const onExit = vi.fn()
    module.setNativeRecorderExitListener(onExit)
    helper.end(1, null)
    const info = await waitForExitInfo(onExit)

    expect(onExit).toHaveBeenCalledTimes(1)
    expect(info).toEqual({
      code: 1,
      signal: null,
      reason: 'crashed',
      outputPath,
      outputPlayable: true,
    })
    expect(module.isNativeMacRecorderActive()).toBe(false)
  })

  it('marks a killed helper and reports an unplayable partial file', async () => {
    const outputPath = path.join(dir, 'recording-2.mp4')
    await writeFile(outputPath, mp4Bytes({ withMoov: false }))
    const module = await startRecorder(outputPath)

    const onExit = vi.fn()
    module.setNativeRecorderExitListener(onExit)
    helper.end(null, 'SIGKILL')
    const info = await waitForExitInfo(onExit)

    expect(onExit).toHaveBeenCalledTimes(1)
    expect(info).toMatchObject({
      signal: 'SIGKILL',
      reason: 'killed',
      outputPlayable: false,
    })
  })

  it('stays silent when the exit follows a stop we asked for', async () => {
    const outputPath = path.join(dir, 'recording-3.mp4')
    await writeFile(outputPath, mp4Bytes({ withMoov: true }))
    const module = await startRecorder(outputPath)

    const onExit = vi.fn()
    module.setNativeRecorderExitListener(onExit)
    // The stop marks the session and SIGINTs the helper; the close that follows
    // is the expected one and must not look like an interruption.
    const stopping = module.stopNativeMacRecorder()
    helper.end(0, null)
    await expect(stopping).resolves.toMatchObject({ success: true, path: outputPath })

    await expectNoExitAnnounced(onExit)
  })

  it('stays silent when a force-terminate ends the helper', async () => {
    const outputPath = path.join(dir, 'recording-4.mp4')
    await writeFile(outputPath, mp4Bytes({ withMoov: true }))
    const module = await startRecorder(outputPath)

    const onExit = vi.fn()
    module.setNativeRecorderExitListener(onExit)
    module.forceTerminateNativeMacRecorder()
    helper.end(null, 'SIGTERM')

    await expectNoExitAnnounced(onExit)
  })

  it('refuses to hand the editor a file with no moov after an unclean stop', async () => {
    const outputPath = path.join(dir, 'recording-5.mp4')
    await writeFile(outputPath, mp4Bytes({ withMoov: false }))
    const module = await startRecorder(outputPath)

    const stopping = module.stopNativeMacRecorder()
    // The helper was killed rather than finishing: no `moov` was ever written.
    helper.end(null, 'SIGKILL')
    await expect(stopping).resolves.toMatchObject({
      success: false,
      code: 'output_missing_moov',
      path: outputPath,
    })
  })

  it('accepts an unclean exit whose file did get finalized', async () => {
    const outputPath = path.join(dir, 'recording-6.mp4')
    await writeFile(outputPath, mp4Bytes({ withMoov: true }))
    const module = await startRecorder(outputPath)

    const stopping = module.stopNativeMacRecorder()
    helper.end(3, null)
    await expect(stopping).resolves.toMatchObject({ success: true, path: outputPath })
  })
})
