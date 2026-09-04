// @vitest-environment jsdom
//
// D3: the opt-in camera preview. Every assertion here is really one question -
// is the camera light off when it should be? - so the fake `mediaDevices` hands
// out streams whose tracks record their own `stop()`.
import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CAMERA_PREVIEW_CONSTRAINTS, useCameraPreviewStream } from './useCameraPreviewStream'

type FakeTrack = { stop: ReturnType<typeof vi.fn>; stopped: boolean }
type FakeStream = { id: number; tracks: FakeTrack[]; getTracks: () => FakeTrack[] }

let openedStreams: FakeStream[] = []

function makeStream(): FakeStream {
  const track: FakeTrack = {
    stopped: false,
    stop: vi.fn(() => {
      track.stopped = true
    }),
  }
  const stream: FakeStream = {
    id: openedStreams.length,
    tracks: [track],
    getTracks: () => stream.tracks,
  }
  openedStreams.push(stream)
  return stream
}

const getUserMedia = vi.fn(
  async (_constraints: MediaStreamConstraints) => makeStream() as unknown as MediaStream,
)

Object.defineProperty(global.navigator, 'mediaDevices', {
  value: { getUserMedia, enumerateDevices: vi.fn(async () => []) },
  configurable: true,
})

/** True when every stream the fake handed out has had all its tracks stopped. */
const allStopped = () => openedStreams.every((s) => s.tracks.every((t) => t.stopped))

describe('useCameraPreviewStream', () => {
  beforeEach(() => {
    openedStreams = []
    getUserMedia.mockClear()
    getUserMedia.mockImplementation(async () => makeStream() as unknown as MediaStream)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('does not touch the camera while the preview is not asked for', () => {
    renderHook(() => useCameraPreviewStream(false, 'cam1'))
    expect(getUserMedia).not.toHaveBeenCalled()
  })

  it('opens a small, muted-by-omission video-only stream when enabled', async () => {
    const { result } = renderHook(() => useCameraPreviewStream(true, 'cam1'))
    await waitFor(() => expect(result.current.stream).not.toBeNull())

    expect(getUserMedia).toHaveBeenCalledWith({
      video: {
        deviceId: { exact: 'cam1' },
        width: CAMERA_PREVIEW_CONSTRAINTS.width,
        height: CAMERA_PREVIEW_CONSTRAINTS.height,
        frameRate: CAMERA_PREVIEW_CONSTRAINTS.frameRate,
      },
      audio: false,
    })
    expect(result.current.error).toBeNull()
  })

  it('asks for the default camera when no device is chosen', async () => {
    renderHook(() => useCameraPreviewStream(true, ''))
    await waitFor(() => expect(getUserMedia).toHaveBeenCalled())
    expect(getUserMedia.mock.calls[0][0]).toEqual({
      video: {
        width: CAMERA_PREVIEW_CONSTRAINTS.width,
        height: CAMERA_PREVIEW_CONSTRAINTS.height,
        frameRate: CAMERA_PREVIEW_CONSTRAINTS.frameRate,
      },
      audio: false,
    })
  })

  it('stops every track when the popover closes', async () => {
    const { result, rerender } = renderHook(
      ({ enabled }) => useCameraPreviewStream(enabled, 'cam1'),
      { initialProps: { enabled: true } },
    )
    await waitFor(() => expect(result.current.stream).not.toBeNull())

    rerender({ enabled: false })
    await waitFor(() => expect(result.current.stream).toBeNull())
    expect(allStopped()).toBe(true)
  })

  it('stops the old camera and opens the new one on a device change', async () => {
    const { result, rerender } = renderHook(
      ({ deviceId }) => useCameraPreviewStream(true, deviceId),
      { initialProps: { deviceId: 'cam1' } },
    )
    await waitFor(() => expect(result.current.stream).not.toBeNull())
    const first = openedStreams[0]

    rerender({ deviceId: 'cam2' })
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2))
    expect(first.tracks.every((track) => track.stopped)).toBe(true)
    expect(getUserMedia.mock.calls[1][0]).toMatchObject({
      video: { deviceId: { exact: 'cam2' } },
    })
  })

  it('stops synchronously when a recording is about to start', async () => {
    const { result } = renderHook(() => useCameraPreviewStream(true, 'cam1'))
    await waitFor(() => expect(result.current.stream).not.toBeNull())

    // No await: the caller runs this in the same tick as the record click.
    result.current.stop()
    expect(allStopped()).toBe(true)
  })

  it('stops every track on unmount', async () => {
    const { result, unmount } = renderHook(() => useCameraPreviewStream(true, 'cam1'))
    await waitFor(() => expect(result.current.stream).not.toBeNull())

    unmount()
    expect(allStopped()).toBe(true)
  })

  it('never leaves a stream running that resolved after the preview was closed', async () => {
    let release: ((stream: MediaStream) => void) | undefined
    getUserMedia.mockImplementationOnce(
      () =>
        new Promise<MediaStream>((resolve) => {
          release = resolve
        }),
    )

    const { rerender } = renderHook(({ enabled }) => useCameraPreviewStream(enabled, 'cam1'), {
      initialProps: { enabled: true },
    })
    await waitFor(() => expect(release).toBeDefined())

    rerender({ enabled: false })
    const late = makeStream()
    release?.(late as unknown as MediaStream)

    await waitFor(() => expect(late.tracks.every((track) => track.stopped)).toBe(true))
  })

  it('reports why the camera could not be opened and keeps the stream null', async () => {
    getUserMedia.mockRejectedValueOnce(new Error('Permission denied'))
    const { result } = renderHook(() => useCameraPreviewStream(true, 'cam1'))

    await waitFor(() => expect(result.current.error).toBe('Permission denied'))
    expect(result.current.stream).toBeNull()
    expect(result.current.isStarting).toBe(false)
  })
})
