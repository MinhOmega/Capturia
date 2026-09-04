#!/usr/bin/env node
/**
 * Samples the resident memory of the browser processes a benchmark is driving
 * and prints the peak. `performance.memory` inside the page only sees the JS
 * heap, while a `VideoFrame` waiting in the encoder queue lives in native
 * memory — so the number that answers "does a deeper encoder queue cost
 * memory?" has to be read from outside the page.
 *
 *   # the crashpad pid pins it to one browser, so another agent's Chrome does
 *   # not land in the same total
 *   node scripts/sample-renderer-rss.mjs --match "crashpad-handler-pid=777146" --trace
 *
 * Runs until interrupted (SIGINT/SIGTERM), then prints peak and mean total RSS
 * in MB. `--trace` also prints one line per sample so a run with several phases
 * can be split by time afterwards.
 */
import { execFileSync } from 'node:child_process'

const args = process.argv.slice(2)
const flagValue = (flag, fallback) => {
  const index = args.indexOf(flag)
  return index === -1 ? fallback : args[index + 1]
}

const match = flagValue('--match', 'type=renderer')
const extraMatch = flagValue('--and', '')
const intervalMs = Number(flagValue('--interval', '250'))
const trace = args.includes('--trace')

let peakKb = 0
let sumKb = 0
let samples = 0
const startedAt = Date.now()

function totalRssKb() {
  let out = ''
  try {
    out = execFileSync('ps', ['-eo', 'rss=,args='], {
      encoding: 'utf-8',
      maxBuffer: 32 * 1024 * 1024,
    })
  } catch {
    return 0
  }
  let totalKb = 0
  for (const line of out.split('\n')) {
    if (!line.includes(match)) continue
    if (extraMatch && !line.includes(extraMatch)) continue
    const rss = Number(line.trim().split(/\s+/)[0])
    if (Number.isFinite(rss)) totalKb += rss
  }
  return totalKb
}

const timer = setInterval(
  () => {
    const totalKb = totalRssKb()
    if (totalKb === 0) return
    samples += 1
    sumKb += totalKb
    if (totalKb > peakKb) peakKb = totalKb
    if (trace) {
      console.log(`t=${Date.now() - startedAt} rssMB=${(totalKb / 1024).toFixed(1)}`)
    }
  },
  Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 250,
)

function finish() {
  clearInterval(timer)
  const mb = (kb) => (kb / 1024).toFixed(1)
  console.log(
    `samples=${samples} peakRssMB=${mb(peakKb)} meanRssMB=${samples ? mb(sumKb / samples) : '0'} match=${match}${extraMatch ? ` and=${extraMatch}` : ''}`,
  )
  process.exit(0)
}

process.on('SIGINT', finish)
process.on('SIGTERM', finish)
