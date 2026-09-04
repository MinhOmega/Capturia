#!/usr/bin/env node
/**
 * Builds the 1080p source the export benchmark measures against
 * (`src/lib/exporter/frameRendererPerf.browser.test.ts`).
 *
 * The file is ~10 MB, so it is generated on demand and git-ignored rather than
 * committed. Needs ffmpeg on PATH.
 *
 *   node scripts/make-export-perf-fixture.mjs [seconds]
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(repoRoot, 'src', '__fixtures__')
const outFile = path.join(outDir, 'perf-1080p.mp4')
const seconds = Number(process.argv[2] ?? 10)

if (!Number.isFinite(seconds) || seconds <= 0) {
  console.error(`Invalid duration: ${process.argv[2]}`)
  process.exit(1)
}

mkdirSync(outDir, { recursive: true })

execFileSync(
  'ffmpeg',
  [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=1920x1080:rate=30:duration=${seconds}`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:duration=${seconds}`,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-pix_fmt',
    'yuv420p',
    '-g',
    '60',
    '-b:v',
    '8M',
    '-c:a',
    'aac',
    '-shortest',
    outFile,
  ],
  { stdio: 'inherit' },
)

if (!existsSync(outFile)) {
  console.error('ffmpeg reported success but the fixture is missing')
  process.exit(1)
}
console.log(`Wrote ${outFile} (${seconds}s, 1920x1080 @ 30 fps)`)
