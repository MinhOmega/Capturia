import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * D3: an opt-in camera preview for the HUD's camera popover.
 *
 * Capturia's stance is that the camera light stays off until recording
 * (`useCameraDevices` only enumerates), and this does not change that: the
 * stream is opened only while the popover is open *and* the user has asked for
 * a preview, and it is torn down the moment either stops being true, the chosen
 * camera changes, or a recording is about to start. The recorder opens its own
 * camera, so leaving this one running would mean two claims on the same device.
 *
 * Every teardown stops every track synchronously - a `MediaStream` that is
 * merely dropped keeps the camera light on until the garbage collector gets to
 * it, which is exactly the surprise the stance exists to avoid.
 */

/** Small enough to be a thumbnail, and a cheap ask of the camera. */
export const CAMERA_PREVIEW_CONSTRAINTS = {
  width: 320,
  height: 320,
  frameRate: 24,
} as const

export interface CameraPreviewStream {
  /** Live preview stream, or null whenever the camera is (or should be) off. */
  stream: MediaStream | null
  /** True between the `getUserMedia` call and its answer. */
  isStarting: boolean
  /** Why the preview could not open (permission denied, camera in use, ...). */
  error: string | null
  /**
   * Stop the preview now. Synchronous, so a caller can run it immediately
   * before `startRecording` and know the device is free.
   */
  stop: () => void
}

export function useCameraPreviewStream(
  enabled: boolean,
  deviceId: string = '',
): CameraPreviewStream {
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [isStarting, setIsStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The live stream, readable without waiting for a render: `stop` has to work
  // in the same tick as the click that starts a recording.
  const streamRef = useRef<MediaStream | null>(null)

  const stopTracks = useCallback(() => {
    const current = streamRef.current
    if (!current) return
    streamRef.current = null
    for (const track of current.getTracks()) {
      track.stop()
    }
  }, [])

  const stop = useCallback(() => {
    stopTracks()
    setStream(null)
    setIsStarting(false)
  }, [stopTracks])

  useEffect(() => {
    if (!enabled) {
      stop()
      return
    }

    const mediaDevices = navigator.mediaDevices as MediaDevices | undefined
    if (!mediaDevices?.getUserMedia) {
      setError('Camera preview is unavailable')
      return
    }

    // A stale resolution must not leave a stream behind after the effect that
    // asked for it has been cleaned up (popover closed, camera changed).
    let cancelled = false
    setIsStarting(true)
    setError(null)

    mediaDevices
      .getUserMedia({
        video: {
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
          width: CAMERA_PREVIEW_CONSTRAINTS.width,
          height: CAMERA_PREVIEW_CONSTRAINTS.height,
          frameRate: CAMERA_PREVIEW_CONSTRAINTS.frameRate,
        },
        audio: false,
      })
      .then((opened) => {
        if (cancelled) {
          for (const track of opened.getTracks()) track.stop()
          return
        }
        streamRef.current = opened
        setStream(opened)
        setIsStarting(false)
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setError(cause instanceof Error ? cause.message : 'Could not open the camera')
        setIsStarting(false)
      })

    return () => {
      cancelled = true
      stopTracks()
      setStream(null)
      setIsStarting(false)
    }
  }, [enabled, deviceId, stop, stopTracks])

  // Unmount (the HUD switching to its compact recording bar, for instance)
  // must not leave the camera light on either.
  useEffect(() => stopTracks, [stopTracks])

  return { stream, isStarting, error, stop }
}
