import { server } from '@vitest/browser/context'
import { describe, it } from 'vitest'
import fixtureUrl from '@/__fixtures__/scrolling-table.webm?url'
import {
  decodeTimecode,
  FIXTURE_TIMECODE,
  rowRectAt,
  SCROLLING_TABLE_FIXTURE,
} from '@/__fixtures__/scrollingTable'
import { StreamingVideoDecoder } from '@/lib/exporter/streamingDecoder'
import { resolveTrackedBlurRect } from './keyframes'
import { trackBlurRegion } from './trackBlurRegion'

declare module 'vitest/internal/browser' {
  interface BrowserCommands {
    writeSpikeArtifact: (name: string, content: string) => Promise<string>
  }
}

const SOURCE = { width: SCROLLING_TABLE_FIXTURE.width, height: SCROLLING_TABLE_FIXTURE.height }

describe('diag', () => {
  it('dumps the timeline and the track', async () => {
    const lines: string[] = []
    const decoder = new StreamingVideoDecoder()
    const canvas = document.createElement('canvas')
    canvas.width = SOURCE.width
    canvas.height = SOURCE.height
    const context = canvas.getContext('2d', { willReadFrequently: true })!
    const timeline: Array<{ videoMs: number; programmeMs: number }> = []
    const info = await decoder.loadMetadata(fixtureUrl)
    lines.push(`metadata ${JSON.stringify(info)}`)
    await decoder.decodeRange({ startSec: 0, endSec: 10 }, (frame, videoMs) => {
      try {
        context.drawImage(frame, 0, 0)
        const { x, y, cellWidth, cellHeight, bits } = FIXTURE_TIMECODE
        const strip = context.getImageData(x, y + (cellHeight >> 1), cellWidth * bits, 1).data
        let code = 0
        const raw: number[] = []
        for (let bit = 0; bit < bits; bit++) {
          const centre = (bit * cellWidth + (cellWidth >> 1)) * 4
          raw.push(strip[centre])
          if (strip[centre] >= 128) code |= 1 << bit
        }
        timeline.push({ videoMs, programmeMs: decodeTimecode(code) })
        if (timeline.length <= 4)
          lines.push(`  raw@${videoMs.toFixed(0)} ${raw.join(',')} code=${code}`)
      } finally {
        frame.close()
      }
    })
    decoder.destroy()
    timeline.sort((a, b) => a.videoMs - b.videoMs)
    lines.push(`frames ${timeline.length}`)
    lines.push(
      `timeline ${timeline
        .filter((_e, i) => i % 10 === 0)
        .map((e) => `${e.videoMs.toFixed(0)}->${e.programmeMs}`)
        .join(' ')}`,
    )

    const programmeAt = (videoMs: number): number => {
      let best = timeline[0]
      for (const entry of timeline) {
        if (Math.abs(entry.videoMs - videoMs) < Math.abs(best.videoMs - videoMs)) best = entry
      }
      return best.programmeMs
    }

    const TRACKED_ROW = 12
    const anchorProgramme = programmeAt(1000)
    const anchorPx = rowRectAt(TRACKED_ROW, anchorProgramme)
    lines.push(`anchor programme=${anchorProgramme} rect=${JSON.stringify(anchorPx)}`)

    const result = await trackBlurRegion({
      videoUrl: fixtureUrl,
      startMs: 0,
      endMs: 5800,
      anchorMs: 1000,
      anchorRect: {
        x: anchorPx.x / SOURCE.width,
        y: anchorPx.y / SOURCE.height,
        w: anchorPx.w / SOURCE.width,
        h: anchorPx.h / SOURCE.height,
      },
      decodePath: 'webcodecs',
      useWorker: false,
    })
    lines.push(`keyframes ${result.track.keyframes.length} analysed ${result.analysedSamples}`)
    for (let timeMs = 200; timeMs <= 5600; timeMs += 200) {
      const resolved = resolveTrackedBlurRect(result.track, timeMs)
      const truth = rowRectAt(TRACKED_ROW, programmeAt(timeMs))
      lines.push(
        `  t=${timeMs} prog=${programmeAt(timeMs)} truthY=${truth.y.toFixed(1)} gotY=${
          resolved ? (resolved.rect.y * SOURCE.height).toFixed(1) : 'none'
        } err=${resolved ? (resolved.rect.y * SOURCE.height - truth.y).toFixed(1) : '-'}`,
      )
    }
    await server.commands.writeSpikeArtifact('blur-diag.txt', `${lines.join('\n')}\n`)
  })
})
