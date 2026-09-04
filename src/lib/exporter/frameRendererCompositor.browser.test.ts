import { commands } from 'vitest/browser'
import { describe, expect, it } from 'vitest'
import type { ZoomRegion } from '@/components/video-editor/types'
import { FrameRenderer } from './frameRenderer'

/**
 * Compositor parity, checked in a real browser with real WebGL.
 *
 * `legacyCompositor: true` is the allocate-per-frame path the exporter used
 * before the caches (a new video texture per frame, a fresh drop-shadow raster
 * per frame); `false` is the current one. Both must produce the same picture,
 * so the same frames go through both renderers and every output pixel is
 * compared.
 *
 * The threshold is per channel on 0..255. The only place the two paths can
 * legitimately disagree is the antialiased outline of the rounded mask, where
 * the cached path composites `shadow -> background -> video` in three 8-bit
 * steps instead of two, and the recovered shadow alpha is quantised.
 */

const WIDTH = 640
const HEIGHT = 360
const SOURCE_WIDTH = 1280
const SOURCE_HEIGHT = 720
const FRAME_COUNT = 8
const FPS = 30

/** Largest per-channel difference tolerated between the two compositors. */
const MAX_CHANNEL_DELTA = 2
/** Largest share of pixels allowed to differ at all. */
const MAX_DIFFERING_PIXEL_RATIO = 0.02

/**
 * Browser-mode `console.log` is not forwarded to the terminal, so the measured
 * numbers go to a file the node side writes (see `writeSpikeArtifact` in
 * `vitest.browser.config.ts`; `CAPTURIA_SPIKE_OUT` overrides the path).
 */
async function report(line: string): Promise<void> {
  // eslint-disable-next-line no-console -- also useful when debugging in a headed run
  console.log(line)
  try {
    await (
      commands as unknown as {
        writeSpikeArtifact: (name: string, content: string) => Promise<string>
      }
    ).writeSpikeArtifact('compositor-parity.txt', `${line}\n`)
  } catch {
    // The command is optional; a missing one must not fail the assertion.
  }
}

interface Diff {
  maxChannelDelta: number
  meanAbsDelta: number
  differingPixels: number
  totalPixels: number
}

function makeSourceCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = SOURCE_WIDTH
  canvas.height = SOURCE_HEIGHT
  return canvas
}

/** Deterministic, high-contrast content so a compositing slip cannot hide. */
function paintSourceFrame(canvas: HTMLCanvasElement, index: number): void {
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#101822'
  ctx.fillRect(0, 0, SOURCE_WIDTH, SOURCE_HEIGHT)
  for (let row = 0; row < 9; row += 1) {
    for (let col = 0; col < 16; col += 1) {
      const on = (row + col + index) % 2 === 0
      ctx.fillStyle = on ? '#f2f5f7' : '#2f6f4f'
      ctx.fillRect(col * 80, row * 80, 80, 80)
    }
  }
  ctx.fillStyle = '#ff3355'
  ctx.fillRect(40 + index * 24, 300, 160, 90)
  ctx.fillStyle = '#ffffff'
  ctx.font = 'bold 96px sans-serif'
  ctx.fillText(`frame ${index}`, 60, 140)
}

function diffCanvases(a: HTMLCanvasElement, b: HTMLCanvasElement): Diff {
  const aData = a.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, WIDTH, HEIGHT)
  const bData = b.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, WIDTH, HEIGHT)
  let maxChannelDelta = 0
  let sum = 0
  let differingPixels = 0
  const total = WIDTH * HEIGHT
  for (let i = 0; i < aData.data.length; i += 4) {
    let pixelDiffers = false
    for (let c = 0; c < 4; c += 1) {
      const delta = Math.abs(aData.data[i + c] - bData.data[i + c])
      if (delta > 0) pixelDiffers = true
      if (delta > maxChannelDelta) maxChannelDelta = delta
      sum += delta
    }
    if (pixelDiffers) differingPixels += 1
  }
  return {
    maxChannelDelta,
    meanAbsDelta: sum / (total * 4),
    differingPixels,
    totalPixels: total,
  }
}

/** Copies the renderer's composite canvas so it survives the next frame. */
function snapshot(source: HTMLCanvasElement): HTMLCanvasElement {
  const copy = document.createElement('canvas')
  copy.width = WIDTH
  copy.height = HEIGHT
  copy.getContext('2d', { willReadFrequently: true })!.drawImage(source, 0, 0)
  return copy
}

function baseConfig(legacyCompositor: boolean, platform: string | undefined) {
  return {
    width: WIDTH,
    height: HEIGHT,
    wallpaper: 'linear-gradient(135deg, #f6d365 0%, #fda085 100%)',
    zoomRegions: [] as ZoomRegion[],
    showShadow: true,
    shadowIntensity: 0.8,
    showBlur: false,
    borderRadius: 24,
    padding: 12,
    cropRegion: { x: 0.05, y: 0.05, width: 0.9, height: 0.9 },
    videoWidth: SOURCE_WIDTH,
    videoHeight: SOURCE_HEIGHT,
    previewWidth: 1920,
    previewHeight: 1080,
    platform,
    legacyCompositor,
  }
}

async function renderSequence(
  legacyCompositor: boolean,
  platform: string | undefined,
  zoomRegions: ZoomRegion[],
): Promise<{ frames: HTMLCanvasElement[]; stats: FrameRenderer['stats'] }> {
  const renderer = new FrameRenderer({ ...baseConfig(legacyCompositor, platform), zoomRegions })
  await renderer.initialize()
  const source = makeSourceCanvas()
  const frames: HTMLCanvasElement[] = []
  try {
    for (let index = 0; index < FRAME_COUNT; index += 1) {
      paintSourceFrame(source, index)
      const timestampUs = Math.round((index / FPS) * 1_000_000)
      const frame = new VideoFrame(source, { timestamp: timestampUs })
      try {
        await renderer.renderFrame(frame, timestampUs, { effectTimeMs: (index / FPS) * 1000 })
      } finally {
        frame.close()
      }
      frames.push(snapshot(renderer.getCanvas()))
    }
    return { frames, stats: { ...renderer.stats } }
  } finally {
    renderer.destroy()
  }
}

describe('export compositor parity (real WebGL)', () => {
  for (const platform of [undefined, 'linux'] as const) {
    const label = platform ?? 'default'

    it(`matches the legacy compositor on a static camera (${label} path)`, async () => {
      const legacy = await renderSequence(true, platform, [])
      const cached = await renderSequence(false, platform, [])

      // The caches did engage: one texture, one mask, one shadow raster.
      expect(cached.stats.framesRendered).toBe(FRAME_COUNT)
      expect(cached.stats.textureAllocations).toBe(1)
      expect(cached.stats.layoutRebuilds).toBe(1)
      expect(cached.stats.shadowRasterisations).toBe(1)
      // ...and the legacy path really did allocate one texture per frame.
      expect(legacy.stats.textureAllocations).toBe(FRAME_COUNT)

      const worst: Diff[] = []
      for (let index = 0; index < FRAME_COUNT; index += 1) {
        worst.push(diffCanvases(legacy.frames[index], cached.frames[index]))
      }
      const maxChannelDelta = Math.max(...worst.map((d) => d.maxChannelDelta))
      const maxRatio = Math.max(...worst.map((d) => d.differingPixels / d.totalPixels))
      const meanAbsDelta = Math.max(...worst.map((d) => d.meanAbsDelta))
      await report(
        `[compositor-parity ${label}] maxChannelDelta=${maxChannelDelta} ` +
          `meanAbsDelta=${meanAbsDelta.toFixed(5)} differingPixelRatio=${maxRatio.toFixed(5)}`,
      )
      expect(maxChannelDelta).toBeLessThanOrEqual(MAX_CHANNEL_DELTA)
      expect(maxRatio).toBeLessThanOrEqual(MAX_DIFFERING_PIXEL_RATIO)
    })
  }

  it('matches the legacy compositor while the zoom camera is moving', async () => {
    const zoomRegions: ZoomRegion[] = [
      {
        id: 'zoom-parity',
        startMs: 30,
        endMs: 260,
        depth: 3,
        focus: { cx: 0.35, cy: 0.6 },
      },
    ]
    const legacy = await renderSequence(true, undefined, zoomRegions)
    const cached = await renderSequence(false, undefined, zoomRegions)

    const diffs = []
    for (let index = 0; index < FRAME_COUNT; index += 1) {
      diffs.push(diffCanvases(legacy.frames[index], cached.frames[index]))
    }
    const maxChannelDelta = Math.max(...diffs.map((d) => d.maxChannelDelta))
    const maxRatio = Math.max(...diffs.map((d) => d.differingPixels / d.totalPixels))
    await report(
      `[compositor-parity zoom] maxChannelDelta=${maxChannelDelta} ` +
        `differingPixelRatio=${maxRatio.toFixed(5)} ` +
        `shadowRasterisations=${cached.stats.shadowRasterisations}`,
    )
    expect(maxChannelDelta).toBeLessThanOrEqual(MAX_CHANNEL_DELTA)
    expect(maxRatio).toBeLessThanOrEqual(MAX_DIFFERING_PIXEL_RATIO)
  })

  it('keeps one texture across frames and rebuilds it when the source size changes', async () => {
    const renderer = new FrameRenderer(baseConfig(false, undefined))
    await renderer.initialize()
    try {
      const small = document.createElement('canvas')
      small.width = SOURCE_WIDTH
      small.height = SOURCE_HEIGHT
      paintSourceFrame(small, 0)
      for (let index = 0; index < 3; index += 1) {
        const frame = new VideoFrame(small, { timestamp: index * 1000 })
        await renderer.renderFrame(frame, index * 1000)
        frame.close()
      }
      expect(renderer.stats.textureAllocations).toBe(1)

      const resized = document.createElement('canvas')
      resized.width = SOURCE_WIDTH / 2
      resized.height = SOURCE_HEIGHT / 2
      resized.getContext('2d')!.fillRect(0, 0, resized.width, resized.height)
      const resizedFrame = new VideoFrame(resized, { timestamp: 9000 })
      await renderer.renderFrame(resizedFrame, 9000)
      resizedFrame.close()
      expect(renderer.stats.textureAllocations).toBe(2)
    } finally {
      renderer.destroy()
    }
  })
})
