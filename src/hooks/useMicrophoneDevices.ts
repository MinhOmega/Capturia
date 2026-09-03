import { useEffect, useRef, useState } from 'react'

export interface MicrophoneDevice {
  deviceId: string
  label: string
  groupId: string
}

/**
 * Enumerates audio inputs for the HUD microphone picker. Deliberately does not
 * open a permission stream: the level meter opens the mic while the popover is
 * visible, and the recorder opens it at record time.
 *
 * `""` means "system default" (no `deviceId` constraint). A persisted id is kept
 * while the device is present and reset to the default when it is unplugged.
 */
export function useMicrophoneDevices(enabled: boolean = true, initialDeviceId: string = '') {
  const [devices, setDevices] = useState<MicrophoneDevice[]>([])
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

        const allDevices = await mediaDevices.enumerateDevices()
        const audioInputs = allDevices
          .filter((device) => device.kind === 'audioinput')
          .map((device) => ({
            deviceId: device.deviceId,
            label: device.label || `Microphone ${device.deviceId.slice(0, 8)}`,
            groupId: device.groupId,
          }))

        if (mounted) {
          setDevices(audioInputs)
          const currentId = selectedDeviceIdRef.current
          if (currentId && !audioInputs.some((device) => device.deviceId === currentId)) {
            setSelectedDeviceId('')
          }
          setIsLoading(false)
        }
      } catch (err) {
        if (mounted) {
          setError(err instanceof Error ? err.message : 'Failed to enumerate audio devices')
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
