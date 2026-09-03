import { app } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileHasMp4MoovBox } from '../ipc/mp4Boxes'

export type NativeCursorMode = 'always' | 'never'

export type NativeRecorderStartOptions = {
  outputPath: string
  sourceId?: string
  displayId?: string
  cursorMode: NativeCursorMode
  microphoneEnabled?: boolean
  microphoneGain?: number
  cameraEnabled?: boolean
  cameraShape?: 'rounded' | 'square' | 'circle'
  cameraSizePercent?: number
  /**
   * Preferred camera. `cameraDeviceId` is Chromium's per-origin hashed id (it only
   * matches an AVCaptureDevice `uniqueID` by coincidence); `cameraDeviceName` is
   * the label the browser reported, which the helper matches against
   * `localizedName`. Both are best-effort: the helper keeps its own pick otherwise.
   */
  cameraDeviceId?: string
  cameraDeviceName?: string
  /**
   * Preferred microphone, same contract as the camera pair: the helper tries the
   * AVCaptureDevice `uniqueID`, then the label under the word-boundary rules of
   * `electron/recording/deviceNameMatching.ts`, else opens the system default and
   * prints `SCK_RECORDER_WARN mic_device_not_found`.
   */
  microphoneDeviceId?: string
  microphoneDeviceName?: string
  /**
   * Capture what the system plays (`--system-audio 1`). The helper mixes it with
   * the mic into one AAC track; an old helper ignores the flag and the ready line
   * then reports `system_audio=0` (see `hasSystemAudio`).
   */
  systemAudio?: boolean
  frameRate: number
  bitrateScale?: number
  width?: number
  height?: number
}

export type NativeRecorderStopResult = {
  success: boolean
  path?: string
  message?: string
  /**
   * Machine-readable failure reason. `output_missing_moov` means the helper
   * died before finalizing the MP4, so the file on disk cannot be played and
   * the editor must not open it.
   */
  code?: 'no_session' | 'output_missing' | 'output_missing_moov'
  metadata?: {
    frameRate: number
    width: number
    height: number
    mimeType: string
    capturedAt: number
    systemCursorMode: NativeCursorMode
    hasMicrophoneAudio: boolean
    hasSystemAudio: boolean
  }
}

export type RecorderReadyInfo = {
  width: number
  height: number
  frameRate: number
  sourceKind: 'display' | 'window' | 'unknown'
  hasMicrophoneAudio: boolean
  /** The helper is capturing system audio (absent on an old helper -> false). */
  hasSystemAudio: boolean
}

type RecorderHelperErrorInfo = {
  code: string
  message: string
}

type RecorderDoneInfo = {
  frameCount: number
  observedFrameRate?: number
}

/**
 * Helper features announced on stdout right after `SCK_RECORDER_READY` as
 * `SCK_RECORDER_CAPS <name> <name> ...`. A helper built before the stdin
 * protocol never prints the line, so every capability defaults to off.
 */
export type NativeRecorderCapabilities = {
  pause: boolean
  /** `--mic-device-id` / `--mic-device-name` are honoured (an old helper ignores them). */
  microphoneDevice: boolean
  /** `--system-audio 1` is honoured; the HUD hides the toggle otherwise. */
  systemAudio: boolean
}

/**
 * Non-fatal condition the helper reported on stdout as
 * `SCK_RECORDER_WARN <code> [details]` before or after READY. Codes are
 * snake_case; the renderer maps known ones to toasts.
 */
export type NativeRecorderWarning = {
  code: string
  details?: string
}

export type NativeRecorderPauseResult = {
  success: boolean
  /** False when the running helper does not implement pause (old binary). */
  supported: boolean
  message?: string
}

type PauseAck = 'paused' | 'resumed'

/**
 * The helper process ended while a recording was still running and nobody had
 * asked it to stop. Pushed to the HUD so the renderer can leave the "recording"
 * state instead of sitting there forever.
 */
export type NativeRecorderExitInfo = {
  code: number | null
  signal: NodeJS.Signals | null
  /** `killed` when a signal ended it, `crashed` for a non-zero exit of its own. */
  reason: 'killed' | 'crashed'
  /** The partial recording the helper left behind. */
  outputPath: string
  /** The partial file has a top-level `moov` box, so it can be opened (A3). */
  outputPlayable: boolean
}

export type NativeRecorderExitListener = (info: NativeRecorderExitInfo) => void

let nativeRecorderExitListener: NativeRecorderExitListener | null = null

/**
 * Installed by the IPC layer, which owns the HUD window. Kept as a setter
 * rather than an import so this module stays free of Electron window plumbing.
 */
export function setNativeRecorderExitListener(listener: NativeRecorderExitListener | null): void {
  nativeRecorderExitListener = listener
}

type ActiveNativeRecorderSession = {
  process: ChildProcess
  outputPath: string
  /**
   * Capturia asked the helper to end (stop, discard or shutdown). An exit that
   * follows is the expected one and must not be reported as an interruption.
   */
  stopRequested: boolean
  cursorMode: NativeCursorMode
  ready: RecorderReadyInfo
  capabilities: NativeRecorderCapabilities
  warnings: NativeRecorderWarning[]
  doneInfoRef: { current?: RecorderDoneInfo }
  exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  /** Pending pause/resume commands waiting for their ack line. */
  ackWaiters: AckWaiters
}

/** How long a pause/resume command may wait for `SCK_RECORDER_PAUSED|RESUMED`. */
export const NATIVE_RECORDER_ACK_TIMEOUT_MS = 3_000

let activeSession: ActiveNativeRecorderSession | null = null

export const NO_NATIVE_RECORDER_CAPABILITIES: NativeRecorderCapabilities = Object.freeze({
  pause: false,
  microphoneDevice: false,
  systemAudio: false,
})

/** `SCK_RECORDER_CAPS pause mic-device` -> `{ pause: true, ... }`; unknown names are ignored. */
export function parseCapsLine(line: string): NativeRecorderCapabilities | null {
  const match = /^SCK_RECORDER_CAPS\b(.*)$/i.exec(line.trim())
  if (!match) return null
  const names = new Set(
    String(match[1])
      .split(/\s+/)
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  )
  return {
    pause: names.has('pause'),
    microphoneDevice: names.has('mic-device'),
    systemAudio: names.has('system-audio'),
  }
}

/** `SCK_RECORDER_WARN mic_device_not_found requested=...` -> `{ code, details }`. */
export function parseWarnLine(line: string): NativeRecorderWarning | null {
  const match = /^SCK_RECORDER_WARN\s+([a-z0-9_-]+)(?:\s+(.*))?$/i.exec(line.trim())
  if (!match) return null
  const details = String(match[2] ?? '').trim()
  return {
    code: String(match[1]).toLowerCase(),
    ...(details ? { details } : {}),
  }
}

/** `SCK_RECORDER_PAUSED` / `SCK_RECORDER_RESUMED` acks for the stdin commands. */
export function parsePauseAckLine(line: string): PauseAck | null {
  const normalized = line.trim().toUpperCase()
  if (normalized === 'SCK_RECORDER_PAUSED') return 'paused'
  if (normalized === 'SCK_RECORDER_RESUMED') return 'resumed'
  return null
}

/**
 * Resolves the promise of a pending command when its ack line arrives, or with
 * `false` on timeout. One waiter per ack kind: a second `pause` while the first
 * is still pending shares the same ack.
 */
export class AckWaiters {
  private readonly pending = new Map<
    PauseAck,
    { resolvers: Array<(ok: boolean) => void>; timer: ReturnType<typeof setTimeout> }
  >()

  wait(kind: PauseAck, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const existing = this.pending.get(kind)
      if (existing) {
        existing.resolvers.push(resolve)
        return
      }
      const timer = globalThis.setTimeout(() => {
        this.finish(kind, false)
      }, timeoutMs)
      this.pending.set(kind, { resolvers: [resolve], timer })
    })
  }

  /** Returns true when a waiter was resolved. */
  settle(kind: PauseAck): boolean {
    return this.finish(kind, true)
  }

  /** Fail every pending waiter (helper exited or is being stopped). */
  abortAll(): void {
    for (const kind of [...this.pending.keys()]) {
      this.finish(kind, false)
    }
  }

  get pendingCount(): number {
    return this.pending.size
  }

  private finish(kind: PauseAck, ok: boolean): boolean {
    const entry = this.pending.get(kind)
    if (!entry) return false
    globalThis.clearTimeout(entry.timer)
    this.pending.delete(kind)
    for (const resolve of entry.resolvers) resolve(ok)
    return true
  }
}

function isChildProcessAlive(processRef: ChildProcess): boolean {
  const pid = processRef.pid
  if (!pid || processRef.exitCode !== null) {
    return false
  }

  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function clearStaleActiveSession(): void {
  if (!activeSession) {
    return
  }

  if (!isChildProcessAlive(activeSession.process)) {
    activeSession = null
  }
}

/**
 * `SCK_RECORDER_READY width=<w> height=<h> fps=<n> source=display|window [mic=0|1] [system_audio=0|1]`.
 * The trailing flags are optional so older helpers still parse.
 */
export function parseReadyLine(line: string): RecorderReadyInfo | null {
  const match =
    /SCK_RECORDER_READY\s+width=(\d+)\s+height=(\d+)\s+fps=(\d+)\s+source=([a-zA-Z-]+)(?:\s+mic=(\d+))?(?:\s+system_audio=(\d+))?/.exec(
      line,
    )
  if (!match) return null
  const width = Number(match[1])
  const height = Number(match[2])
  const frameRate = Number(match[3])
  const sourceKindRaw = String(match[4])
  const micFlagRaw = Number(match[5] ?? 0)
  const systemAudioFlagRaw = Number(match[6] ?? 0)
  if (!Number.isFinite(width) || !Number.isFinite(height) || !Number.isFinite(frameRate)) {
    return null
  }

  const sourceKind: RecorderReadyInfo['sourceKind'] =
    sourceKindRaw === 'window' ? 'window' : sourceKindRaw === 'display' ? 'display' : 'unknown'

  return {
    width: Math.max(2, Math.round(width)),
    height: Math.max(2, Math.round(height)),
    frameRate: Math.max(1, Math.round(frameRate)),
    sourceKind,
    hasMicrophoneAudio: micFlagRaw === 1,
    hasSystemAudio: systemAudioFlagRaw === 1,
  }
}

function parseHelperErrorLine(line: string): RecorderHelperErrorInfo | null {
  const match = /^SCK_RECORDER_ERROR\s+code=([a-z0-9_-]+)\s+message=(.+)$/i.exec(line)
  if (!match) return null
  return {
    code: String(match[1]).toLowerCase(),
    message: String(match[2]).trim(),
  }
}

function parseDoneLine(line: string): RecorderDoneInfo | null {
  const match = /^SCK_RECORDER_DONE\s+frames=(\d+)(?:\s+observed_fps=(\d+))?$/i.exec(line)
  if (!match) return null
  const frameCount = Number(match[1])
  const observedFrameRateRaw = Number(match[2] ?? 0)
  if (!Number.isFinite(frameCount) || frameCount < 0) {
    return null
  }
  const observedFrameRate =
    Number.isFinite(observedFrameRateRaw) && observedFrameRateRaw > 0
      ? Math.max(1, Math.min(240, Math.round(observedFrameRateRaw)))
      : undefined
  return {
    frameCount: Math.max(0, Math.round(frameCount)),
    observedFrameRate,
  }
}

function collectLines(stream: NodeJS.ReadableStream, onLine: (line: string) => void): () => void {
  let buffer = ''

  const onData = (chunk: Buffer | string): void => {
    buffer += String(chunk)
    let newlineIndex = buffer.indexOf('\n')
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).trim()
      buffer = buffer.slice(newlineIndex + 1)
      if (line) onLine(line)
      newlineIndex = buffer.indexOf('\n')
    }
  }

  stream.on('data', onData)
  return () => {
    stream.off('data', onData)
  }
}

async function ensureHelperBinary(): Promise<string> {
  const helperPath = app.isPackaged
    ? path.join(process.resourcesPath, 'native', 'sck-recorder')
    : path.join(app.getAppPath(), 'electron', 'native', 'bin', 'sck-recorder')

  try {
    await fs.access(helperPath)
    return helperPath
  } catch {
    if (app.isPackaged) {
      throw new Error(`Native recorder helper missing: ${helperPath}`)
    }
  }

  const projectRoot = app.getAppPath()
  const sourcePath = path.join(projectRoot, 'electron', 'native', 'macos', 'sck-recorder.swift')
  await fs.mkdir(path.dirname(helperPath), { recursive: true })

  await new Promise<void>((resolve, reject) => {
    const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64'
    const compile = spawn(
      'xcrun',
      [
        'swiftc',
        '-parse-as-library',
        '-O',
        '-target',
        `${arch}-apple-macos13.0`,
        sourcePath,
        '-framework',
        'ScreenCaptureKit',
        '-framework',
        'AVFoundation',
        '-framework',
        'CoreMedia',
        '-framework',
        'CoreVideo',
        '-framework',
        'CoreGraphics',
        '-framework',
        'Foundation',
        '-o',
        helperPath,
      ],
      {
        cwd: projectRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )

    let stderr = ''
    compile.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })

    compile.on('error', (error) => {
      reject(error)
    })

    compile.on('exit', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(stderr.trim() || `swiftc failed with code ${code ?? 'unknown'}`))
      }
    })
  })

  await fs.chmod(helperPath, 0o755)
  return helperPath
}

function waitForProcessExit(
  processRef: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    processRef.once('exit', (code, signal) => {
      resolve({ code, signal })
    })
  })
}

export function isNativeMacRecorderActive(): boolean {
  return Boolean(activeSession)
}

/**
 * The helper ended on its own with a recording still running. Check what it
 * left on disk (so the HUD knows whether the partial file can be opened) and
 * push the event; a missing listener is not an error, it just means no HUD.
 */
async function announceUnexpectedExit(
  session: ActiveNativeRecorderSession,
  exit: { code: number | null; signal: NodeJS.Signals | null },
): Promise<void> {
  const reason: NativeRecorderExitInfo['reason'] = exit.signal ? 'killed' : 'crashed'
  console.error(
    `[sck-recorder] helper exited while recording: code=${exit.code ?? 'null'} signal=${exit.signal ?? 'none'} reason=${reason}`,
  )
  let outputPlayable = false
  try {
    outputPlayable = (await fileHasMp4MoovBox(session.outputPath)).hasMoov
  } catch {
    outputPlayable = false
  }
  nativeRecorderExitListener?.({
    code: exit.code,
    signal: exit.signal,
    reason,
    outputPath: session.outputPath,
    outputPlayable,
  })
}

/**
 * Output file of the in-progress native recording, if any. Lets a discard delete
 * the file even when `stopNativeMacRecorder` reports it as missing or empty.
 */
export function getNativeMacRecorderOutputPath(): string | null {
  return activeSession?.outputPath ?? null
}

export function forceTerminateNativeMacRecorder(): void {
  const session = activeSession
  activeSession = null
  if (!session) return

  // Capturia is ending this helper: its exit is expected, not an interruption.
  session.stopRequested = true
  session.ackWaiters.abortAll()
  try {
    session.process.kill('SIGTERM')
  } catch {
    // ignore process teardown errors
  }

  globalThis.setTimeout(() => {
    try {
      session.process.kill('SIGKILL')
    } catch {
      // ignore process teardown errors
    }
  }, 300)
}

export async function startNativeMacRecorder(options: NativeRecorderStartOptions): Promise<{
  success: boolean
  code?: string
  message?: string
  ready?: RecorderReadyInfo
  capabilities?: NativeRecorderCapabilities
  warnings?: NativeRecorderWarning[]
}> {
  if (process.platform !== 'darwin') {
    return {
      success: false,
      message: 'Native ScreenCaptureKit recorder is only supported on macOS.',
    }
  }

  // Darwin kernel 22.x = macOS 13 Ventura. The native helper requires macOS >= 13.0.
  const darwinMajor = Number(os.release().split('.')[0])
  if (Number.isFinite(darwinMajor) && darwinMajor < 22) {
    const inferredMacOS = darwinMajor - 9 // rough mapping: Darwin 22 = macOS 13, 21 = 12, etc.
    return {
      success: false,
      code: 'os_version_unsupported',
      message: `macOS 13.0 (Ventura) or later is required for native screen recording, but this system appears to be macOS ${inferredMacOS}. Please upgrade macOS or use the built-in recorder instead.`,
    }
  }

  clearStaleActiveSession()
  if (activeSession) {
    return { success: false, message: 'Native recorder is already active.' }
  }

  try {
    const helperPath = await ensureHelperBinary()
    const args = [
      '--output',
      options.outputPath,
      '--hide-cursor',
      options.cursorMode === 'never' ? '1' : '0',
      '--microphone-enabled',
      options.microphoneEnabled === false ? '0' : '1',
      '--microphone-gain',
      String(
        Math.max(
          0.5,
          Math.min(2, Number.isFinite(options.microphoneGain) ? Number(options.microphoneGain) : 1),
        ),
      ),
      '--fps',
      String(Math.max(1, Math.min(120, Math.round(options.frameRate || 60)))),
      '--bitrate-scale',
      String(
        Math.max(
          0.5,
          Math.min(2, Number.isFinite(options.bitrateScale) ? Number(options.bitrateScale) : 1),
        ),
      ),
    ]

    if (options.sourceId) {
      args.push('--source-id', options.sourceId)
    }
    if (options.displayId) {
      args.push('--display-id', options.displayId)
    }
    if (options.width && options.width > 1) {
      args.push('--width', String(Math.round(options.width)))
    }
    if (options.height && options.height > 1) {
      args.push('--height', String(Math.round(options.height)))
    }
    if (options.cameraEnabled) {
      args.push('--camera-enabled', '1')
      args.push('--camera-shape', options.cameraShape ?? 'rounded')
      const sizePercent = Math.max(14, Math.min(40, Math.round(options.cameraSizePercent ?? 22)))
      args.push('--camera-size-percent', String(sizePercent))
      if (options.cameraDeviceId) {
        args.push('--camera-device-id', options.cameraDeviceId)
      }
      if (options.cameraDeviceName) {
        args.push('--camera-device-name', options.cameraDeviceName)
      }
    }
    if (options.systemAudio === true) {
      // Only ever passed as `1`: an old helper skips the unknown flag and its value.
      args.push('--system-audio', '1')
    }
    if (options.microphoneEnabled !== false) {
      // An old helper skips unknown flags (and their value) and keeps its default mic.
      if (options.microphoneDeviceId) {
        args.push('--mic-device-id', options.microphoneDeviceId)
      }
      if (options.microphoneDeviceName) {
        args.push('--mic-device-name', options.microphoneDeviceName)
      }
    }

    // stdin is a pipe so `pause` / `resume` / `stop` lines can be written to the
    // helper. An old helper that never reads stdin is unaffected: it ignores the
    // pipe and still stops on SIGINT.
    const helperProcess = spawn(helperPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    helperProcess.stdout.setEncoding('utf8')
    helperProcess.stderr.setEncoding('utf8')
    // A helper that closes stdin (or never reads it) must not crash main with EPIPE.
    helperProcess.stdin?.on('error', (error) => {
      console.warn('[sck-recorder] stdin error:', error)
    })

    const exitPromise = waitForProcessExit(helperProcess)

    let readyInfo: RecorderReadyInfo | null = null
    const doneInfoRef: { current?: RecorderDoneInfo } = {}
    const capabilitiesRef: { current: NativeRecorderCapabilities } = {
      current: { ...NO_NATIVE_RECORDER_CAPABILITIES },
    }
    const ackWaiters = new AckWaiters()
    const warnings: NativeRecorderWarning[] = []
    let stderrBuffer = ''
    const helperErrorRef: { current?: RecorderHelperErrorInfo } = {}

    const cleanupStdout = collectLines(helperProcess.stdout, (line) => {
      const maybeReady = parseReadyLine(line)
      if (maybeReady) {
        readyInfo = maybeReady
      }
      const maybeCaps = parseCapsLine(line)
      if (maybeCaps) {
        capabilitiesRef.current = maybeCaps
        return
      }
      const maybeAck = parsePauseAckLine(line)
      if (maybeAck) {
        ackWaiters.settle(maybeAck)
        return
      }
      const maybeWarn = parseWarnLine(line)
      if (maybeWarn) {
        warnings.push(maybeWarn)
        console.warn(`[sck-recorder] ${line}`)
        return
      }
      const maybeDone = parseDoneLine(line)
      if (maybeDone) {
        doneInfoRef.current = maybeDone
      }
      if (!line.startsWith('SCK_RECORDER_READY') && !line.startsWith('SCK_RECORDER_DONE')) {
        console.log(`[sck-recorder] ${line}`)
      }
    })

    const cleanupStderr = collectLines(helperProcess.stderr, (line) => {
      stderrBuffer += `${line}\n`
      const parsed = parseHelperErrorLine(line)
      if (parsed) {
        helperErrorRef.current = parsed
      }
      console.error(`[sck-recorder] ${line}`)
    })

    const started = await new Promise<boolean>((resolve) => {
      const timeout = globalThis.setTimeout(() => {
        resolve(false)
      }, 10_000)

      const interval = globalThis.setInterval(() => {
        if (readyInfo) {
          globalThis.clearTimeout(timeout)
          globalThis.clearInterval(interval)
          resolve(true)
        }
      }, 20)

      exitPromise
        .then(() => {
          globalThis.clearTimeout(timeout)
          globalThis.clearInterval(interval)
          if (!readyInfo) {
            resolve(false)
          }
        })
        .catch(() => {
          globalThis.clearTimeout(timeout)
          globalThis.clearInterval(interval)
          resolve(false)
        })
    })

    if (!started || !readyInfo) {
      cleanupStdout()
      cleanupStderr()
      const exit = await exitPromise
      const reason =
        helperErrorRef.current?.message ||
        stderrBuffer.trim() ||
        `Helper exited before ready (code=${exit.code ?? 'null'}, signal=${exit.signal ?? 'none'})`
      return { success: false, code: helperErrorRef.current?.code, message: reason }
    }

    // The caps line follows READY in the same flush; give it one tick in case the
    // two lines arrived in separate chunks. An old helper simply never sends it.
    if (!capabilitiesRef.current.pause) {
      await new Promise<void>((resolve) => {
        globalThis.setTimeout(resolve, 50)
      })
    }

    const session: ActiveNativeRecorderSession = {
      process: helperProcess,
      outputPath: options.outputPath,
      stopRequested: false,
      cursorMode: options.cursorMode,
      ready: readyInfo,
      capabilities: capabilitiesRef.current,
      warnings,
      doneInfoRef,
      exitPromise,
      ackWaiters,
    }
    activeSession = session

    void exitPromise.then(
      (exit) => {
        ackWaiters.abortAll()
        // Only this session's exit may clear the global; a stop already
        // replaced it with null and a restart may have installed a new one.
        const wasActive = activeSession === session
        if (wasActive) activeSession = null
        if (!wasActive || session.stopRequested) return
        void announceUnexpectedExit(session, exit)
      },
      () => {
        ackWaiters.abortAll()
      },
    )

    return {
      success: true,
      ready: readyInfo,
      capabilities: capabilitiesRef.current,
      // Warnings printed before READY (e.g. the picked mic was not found).
      warnings: [...warnings],
    }
  } catch (error) {
    return {
      success: false,
      code: 'start_exception',
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

/** Capabilities of the running helper; all off when nothing is recording. */
export function getNativeMacRecorderCapabilities(): NativeRecorderCapabilities {
  return activeSession?.capabilities ?? NO_NATIVE_RECORDER_CAPABILITIES
}

async function sendPauseCommand(command: 'pause' | 'resume'): Promise<NativeRecorderPauseResult> {
  const session = activeSession
  if (!session) {
    return { success: false, supported: false, message: 'Native recorder is not active.' }
  }
  if (!session.capabilities.pause) {
    return {
      success: false,
      supported: false,
      message:
        'The native recorder helper was built without pause support; rebuild it with `npm run build:native`.',
    }
  }
  const stdin = session.process.stdin
  if (!stdin || stdin.destroyed || !stdin.writable) {
    return { success: false, supported: true, message: 'Native recorder stdin is not writable.' }
  }

  const ackKind = command === 'pause' ? 'paused' : 'resumed'
  const acked = session.ackWaiters.wait(ackKind, NATIVE_RECORDER_ACK_TIMEOUT_MS)
  try {
    stdin.write(`${command}\n`)
  } catch (error) {
    session.ackWaiters.abortAll()
    return {
      success: false,
      supported: true,
      message: error instanceof Error ? error.message : String(error),
    }
  }
  const ok = await acked
  if (!ok) {
    return {
      success: false,
      supported: true,
      message: `Native recorder did not acknowledge ${command} within ${NATIVE_RECORDER_ACK_TIMEOUT_MS} ms.`,
    }
  }
  return { success: true, supported: true }
}

/** Write `pause` to the helper and wait for `SCK_RECORDER_PAUSED`. */
export function pauseNativeMacRecorder(): Promise<NativeRecorderPauseResult> {
  return sendPauseCommand('pause')
}

/** Write `resume` to the helper and wait for `SCK_RECORDER_RESUMED`. */
export function resumeNativeMacRecorder(): Promise<NativeRecorderPauseResult> {
  return sendPauseCommand('resume')
}

export async function stopNativeMacRecorder(): Promise<NativeRecorderStopResult> {
  const session = activeSession
  activeSession = null

  if (!session) {
    return { success: false, code: 'no_session', message: 'Native recorder is not active.' }
  }

  session.stopRequested = true
  session.ackWaiters.abortAll()
  try {
    session.process.kill('SIGINT')
  } catch {
    // process may already be gone; rely on exitPromise/timeout path
  }

  const exitResult = await Promise.race([
    session.exitPromise,
    new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      globalThis.setTimeout(() => {
        try {
          session.process.kill('SIGKILL')
        } catch {
          // process may already be gone
        }
        resolve({ code: null, signal: 'SIGKILL' })
      }, 15_000)
    }),
  ])

  let hasValidOutput = false
  try {
    const stat = await fs.stat(session.outputPath)
    hasValidOutput = stat.isFile() && stat.size >= 1024
  } catch {
    hasValidOutput = false
  }

  if (!hasValidOutput) {
    return {
      success: false,
      code: 'output_missing',
      message: 'Native recorder output file is missing or empty.',
    }
  }

  const exitedCleanly = exitResult.code === 0 && exitResult.signal === null
  if (!exitedCleanly) {
    console.warn(
      `[sck-recorder] helper exited with non-zero status but produced output. code=${exitResult.code ?? 'null'} signal=${exitResult.signal ?? 'none'}`,
    )
    // A helper that was killed (including by our own 15 s stop timeout) never
    // got to write the `moov` box, and the bytes on disk are then a file no
    // player can open. Size alone does not catch that, so check the boxes.
    const scan = await fileHasMp4MoovBox(session.outputPath)
    if (!scan.hasMoov) {
      console.error(
        `[sck-recorder] output has no moov box (${scan.reason ?? 'unknown'}; top-level boxes: ${scan.topLevelTypes.join(', ') || 'none'}): ${session.outputPath}`,
      )
      return {
        success: false,
        code: 'output_missing_moov',
        path: session.outputPath,
        message: `The recording was interrupted before it could be finalized, so ${session.outputPath} has no playable movie header.`,
      }
    }
  }

  return {
    success: true,
    path: session.outputPath,
    metadata: {
      frameRate: session.doneInfoRef.current?.observedFrameRate ?? session.ready.frameRate,
      width: session.ready.width,
      height: session.ready.height,
      mimeType: 'video/mp4',
      capturedAt: Date.now(),
      systemCursorMode: session.cursorMode,
      hasMicrophoneAudio: session.ready.hasMicrophoneAudio,
      hasSystemAudio: session.ready.hasSystemAudio,
    },
  }
}
