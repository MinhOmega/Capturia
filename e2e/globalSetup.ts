import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Keeps `dist/` and `dist-electron/` in step with the working tree before any
 * Electron spec launches them.
 *
 * The specs boot the *built* app, so a stale build makes the whole lane lie:
 * every spec passes or fails against yesterday's renderer while the change
 * under test sits unbuilt in `src/`. The old guard only checked that
 * `dist-electron/main.js` existed, which a day-old build satisfies.
 *
 * So: compare the newest input under `src/` + `electron/` (plus the build's own
 * config files) against the oldest artifact the specs launch, and run
 * `npm run build:vite` when the artifacts are behind. Up to date, this costs a
 * directory walk (milliseconds); behind, it costs one build (~2 min on a loaded
 * developer box) — which is the price of the lane meaning anything at all.
 *
 * Escape hatches:
 *  - `CAPTURIA_E2E_SKIP_BUILD=1` never builds. Stale artifacts then *fail*
 *    loudly here rather than being launched. CI uses it because its own
 *    workflow step already ran the build.
 *  - No display server means every spec skips anyway, so neither the build nor
 *    the staleness check is worth running.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')

/** Directories `vite build` reads. Test files are excluded: they are never bundled. */
const SOURCE_DIRS = ['src', 'electron']

/** Single files that change what the build emits. */
const SOURCE_FILES = [
  'index.html',
  'vite.config.ts',
  'tsconfig.json',
  'tsconfig.node.json',
  'package.json',
  'package-lock.json',
]

/** What the specs launch. All three must be newer than every input. */
const ARTIFACTS = [
  path.join('dist', 'index.html'),
  path.join('dist-electron', 'main.js'),
  path.join('dist-electron', 'preload.mjs'),
]

const SKIPPED_DIRS = new Set(['node_modules', '__snapshots__'])
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/

interface Newest {
  mtimeMs: number
  file: string
}

function newestInput(): Newest {
  let newest: Newest = { mtimeMs: 0, file: '' }

  const consider = (absolute: string, mtimeMs: number) => {
    if (mtimeMs > newest.mtimeMs) {
      newest = { mtimeMs, file: path.relative(ROOT, absolute) }
    }
  }

  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || SKIPPED_DIRS.has(entry.name)) continue
      const absolute = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(absolute)
      } else if (entry.isFile() && !TEST_FILE.test(entry.name)) {
        consider(absolute, fs.statSync(absolute).mtimeMs)
      }
    }
  }

  for (const dir of SOURCE_DIRS) {
    const absolute = path.join(ROOT, dir)
    if (fs.existsSync(absolute)) walk(absolute)
  }
  for (const file of SOURCE_FILES) {
    const absolute = path.join(ROOT, file)
    if (fs.existsSync(absolute)) consider(absolute, fs.statSync(absolute).mtimeMs)
  }

  return newest
}

/** The oldest artifact, or `null` when one is missing (nothing to compare). */
function oldestArtifact(): Newest | null {
  let oldest: Newest | null = null
  for (const artifact of ARTIFACTS) {
    const absolute = path.join(ROOT, artifact)
    if (!fs.existsSync(absolute)) return null
    const mtimeMs = fs.statSync(absolute).mtimeMs
    if (oldest === null || mtimeMs < oldest.mtimeMs) oldest = { mtimeMs, file: artifact }
  }
  return oldest
}

export default function globalSetup(): void {
  if (process.platform === 'linux' && !process.env['DISPLAY'] && !process.env['WAYLAND_DISPLAY']) {
    console.log('[e2e] no display server; skipping the build check (every spec will skip)')
    return
  }

  const artifact = oldestArtifact()
  const input = newestInput()
  const stale = artifact === null || artifact.mtimeMs < input.mtimeMs

  if (!stale) return

  const why =
    artifact === null
      ? `${ARTIFACTS.join(', ')}: not all present`
      : `${artifact.file} is older than ${input.file}`

  if (process.env['CAPTURIA_E2E_SKIP_BUILD'] === '1') {
    throw new Error(
      `[e2e] build artifacts are stale (${why}), and CAPTURIA_E2E_SKIP_BUILD=1 forbids rebuilding. ` +
        'Run "npm run build:vite" — the specs launch the built app, so a stale build tests the wrong code.',
    )
  }

  console.log(`[e2e] rebuilding: ${why}`)
  const startedAt = Date.now()
  const result = spawnSync('npm', ['run', 'build:vite'], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (result.status !== 0) {
    throw new Error(`[e2e] "npm run build:vite" failed with status ${result.status ?? 'null'}`)
  }
  console.log(`[e2e] build finished in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`)
}
