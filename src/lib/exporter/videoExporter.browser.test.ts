import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import sampleVideoUrl from '@/__fixtures__/sample.webm?url'
import type { ExportProgress } from './types'
import { VideoExporter } from './videoExporter'

/**
 * Silent-export invariant, checked in a real browser.
 *
 * The seek path renders frames from a `<video>` element that must stay muted
 * and paused for the whole export: nothing may call `play()`, no `play` event
 * may fire, and the export must still deliver `ceil(duration * fps)` frames
 * purely by seeking. The fixture is a 2 s, 15 fps VP9/Opus WebM.
 */

const FIXTURE_DURATION_SEC = 2
const EXPORT_FPS = 15

async function h264EncoderAvailable(): Promise<boolean> {
  if (typeof VideoEncoder === 'undefined') return false
  try {
    const support = await VideoEncoder.isConfigSupported({
      codec: 'avc1.640033',
      width: 320,
      height: 180,
      bitrate: 1_000_000,
      framerate: EXPORT_FPS,
    })
    return support.supported === true
  } catch {
    return false
  }
}

describe('VideoExporter seek path (real browser)', () => {
  const createdVideos: HTMLVideoElement[] = []
  const playEvents: Event[] = []
  let playSpy: ReturnType<typeof vi.spyOn>
  let createElementSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    createdVideos.length = 0
    playEvents.length = 0
    playSpy = vi.spyOn(HTMLMediaElement.prototype, 'play')
    const original = document.createElement.bind(document)
    // Cast: Electron's `webview` overload narrows the signature past what a
    // tag-agnostic spy can express.
    createElementSpy = vi.spyOn(document, 'createElement').mockImplementation(((
      tagName: string,
      options?: ElementCreationOptions,
    ) => {
      const element = original(tagName, options)
      if (element instanceof HTMLVideoElement) {
        createdVideos.push(element)
        element.addEventListener('play', (event) => playEvents.push(event))
      }
      return element
    }) as typeof document.createElement)
  })

  afterEach(() => {
    playSpy.mockRestore()
    createElementSpy.mockRestore()
  })

  it('renders every frame from a muted, paused <video> without ever calling play()', async () => {
    if (!(await h264EncoderAvailable())) {
      console.warn('[browser-test] H.264 VideoEncoder unavailable in this browser; skipping')
      return
    }

    const progressEvents: ExportProgress[] = []
    const exporter = new VideoExporter({
      videoUrl: sampleVideoUrl,
      width: 320,
      height: 180,
      frameRate: EXPORT_FPS,
      bitrate: 1_000_000,
      wallpaper: '#1a1a2e',
      zoomRegions: [],
      showShadow: false,
      shadowIntensity: 0,
      showBlur: false,
      cropRegion: { x: 0, y: 0, width: 1, height: 1 },
      decodePath: 'seek',
      audioEnabled: true,
      sourceDurationMs: FIXTURE_DURATION_SEC * 1000,
      onProgress: (progress) => progressEvents.push(progress),
    })

    const result = await exporter.export()
    expect(result.success, result.error).toBe(true)
    expect(result.blob).toBeInstanceOf(Blob)
    expect(result.sourceCopy).not.toBe(true)

    // A real MP4 came out: `ftyp` box at offset 4.
    const bytes = new Uint8Array(await result.blob!.arrayBuffer())
    expect(new TextDecoder().decode(bytes.slice(4, 8))).toBe('ftyp')
    expect(bytes.length).toBeGreaterThan(1024)

    // Frame count on the seek path is ceil(effectiveDuration * fps); every
    // frame was rendered (no "ended early") and the export finalised at 100 %.
    const expectedFrames = Math.ceil(FIXTURE_DURATION_SEC * EXPORT_FPS)
    const rendering = progressEvents.filter((p) => !p.isHeartbeat && p.phase !== 'finalizing')
    expect(rendering.length).toBeGreaterThan(0)
    expect(rendering.at(-1)!.totalFrames).toBe(expectedFrames)
    expect(rendering.at(-1)!.currentFrame).toBe(expectedFrames)
    const finalizing = progressEvents.filter((p) => p.phase === 'finalizing')
    expect(finalizing.at(-1)!.percentage).toBe(100)

    // The invariant: the decoder's <video> was created, stayed silent and was
    // never played. Nothing in the export may call play(), on any element.
    expect(playSpy).not.toHaveBeenCalled()
    expect(playEvents).toHaveLength(0)

    // Only the elements that carry the export source count as decoder videos.
    // A muxing dependency probes codec support with its own throwaway
    // `data:video/webm` element, which never touches the recording.
    const sourceVideos = createdVideos.filter(
      (video) => video.src.length > 0 && !video.src.startsWith('data:'),
    )
    expect(sourceVideos.length).toBeGreaterThanOrEqual(1)
    for (const video of sourceVideos) {
      expect(video.muted).toBe(true)
      expect(video.defaultMuted).toBe(true)
      expect(video.volume).toBe(0)
      expect(video.paused).toBe(true)
    }
  })
})
