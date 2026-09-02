// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useMicrophoneDevices } from './useMicrophoneDevices'

const mockDevices = [
  { kind: 'audioinput', deviceId: 'mic1', label: 'Mic 1', groupId: 'group1' },
  { kind: 'audioinput', deviceId: 'mic2', label: '', groupId: 'group1' },
  { kind: 'videoinput', deviceId: 'cam1', label: 'Camera 1', groupId: 'group2' },
]

const mockGetUserMedia = vi.fn()
const mockEnumerateDevices = vi.fn().mockResolvedValue(mockDevices)

Object.defineProperty(global.navigator, 'mediaDevices', {
  value: {
    enumerateDevices: mockEnumerateDevices,
    getUserMedia: mockGetUserMedia,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  },
  configurable: true,
})

describe('useMicrophoneDevices', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockEnumerateDevices.mockResolvedValue(mockDevices)
  })

  afterEach(() => {
    vi.resetAllMocks()
  })

  it('lists audio inputs without opening a permission stream', async () => {
    const { result } = renderHook(() => useMicrophoneDevices(true))

    await waitFor(() => {
      expect(result.current.devices).toHaveLength(2)
    })

    expect(result.current.devices[0].label).toBe('Mic 1')
    expect(result.current.devices[1].label).toBe('Microphone mic2')
    expect(mockGetUserMedia).not.toHaveBeenCalled()
  })

  it('defaults to the system default microphone', async () => {
    const { result } = renderHook(() => useMicrophoneDevices(true))

    await waitFor(() => {
      expect(result.current.devices).toHaveLength(2)
    })

    expect(result.current.selectedDeviceId).toBe('')
  })

  it('keeps a persisted selection while the device is present', async () => {
    const { result } = renderHook(() => useMicrophoneDevices(true, 'mic2'))

    await waitFor(() => {
      expect(result.current.devices).toHaveLength(2)
    })

    expect(result.current.selectedDeviceId).toBe('mic2')
  })

  it('falls back to the default when the selected microphone is unplugged', async () => {
    const { result } = renderHook(() => useMicrophoneDevices(true, 'mic2'))

    await waitFor(() => {
      expect(result.current.devices).toHaveLength(2)
    })

    mockEnumerateDevices.mockResolvedValueOnce([mockDevices[0]])
    const devicechangeHandler = (
      navigator.mediaDevices.addEventListener as ReturnType<typeof vi.fn>
    ).mock.calls[0]?.[1] as (() => void) | undefined

    await act(async () => {
      devicechangeHandler?.()
    })

    await waitFor(() => {
      expect(result.current.selectedDeviceId).toBe('')
    })
  })

  it('reports enumeration failures', async () => {
    mockEnumerateDevices.mockRejectedValueOnce(new Error('Permission denied'))

    const { result } = renderHook(() => useMicrophoneDevices(true))

    await waitFor(() => {
      expect(result.current.error).toBe('Permission denied')
    })

    expect(result.current.devices).toHaveLength(0)
    expect(result.current.isLoading).toBe(false)
  })
})
