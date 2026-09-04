import { server } from 'vitest/browser'
import { beforeAll, describe, expect, it } from 'vitest'
import fixtureUrl from '@/__fixtures__/scrolling-table.webm?url'
import {
  decodeTimecode,
  FIXTURE_TIMECODE,
  rowRectAt,
  SCROLLING_TABLE_FIXTURE,
  TRACKED_ROW,
} from '@/__fixtures__/scrollingTable'
import { StreamingVideoDecoder } from '@/lib/exporter/streamingDecoder'
import type { ExportDecodePath } from '@/lib/exporter/types'
import { resolveTrackedBlurRect } from './keyframes'
import { trackBlurRegion, type TrackBlurRegionResult } from './trackBlurRegion'
import { BLUR_TRACKER_TUNING } from './trackerCore'

/**
 * The tracker end to end in a real browser: a real WebM, a real WebCodecs
 * decoder, real `OffscreenCanvas` draws and a real worker
 * (`docs/specs/tracked-blur-regions.md` §4.2).
 *
 * The fixture's scroll programme is known exactly
 * (`src/__fixtures__/scrollingTable.ts`), so every assertion here is against
 * ground truth rather than against a previous run of the tracker.
 */

/**
 * `writeSpikeArtifact` is registered in `vitest.browser.config.ts`; browser-mode
 * `console.log` is not forwarded to the terminal, so a measurement has nowhere
 * else to go. Declared here because this is currently its only caller.
 */
declare module 'vitest/internal/browser' {
  interface BrowserCommands {
    writeSpikeArtifact: (name: string, content: string) => Promise<string>
  }
}

const SOURCE = { width: SCROLLING_TABLE_FIXTURE.width, height: SCROLLING_TABLE_FIXTURE.height }
const ANCHOR_MS = 1000
const SPAN = { startMs: 0, endMs: 5800 }

/** Recall tolerance, source px, per the design: 3 on WebCodecs, 6 when seeking. */
const TOLERANCE_PX: Record<ExportDecodePath, number> = { webcodecs: 3, seek: 6 }

/**
 * Video time -> programme time, read out of the timecode drawn into every
 * frame.
 *
 * `MediaRecorder` timestamps a frame when it arrives, not when it was drawn, so
 * the frame at video time t shows some nearby instant of the scroll programme
 * rather than t exactly. Reading the timecode is what makes the assertions
 * below measure the tracker instead of the recorder's jitter.
 */
const timeline: Array<{ videoMs: number; programmeMs: number }> = []

async function readTimeline(): Promise<void> {
  const decoder = new StreamingVideoDecoder()
  const canvas = document.createElement('canvas')
  canvas.width = SOURCE.width
  canvas.height = SOURCE.height
  const context = canvas.getContext('2d', { willReadFrequently: true })!
  try {
    await decoder.loadMetadata(fixtureUrl)
    await decoder.decodeRange({ startSec: 0, endSec: 10 }, (frame, videoMs) => {
      try {
        context.drawImage(frame, 0, 0)
        const { x, y, cellWidth, cellHeight, bits } = FIXTURE_TIMECODE
        const strip = context.getImageData(x, y + (cellHeight >> 1), cellWidth * bits, 1).data
        let code = 0
        for (let bit = 0; bit < bits; bit++) {
          const centre = (bit * cellWidth + (cellWidth >> 1)) * 4
          if (strip[centre] >= 128) code |= 1 << bit
        }
        timeline.push({ videoMs, programmeMs: decodeTimecode(code) })
      } finally {
        frame.close()
      }
    })
  } finally {
    decoder.destroy()
  }
  timeline.sort((a, b) => a.videoMs - b.videoMs)
}

/** The programme instant the frame nearest `videoMs` shows. */
function programmeAt(videoMs: number): number {
  let best = timeline[0]
  for (const entry of timeline) {
    if (Math.abs(entry.videoMs - videoMs) < Math.abs(best.videoMs - videoMs)) best = entry
  }
  return best.programmeMs
}

function anchorRect(): { x: number; y: number; w: number; h: number } {
  const rect = rowRectAt(TRACKED_ROW, programmeAt(ANCHOR_MS))
  return {
    x: rect.x / SOURCE.width,
    y: rect.y / SOURCE.height,
    w: rect.w / SOURCE.width,
    h: rect.h / SOURCE.height,
  }
}

/**
 * The instants where the scroll is smooth, so a per-sample tolerance is
 * meaningful. The 200 ms jump and one grid interval either side are left to the
 * coverage test below: through a movement the grid cannot resolve, the question
 * is whether the content stayed covered, not whether the rect is within 3 px.
 */
function smoothInstants(): number[] {
  const times: number[] = []
  for (let timeMs = 200; timeMs <= 2800; timeMs += 100) times.push(timeMs)
  for (let timeMs = 3500; timeMs <= 4400; timeMs += 100) times.push(timeMs)
  for (let timeMs = 4600; timeMs <= 5700; timeMs += 100) times.push(timeMs)
  return times
}

interface Recall {
  checked: number
  within: number
  worstPx: number
}

function measureRecall(result: TrackBlurRegionResult, tolerancePx: number): Recall {
  let within = 0
  let worstPx = 0
  const instants = smoothInstants()
  for (const timeMs of instants) {
    const resolved = resolveTrackedBlurRect(result.track, timeMs)
    if (!resolved) continue
    const truth = rowRectAt(TRACKED_ROW, programmeAt(timeMs))
    const error = Math.abs(resolved.rect.y * SOURCE.height - truth.y)
    worstPx = Math.max(worstPx, error)
    if (error <= tolerancePx) within++
  }
  return { checked: instants.length, within, worstPx }
}

async function report(name: string, lines: string[]): Promise<void> {
  const text = `${lines.join('\n')}\n`
  // Browser-mode console.log is not forwarded to the terminal, so the numbers
  // go through the artifact command the redaction spike already uses.
  await server.commands.writeSpikeArtifact(name, `\n--- ${name} ---\n${text}`)
  console.log(`[blur-tracking] ${name}\n${text}`)
}

let webcodecsSupported = false

/**
 * Decodes the whole fixture once to read its timecode, which is real work: a
 * few seconds alone, longer when the rest of the browser lane is decoding and
 * encoding in the same Chromium. The 30 s `hookTimeout` in
 * `vitest.browser.config.ts` is sized for hooks that only set state, so this
 * one carries its own budget rather than failing the suite under load.
 */
beforeAll(async () => {
  if (typeof VideoDecoder === 'undefined') return
  const support = await VideoDecoder.isConfigSupported({ codec: 'vp09.00.10.08' }).catch(() => null)
  webcodecsSupported = support?.supported === true
  if (webcodecsSupported) await readTimeline()
}, 120_000)

describe('trackBlurRegion (real browser)', () => {
  it('recovers the scroll within 3 source px on the WebCodecs path', async () => {
    expect(
      webcodecsSupported,
      'this browser cannot decode the VP9 fixture; the tracker has nothing to run on',
    ).toBe(true)

    const started = performance.now()
    const result = await trackBlurRegion({
      videoUrl: fixtureUrl,
      ...SPAN,
      anchorMs: ANCHOR_MS,
      anchorRect: anchorRect(),
      decodePath: 'webcodecs',
    })
    const wallMs = performance.now() - started

    expect(result.decodePath).toBe('webcodecs')
    expect(result.track.keyframes.length).toBeGreaterThan(10)
    expect(result.track.sourceSize).toEqual(SOURCE)

    const recall = measureRecall(result, TOLERANCE_PX.webcodecs)
    await report('blur-tracking-webcodecs.txt', [
      `keyframes           ${result.track.keyframes.length}`,
      `analysed samples    ${result.analysedSamples}`,
      `decode wall ms      ${result.decodeMs.toFixed(1)}`,
      `analyse wall ms     ${result.analyseMs.toFixed(1)}`,
      `total wall ms       ${wallMs.toFixed(1)}`,
      `ms per sample       ${(result.analyseMs / Math.max(1, result.analysedSamples)).toFixed(2)}`,
      `VideoFrame transfer ${result.transferredVideoFrames}`,
      `recall within ${TOLERANCE_PX.webcodecs} px  ${recall.within}/${recall.checked}`,
      `worst error px      ${recall.worstPx.toFixed(2)}`,
      `mean score          ${result.track.quality?.meanScore.toFixed(3)}`,
      `hidden ms           ${result.track.quality?.lostMs}`,
    ])

    expect(recall.within / recall.checked).toBeGreaterThanOrEqual(0.95)
  })

  it('recovers the scroll within 6 source px on the seek path', async () => {
    const started = performance.now()
    const result = await trackBlurRegion({
      videoUrl: fixtureUrl,
      ...SPAN,
      anchorMs: ANCHOR_MS,
      anchorRect: anchorRect(),
      decodePath: 'seek',
    })
    const wallMs = performance.now() - started

    expect(result.decodePath).toBe('seek')
    const recall = measureRecall(result, TOLERANCE_PX.seek)
    await report('blur-tracking-seek.txt', [
      `keyframes           ${result.track.keyframes.length}`,
      `analysed samples    ${result.analysedSamples}`,
      `decode wall ms      ${result.decodeMs.toFixed(1)}`,
      `analyse wall ms     ${result.analyseMs.toFixed(1)}`,
      `total wall ms       ${wallMs.toFixed(1)}`,
      `recall within ${TOLERANCE_PX.seek} px  ${recall.within}/${recall.checked}`,
      `worst error px      ${recall.worstPx.toFixed(2)}`,
    ])

    expect(recall.within / recall.checked).toBeGreaterThanOrEqual(0.95)
  })

  it('covers the content through the 200 px jump the grid cannot interpolate', async () => {
    expect(webcodecsSupported).toBe(true)
    const result = await trackBlurRegion({
      videoUrl: fixtureUrl,
      ...SPAN,
      anchorMs: ANCHOR_MS,
      anchorRect: anchorRect(),
      decodePath: 'webcodecs',
    })

    // Through the jump, what matters is how much of the row the mosaic is
    // actually on at every displayed frame. A rect a frame stale is a rect on
    // the wrong row, and for a redaction that is the leak this feature exists
    // to prevent - so the measure is overlap, not distance.
    const overlaps: number[] = []
    for (let timeMs = 2950; timeMs <= 3450; timeMs += 1000 / SCROLLING_TABLE_FIXTURE.frameRate) {
      const resolved = resolveTrackedBlurRect(result.track, timeMs)
      const truth = rowRectAt(TRACKED_ROW, programmeAt(timeMs))
      if (!resolved) {
        overlaps.push(0)
        continue
      }
      const top = resolved.rect.y * SOURCE.height
      const bottom = top + resolved.rect.h * SOURCE.height
      const covered = Math.max(0, Math.min(bottom, truth.y + truth.h) - Math.max(top, truth.y))
      overlaps.push(covered / truth.h)
    }
    const worst = Math.min(...overlaps)
    const mean = overlaps.reduce((total, value) => total + value, 0) / overlaps.length
    await report('blur-tracking-jump.txt', [
      `frames checked      ${overlaps.length}`,
      `worst overlap       ${worst.toFixed(3)}`,
      `mean overlap        ${mean.toFixed(3)}`,
      `row y before jump   ${rowRectAt(TRACKED_ROW, programmeAt(3000)).y.toFixed(1)}`,
      `row y after jump    ${rowRectAt(TRACKED_ROW, programmeAt(3400)).y.toFixed(1)}`,
      `keyframes in jump   ${result.track.keyframes.filter((k) => k.timeMs >= 2950 && k.timeMs <= 3450).length}`,
    ])
    expect(overlaps.length).toBeGreaterThan(5)
    // Densification analyses the jump at the source frame rate, so the rect
    // should be on the row throughout rather than sliding across it.
    expect(worst).toBeGreaterThanOrEqual(0.5)
    expect(mean).toBeGreaterThanOrEqual(0.85)
  })

  it('produces identical keyframes on a second run over the same file', async () => {
    expect(webcodecsSupported).toBe(true)
    const options = {
      videoUrl: fixtureUrl,
      ...SPAN,
      anchorMs: ANCHOR_MS,
      anchorRect: anchorRect(),
      decodePath: 'webcodecs' as const,
    }
    const first = await trackBlurRegion(options)
    const second = await trackBlurRegion(options)
    expect(second.track.keyframes).toEqual(first.track.keyframes)
    expect(second.track.quality).toEqual(first.track.quality)
  })

  it('rejects with AbortError on cancel and leaves the next run working', async () => {
    expect(webcodecsSupported).toBe(true)
    const controller = new AbortController()
    const pending = trackBlurRegion({
      videoUrl: fixtureUrl,
      ...SPAN,
      anchorMs: ANCHOR_MS,
      anchorRect: anchorRect(),
      decodePath: 'webcodecs',
      signal: controller.signal,
      onProgress: ({ decodedMs }) => {
        if (decodedMs > 200) controller.abort()
      },
    })
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })

    // A leaked VideoFrame holds a decoder buffer; a handful of them stall the
    // next decode outright, so a second run succeeding is the leak check.
    const after = await trackBlurRegion({
      videoUrl: fixtureUrl,
      startMs: 0,
      endMs: 2000,
      anchorMs: ANCHOR_MS,
      anchorRect: anchorRect(),
      decodePath: 'webcodecs',
    })
    expect(after.track.keyframes.length).toBeGreaterThan(3)
  })

  it('refuses a patch with too little detail to track', async () => {
    expect(webcodecsSupported).toBe(true)
    await expect(
      trackBlurRegion({
        videoUrl: fixtureUrl,
        startMs: 0,
        endMs: 1500,
        anchorMs: ANCHOR_MS,
        // A flat area of the dark background, left of the pane and below the
        // sidebar entries.
        anchorRect: { x: 0.02, y: 0.85, w: 0.12, h: 0.08 },
        decodePath: 'webcodecs',
      }),
    ).rejects.toThrow(/low-detail/)
  })

  /**
   * The acceptance number for phase 1: median milliseconds per analysed sample.
   * Reported, not tuned to pass - the design's kill criterion is on the real
   * measurement (§5).
   */
  it('benchmarks the analysis at the design budget', async () => {
    expect(webcodecsSupported).toBe(true)
    // A warm-up run first: the first frames of a cold tracker are the JIT
    // compiling, not analysis, and they dominate a run this short.
    await trackBlurRegion({
      videoUrl: fixtureUrl,
      startMs: 0,
      endMs: 2000,
      anchorMs: ANCHOR_MS,
      anchorRect: anchorRect(),
      decodePath: 'webcodecs',
      useWorker: false,
    })

    const result = await trackBlurRegion({
      videoUrl: fixtureUrl,
      ...SPAN,
      anchorMs: ANCHOR_MS,
      anchorRect: anchorRect(),
      decodePath: 'webcodecs',
      // Measured without the worker so the number is analysis, not postMessage
      // latency; the worker exists to keep the main thread free, not to be fast.
      useWorker: false,
    })

    const sorted = [...result.analyseDurationsMs].sort((a, b) => a - b)
    const at = (fraction: number) =>
      sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]
    await report('blur-tracking-benchmark.txt', [
      `analysed samples    ${result.analysedSamples}`,
      `timed pushes        ${sorted.length}`,
      `median ms/sample    ${at(0.5).toFixed(2)}`,
      `p90 ms/sample       ${at(0.9).toFixed(2)}`,
      `min ms/sample       ${sorted[0].toFixed(2)}`,
      `max ms/sample       ${sorted[sorted.length - 1].toFixed(2)}`,
      `mean ms/sample      ${(result.analyseMs / Math.max(1, result.analysedSamples)).toFixed(2)}`,
      `analyse wall ms     ${result.analyseMs.toFixed(1)}`,
      `decode wall ms      ${result.decodeMs.toFixed(1)}`,
      `budget ms/sample    5`,
      `source              ${SOURCE.width}x${SOURCE.height}`,
      `patch               ${Math.round(anchorRect().w * SOURCE.width)}x${Math.round(anchorRect().h * SOURCE.height)} px`,
      `coarse width        ${BLUR_TRACKER_TUNING.coarseWidth}`,
    ])
    expect(sorted.length).toBeGreaterThan(10)
    // The design's kill criterion is 15 ms/sample after profiling, not the 5 ms
    // target: reported either way, never tuned to pass.
    expect(at(0.5)).toBeLessThan(15)
  })
})
