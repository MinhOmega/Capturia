import { useState, useRef, useEffect } from 'react'
import { fixWebmDuration } from '@fix-webm-duration/fix'
import { toast } from 'sonner'
import { computeCameraOverlayRect, type CameraOverlayShape } from './cameraOverlay'
import { createRecorderHandle, type RecorderHandle } from './recorderHandle'
import {
  beginStopTransition,
  canPauseRecording,
  canRequestDiscard,
  canRequestRestart,
  planNativeStopSideEffects,
  planRecorderExitInterruption,
  resolveStopRoute,
  shouldStartAfterRestart,
  type RecordingPhase,
  type RecordingTransitionState,
} from './recordingPhase'
import { useI18n } from '@/i18n'
import { mixAudioTracks, normalizeMicrophoneGain } from '@/lib/audioMix'
import { resolveNativeRecorderStartFailureMessage } from '@/lib/permissions/nativeRecorderErrors'
import { assessRecordingDiskSpace, formatAvailableSpace } from '@/lib/recordingDiskSpace'
import { reportUserActionError } from '@/lib/userErrorFeedback'
import { webcamDeviceIdentityFrom } from '@/lib/webcamDeviceIdentity'

type UseScreenRecorderReturn = {
  recording: boolean
  recordingState: RecordingPhase
  /**
   * Pause/resume is available on the MediaRecorder path and, since A5, on the native
   * macOS path when the running helper announced pause support (old helper: hidden).
   */
  canPause: boolean
  /**
   * The native macOS helper announced system-audio capture on its last start
   * (remembered across launches). The HUD hides the system-audio toggle on macOS
   * until this is true; on Windows/Linux the browser path handles it directly.
   */
  nativeSystemAudioSupported: boolean
  toggleRecording: () => void
  pauseRecording: () => void
  resumeRecording: () => void
  discardRecording: () => void
  /** Discard the active session and start a fresh one with the same source, skipping the HUD countdown. */
  restartRecording: () => void
  startTimeRef: React.RefObject<number>
  cumulativePauseMsRef: React.RefObject<number>
  pauseStartTimeRef: React.RefObject<number>
}

type UseScreenRecorderOptions = {
  includeCamera?: boolean
  cameraShape?: CameraOverlayShape
  cameraSizePercent?: number
  /** Camera chosen in the HUD picker (Chromium deviceId); empty = automatic pick. */
  cameraDeviceId?: string
  /** Label of that camera, forwarded to the native helper which matches by name. */
  cameraDeviceName?: string
  captureProfile?: CaptureProfile
  captureFrameRate?: CaptureFrameRate
  captureResolutionPreset?: CaptureResolutionPreset
  recordSystemCursor?: boolean
  microphoneGain?: number
  /** Off = record without an audio track. Default on. */
  microphoneEnabled?: boolean
  /** Microphone chosen in the HUD picker (Chromium deviceId); empty = system default. */
  microphoneDeviceId?: string
  /**
   * Record what the computer plays (loopback on Windows, the desktop audio source
   * on Linux) mixed with the microphone. Default off. Ignored on the macOS browser
   * fallback path, where Chromium cannot capture system audio.
   */
  systemAudioEnabled?: boolean
  /** Label of that microphone for the native helper (looked up from the id when absent). */
  microphoneDeviceName?: string
}

/** Remembered answer of the native macOS helper to "can you capture system audio?". */
const NATIVE_SYSTEM_AUDIO_STORAGE_KEY = 'capturia.nativeSystemAudioSupported'

function readNativeSystemAudioSupported(): boolean {
  try {
    return window.localStorage.getItem(NATIVE_SYSTEM_AUDIO_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function writeNativeSystemAudioSupported(supported: boolean): void {
  try {
    window.localStorage.setItem(NATIVE_SYSTEM_AUDIO_STORAGE_KEY, supported ? '1' : '0')
  } catch {
    // no-op
  }
}

export type CaptureProfile = 'balanced' | 'quality' | 'ultra'
export type CaptureFrameRate = 24 | 30 | 60 | 120
export type CaptureResolutionPreset = 'auto' | '1080p' | '1440p' | '2160p'
type CursorMode = 'always' | 'never'

type LegacyDesktopGetUserMedia = (constraints: {
  audio?:
    | { mandatory?: Record<string, string | number | boolean | undefined> }
    | MediaTrackConstraints
    | boolean
  video?: {
    mandatory?: Record<string, string | number | boolean | undefined>
    cursor?: CursorMode
  }
}) => Promise<MediaStream>

type CompositionResources = {
  compositeStream: MediaStream
  width: number
  height: number
  frameRate: number
  cleanup: () => void
}

type SelectedCaptureSource = {
  id?: string
  name?: string
  display_id?: string | number | null
  width?: number
  height?: number
}

const VIRTUAL_CAMERA_KEYWORDS = [
  'virtual',
  'obs',
  'continuity',
  'desk view',
  'presenter',
  'iphone',
  'epoccam',
  'ndi',
  'snap camera',
]

function isLikelyVirtualCameraLabel(label: string): boolean {
  const normalized = label.trim().toLowerCase()
  return VIRTUAL_CAMERA_KEYWORDS.some((keyword) => normalized.includes(keyword))
}

function dedupe<T>(items: T[]): T[] {
  return Array.from(new Set(items))
}

/**
 * Video from `videoStream` plus the audio of `audioStream` (the mixed recording
 * audio). Only video tracks are taken from `videoStream`, so a raw system-audio
 * track riding on the desktop stream is never added twice.
 */
function combineVideoAndAudioStream(
  videoStream: MediaStream,
  audioStream?: MediaStream | null,
): MediaStream {
  const tracks: MediaStreamTrack[] = [...videoStream.getVideoTracks()]
  if (audioStream) {
    tracks.push(...audioStream.getAudioTracks())
  }
  return new MediaStream(tracks)
}

function normalizeSelectedCaptureSource(input: unknown): SelectedCaptureSource | null {
  if (!input || typeof input !== 'object') return null
  const row = input as Record<string, unknown>
  const id = typeof row.id === 'string' ? row.id : undefined
  const display_id =
    typeof row.display_id === 'string' || typeof row.display_id === 'number' ? row.display_id : null
  const name = typeof row.name === 'string' ? row.name : undefined
  const width = Number(row.width)
  const height = Number(row.height)

  if (!id && display_id === null) return null

  return {
    id,
    display_id,
    name,
    width: Number.isFinite(width) && width > 1 ? Math.round(width) : undefined,
    height: Number.isFinite(height) && height > 1 ? Math.round(height) : undefined,
  }
}

/** Label Chromium reports for an audio input id; the native helper matches devices by label. */
async function lookupMicrophoneLabel(deviceId: string): Promise<string | undefined> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    return (
      devices.find((device) => device.kind === 'audioinput' && device.deviceId === deviceId)
        ?.label || undefined
    )
  } catch {
    return undefined
  }
}

async function pickPreferredCameraId(): Promise<string | undefined> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    const cameras = devices.filter((device) => device.kind === 'videoinput')
    if (cameras.length === 0) return undefined

    const nonVirtual = cameras.filter((camera) => !isLikelyVirtualCameraLabel(camera.label))
    const preferred = nonVirtual[0] ?? cameras[0]
    return preferred?.deviceId || undefined
  } catch (error) {
    console.warn('Failed to enumerate camera devices, using system default camera.', error)
    return undefined
  }
}

export function useScreenRecorder(options: UseScreenRecorderOptions = {}): UseScreenRecorderReturn {
  const { t } = useI18n()
  const includeCamera = options.includeCamera ?? false
  const cameraShape = options.cameraShape ?? 'rounded'
  const cameraSizePercent = options.cameraSizePercent ?? 22
  const cameraDeviceId = options.cameraDeviceId || undefined
  const cameraDeviceName = options.cameraDeviceName || undefined
  const captureProfile = options.captureProfile ?? 'quality'
  const captureFrameRate = options.captureFrameRate
  const captureResolutionPreset = options.captureResolutionPreset
  const recordSystemCursor = options.recordSystemCursor ?? true
  const microphoneGain = normalizeMicrophoneGain(options.microphoneGain)
  const microphoneEnabled = options.microphoneEnabled ?? true
  const systemAudioEnabled = options.systemAudioEnabled ?? false
  const microphoneDeviceId = options.microphoneDeviceId || undefined
  const microphoneDeviceName = options.microphoneDeviceName || undefined
  const [recording, setRecording] = useState(false)
  const [nativeSystemAudioSupported, setNativeSystemAudioSupported] = useState(
    readNativeSystemAudioSupported,
  )
  const [recordingState, setRecordingPhase] = useState<RecordingPhase>('idle')
  // The native-helper-exit subscription is registered once; it reads the phase
  // from here instead of from the closure it was created in.
  const recordingPhaseRef = useRef<RecordingPhase>('idle')
  recordingPhaseRef.current = recordingState
  // Mirrors `nativeRecordingActive` for rendering (refs don't re-render): the HUD hides
  // Pause while the native recorder owns the session.
  const [nativeSessionActive, setNativeSessionActive] = useState(false)
  // Announced by the helper at start (`canPause`); false for a helper built before
  // the stdin protocol, in which case the HUD keeps hiding Pause on the native path.
  const [nativePauseSupported, setNativePauseSupported] = useState(false)
  // A native pause/resume round-trips to the helper; ignore re-entrant clicks meanwhile.
  const pauseTransitionInFlight = useRef(false)
  // Wraps the MediaRecorder and streams its chunks to disk (or buffers them in memory
  // when the stream IPC is unavailable). Null outside a MediaRecorder session.
  const recorderHandle = useRef<RecorderHandle | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const cameraStream = useRef<MediaStream | null>(null)
  // Identity of the camera actually opened for the last (attempted) recording.
  const openedCameraRef = useRef<{ deviceId?: string; deviceName?: string } | null>(null)
  // Audio handed to the recorder: the mixed mic + system destination stream, or a
  // stream around the lone system track. Null when the recording has no audio.
  const recordingAudioStream = useRef<MediaStream | null>(null)
  // Raw microphone capture feeding the mix (kept so it is released on teardown).
  const microphoneSourceStream = useRef<MediaStream | null>(null)
  // AudioContext owning the mix graph (gain ramps, user gain, limiter).
  const audioMixContext = useRef<AudioContext | null>(null)
  const startTime = useRef<number>(0)
  const compositionCleanup = useRef<(() => void) | null>(null)
  const cursorTrackingActive = useRef(false)
  const nativeRecordingActive = useRef(false)
  const transitionInFlight = useRef(false)
  const cumulativePauseMs = useRef(0)
  const pauseStartTime = useRef(0)
  const discardFlag = useRef(false)
  // A restart is a discard followed by a start once the hook is idle again; the ref
  // survives the stop/idle re-renders and blocks a second restart until then.
  const restartPending = useRef(false)
  const nativeRecordingMetadata = useRef<{
    frameRate: number
    width: number
    height: number
    mimeType: string
    systemCursorMode: CursorMode
    hasMicrophoneAudio: boolean
  } | null>(null)

  const profileSettings: Record<
    CaptureProfile,
    {
      targetFps: number
      maxFps: number
      bitrateScale: number
      cameraCompositeFpsCap: number
      maxLongEdge: number
    }
  > = {
    balanced: {
      targetFps: 30,
      maxFps: 60,
      bitrateScale: 0.9,
      cameraCompositeFpsCap: 30,
      maxLongEdge: 1920,
    },
    quality: {
      targetFps: 60,
      maxFps: 60,
      bitrateScale: 1.1,
      cameraCompositeFpsCap: 60,
      maxLongEdge: 3840,
    },
    // Experimental profile: only beneficial on devices that can sustain high-refresh desktop capture.
    ultra: {
      targetFps: 120,
      maxFps: 120,
      bitrateScale: 1.25,
      cameraCompositeFpsCap: 60,
      maxLongEdge: 5120,
    },
  }

  const activeProfile = profileSettings[captureProfile]
  const resolutionLongEdgeByPreset: Record<Exclude<CaptureResolutionPreset, 'auto'>, number> = {
    '1080p': 1920,
    '1440p': 2560,
    '2160p': 3840,
  }
  const hasExplicitFrameRate = Number.isFinite(captureFrameRate)
  const requestedFrameRate = hasExplicitFrameRate
    ? Number(captureFrameRate)
    : activeProfile.targetFps
  const MAX_CAPTURE_FPS = hasExplicitFrameRate ? 120 : activeProfile.maxFps
  const TARGET_CAPTURE_FPS = Math.max(24, Math.min(MAX_CAPTURE_FPS, Math.round(requestedFrameRate)))
  const targetMaxLongEdge =
    captureResolutionPreset && captureResolutionPreset !== 'auto'
      ? resolutionLongEdgeByPreset[captureResolutionPreset]
      : captureResolutionPreset === 'auto'
        ? undefined
        : activeProfile.maxLongEdge
  const cameraCompositeFpsCap = hasExplicitFrameRate ? 60 : activeProfile.cameraCompositeFpsCap

  const ensureEvenDimension = (value: number, fallback: number) => {
    const resolved = Number.isFinite(value) && value > 0 ? value : fallback
    return Math.max(2, Math.floor(resolved / 2) * 2)
  }

  const normalizeCaptureDimensions = (
    rawWidth: number,
    rawHeight: number,
    maxLongEdge = targetMaxLongEdge,
  ): { width: number; height: number } => {
    let width = ensureEvenDimension(rawWidth, 1920)
    let height = ensureEvenDimension(rawHeight, 1080)

    if (!Number.isFinite(maxLongEdge) || !maxLongEdge || maxLongEdge <= 0) {
      return { width, height }
    }

    const longEdge = Math.max(width, height)
    if (longEdge <= maxLongEdge) {
      return { width, height }
    }

    const scale = maxLongEdge / longEdge
    width = ensureEvenDimension(Math.round(width * scale), 1920)
    height = ensureEvenDimension(Math.round(height * scale), 1080)
    return { width, height }
  }

  const selectMimeType = () => {
    // Prefer H.264 first for decoding/export compatibility and smoother timeline playback.
    const preferred = [
      'video/webm;codecs=h264',
      'video/mp4;codecs=h264',
      'video/webm;codecs=vp8',
      'video/webm;codecs=vp9',
      'video/webm;codecs=av1',
      'video/webm',
    ]

    return preferred.find((type) => MediaRecorder.isTypeSupported(type)) ?? 'video/webm'
  }

  const computeBitrate = (width: number, height: number, frameRate: number) => {
    const pixels = width * height
    const frameRateBoost = frameRate >= 50 ? 1.25 : frameRate >= 30 ? 1 : 0.85

    if (pixels >= 3840 * 2160)
      return Math.round(50_000_000 * frameRateBoost * activeProfile.bitrateScale)
    if (pixels >= 2560 * 1440)
      return Math.round(32_000_000 * frameRateBoost * activeProfile.bitrateScale)
    if (pixels >= 1920 * 1080)
      return Math.round(20_000_000 * frameRateBoost * activeProfile.bitrateScale)
    return Math.round(12_000_000 * frameRateBoost * activeProfile.bitrateScale)
  }

  const createMediaRecorderWithFallback = (
    sourceStream: MediaStream,
    preferredMimeType: string,
    bitrate: number,
  ): MediaRecorder => {
    const mimeCandidates = dedupe(
      [
        preferredMimeType,
        'video/webm;codecs=h264',
        'video/mp4;codecs=h264',
        'video/webm;codecs=vp8',
        'video/webm;codecs=vp9',
        'video/webm',
      ].filter((mime) => MediaRecorder.isTypeSupported(mime)),
    )

    let lastError: unknown = null
    for (const mimeType of mimeCandidates) {
      try {
        return new MediaRecorder(sourceStream, {
          mimeType,
          videoBitsPerSecond: bitrate,
        })
      } catch (error) {
        lastError = error
        // Retry same codec without explicit bitrate (some machines reject high-bitrate options)
        try {
          return new MediaRecorder(sourceStream, { mimeType })
        } catch (retryError) {
          lastError = retryError
        }
      }
    }

    try {
      return new MediaRecorder(sourceStream, { videoBitsPerSecond: bitrate })
    } catch (error) {
      lastError = error
    }

    throw lastError instanceof Error
      ? lastError
      : new Error('Failed to create MediaRecorder with available codecs.')
  }

  /** Stop the mixed + source microphone streams and close the mix AudioContext. */
  const releaseAudioCapture = () => {
    const mixedStream = recordingAudioStream.current
    if (mixedStream) {
      mixedStream.getTracks().forEach((track) => track.stop())
      recordingAudioStream.current = null
    }
    const sourceMicStream = microphoneSourceStream.current
    if (sourceMicStream && sourceMicStream !== mixedStream) {
      sourceMicStream.getTracks().forEach((track) => track.stop())
    }
    microphoneSourceStream.current = null
    if (audioMixContext.current) {
      void audioMixContext.current.close().catch((error) => {
        console.warn('Failed to close the recording AudioContext during cleanup.', error)
      })
      audioMixContext.current = null
    }
  }

  const cleanupActiveMedia = (options: { stopNative?: boolean } = {}) => {
    const stopNative = options.stopNative ?? true

    if (stopNative && nativeRecordingActive.current) {
      nativeRecordingActive.current = false
      setNativeSessionActive(false)
      setNativePauseSupported(false)
      nativeRecordingMetadata.current = null
      void window.electronAPI?.stopNativeScreenRecording?.().catch((error) => {
        console.warn('Failed to stop native ScreenCaptureKit recorder during cleanup.', error)
      })
      window.electronAPI?.setRecordingState(false)
    }

    if (cursorTrackingActive.current) {
      cursorTrackingActive.current = false
      void window.electronAPI?.stopCursorTracking?.().catch((error) => {
        console.warn('Failed to stop cursor tracking during cleanup.', error)
      })
    }
    if (compositionCleanup.current) {
      compositionCleanup.current()
      compositionCleanup.current = null
    }
    if (cameraStream.current) {
      cameraStream.current.getTracks().forEach((track) => track.stop())
      cameraStream.current = null
    }
    releaseAudioCapture()
    if (stream.current) {
      stream.current.getTracks().forEach((track) => track.stop())
      stream.current = null
    }
  }

  /**
   * Stop the native ScreenCaptureKit session. With `discard`, main deletes the output
   * file and the HUD returns to idle without opening the editor. Every exit path goes
   * through `finally`, so the transition flag and cursor tracker are always reset.
   */
  const stopNativeRecording = async (options: { discard?: boolean } = {}) => {
    const discard = options.discard === true
    const initialMetadata = nativeRecordingMetadata.current
    nativeRecordingActive.current = false
    setNativeSessionActive(false)
    setNativePauseSupported(false)
    pauseTransitionInFlight.current = false
    nativeRecordingMetadata.current = null

    let capturedCursorTrack: CursorTrackMetadata | undefined

    if (cursorTrackingActive.current) {
      cursorTrackingActive.current = false
      try {
        const cursorResult = await window.electronAPI.stopCursorTracking()
        capturedCursorTrack = discard ? undefined : cursorResult.track
      } catch (error) {
        console.warn('Failed to retrieve cursor tracking payload for native recording.', error)
      }
    }

    try {
      const stopResult = await window.electronAPI.stopNativeScreenRecording(
        discard ? { discard: true } : undefined,
      )
      setRecording(false)
      setRecordingPhase('stopping')
      window.electronAPI?.setRecordingState(false)

      const plan = planNativeStopSideEffects({
        discard,
        stopSucceeded: Boolean(stopResult.success && stopResult.path),
      })
      if (plan.reportFailure) {
        console.error('Failed to stop native ScreenCaptureKit recording:', stopResult.message)
        // A3: the helper was killed before it wrote the MP4 `moov` box, so the
        // file on disk cannot be decoded. Name the path so the user can point a
        // repair tool at it instead of losing track of the recording.
        const unplayable = stopResult.code === 'output_missing_moov'
        reportUserActionError({
          t,
          userMessage: unplayable
            ? t('launch.recordingFileUnplayable', { path: stopResult.path ?? '' })
            : t('launch.recordStopFailed'),
          error: stopResult.message || 'native-screen-recorder-stop returned no path',
          context: 'recording.stop.native',
          details: stopResult,
          dedupeKey: 'recording.stop.native',
        })
        return
      }
      if (!plan.openEditor || !stopResult.path) {
        // Discarded: main already removed the file; nothing to publish.
        return
      }

      const fallbackMetadata = initialMetadata ?? {
        frameRate: 60,
        width: 1920,
        height: 1080,
        mimeType: 'video/mp4',
        systemCursorMode: 'always' as CursorMode,
        hasMicrophoneAudio: false,
      }
      const metadata = stopResult.metadata ?? fallbackMetadata
      const capturedAt = stopResult.metadata?.capturedAt ?? Date.now()

      await window.electronAPI.setCurrentVideoPath(stopResult.path, {
        frameRate: metadata.frameRate,
        width: metadata.width,
        height: metadata.height,
        mimeType: metadata.mimeType ?? 'video/mp4',
        capturedAt,
        systemCursorMode: metadata.systemCursorMode ?? fallbackMetadata.systemCursorMode,
        hasMicrophoneAudio: metadata.hasMicrophoneAudio ?? fallbackMetadata.hasMicrophoneAudio,
        cursorTrack: capturedCursorTrack,
      })

      await window.electronAPI.switchToEditor()
    } catch (error) {
      console.error('Failed to finalize native ScreenCaptureKit recording:', error)
      reportUserActionError({
        t,
        userMessage: t('launch.recordStopFailed'),
        error,
        context: 'recording.stop.native.finalize',
        dedupeKey: 'recording.stop.native.finalize',
      })
      setRecording(false)
      window.electronAPI?.setRecordingState(false)
    } finally {
      discardFlag.current = false
      transitionInFlight.current = false
      setRecording(false)
      setRecordingPhase('idle')
      window.electronAPI?.setRecordingState(false)
      cleanupActiveMedia({ stopNative: false })
    }
  }

  /**
   * A2: the native helper process ended on its own with a session still open —
   * it crashed, the OS killed it, or a capture permission was revoked. Main has
   * already checked what it left on disk, so the HUD returns to idle and offers
   * the partial recording only when it is actually playable.
   */
  const handleNativeRecorderExit = async (info: NativeRecorderExitPayload) => {
    const plan = planRecorderExitInterruption({
      state: {
        phase: recordingPhaseRef.current,
        recording: nativeRecordingActive.current,
        transitionInFlight: transitionInFlight.current,
        discardRequested: discardFlag.current,
      },
      // A stop of our own already cleared the session flag; that exit belongs to
      // the stop path and must not surface as an interruption.
      stopRequested: !nativeRecordingActive.current,
      outputPlayable: info.outputPlayable,
    })
    if (!plan) return

    console.warn('Native recorder helper exited unexpectedly.', info)
    const metadata = nativeRecordingMetadata.current
    nativeRecordingActive.current = false
    setNativeSessionActive(false)
    setNativePauseSupported(false)
    pauseTransitionInFlight.current = false
    nativeRecordingMetadata.current = null

    let capturedCursorTrack: CursorTrackMetadata | undefined
    if (cursorTrackingActive.current) {
      cursorTrackingActive.current = false
      try {
        capturedCursorTrack = (await window.electronAPI.stopCursorTracking()).track
      } catch (error) {
        console.warn('Failed to retrieve cursor tracking payload after a helper exit.', error)
      }
    }

    cleanupActiveMedia({ stopNative: false })
    discardFlag.current = plan.state.discardRequested
    transitionInFlight.current = plan.state.transitionInFlight
    setRecording(plan.state.recording)
    setRecordingPhase(plan.state.phase)
    window.electronAPI?.setRecordingState(false)

    if (!plan.offerOpen) {
      // The file has no `moov` box: handing it to the editor would only produce
      // a video that will not decode, so name the path and stop there.
      toast.error(t('launch.recordingFileUnplayable', { path: info.outputPath }))
      return
    }

    if (!plan.notify) return
    toast.warning(t('launch.recordingInterrupted'), {
      action: {
        label: t('launch.recordingInterruptedOpenAction'),
        onClick: () => {
          void (async () => {
            try {
              await window.electronAPI.setCurrentVideoPath(info.outputPath, {
                frameRate: metadata?.frameRate ?? 60,
                width: metadata?.width ?? 1920,
                height: metadata?.height ?? 1080,
                mimeType: metadata?.mimeType ?? 'video/mp4',
                capturedAt: Date.now(),
                systemCursorMode: metadata?.systemCursorMode ?? 'always',
                hasMicrophoneAudio: metadata?.hasMicrophoneAudio ?? false,
                cursorTrack: capturedCursorTrack,
              })
              await window.electronAPI.switchToEditor()
            } catch (error) {
              reportUserActionError({
                t,
                userMessage: t('launch.openVideoFailed'),
                error,
                context: 'recording.interrupted.open',
                dedupeKey: 'recording.interrupted.open',
              })
            }
          })()
        },
      },
    })
  }

  // The subscription below is installed once, so it calls through this ref to
  // reach the handler of the current render rather than the first one.
  const nativeRecorderExitHandler = useRef(handleNativeRecorderExit)
  nativeRecorderExitHandler.current = handleNativeRecorderExit

  const stopRecording = useRef(() => {
    if (transitionInFlight.current) {
      return
    }

    const recorder = recorderHandle.current?.recorder ?? null
    const route = resolveStopRoute({
      nativeRecordingActive: nativeRecordingActive.current,
      recorderState: recorder?.state,
    })
    if (route === 'native') {
      transitionInFlight.current = true
      setRecording(false)
      setRecordingPhase('stopping')
      window.electronAPI?.setRecordingState(false)
      void stopNativeRecording()
      return
    }
    if (route === 'media-recorder' && recorder) {
      // Account for any in-progress pause
      if (pauseStartTime.current > 0) {
        cumulativePauseMs.current += Date.now() - pauseStartTime.current
        pauseStartTime.current = 0
      }
      transitionInFlight.current = true
      setRecording(false)
      setRecordingPhase('stopping')
      window.electronAPI?.setRecordingState(false)
      recorder.stop()
      return
    }
    setRecording(false)
    setRecordingPhase('idle')
    window.electronAPI?.setRecordingState(false)
    transitionInFlight.current = false
    cleanupActiveMedia()
  })

  useEffect(() => {
    let cleanup: (() => void) | undefined

    if (window.electronAPI?.onStopRecordingFromTray) {
      cleanup = window.electronAPI.onStopRecordingFromTray(() => {
        stopRecording.current()
      })
    }
    const exitCleanup = window.electronAPI?.onNativeRecorderExited?.((info) => {
      void nativeRecorderExitHandler.current(info)
    })

    return () => {
      if (cleanup) cleanup()
      if (exitCleanup) exitCleanup()

      const recorder = recorderHandle.current?.recorder
      if (recorder?.state === 'recording') {
        recorder.stop()
        return
      }

      cleanupActiveMedia()
      setRecording(false)
      setRecordingPhase('idle')
      window.electronAPI?.setRecordingState(false)
      transitionInFlight.current = false
    }
  }, [])

  const buildCompositedStream = async (
    desktopStream: MediaStream,
    sourceWidthHint: number,
    sourceHeightHint: number,
    sourceFrameRateHint: number,
    overlayOptions: { shape: CameraOverlayShape; sizePercent: number },
  ): Promise<CompositionResources> => {
    const openWebcam = async (deviceId: string | undefined): Promise<MediaStream> => {
      // No size hint on purpose: asking for 1280x720 made some drivers rotate a
      // portrait camera into landscape. The native frame is centre-cropped into
      // the overlay box by `drawVideoCover`, so any orientation renders undistorted.
      const videoConstraints: MediaTrackConstraints = {
        frameRate: { ideal: 30, max: 60 },
      }
      if (deviceId) {
        videoConstraints.deviceId = { exact: deviceId }
      }
      return await navigator.mediaDevices.getUserMedia({ audio: false, video: videoConstraints })
    }

    let webcamStream: MediaStream
    if (cameraDeviceId) {
      try {
        webcamStream = await openWebcam(cameraDeviceId)
      } catch (error) {
        // The picked camera may have been unplugged since the HUD enumerated it;
        // fall back to the automatic pick before giving up on the overlay.
        console.warn(
          'Selected camera is unavailable, falling back to the automatic camera pick.',
          error,
        )
        webcamStream = await openWebcam(await pickPreferredCameraId())
      }
    } else {
      webcamStream = await openWebcam(await pickPreferredCameraId())
    }
    cameraStream.current = webcamStream
    openedCameraRef.current = webcamDeviceIdentityFrom(
      webcamStream,
      cameraDeviceId,
      cameraDeviceName,
    )
    console.log(
      '[capture] camera overlay device:',
      openedCameraRef.current.deviceName ?? openedCameraRef.current.deviceId,
    )

    const desktopVideo = document.createElement('video')
    desktopVideo.srcObject = desktopStream
    desktopVideo.muted = true
    desktopVideo.playsInline = true
    await desktopVideo.play()

    const webcamVideo = document.createElement('video')
    webcamVideo.srcObject = webcamStream
    webcamVideo.muted = true
    webcamVideo.playsInline = true
    await webcamVideo.play()

    const sourceWidth = ensureEvenDimension(desktopVideo.videoWidth, sourceWidthHint)
    const sourceHeight = ensureEvenDimension(desktopVideo.videoHeight, sourceHeightHint)
    const sourceFrameRate = Math.max(
      24,
      Math.min(
        MAX_CAPTURE_FPS,
        Math.round(
          sourceFrameRateHint ||
            Number(desktopStream.getVideoTracks()[0]?.getSettings().frameRate) ||
            TARGET_CAPTURE_FPS,
        ),
      ),
    )
    const compositeFrameRate = Math.min(sourceFrameRate, cameraCompositeFpsCap)
    console.log(
      `Compositing camera overlay on ${desktopVideo.videoWidth || sourceWidthHint}x${desktopVideo.videoHeight || sourceHeightHint} -> ${sourceWidth}x${sourceHeight} @ ${compositeFrameRate}fps`,
    )

    const canvas = document.createElement('canvas')
    canvas.width = sourceWidth
    canvas.height = sourceHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      throw new Error('Failed to create 2D context for camera composition.')
    }

    const overlay = computeCameraOverlayRect(sourceWidth, sourceHeight, overlayOptions)
    const drawVideoCover = (
      ctx2d: CanvasRenderingContext2D,
      video: HTMLVideoElement,
      x: number,
      y: number,
      targetWidth: number,
      targetHeight: number,
    ) => {
      const sourceWidthPx = video.videoWidth || targetWidth
      const sourceHeightPx = video.videoHeight || targetHeight
      const sourceRatio = sourceWidthPx / sourceHeightPx
      const targetRatio = targetWidth / targetHeight

      let cropWidth = sourceWidthPx
      let cropHeight = sourceHeightPx
      let cropX = 0
      let cropY = 0
      if (sourceRatio > targetRatio) {
        cropWidth = sourceHeightPx * targetRatio
        cropX = (sourceWidthPx - cropWidth) / 2
      } else if (sourceRatio < targetRatio) {
        cropHeight = sourceWidthPx / targetRatio
        cropY = (sourceHeightPx - cropHeight) / 2
      }
      ctx2d.drawImage(video, cropX, cropY, cropWidth, cropHeight, x, y, targetWidth, targetHeight)
    }
    const drawRoundedRectPath = (
      ctx2d: CanvasRenderingContext2D,
      x: number,
      y: number,
      width: number,
      height: number,
      radius: number,
    ) => {
      const clamped = Math.max(0, Math.min(radius, Math.min(width, height) / 2))
      ctx2d.beginPath()
      ctx2d.moveTo(x + clamped, y)
      ctx2d.lineTo(x + width - clamped, y)
      ctx2d.quadraticCurveTo(x + width, y, x + width, y + clamped)
      ctx2d.lineTo(x + width, y + height - clamped)
      ctx2d.quadraticCurveTo(x + width, y + height, x + width - clamped, y + height)
      ctx2d.lineTo(x + clamped, y + height)
      ctx2d.quadraticCurveTo(x, y + height, x, y + height - clamped)
      ctx2d.lineTo(x, y + clamped)
      ctx2d.quadraticCurveTo(x, y, x + clamped, y)
      ctx2d.closePath()
    }

    let rafToken = 0
    let videoFrameCallbackToken: number | null = null
    let running = true
    let lastDrawTime = 0
    const frameIntervalMs = 1000 / compositeFrameRate

    // Camera unplugged mid-recording: the <video> keeps showing its last frame, so
    // without this flag the overlay would freeze on it. Drop the overlay, keep
    // recording the plain desktop and tell the user once. `track.stop()` from our
    // own cleanup does not fire `ended`, so this only reacts to a real loss.
    let webcamLost = false
    const webcamTrack = webcamStream.getVideoTracks()[0]
    const handleWebcamEnded = () => {
      if (!running || webcamLost) return
      webcamLost = true
      console.warn('[capture] camera track ended mid-recording; continuing without the overlay.')
      toast.warning(t('editor.recordingCameraDisconnected'))
    }
    webcamTrack?.addEventListener('ended', handleWebcamEnded)

    const drawCompositedFrame = () => {
      if (desktopVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        ctx.drawImage(desktopVideo, 0, 0, sourceWidth, sourceHeight)
      }

      if (!webcamLost && webcamVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        const x = overlay.x
        const y = overlay.y
        const w = overlay.width
        const h = overlay.height

        ctx.save()
        if (overlayOptions.shape === 'circle') {
          const radius = Math.min(w, h) / 2
          ctx.beginPath()
          ctx.arc(x + w / 2, y + h / 2, radius, 0, Math.PI * 2)
          ctx.closePath()
        } else if (overlayOptions.shape === 'square') {
          ctx.beginPath()
          ctx.rect(x, y, w, h)
          ctx.closePath()
        } else {
          drawRoundedRectPath(ctx, x, y, w, h, overlay.cornerRadius)
        }
        ctx.clip()
        drawVideoCover(ctx, webcamVideo, x, y, w, h)
        ctx.restore()

        ctx.lineWidth = 2
        ctx.strokeStyle = 'rgba(255,255,255,0.45)'
        if (overlayOptions.shape === 'circle') {
          const radius = Math.min(w, h) / 2
          ctx.beginPath()
          ctx.arc(x + w / 2, y + h / 2, radius, 0, Math.PI * 2)
          ctx.closePath()
          ctx.stroke()
        } else if (overlayOptions.shape === 'square') {
          ctx.strokeRect(x, y, w, h)
        } else {
          drawRoundedRectPath(ctx, x, y, w, h, overlay.cornerRadius)
          ctx.stroke()
        }
      }
    }

    const maybeDrawFrame = (timestamp: number) => {
      if (timestamp - lastDrawTime < frameIntervalMs) {
        return
      }
      lastDrawTime = timestamp
      drawCompositedFrame()
    }

    const hasVideoFrameCallback = typeof desktopVideo.requestVideoFrameCallback === 'function'
    if (hasVideoFrameCallback) {
      const scheduleVideoFrame = () => {
        if (!running) return
        videoFrameCallbackToken = desktopVideo.requestVideoFrameCallback((timestamp) => {
          maybeDrawFrame(timestamp)
          scheduleVideoFrame()
        })
      }
      scheduleVideoFrame()
    } else {
      const tick = (timestamp: number) => {
        if (!running) return
        maybeDrawFrame(timestamp)
        rafToken = requestAnimationFrame(tick)
      }
      rafToken = requestAnimationFrame(tick)
    }

    const compositeStream = canvas.captureStream(compositeFrameRate)
    const compositeTrack = compositeStream.getVideoTracks()[0]
    if (compositeTrack && 'contentHint' in compositeTrack) {
      compositeTrack.contentHint = 'detail'
    }
    return {
      compositeStream,
      width: sourceWidth,
      height: sourceHeight,
      frameRate: compositeFrameRate,
      cleanup: () => {
        running = false
        webcamTrack?.removeEventListener('ended', handleWebcamEnded)
        cancelAnimationFrame(rafToken)
        if (
          videoFrameCallbackToken !== null &&
          typeof desktopVideo.cancelVideoFrameCallback === 'function'
        ) {
          desktopVideo.cancelVideoFrameCallback(videoFrameCallbackToken)
        }
        desktopVideo.pause()
        webcamVideo.pause()
        webcamStream.getTracks().forEach((track) => track.stop())
      },
    }
  }

  /**
   * Desktop capture for the MediaRecorder path. With `withSystemAudio` the stream
   * is asked for the desktop's audio as well (main grants Windows loopback through
   * the display-media handler; the legacy constraints reach PulseAudio/PipeWire on
   * Linux). A request that fails *with* audio is retried without it, so system
   * audio never costs the recording; the caller checks the returned audio tracks
   * and tells the user when none arrived.
   */
  const captureDesktopStream = async (
    selectedSource: { id?: string | null },
    cursorMode: CursorMode,
    withSystemAudio: boolean,
  ): Promise<MediaStream> => {
    const captureWithLegacyDesktopConstraints = async (
      includeAudio: boolean,
    ): Promise<MediaStream> => {
      console.log(
        '[capture] using legacy getUserMedia with chromeMediaSource=desktop, cursor:',
        cursorMode,
        'sourceId:',
        selectedSource.id,
        'systemAudio:',
        includeAudio,
      )
      const getLegacyUserMedia = navigator.mediaDevices.getUserMedia.bind(
        navigator.mediaDevices,
      ) as unknown as LegacyDesktopGetUserMedia
      const stream = await getLegacyUserMedia({
        audio: includeAudio ? { mandatory: { chromeMediaSource: 'desktop' } } : false,
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: selectedSource.id ?? undefined,
            maxFrameRate: TARGET_CAPTURE_FPS,
            cursor: cursorMode,
          },
          cursor: cursorMode,
        },
      })
      const trackSettings = stream.getVideoTracks()[0]?.getSettings()
      console.log('[capture] legacy stream obtained, track settings:', trackSettings)
      return stream
    }
    const captureLegacy = async (): Promise<MediaStream> => {
      if (!withSystemAudio) return await captureWithLegacyDesktopConstraints(false)
      try {
        return await captureWithLegacyDesktopConstraints(true)
      } catch (error) {
        console.warn(
          '[capture] legacy desktop capture with system audio failed, retrying video-only.',
          error,
        )
        return await captureWithLegacyDesktopConstraints(false)
      }
    }

    // Hide-native-cursor path: prefer legacy constraints first because this path is
    // currently more reliable on Electron/macOS for cursor suppression.
    if (cursorMode === 'never') {
      try {
        return await captureLegacy()
      } catch (error) {
        console.warn(
          'Legacy desktop capture failed for cursor hidden mode, trying displayMedia.',
          error,
        )
      }
    }

    const getDisplayMedia = navigator.mediaDevices.getDisplayMedia?.bind(navigator.mediaDevices)
    if (typeof getDisplayMedia === 'function') {
      const requestDisplayMedia = (includeAudio: boolean) =>
        getDisplayMedia({
          audio: includeAudio,
          video: {
            frameRate: { ideal: TARGET_CAPTURE_FPS, max: MAX_CAPTURE_FPS },
            cursor: cursorMode,
          } as MediaTrackConstraints,
        })
      try {
        console.log(
          '[capture] trying getDisplayMedia with cursor:',
          cursorMode,
          'systemAudio:',
          withSystemAudio,
        )
        let stream: MediaStream
        try {
          stream = await requestDisplayMedia(withSystemAudio)
        } catch (error) {
          if (!withSystemAudio) throw error
          console.warn(
            '[capture] getDisplayMedia with system audio failed, retrying video-only.',
            error,
          )
          stream = await requestDisplayMedia(false)
        }
        console.log('[capture] getDisplayMedia succeeded')
        return stream
      } catch (error) {
        console.warn(
          '[capture] getDisplayMedia failed, falling back to legacy desktop capture constraints.',
          error,
        )
      }
    }

    return await captureLegacy()
  }

  /**
   * Raw microphone capture for the MediaRecorder path (gain, ramp and limiter are
   * applied later by the mix graph together with system audio). Resolves to `null`
   * when the mic is switched off or cannot be opened (denied, unplugged): the
   * recording then proceeds without a mic instead of failing outright.
   */
  const captureOptionalMicrophoneStream = async (): Promise<MediaStream | null> => {
    if (!microphoneEnabled) {
      return null
    }

    const openMicrophone = async (deviceId: string | undefined): Promise<MediaStream> => {
      const audioConstraints: MediaTrackConstraints = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      }
      if (deviceId) {
        audioConstraints.deviceId = { exact: deviceId }
      }
      return await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false })
    }

    try {
      let sourceStream: MediaStream
      if (microphoneDeviceId) {
        try {
          sourceStream = await openMicrophone(microphoneDeviceId)
        } catch (error) {
          // The picked mic may have been unplugged since the HUD enumerated it.
          console.warn(
            'Selected microphone is unavailable, falling back to the system default.',
            error,
          )
          sourceStream = await openMicrophone(undefined)
        }
      } else {
        sourceStream = await openMicrophone(undefined)
      }
      microphoneSourceStream.current = sourceStream
      return sourceStream
    } catch (error) {
      console.warn('Microphone unavailable, recording without audio.', error)
      notifyMicrophoneFallback()
      return null
    }
  }

  /** System audio was asked for but the platform gave no track; the recording goes on without it. */
  const notifySystemAudioUnavailable = () => {
    toast.warning(t('editor.recordingSystemAudioUnavailable'))
  }

  /** The recording continues without the webcam overlay; tell the user instead of failing silently. */
  const notifyCameraFallback = () => {
    toast.warning(t('launch.cameraFallback'))
  }

  /** The recording continues without an audio track; tell the user instead of aborting. */
  const notifyMicrophoneFallback = () => {
    toast.warning(t('launch.microphoneFallback'))
  }

  /**
   * A5: both recorder paths go through here before anything is opened. Returns
   * false only when the volume is too full for the recording to be worth
   * starting; a check that could not run never blocks one.
   */
  const hasRoomToRecord = async (): Promise<boolean> => {
    let snapshot: Awaited<ReturnType<NonNullable<typeof window.electronAPI.getRecordingsDiskSpace>>>
    try {
      snapshot = await window.electronAPI?.getRecordingsDiskSpace?.()
    } catch (error) {
      console.warn('Could not read the free space of the recordings folder.', error)
      return true
    }

    const verdict = assessRecordingDiskSpace(snapshot)
    if (verdict.level === 'blocked') {
      toast.error(
        t('launch.diskSpaceBlocked', { available: formatAvailableSpace(verdict.availableBytes) }),
      )
      return false
    }
    if (verdict.level === 'warn') {
      toast.warning(
        t('launch.diskSpaceLow', { available: formatAvailableSpace(verdict.availableBytes) }),
      )
    }
    return true
  }

  const isNativeMicrophoneFailure = (code: string | undefined): boolean =>
    code === 'microphone_permission_denied' || code === 'microphone_unavailable'

  const startRecording = async () => {
    if (transitionInFlight.current || recordingState !== 'idle') {
      return
    }

    if (!(await hasRoomToRecord())) {
      return
    }

    transitionInFlight.current = true
    setRecordingPhase('starting')
    let nativeStartFailure:
      | {
          code?: string
          message?: string
          sourceId?: string
        }
      | undefined

    try {
      const selectedSource = normalizeSelectedCaptureSource(
        await window.electronAPI.getSelectedSource(),
      )
      if (!selectedSource) {
        throw new Error(t('launch.recordSourceRequired'))
      }

      const cursorMode: CursorMode = recordSystemCursor ? 'always' : 'never'
      const systemCursorMode: CursorMode = cursorMode
      const platform = await window.electronAPI.getPlatform()
      const shouldUseNativeRecorder = platform === 'darwin'
      const selectedSourceWidth = Number(selectedSource.width)
      const selectedSourceHeight = Number(selectedSource.height)
      const nativeTargetSize =
        Number.isFinite(selectedSourceWidth) &&
        Number.isFinite(selectedSourceHeight) &&
        selectedSourceWidth > 1 &&
        selectedSourceHeight > 1
          ? normalizeCaptureDimensions(selectedSourceWidth, selectedSourceHeight)
          : undefined

      if (shouldUseNativeRecorder) {
        const sourceRef = {
          id: typeof selectedSource.id === 'string' ? selectedSource.id : undefined,
          display_id: selectedSource.display_id ?? undefined,
        }
        const nativeMicrophoneDeviceName =
          microphoneDeviceName ??
          (microphoneDeviceId ? await lookupMicrophoneLabel(microphoneDeviceId) : undefined)
        const startNative = async (
          cameraEnabled: boolean,
          nativeMicrophoneEnabled = microphoneEnabled,
        ) =>
          await window.electronAPI.startNativeScreenRecording({
            source: sourceRef,
            cursorMode,
            microphoneEnabled: nativeMicrophoneEnabled,
            microphoneGain,
            microphoneDeviceId,
            microphoneDeviceName: nativeMicrophoneDeviceName,
            systemAudio: systemAudioEnabled,
            cameraEnabled,
            cameraShape,
            cameraSizePercent,
            cameraDeviceId,
            cameraDeviceName,
            frameRate: TARGET_CAPTURE_FPS,
            bitrateScale: activeProfile.bitrateScale,
            maxLongEdge: targetMaxLongEdge,
            width: nativeTargetSize?.width,
            height: nativeTargetSize?.height,
          })

        let nativeStart = await startNative(includeCamera)
        if (
          !nativeStart.success &&
          microphoneEnabled &&
          isNativeMicrophoneFailure(nativeStart.code)
        ) {
          // Same policy as the browser path: a denied or missing mic must not
          // abort the recording. Retry silent and tell the user.
          console.warn(
            'Native microphone capture failed, retrying native recording without audio.',
            nativeStart.message,
          )
          nativeStart = await startNative(includeCamera, false)
          if (nativeStart.success) {
            notifyMicrophoneFallback()
          }
        }
        if (!nativeStart.success && includeCamera) {
          console.warn(
            'Native camera overlay capture failed, retrying native recording without camera overlay.',
            nativeStart.message,
          )
          nativeStart = await startNative(false)
          if (nativeStart.success) {
            notifyCameraFallback()
          }
        }

        if (!nativeStart.success) {
          // For unsupported OS versions, fall back to WebRTC recorder instead of failing
          if (nativeStart.code === 'os_version_unsupported') {
            console.warn(
              'macOS version does not support ScreenCaptureKit, falling back to WebRTC recorder.',
              nativeStart.message,
            )
            // Continue to WebRTC path below
          } else {
            nativeStartFailure = {
              code: nativeStart.code,
              message: nativeStart.message,
              sourceId: sourceRef.id,
            }
            const userMessage = resolveNativeRecorderStartFailureMessage(nativeStartFailure)
            console.error('Native ScreenCaptureKit recorder start failed.', {
              code: nativeStart.code,
              message: nativeStart.message,
              sourceId: sourceRef.id,
            })
            throw new Error(userMessage)
          }
        }

        if (nativeStart.success) {
          const nativeWidth = Math.max(2, Math.round(nativeStart.width ?? 1920))
          const nativeHeight = Math.max(2, Math.round(nativeStart.height ?? 1080))
          const nativeFrameRate = Math.max(
            24,
            Math.min(MAX_CAPTURE_FPS, Math.round(nativeStart.frameRate ?? TARGET_CAPTURE_FPS)),
          )

          nativeRecordingMetadata.current = {
            frameRate: nativeFrameRate,
            width: nativeWidth,
            height: nativeHeight,
            mimeType: 'video/mp4',
            systemCursorMode,
            hasMicrophoneAudio: nativeStart.hasMicrophoneAudio === true,
          }
          nativeRecordingActive.current = true
          setNativeSessionActive(true)
          setNativePauseSupported(nativeStart.canPause === true)
          pauseTransitionInFlight.current = false
          if (nativeStart.warnings?.includes('mic_device_not_found')) {
            // The helper opened the default microphone instead of the picked one.
            toast.warning(t('launch.microphoneDeviceNotFound'))
          }
          // A helper that knows about system audio reports whether it can capture it;
          // an older one says nothing, which is remembered as "not supported".
          const nativeSystemAudio = nativeStart.canCaptureSystemAudio
          if (typeof nativeSystemAudio === 'boolean') {
            setNativeSystemAudioSupported(nativeSystemAudio)
            writeNativeSystemAudioSupported(nativeSystemAudio)
          }
          if (systemAudioEnabled && nativeSystemAudio !== true) {
            // Helper built before system audio: the recording goes on without it.
            toast.warning(t('launch.systemAudioUnavailable'))
          }

          try {
            const trackingResult = await window.electronAPI.startCursorTracking({
              source: sourceRef,
              captureSize: { width: nativeWidth, height: nativeHeight },
            })
            cursorTrackingActive.current = Boolean(trackingResult?.success)
            if (trackingResult?.warningMessage) {
              console.warn(
                'Cursor tracking warning:',
                trackingResult.warningCode,
                trackingResult.warningMessage,
              )
              toast.warning(trackingResult.warningMessage)
            }
          } catch (error) {
            cursorTrackingActive.current = false
            console.warn('Failed to start cursor tracking for native recording.', error)
          }

          startTime.current = Date.now()
          cumulativePauseMs.current = 0
          pauseStartTime.current = 0
          discardFlag.current = false
          setRecording(true)
          setRecordingPhase('recording')
          window.electronAPI?.setRecordingState(true)
          transitionInFlight.current = false
          return
        }
      }

      // Chromium cannot capture system audio on macOS; this path only runs there as
      // the fallback for an unsupported OS version, and the HUD hides the toggle.
      const systemAudioRequested = systemAudioEnabled && platform !== 'darwin'

      // Capture screen + microphone in parallel: the gap between the two getUserMedia
      // calls is the dominant source of mic-vs-video lag at the start of a recording.
      const screenCapture = captureDesktopStream(selectedSource, cursorMode, systemAudioRequested)
      const micCapture = captureOptionalMicrophoneStream()

      let desktopStream: MediaStream
      try {
        desktopStream = await screenCapture
      } catch (error) {
        // The mic may resolve after cleanupActiveMedia() has already run, which would
        // leave its tracks (and the OS mic indicator) on. Release it when it settles.
        void micCapture
          .then((micStream) => {
            micStream?.getTracks().forEach((track) => track.stop())
            releaseAudioCapture()
          })
          .catch(() => undefined)
        throw error
      }
      stream.current = desktopStream
      if (!desktopStream) {
        throw new Error('Media stream is not available.')
      }
      const videoTrack = desktopStream.getVideoTracks()[0]
      if (!videoTrack) {
        throw new Error('No video track available from desktop stream.')
      }
      if ('contentHint' in videoTrack) {
        videoTrack.contentHint = 'detail'
      }
      try {
        await videoTrack.applyConstraints({
          frameRate: { ideal: TARGET_CAPTURE_FPS, max: MAX_CAPTURE_FPS },
          // Keep cursor visibility preference stable across subsequent constraint updates.
          ...({ cursor: cursorMode } as MediaTrackConstraints),
        } as MediaTrackConstraints)
      } catch (error) {
        console.warn(
          'Unable to lock recording frame-rate constraints, using best available track settings.',
          error,
        )
      }

      let { width = 1920, height = 1080, frameRate = TARGET_CAPTURE_FPS } = videoTrack.getSettings()
      const normalizedCaptureSize = normalizeCaptureDimensions(width, height)
      width = normalizedCaptureSize.width
      height = normalizedCaptureSize.height

      try {
        await videoTrack.applyConstraints({
          width: { ideal: width, max: width },
          height: { ideal: height, max: height },
          frameRate: { ideal: TARGET_CAPTURE_FPS, max: MAX_CAPTURE_FPS },
          ...({ cursor: cursorMode } as MediaTrackConstraints),
        } as MediaTrackConstraints)
      } catch (error) {
        console.warn(
          'Unable to apply normalized capture dimensions, keeping source track dimensions.',
          error,
        )
      }

      const finalSettings = videoTrack.getSettings()
      const finalNormalizedCaptureSize = normalizeCaptureDimensions(
        finalSettings.width ?? width,
        finalSettings.height ?? height,
      )
      width = finalNormalizedCaptureSize.width
      height = finalNormalizedCaptureSize.height
      frameRate = Math.max(
        24,
        Math.min(
          MAX_CAPTURE_FPS,
          Math.round(finalSettings.frameRate || frameRate || TARGET_CAPTURE_FPS),
        ),
      )

      const micStream = await micCapture
      const micAudioTrack = micStream?.getAudioTracks()[0] ?? null
      const systemAudioTrack = systemAudioRequested
        ? (desktopStream.getAudioTracks()[0] ?? null)
        : null
      if (systemAudioRequested && !systemAudioTrack) {
        console.warn(
          '[capture] system audio requested but the desktop stream carries no audio track.',
        )
        notifySystemAudioUnavailable()
      }
      // One recordable track: mic (user gain, 20 ms ramp) + system audio through a
      // soft limiter; a lone system track passes through untouched.
      const audioMix = mixAudioTracks({ micAudioTrack, systemAudioTrack, microphoneGain })
      audioMixContext.current = audioMix.context
      recordingAudioStream.current = audioMix.stream
      const desktopRecordingStream = combineVideoAndAudioStream(desktopStream, audioMix.stream)
      const hasMicrophoneAudio = micAudioTrack !== null
      const hasSystemAudio = systemAudioTrack !== null

      let recordingStream: MediaStream = desktopRecordingStream
      if (includeCamera) {
        try {
          const composition = await buildCompositedStream(desktopStream, width, height, frameRate, {
            shape: cameraShape,
            sizePercent: cameraSizePercent,
          })
          compositionCleanup.current = composition.cleanup
          recordingStream = combineVideoAndAudioStream(composition.compositeStream, audioMix.stream)
          width = composition.width
          height = composition.height
          frameRate = composition.frameRate
        } catch (error) {
          console.warn('Camera capture failed, fallback to screen-only recording.', error)
          notifyCameraFallback()
        }
      }

      const videoBitsPerSecond = computeBitrate(width, height, frameRate)
      const mimeType = selectMimeType()
      console.log(
        `Recording [${captureProfile}] at ${width}x${height} @ ${frameRate}fps using ${mimeType} / ${Math.round(
          videoBitsPerSecond / 1_000_000,
        )} Mbps`,
      )

      let recorder: MediaRecorder
      try {
        recorder = createMediaRecorderWithFallback(recordingStream, mimeType, videoBitsPerSecond)
      } catch (error) {
        // Some machines fail MediaRecorder init for canvas capture + certain codecs.
        // Fallback to screen-only stream so recording can still start.
        if (recordingStream !== desktopRecordingStream) {
          console.warn(
            'Failed to initialize recorder for camera composited stream, fallback to screen-only.',
            error,
          )
          if (compositionCleanup.current) {
            compositionCleanup.current()
            compositionCleanup.current = null
          }
          recorder = createMediaRecorderWithFallback(
            desktopRecordingStream,
            mimeType,
            videoBitsPerSecond,
          )
          notifyCameraFallback()
        } else {
          throw error
        }
      }

      const recordedMimeType = recorder.mimeType || mimeType
      console.log(`MediaRecorder initialized with ${recordedMimeType}`)

      recorder.onstart = () => {
        void (async () => {
          try {
            if (recorderHandle.current?.recorder !== recorder || recorder.state !== 'recording')
              return
            const trackingResult = await window.electronAPI.startCursorTracking({
              source: {
                id: typeof selectedSource.id === 'string' ? selectedSource.id : undefined,
                display_id: selectedSource.display_id ?? undefined,
              },
              captureSize: { width, height },
            })
            cursorTrackingActive.current = Boolean(trackingResult?.success)
            if (trackingResult?.warningMessage) {
              console.warn(
                'Cursor tracking warning:',
                trackingResult.warningCode,
                trackingResult.warningMessage,
              )
              toast.warning(trackingResult.warningMessage)
            }
          } catch (error) {
            cursorTrackingActive.current = false
            console.warn(
              'Failed to start cursor tracking, falling back to synthetic cursor behavior.',
              error,
            )
          }
        })()
      }
      // The file name is fixed at start so chunks can stream into it; `store-recorded-video`
      // finalizes the same file (or writes the in-memory fallback to it) on stop.
      const videoFileName = `recording-${Date.now()}.webm`
      // Sets ondataavailable/onstop/onerror and starts the recorder with a 1000 ms timeslice.
      const handle = createRecorderHandle(recorder, videoFileName)
      recorderHandle.current = handle

      const finalizeRecording = async () => {
        let recordedBlob: Blob | null = null
        let recordError: unknown = null
        try {
          recordedBlob = await handle.recordedBlobPromise
        } catch (error) {
          recordError = error
        }

        // Discard: skip saving, drop the partial file, just clean up
        if (discardFlag.current) {
          discardFlag.current = false
          if (cursorTrackingActive.current) {
            cursorTrackingActive.current = false
            try {
              await window.electronAPI.stopCursorTracking()
            } catch {
              /* ignore */
            }
          }
          cleanupActiveMedia()
          recorderHandle.current = null
          try {
            await handle.discard()
          } catch (error) {
            console.warn('Failed to remove discarded recording stream.', error)
          }
          setRecording(false)
          setRecordingPhase('idle')
          window.electronAPI?.setRecordingState(false)
          transitionInFlight.current = false
          return
        }

        try {
          let capturedCursorTrack: CursorTrackMetadata | undefined

          if (cursorTrackingActive.current) {
            cursorTrackingActive.current = false
            try {
              const cursorResult = await window.electronAPI.stopCursorTracking()
              capturedCursorTrack = cursorResult.track
            } catch (error) {
              console.warn('Failed to retrieve cursor tracking payload.', error)
            }
          }
          cleanupActiveMedia()
          recorderHandle.current = null
          if (recordError) {
            // A chunk failed to reach disk mid-stream: the file is truncated, so drop
            // it rather than saving a silently partial recording.
            await handle.discard().catch(() => undefined)
            throw recordError
          }
          const streamed = handle.isStreaming()
          if (!streamed && (!recordedBlob || recordedBlob.size === 0)) return
          const duration = Date.now() - startTime.current - cumulativePauseMs.current
          const timestamp = Date.now()

          let arrayBuffer: ArrayBuffer
          if (streamed) {
            // Bytes are already on disk; main patches the WebM Duration header there.
            arrayBuffer = new ArrayBuffer(0)
          } else {
            // In-memory fallback (stream IPC unavailable or failed to open): fix the
            // header here as before and hand the whole blob to main.
            const videoBlob = await fixWebmDuration(recordedBlob as Blob, duration)
            arrayBuffer = await videoBlob.arrayBuffer()
            recordedBlob = null
          }
          const captureMetadata = {
            frameRate,
            width,
            height,
            mimeType: recordedMimeType,
            capturedAt: timestamp,
            systemCursorMode,
            // The editor reads this as "the file carries an audio track".
            hasMicrophoneAudio: hasMicrophoneAudio || hasSystemAudio,
            durationMs: duration,
            cursorTrack: capturedCursorTrack,
          }
          const videoResult = await window.electronAPI.storeRecordedVideo(
            arrayBuffer,
            videoFileName,
            captureMetadata,
          )
          if (!videoResult.success) {
            console.error('Failed to store video:', videoResult.message)
            reportUserActionError({
              t,
              userMessage: t('launch.recordSaveFailed'),
              error: videoResult.message || 'storeRecordedVideo returned unsuccessful result',
              context: 'recording.save.store-recorded-video',
              details: videoResult,
              dedupeKey: 'recording.save.store-recorded-video',
            })
            return
          }

          // storeRecordedVideo already updates current video path + metadata in main process.
          // Avoid sending a second large metadata payload over IPC, which can delay editor launch.

          await window.electronAPI.switchToEditor()
        } catch (error) {
          console.error('Error saving recording:', error)
          reportUserActionError({
            t,
            userMessage: t('launch.recordSaveFailed'),
            error,
            context: 'recording.save.media-recorder.onstop',
            dedupeKey: 'recording.save.media-recorder.onstop',
          })
        } finally {
          transitionInFlight.current = false
          setRecording(false)
          setRecordingPhase('idle')
          window.electronAPI?.setRecordingState(false)
        }
      }
      // A MediaRecorder `error` rejects `recordedBlobPromise`; finalizeRecording reports
      // it, drops the partial stream and resets the phase, replacing the old onerror.
      void finalizeRecording()
      startTime.current = Date.now()
      cumulativePauseMs.current = 0
      pauseStartTime.current = 0
      discardFlag.current = false
      setRecording(true)
      setRecordingPhase('recording')
      window.electronAPI?.setRecordingState(true)
      transitionInFlight.current = false
    } catch (error) {
      const message =
        error instanceof Error && error.message ? error.message : 'Failed to start recording.'
      const userMessage =
        message === 'Failed to start recording.' ? t('launch.recordStartFailed') : message
      console.error('Failed to start recording:', error)
      // If the recorder had already started, let finalizeRecording discard it; it owns
      // the transition reset in that case.
      const startedHandle = recorderHandle.current
      if (startedHandle && startedHandle.recorder.state !== 'inactive') {
        discardFlag.current = true
        startedHandle.recorder.stop()
      } else {
        transitionInFlight.current = false
        setRecording(false)
        setRecordingPhase('idle')
        window.electronAPI?.setRecordingState(false)
        cleanupActiveMedia()
      }
      reportUserActionError({
        t,
        userMessage,
        error,
        context: 'recording.start',
        details: {
          includeCamera,
          cameraShape,
          cameraSizePercent,
          cameraDeviceId,
          cameraDeviceName,
          openedCamera: openedCameraRef.current,
          captureProfile,
          microphoneGain,
          microphoneEnabled,
          microphoneDeviceId,
          systemAudioEnabled,
          recordSystemCursor,
          normalizedMessage: message,
          nativeStartCode: nativeStartFailure?.code,
          nativeStartMessage: nativeStartFailure?.message,
          nativeStartSourceId: nativeStartFailure?.sourceId,
        },
        dedupeKey: 'recording.start',
      })
    }
  }

  // The cursor tracker samples on the wall clock; tell it about pauses so main can
  // compact them out of the track (both recorder paths, see cursor-tracker-pause).
  const notifyCursorTrackerPaused = (paused: boolean) => {
    if (!cursorTrackingActive.current) return
    const call = paused
      ? window.electronAPI?.pauseCursorTracking
      : window.electronAPI?.resumeCursorTracking
    void call?.().catch((error) => {
      console.warn(`Failed to ${paused ? 'pause' : 'resume'} cursor tracking.`, error)
    })
  }

  /**
   * Native path: ask the helper over stdin and only flip the phase once it acked.
   * On failure the recording simply continues (or stays paused) and the user is told.
   */
  const toggleNativePause = async (pause: boolean) => {
    if (pauseTransitionInFlight.current) return
    if (!nativePauseSupported) return
    if (pause && recordingState !== 'recording') return
    if (!pause && recordingState !== 'paused') return
    pauseTransitionInFlight.current = true
    try {
      const api = pause
        ? window.electronAPI?.pauseNativeScreenRecording
        : window.electronAPI?.resumeNativeScreenRecording
      const result = await api?.()
      if (!result?.success) {
        if (result && !result.supported) {
          // Helper turned out not to support pause after all: hide the button.
          setNativePauseSupported(false)
        }
        reportUserActionError({
          t,
          userMessage: t(pause ? 'launch.pauseFailed' : 'launch.resumeFailed'),
          error:
            result?.message || `${pause ? 'pause' : 'resume'}-native-recording returned no success`,
          context: pause ? 'recording.pause.native' : 'recording.resume.native',
          details: result,
          dedupeKey: pause ? 'recording.pause.native' : 'recording.resume.native',
        })
        return
      }
      if (!nativeRecordingActive.current) return // stopped while the command was in flight
      if (pause) {
        pauseStartTime.current = Date.now()
        setRecordingPhase('paused')
      } else {
        if (pauseStartTime.current > 0) {
          cumulativePauseMs.current += Date.now() - pauseStartTime.current
          pauseStartTime.current = 0
        }
        setRecordingPhase('recording')
      }
      notifyCursorTrackerPaused(pause)
    } catch (error) {
      console.warn(`Native ${pause ? 'pause' : 'resume'} failed.`, error)
    } finally {
      pauseTransitionInFlight.current = false
    }
  }

  const pauseRecording = () => {
    if (nativeRecordingActive.current) {
      void toggleNativePause(true)
      return
    }
    const recorder = recorderHandle.current?.recorder
    if (!recorder) return
    if (recorder.state === 'recording') {
      pauseStartTime.current = Date.now()
      recorder.pause()
      setRecordingPhase('paused')
      notifyCursorTrackerPaused(true)
    }
  }

  const resumeRecording = () => {
    if (nativeRecordingActive.current) {
      void toggleNativePause(false)
      return
    }
    const recorder = recorderHandle.current?.recorder
    if (!recorder) return
    if (recorder.state === 'paused') {
      if (pauseStartTime.current > 0) {
        cumulativePauseMs.current += Date.now() - pauseStartTime.current
        pauseStartTime.current = 0
      }
      recorder.resume()
      setRecordingPhase('recording')
      notifyCursorTrackerPaused(false)
    }
  }

  const discardRecording = () => {
    const current: RecordingTransitionState = {
      phase: recordingState,
      recording,
      transitionInFlight: transitionInFlight.current,
      discardRequested: discardFlag.current,
    }
    if (!canRequestDiscard(current)) return

    const next = beginStopTransition(current, { discard: true })
    discardFlag.current = next.discardRequested
    transitionInFlight.current = next.transitionInFlight
    setRecording(next.recording)
    setRecordingPhase(next.phase)
    window.electronAPI?.setRecordingState(false)

    const recorder = recorderHandle.current?.recorder ?? null
    const route = resolveStopRoute({
      nativeRecordingActive: nativeRecordingActive.current,
      recorderState: recorder?.state,
    })
    if (route === 'native') {
      // Same path as a normal stop so `finally` resets the transition flag, phase and
      // cursor tracker; main deletes the output file instead of returning it.
      void stopNativeRecording({ discard: true })
      return
    }

    if (route === 'media-recorder' && recorder) {
      // finalizeRecording sees discardFlag once the recorder drains and cleans up.
      recorder.stop()
      return
    }

    cleanupActiveMedia()
    const handle = recorderHandle.current
    recorderHandle.current = null
    if (handle) {
      void handle.discard().catch((error) => {
        console.warn('Failed to remove discarded recording stream.', error)
      })
    }
    discardFlag.current = false
    setRecordingPhase('idle')
    transitionInFlight.current = false
  }

  /**
   * Restart = discard + start. Both recorder paths (MediaRecorder drain, native
   * `stopNativeRecording({ discard: true })`) end in the `idle` phase with the
   * transition flag cleared; the effect below picks the start up from there so it
   * never runs against the stale `recordingState` closure of this call. The start
   * re-reads `getSelectedSource`, so the same source is reused, and it bypasses the
   * HUD countdown on purpose (the user already recorded once with it).
   */
  const restartRecording = () => {
    const current: RecordingTransitionState = {
      phase: recordingState,
      recording,
      transitionInFlight: transitionInFlight.current,
      discardRequested: discardFlag.current,
    }
    if (!canRequestRestart(current, { restartPending: restartPending.current })) return
    restartPending.current = true
    discardRecording()
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: startRecording is recreated every render; the effect must only fire on the phase transition back to idle.
  useEffect(() => {
    if (
      !shouldStartAfterRestart({
        phase: recordingState,
        transitionInFlight: transitionInFlight.current,
        restartPending: restartPending.current,
      })
    ) {
      return
    }
    restartPending.current = false
    void startRecording()
  }, [recordingState])

  const toggleRecording = () => {
    if (transitionInFlight.current) {
      return
    }

    if (recordingState === 'starting' || recordingState === 'stopping') {
      return
    }

    if (recording || recordingState === 'recording' || recordingState === 'paused') {
      stopRecording.current()
      return
    }

    void startRecording()
  }

  const canPause = canPauseRecording({
    phase: recordingState,
    nativeRecordingActive: nativeSessionActive,
    nativePauseSupported,
  })

  return {
    recording,
    recordingState,
    canPause,
    nativeSystemAudioSupported,
    toggleRecording,
    pauseRecording,
    resumeRecording,
    discardRecording,
    restartRecording,
    startTimeRef: startTime,
    cumulativePauseMsRef: cumulativePauseMs,
    pauseStartTimeRef: pauseStartTime,
  }
}
