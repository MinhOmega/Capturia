import { useEffect, useRef, useState } from 'react'

export interface CameraDevice {
  deviceId: string
  label: string
  groupId: string
}

/**
 * Enumerates video inputs for the HUD camera picker (ported from upstream
 * v1.7.0). Enumeration only: the recorder opens the camera at record time, so
 * no preview stream is requested here and the camera light stays off.
 *
 * `initialDeviceId` seeds the selection from a persisted preference; it is kept
 * while the device is present and replaced by the first available camera when
 * it is unplugged.
 */
export function useCameraDevices(enabled: boolean = false, initialDeviceId: string = '') {
  const [devices, setDevices] = useState<CameraDevice[]>([])
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>(initialDeviceId)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const selectedDeviceIdRef = useRef(selectedDeviceId)
  selectedDeviceIdRef.current = selectedDeviceId

  useEffect(() => {
    if (!enabled) return
    const mediaDevices = navigator.mediaDevices as MediaDevices | undefined
    if (!mediaDevices) {
      setError('Media devices are unavailable')
      return
    }
    let mounted = true

    const loadDevices = async () => {
      try {
        setIsLoading(true)
        setError(null)

        // Unlabeled devices (no camera permission yet) fall back to their device ID.
        const allDevices = await mediaDevices.enumerateDevices()
        const videoInputs = allDevices
          .filter((device) => device.kind === 'videoinput')
          .map((device) => ({
            deviceId: device.deviceId,
            label: device.label || `Camera ${device.deviceId.slice(0, 8)}`,
            groupId: device.groupId,
          }))

        if (mounted) {
          setDevices(videoInputs)
          const currentId = selectedDeviceIdRef.current
          const stillAvailable = videoInputs.some((d) => d.deviceId === currentId)
          if (!currentId || !stillAvailable) {
            setSelectedDeviceId(videoInputs[0]?.deviceId ?? '')
          }
          setIsLoading(false)
        }
      } catch (err) {
        if (mounted) {
          setError(err instanceof Error ? err.message : 'Failed to load cameras')
          setIsLoading(false)
        }
      }
    }

    loadDevices()

    mediaDevices.addEventListener('devicechange', loadDevices)
    return () => {
      mounted = false
      mediaDevices.removeEventListener('devicechange', loadDevices)
    }
  }, [enabled])

  return { devices, selectedDeviceId, setSelectedDeviceId, isLoading, error }
}
