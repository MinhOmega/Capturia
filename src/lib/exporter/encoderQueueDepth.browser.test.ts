import { commands } from 'vitest/browser'
import { describe, expect, it } from 'vitest'
import { VideoExporter } from './videoExporter'

/**
 * Encoder queue depth, measured on a real 1080p export.
 *
 * A deep queue only buys throughput while the encoder is the slower half of
 * the pipeline: it lets the render loop run ahead instead of blocking. Each
 * queued frame keeps a `VideoFrame` alive, so the depth is paid for in memory.
 * On the Linux CPU-readback path the renderer is by far the slower half, so the
 * queue is expected never to fill and the depth to buy nothing.
 *
 * Opt-in, because it runs two full 1080p exports:
 *
 *   node scripts/make-export-perf-fixture.mjs 4
 *   CAPTURIA_EXPORT_PERF=1 CAPTURIA_SPIKE_OUT=/tmp/queue-depth.txt \
 *     npx vitest --config vitest.browser.config.ts --run \
 *     src/lib/exporter/encoderQueueDepth.browser.test.ts
 *
 * The renderer's resident memory is sampled from outside the page by
 * `scripts/sample-renderer-rss.mjs`, because a queued frame lives in native
 * memory that `performance.memory` cannot see. What the page can report is the
 * JS heap and the peak queue occupancy — and the occupancy is the number that
 * decides the question: a limit that is never reached cannot matter.
 */

const ENABLED = import.meta.env['CAPTURIA_EXPORT_PERF'] === '1'
const FIXTURE_URL = '/src/__fixtures__/perf-1080p.mp4'
const WIDTH = 1920
const HEIGHT = 1080
const FPS = 30

async function report(line: string): Promise<void> {
  console.log(line)
  try {
    await (
      commands as unknown as {
        writeSpikeArtifact: (name: string, content: string) => Promise<string>
      }
    ).writeSpikeArtifact('queue-depth.txt', `${line}\n`)
  } catch {
    // The artifact command is optional.
  }
}

interface HeapSample {
  usedJsHeapSize: number
}

function readHeap(): number {
  const memory = (performance as unknown as { memory?: HeapSample }).memory
  return memory?.usedJsHeapSize ?? 0
}

async function runExport(
  blobUrl: string,
  maxEncodeQueue: number,
): Promise<{
  totalMs: number
  frames: number
  peakHeapBytes: number
  peakQueue: number
  ok: boolean
  error?: string
}> {
  let peakHeapBytes = readHeap()
  let frames = 0
  const started = performance.now()
  const exporter = new VideoExporter({
    videoUrl: blobUrl,
    width: WIDTH,
    height: HEIGHT,
    frameRate: FPS,
    bitrate: 8_000_000,
    wallpaper: '#101820',
    zoomRegions: [],
    showShadow: true,
    shadowIntensity: 0.8,
    showBlur: false,
    borderRadius: 24,
    padding: 10,
    cropRegion: { x: 0, y: 0, width: 1, height: 1 },
    audioEnabled: false,
    maxEncodeQueue,
    onProgress: (progress) => {
      if (progress.currentFrame > frames) frames = progress.currentFrame
      const heap = readHeap()
      if (heap > peakHeapBytes) peakHeapBytes = heap
    },
  })
  const result = await exporter.export()
  return {
    totalMs: performance.now() - started,
    frames,
    peakHeapBytes,
    peakQueue: exporter.peakEncodeQueue,
    ok: result.success,
    error: result.error,
  }
}

describe.skipIf(!ENABLED)('encoder queue depth (1080p export)', () => {
  it('compares depth 120 against depth 32', async () => {
    const response = await fetch(FIXTURE_URL)
    if (!response.ok) {
      await report(`[queue-depth] fixture missing (${FIXTURE_URL})`)
      return
    }
    const blobUrl = URL.createObjectURL(await response.blob())
    try {
      for (const depth of [120, 32]) {
        const run = await runExport(blobUrl, depth)
        await report(
          `[queue-depth ${depth}] ok=${run.ok} wall=${(run.totalMs / 1000).toFixed(2)}s ` +
            `frames=${run.frames} ` +
            `msPerFrame=${run.frames > 0 ? (run.totalMs / run.frames).toFixed(1) : 'n/a'} ` +
            `peakQueue=${run.peakQueue} ` +
            `peakJsHeap=${(run.peakHeapBytes / 1024 / 1024).toFixed(1)}MB` +
            (run.error ? ` error=${run.error}` : ''),
        )
        expect(run.totalMs).toBeGreaterThan(0)
      }
    } finally {
      URL.revokeObjectURL(blobUrl)
    }
  }, 1_800_000)
})
