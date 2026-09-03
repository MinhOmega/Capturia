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

  /** One microtask drain is not enough: the exit handler stats the output file. */
  async function settle() {
    for (let index = 0; index < 5; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }

  it('announces an exit nobody asked for, with the file verdict attached', async () => {
    const outputPath = path.join(dir, 'recording-1.mp4')
    await writeFile(outputPath, mp4Bytes({ withMoov: true }))
    const module = await startRecorder(outputPath)

    const onExit = vi.fn()
    module.setNativeRecorderExitListener(onExit)
    helper.end(1, null)
    await settle()

    expect(onExit).toHaveBeenCalledTimes(1)
    expect(onExit.mock.calls[0][0]).toEqual({
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
    await settle()

    expect(onExit).toHaveBeenCalledTimes(1)
    expect(onExit.mock.calls[0][0]).toMatchObject({
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
    await settle()

    expect(onExit).not.toHaveBeenCalled()
  })

  it('stays silent when a force-terminate ends the helper', async () => {
    const outputPath = path.join(dir, 'recording-4.mp4')
    await writeFile(outputPath, mp4Bytes({ withMoov: true }))
    const module = await startRecorder(outputPath)

    const onExit = vi.fn()
    module.setNativeRecorderExitListener(onExit)
    module.forceTerminateNativeMacRecorder()
    helper.end(null, 'SIGTERM')
    await settle()

    expect(onExit).not.toHaveBeenCalled()
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
