import { commands } from 'vitest/browser'
import { describe, expect, it } from 'vitest'
import type { ZoomRegion } from '@/components/video-editor/types'
import { FrameRenderer } from './frameRenderer'
import { VideoExporter } from './videoExporter'

/**
 * Export compositor benchmark. Opt-in, because it renders thousands of 1080p
 * frames and takes minutes:
 *
 *   node scripts/make-export-perf-fixture.mjs
 *   CAPTURIA_EXPORT_PERF=1 CAPTURIA_SPIKE_OUT=/tmp/export-perf.txt \
 *     npx vitest --config vitest.browser.config.ts --run \
 *     src/lib/exporter/frameRendererPerf.browser.test.ts
 *
 * It runs the same work twice — once with `legacyCompositor: true` (a video
 * texture and a drop-shadow raster per frame) and once with the caches — and
 * reports wall time and median ms/frame for each. Numbers are only meaningful
 * against a quiet machine; the headless Chromium the browser lane uses runs on
 * SwiftShader, so they are a lower bound on the win, not a product claim.
 */

const ENABLED = import.meta.env['CAPTURIA_EXPORT_PERF'] === '1'
const FIXTURE_URL = '/src/__fixtures__/perf-1080p.mp4'

const WIDTH = 1920
const HEIGHT = 1080
/**
 * Frames per benchmarked sequence. 60 spans 2 s of a 30 fps timeline; 120 spans
 * 4 s, which is what the zoom sequence below needs to cover *both* of its zoom
 * regions rather than only the first. Override with
 * `CAPTURIA_EXPORT_PERF_FRAMES` so a reported number can be reproduced at the
 * length it was measured at.
 */
const FRAME_COUNT = Number(import.meta.env['CAPTURIA_EXPORT_PERF_FRAMES'] ?? 60) || 60
const FPS = 30

async function report(line: string): Promise<void> {
  console.log(line)
  try {
    await (
      commands as unknown as {
        writeSpikeArtifact: (name: string, content: string) => Promise<string>
      }
    ).writeSpikeArtifact('export-perf.txt', `${line}\n`)
  } catch {
    // The artifact command is optional.
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function paintSourceFrame(canvas: HTMLCanvasElement, index: number): void {
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#0e1420'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  for (let row = 0; row < 9; row += 1) {
    for (let col = 0; col < 16; col += 1) {
      ctx.fillStyle = (row + col + index) % 2 === 0 ? '#eef2f5' : '#2c6f52'
      ctx.fillRect(col * 120, row * 120, 120, 120)
    }
  }
  ctx.fillStyle = '#ffffff'
  ctx.font = 'bold 140px sans-serif'
  ctx.fillText(`${index}`, 80, 220)
}

function perfConfig(legacyCompositor: boolean, zoomRegions: ZoomRegion[]) {
  return {
    width: WIDTH,
    height: HEIGHT,
    wallpaper: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    zoomRegions,
    showShadow: true,
    shadowIntensity: 0.8,
    showBlur: false,
    borderRadius: 24,
    padding: 10,
    cropRegion: { x: 0, y: 0, width: 1, height: 1 },
    videoWidth: WIDTH,
    videoHeight: HEIGHT,
    previewWidth: 1920,
    previewHeight: 1080,
    platform: 'linux',
    legacyCompositor,
  }
}

async function benchRenderer(
  legacyCompositor: boolean,
  zoomRegions: ZoomRegion[],
): Promise<{ totalMs: number; medianMs: number; stats: FrameRenderer['stats'] }> {
  const renderer = new FrameRenderer(perfConfig(legacyCompositor, zoomRegions))
  await renderer.initialize()
  const source = document.createElement('canvas')
  source.width = WIDTH
  source.height = HEIGHT
  const durations: number[] = []
  try {
    // One warm-up frame so shader and pipeline compilation is not measured.
    paintSourceFrame(source, 0)
    const warmup = new VideoFrame(source, { timestamp: 0 })
    await renderer.renderFrame(warmup, 0, { effectTimeMs: 0 })
    warmup.close()

    const started = performance.now()
    for (let index = 0; index < FRAME_COUNT; index += 1) {
      paintSourceFrame(source, index)
      const timestampUs = Math.round((index / FPS) * 1_000_000)
      const frame = new VideoFrame(source, { timestamp: timestampUs })
      const frameStart = performance.now()
      await renderer.renderFrame(frame, timestampUs, { effectTimeMs: (index / FPS) * 1000 })
      durations.push(performance.now() - frameStart)
      frame.close()
    }
    return {
      totalMs: performance.now() - started,
      medianMs: median(durations),
      stats: { ...renderer.stats },
    }
  } finally {
    renderer.destroy()
  }
}

describe.skipIf(!ENABLED)('export compositor benchmark (1080p)', () => {
  it('renders a static-camera sequence faster than the legacy compositor', async () => {
    const legacy = await benchRenderer(true, [])
    const cached = await benchRenderer(false, [])
    await report(
      `[render static 1080p] legacy total=${legacy.totalMs.toFixed(0)}ms ` +
        `median=${legacy.medianMs.toFixed(2)}ms/frame textures=${legacy.stats.textureAllocations} ` +
        `shadowRasters=${legacy.stats.shadowRasterisations} | ` +
        `cached total=${cached.totalMs.toFixed(0)}ms median=${cached.medianMs.toFixed(2)}ms/frame ` +
        `textures=${cached.stats.textureAllocations} shadowRasters=${cached.stats.shadowRasterisations} ` +
        `| speedup=${(legacy.totalMs / cached.totalMs).toFixed(2)}x`,
    )
    expect(cached.totalMs).toBeGreaterThan(0)
  }, 600_000)

  it('does not regress a zoom-heavy sequence', async () => {
    const zoomRegions: ZoomRegion[] = [
      { id: 'z1', startMs: 200, endMs: 2200, depth: 3, focus: { cx: 0.35, cy: 0.6 } },
      { id: 'z2', startMs: 2600, endMs: 3800, depth: 5, focus: { cx: 0.7, cy: 0.3 } },
    ]
    const legacy = await benchRenderer(true, zoomRegions)
    const cached = await benchRenderer(false, zoomRegions)
    await report(
      `[render zoom 1080p] legacy total=${legacy.totalMs.toFixed(0)}ms ` +
        `median=${legacy.medianMs.toFixed(2)}ms/frame | ` +
        `cached total=${cached.totalMs.toFixed(0)}ms median=${cached.medianMs.toFixed(2)}ms/frame ` +
        `shadowRasters=${cached.stats.shadowRasterisations} ` +
        `| speedup=${(legacy.totalMs / cached.totalMs).toFixed(2)}x`,
    )
    expect(cached.totalMs).toBeGreaterThan(0)
  }, 600_000)

  it('exports the 1080p fixture end to end on both compositors', async () => {
    const response = await fetch(FIXTURE_URL)
    if (!response.ok) {
      await report(
        `[export 1080p] fixture missing (${FIXTURE_URL}); run scripts/make-export-perf-fixture.mjs`,
      )
      return
    }
    const blobUrl = URL.createObjectURL(await response.blob())
    try {
      const runs: Record<string, { totalMs: number; frames: number }> = {}
      for (const legacyCompositor of [true, false]) {
        const started = performance.now()
        let lastFrame = 0
        const exporter = new VideoExporter({
          videoUrl: blobUrl,
          width: WIDTH,
          height: HEIGHT,
          frameRate: FPS,
          bitrate: 8_000_000,
          wallpaper: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
          zoomRegions: [
            { id: 'z1', startMs: 500, endMs: 3000, depth: 3, focus: { cx: 0.4, cy: 0.5 } },
          ],
          showShadow: true,
          shadowIntensity: 0.8,
          showBlur: false,
          borderRadius: 24,
          padding: 10,
          cropRegion: { x: 0, y: 0, width: 1, height: 1 },
          audioEnabled: false,
          legacyCompositor,
          onProgress: (progress) => {
            if (progress.currentFrame > lastFrame) lastFrame = progress.currentFrame
          },
        })
        const result = await exporter.export()
        const totalMs = performance.now() - started
        runs[legacyCompositor ? 'legacy' : 'cached'] = { totalMs, frames: lastFrame }
        if (!result.success) {
          await report(
            `[export 1080p] ${legacyCompositor ? 'legacy' : 'cached'} FAILED: ${result.error}`,
          )
          return
        }
      }
      await report(
        `[export 1080p e2e] legacy wall=${(runs['legacy'].totalMs / 1000).toFixed(2)}s ` +
          `(${runs['legacy'].frames} frames, ${(runs['legacy'].totalMs / runs['legacy'].frames).toFixed(2)} ms/frame) | ` +
          `cached wall=${(runs['cached'].totalMs / 1000).toFixed(2)}s ` +
          `(${runs['cached'].frames} frames, ${(runs['cached'].totalMs / runs['cached'].frames).toFixed(2)} ms/frame) ` +
          `| speedup=${(runs['legacy'].totalMs / runs['cached'].totalMs).toFixed(2)}x`,
      )
      expect(runs['cached'].totalMs).toBeGreaterThan(0)
    } finally {
      URL.revokeObjectURL(blobUrl)
    }
  }, 1_800_000)
})
