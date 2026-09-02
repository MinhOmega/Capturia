import { useTimelineContext } from 'dnd-timeline'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { VideoSegment } from '../types'
import { computeNormalizationFactor, computeWaveformColumns } from './waveformColumns'

export interface BackgroundWaveformProps {
  /** Pre-computed peaks: pairs of [min, max] per block (length = 2 * N), in SOURCE time. */
  peaks: Float32Array | null
  /** Duration of the decoded audio (source time). */
  sourceDurationMs: number
  /** Capturia segments; maps the effective timeline back to source time. */
  segments?: VideoSegment[]
  /** Inset from canvas top so the waveform aligns with item content top. Defaults to 0. */
  topInset?: number
  /** Inset from canvas bottom so the waveform aligns with item content bottom. Defaults to 0. */
  bottomInset?: number
}

/**
 * Renders a rectified (half-wave) audio waveform on a canvas filling its row.
 * Pass as the `background` prop of `<Row>`, which already provides
 * `relative overflow-hidden`.
 *
 * Canvas is always `inset-0` (full row height); vertical alignment comes from
 * `topInset`/`bottomInset` in the draw calls, not CSS, so it's immune to
 * sub-pixel layout rounding. `pointer-events: none` keeps scrubbing working.
 */
export default function BackgroundWaveform({
  peaks,
  sourceDurationMs,
  segments,
  topInset = 0,
  bottomInset = 0,
}: BackgroundWaveformProps) {
  const { range } = useTimelineContext()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [canvasSize, setCanvasSize] = useState({ w: 0, h: 0 })

  // Normalize against the track's own loudest peak so quiet recordings (mic/system
  // audio rarely hit full scale) still fill the row. Recomputed only on peaks change,
  // not zoom/pan, so height stays stable while scrolling.
  const normFactor = useMemo(() => computeNormalizationFactor(peaks), [peaks])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect
      setCanvasSize({ w: width, h: height })
    })
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || canvasSize.w <= 0 || canvasSize.h <= 0) return

    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(canvasSize.w * dpr)
    canvas.height = Math.round(canvasSize.h * dpr)

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, canvasSize.w, canvasSize.h)

    if (!peaks || peaks.length === 0 || normFactor === 0) return

    const W = Math.floor(canvasSize.w)
    const H = canvasSize.h
    if (range.end - range.start <= 0 || sourceDurationMs <= 0 || W <= 0) return

    const topY = topInset
    const bottomY = H - bottomInset
    const drawHeight = bottomY - topY
    if (drawHeight <= 0) return

    const amp = drawHeight * 0.9
    const display = computeWaveformColumns({
      peaks,
      sourceDurationMs,
      rangeStartMs: range.start,
      rangeEndMs: range.end,
      width: W,
      segments,
      normFactor,
    })

    const colY = new Float32Array(W)
    for (let x = 0; x < W; x++) {
      colY[x] = bottomY - display[x] * amp
    }

    // Filled polygon: bottom-left, up over the silhouette, down to bottom-right.
    ctx.beginPath()
    ctx.moveTo(0, bottomY)
    for (let x = 0; x < W; x++) {
      ctx.lineTo(x, colY[x])
    }
    ctx.lineTo(W, bottomY)
    ctx.closePath()
    ctx.fillStyle = 'rgba(74, 222, 128, 0.55)'
    ctx.fill()

    // Crisp top-edge stroke.
    ctx.beginPath()
    ctx.moveTo(0, colY[0])
    for (let x = 1; x < W; x++) {
      ctx.lineTo(x, colY[x])
    }
    ctx.strokeStyle = 'rgba(74, 222, 128, 0.85)'
    ctx.lineWidth = 1
    ctx.stroke()
  }, [peaks, normFactor, range, canvasSize, sourceDurationMs, segments, topInset, bottomInset])

  return <canvas ref={canvasRef} className="absolute inset-0 pointer-events-none w-full h-full" />
}
