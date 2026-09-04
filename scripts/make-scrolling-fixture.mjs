#!/usr/bin/env node
/**
 * Regenerates `src/__fixtures__/scrolling-table.webm`, the recording the blur
 * tracker's browser test and the harness check are driven against.
 *
 * The bundled `sample.webm` is two seconds of 320x240 with nothing that
 * scrolls, so it cannot show whether a blur follows its content. This one is
 * six seconds of a table that scrolls down, holds, jumps, and scrolls back, at
 * a scroll rate the test knows exactly - which is what lets the test assert
 * recovered position against ground truth rather than against itself.
 *
 *   node scripts/make-scrolling-fixture.mjs
 *   node scripts/make-scrolling-fixture.mjs --out /tmp/other.webm
 *
 * It drives Playwright's Chromium (already a dev dependency for the browser
 * lane) and records a canvas with `MediaRecorder`, so the result is a real VP9
 * WebM produced the same way a Capturia recording is, not a synthetic
 * container. Checked in so the fixture is reproducible rather than a binary
 * nobody can explain.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_OUT = path.resolve(HERE, '../src/__fixtures__/scrolling-table.webm')
const SIZE_BUDGET_BYTES = 300 * 1024

/**
 * The scroll programme, read out of the TypeScript module the browser test
 * also reads, so the fixture and the ground truth it is checked against can
 * never drift apart.
 */
function readFixtureSpec() {
  const source = fs.readFileSync(
    path.resolve(HERE, '../src/__fixtures__/scrollingTable.ts'),
    'utf8',
  )
  const pick = (name) => {
    const match = new RegExp(`${name}:\\s*([-0-9.]+)`).exec(source)
    if (!match) throw new Error(`scrollingTable.ts has no ${name}`)
    return Number(match[1])
  }
  const timecode = {
    x: Number(/x: (\d+),\n {2}y:/.exec(source)?.[1] ?? 384),
    y: Number(/y: (\d+),\n {2}cellWidth/.exec(source)?.[1] ?? 4),
    cellWidth: Number(/cellWidth: (\d+)/.exec(source)?.[1] ?? 10),
    cellHeight: Number(/cellHeight: (\d+)/.exec(source)?.[1] ?? 8),
    bits: Number(/bits: (\d+)/.exec(source)?.[1] ?? 8),
    stepMs: Number(/stepMs: (\d+)/.exec(source)?.[1] ?? 25),
  }
  const keyframes = [...source.matchAll(/\{ timeMs: (\d+), scrollY: (\d+) \}/g)].map((match) => ({
    timeMs: Number(match[1]),
    scrollY: Number(match[2]),
  }))
  if (keyframes.length < 2) throw new Error('scrollingTable.ts has no scroll keyframes')
  return {
    width: pick('width'),
    height: pick('height'),
    frameRate: pick('frameRate'),
    durationMs: pick('durationMs'),
    rowHeight: Number(/FIXTURE_ROW_HEIGHT = ([-0-9.]+)/.exec(source)?.[1] ?? 18),
    keyframes,
    timecode,
  }
}

const FIXTURE = readFixtureSpec()

/** Scroll offset at a given time, in source px. Mirrors `scrollYAt` in the TS module. */
function scrollYAt(timeMs) {
  const points = FIXTURE.keyframes
  if (timeMs <= points[0].timeMs) return points[0].scrollY
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]
    const b = points[i + 1]
    if (timeMs <= b.timeMs) {
      const u = (timeMs - a.timeMs) / (b.timeMs - a.timeMs)
      return a.scrollY + (b.scrollY - a.scrollY) * u
    }
  }
  return points[points.length - 1].scrollY
}

const PAGE = `<!doctype html>
<meta charset="utf-8">
<style>html,body{margin:0;background:#111}</style>
<canvas id="c"></canvas>
<script>
const FIXTURE = ${JSON.stringify(FIXTURE)}
const scrollYAt = ${scrollYAt.toString()}

// A deterministic PRNG so two regenerations produce the same table.
function rng(seed) {
  let s = seed >>> 0
  return () => {
    s ^= s << 13; s >>>= 0
    s ^= s >>> 17
    s ^= s << 5; s >>>= 0
    return s / 0x100000000
  }
}

const canvas = document.getElementById('c')
canvas.width = FIXTURE.width
canvas.height = FIXTURE.height
const ctx = canvas.getContext('2d')

const random = rng(20260904)
const ROWS = 40
const rows = []
for (let i = 0; i < ROWS; i++) {
  rows.push({
    label: Array.from({ length: 3 + Math.floor(random() * 4) }, () =>
      String.fromCharCode(97 + Math.floor(random() * 26))).join(''),
    value: Math.floor(random() * 900000).toString(),
    tint: 240 + Math.floor(random() * 12),
  })
}

const PANE = { x: 96, y: 34, w: FIXTURE.width - 108, h: FIXTURE.height - 44 }

function draw(timeMs) {
  const scrollY = scrollYAt(timeMs)

  ctx.fillStyle = '#1c2230'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  // Static chrome: a toolbar and a sidebar that do not scroll with the pane.
  ctx.fillStyle = '#2b3446'
  ctx.fillRect(0, 0, canvas.width, 26)
  ctx.fillStyle = '#8fa0bd'
  ctx.font = '11px monospace'
  ctx.fillText('accounts . ledger . exports', 10, 17)
  ctx.fillStyle = '#222b3b'
  ctx.fillRect(0, 26, 88, canvas.height - 26)
  ctx.fillStyle = '#6d7d99'
  for (let i = 0; i < 8; i++) ctx.fillText('item ' + i, 10, 46 + i * 22)

  ctx.save()
  ctx.beginPath()
  ctx.rect(PANE.x, PANE.y, PANE.w, PANE.h)
  ctx.clip()
  ctx.fillStyle = '#f4f6fa'
  ctx.fillRect(PANE.x, PANE.y, PANE.w, PANE.h)

  ctx.font = '11px monospace'
  for (let i = 0; i < ROWS; i++) {
    const top = PANE.y + i * FIXTURE.rowHeight - scrollY
    if (top + FIXTURE.rowHeight < PANE.y || top > PANE.y + PANE.h) continue
    const row = rows[i]
    ctx.fillStyle = 'rgb(' + row.tint + ',' + row.tint + ',' + (row.tint - 4) + ')'
    ctx.fillRect(PANE.x, top, PANE.w, FIXTURE.rowHeight)
    ctx.fillStyle = '#2c3444'
    ctx.fillText(row.label + '@ledger.test', PANE.x + 8, top + 13)
    ctx.fillStyle = '#5a6478'
    ctx.fillText(row.value, PANE.x + 200, top + 13)
  }
  ctx.restore()

  ctx.strokeStyle = '#3d4a60'
  ctx.strokeRect(PANE.x - 0.5, PANE.y - 0.5, PANE.w + 1, PANE.h + 1)

  // The timecode: which instant of the programme this frame shows, so a test
  // never has to assume the recorder stamped it where it was drawn.
  const tc = FIXTURE.timecode
  const code = Math.min(255, Math.max(0, Math.round(timeMs / tc.stepMs)))
  for (let bit = 0; bit < tc.bits; bit++) {
    ctx.fillStyle = code & (1 << bit) ? '#ffffff' : '#000000'
    ctx.fillRect(tc.x + bit * tc.cellWidth, tc.y, tc.cellWidth, tc.cellHeight)
  }
}

window.record = async () => {
  const stream = canvas.captureStream(0)
  const track = stream.getVideoTracks()[0]
  const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
    .find((type) => MediaRecorder.isTypeSupported(type))
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 320000 })
  const chunks = []
  recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data) }
  const stopped = new Promise((resolve) => { recorder.onstop = resolve })
  recorder.start()

  // Drawn against the **wall clock**, not against a frame counter.
  // MediaRecorder stamps each frame with the time it arrived, and setTimeout
  // does not deliver on a 33 ms cadence, so a frame counter would put content
  // for programme time t at video time 1.2t and every ground-truth assertion
  // downstream would be measuring the drift instead of the tracker.
  const startedAt = performance.now()
  let lastDrawn = -1
  while (true) {
    const elapsed = performance.now() - startedAt
    if (elapsed >= FIXTURE.durationMs) break
    const frame = Math.floor((elapsed / 1000) * FIXTURE.frameRate)
    if (frame !== lastDrawn) {
      lastDrawn = frame
      draw(elapsed)
      track.requestFrame()
    }
    await new Promise((resolve) => requestAnimationFrame(resolve))
  }
  recorder.stop()
  await stopped
  const blob = new Blob(chunks, { type: mimeType })
  const buffer = new Uint8Array(await blob.arrayBuffer())
  return { mimeType, bytes: Array.from(buffer) }
}
</script>`

async function main() {
  const outIndex = process.argv.indexOf('--out')
  const out = outIndex >= 0 ? path.resolve(process.argv[outIndex + 1]) : DEFAULT_OUT

  const browser = await chromium.launch({
    args: ['--autoplay-policy=no-user-gesture-required', '--enable-unsafe-swiftshader'],
  })
  try {
    const page = await browser.newPage()
    await page.setContent(PAGE)
    const result = await page.evaluate(() => window.record())
    const bytes = Buffer.from(result.bytes)
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, bytes)
    console.log(`wrote ${out}`)
    console.log(`  ${result.mimeType}, ${bytes.length} bytes`)
    if (bytes.length > SIZE_BUDGET_BYTES) {
      console.warn(
        `  over the ${SIZE_BUDGET_BYTES} byte budget for a checked-in fixture; ` +
          'lower videoBitsPerSecond or shorten the clip',
      )
      process.exitCode = 1
    }
  } finally {
    await browser.close()
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  await main()
}
