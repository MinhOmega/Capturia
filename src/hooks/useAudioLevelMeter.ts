import { useCallback, useEffect, useRef, useState } from 'react'

export interface AudioLevelMeterOptions {
  enabled: boolean
  /** Chromium deviceId; empty/undefined = system default. */
  deviceId?: string
  smoothingFactor?: number
}

/**
 * Opens the microphone and reports a 0-100 input level while `enabled`. Meant
 * for the HUD mic popover only: the stream and AudioContext are released as
 * soon as the meter is disabled or unmounted.
 */
export function useAudioLevelMeter(options: AudioLevelMeterOptions) {
  const [level, setLevel] = useState(0)
  const audioContextRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const animationFrameRef = useRef<number | null>(null)

  const cleanup = useCallback(() => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current)
      animationFrameRef.current = null
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop())
      streamRef.current = null
    }
    if (audioContextRef.current) {
      void audioContextRef.current.close().catch(() => undefined)
      audioContextRef.current = null
    }
    analyserRef.current = null
  }, [])

  useEffect(() => {
    if (!options.enabled) {
      cleanup()
      setLevel(0)
      return
    }

    let mounted = true

    const startMonitoring = async () => {
      try {
        const constraints: MediaStreamConstraints = {
          audio: options.deviceId ? { deviceId: { exact: options.deviceId } } : true,
          video: false,
        }

        const stream = await navigator.mediaDevices.getUserMedia(constraints)

        if (!mounted) {
          stream.getTracks().forEach((track) => track.stop())
          return
        }

        streamRef.current = stream

        const audioContext = new AudioContext()
        if (audioContext.state === 'suspended') {
          await audioContext.resume()
        }
        audioContextRef.current = audioContext

        const analyser = audioContext.createAnalyser()
        analyser.fftSize = 256
        analyser.smoothingTimeConstant = options.smoothingFactor ?? 0.8
        analyserRef.current = analyser

        const source = audioContext.createMediaStreamSource(stream)
        source.connect(analyser)

        const dataArray = new Uint8Array(analyser.frequencyBinCount)

        const updateLevel = () => {
          if (!mounted || !analyserRef.current) return

          analyser.getByteFrequencyData(dataArray)

          let sum = 0
          for (let i = 0; i < dataArray.length; i++) {
            sum += dataArray[i] * dataArray[i]
          }
          const rms = Math.sqrt(sum / dataArray.length)
          const normalizedLevel = Math.min(100, (rms / 255) * 100 * 2)

          setLevel(normalizedLevel)
          animationFrameRef.current = requestAnimationFrame(updateLevel)
        }

        updateLevel()
      } catch (err) {
        console.warn('Audio level meter could not open the microphone.', err)
        if (mounted) {
          setLevel(0)
        }
      }
    }

    void startMonitoring()

    return () => {
      mounted = false
      cleanup()
    }
  }, [options.enabled, options.deviceId, options.smoothingFactor, cleanup])

  return { level }
}
