import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * `window.electronAPI` was declared twice — `src/vite-env.d.ts` and
 * `electron/electron-env.d.ts` — and the two copies drifted for months while
 * TypeScript merged them and `skipLibCheck` hid the conflict. There is one
 * declaration now (`electron/bridge-types.ts`), and `electron/preload.ts`
 * annotates the exposed object with it, so `tsc` already refuses a member that
 * only one side knows about. These tests fail for the same reasons without a
 * typecheck, and they catch the thing the compiler cannot see: a second
 * declaration reappearing somewhere in the tree.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PRELOAD = path.join(ROOT, 'electron', 'preload.ts')
const BRIDGE_TYPES = path.join(ROOT, 'electron', 'bridge-types.ts')

/** Top-level keys of the object handed to `contextBridge.exposeInMainWorld`. */
function readPreloadBridgeKeys(): string[] {
  const source = fs.readFileSync(PRELOAD, 'utf8')
  const start = source.indexOf('const electronAPI: ElectronAPI = {')
  expect(start, 'preload no longer annotates the exposed object').toBeGreaterThanOrEqual(0)
  const body = source.slice(start).split('\n}')[0]
  const keys = new Set<string>()
  for (const line of body.split('\n')) {
    const match = /^ {2}([A-Za-z_][A-Za-z0-9_]*)\s*[:,(]/.exec(line)
    if (match?.[1]) keys.add(match[1])
  }
  return [...keys].sort()
}

/** Member names of `export interface ElectronAPI`, at one level of indent. */
function readDeclaredBridgeKeys(): string[] {
  const source = fs.readFileSync(BRIDGE_TYPES, 'utf8')
  const start = source.indexOf('export interface ElectronAPI {')
  expect(start, 'ElectronAPI is no longer declared here').toBeGreaterThanOrEqual(0)
  const body = source.slice(start).split('\n}')[0]
  const keys = new Set<string>()
  for (const line of body.split('\n')) {
    const match = /^ {2}([A-Za-z_][A-Za-z0-9_]*)\??\s*:/.exec(line)
    if (match?.[1]) keys.add(match[1])
  }
  return [...keys].sort()
}

/** Every `.ts`/`.d.ts` under a directory, skipping nothing else in the tree. */
function collectSources(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...collectSources(full))
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full)
  }
  return out
}

describe('preload bridge declaration', () => {
  it('declares exactly what the preload exposes, and nothing more', () => {
    const exposed = readPreloadBridgeKeys()
    // A silently-empty match would make the comparison vacuous.
    expect(exposed.length).toBeGreaterThan(50)
    expect(exposed).toContain('getAssetBasePath')

    const declared = readDeclaredBridgeKeys()
    const missing = exposed.filter((key) => !declared.includes(key))
    const extra = declared.filter((key) => !exposed.includes(key))

    expect(
      missing,
      'electron/preload.ts exposes these but electron/bridge-types.ts does not declare them',
    ).toEqual([])
    expect(
      extra,
      'electron/bridge-types.ts declares these but electron/preload.ts does not expose them',
    ).toEqual([])
  })

  it('is the only place the renderer window gets an electronAPI', () => {
    const declaring = [
      ...collectSources(path.join(ROOT, 'src')),
      ...collectSources(path.join(ROOT, 'electron')),
    ]
      // Tests quote the declaration they are about; only shipped code counts.
      .filter((file) => !file.endsWith('.test.ts') && !file.endsWith('.test.tsx'))
      .filter((file) => {
        const source = fs.readFileSync(file, 'utf8')
        // A Window block that names electronAPI, wherever it is written: a
        // global `.d.ts` script or a `declare global` block inside a module.
        return /interface Window \{[^}]*\belectronAPI\b/s.test(source)
      })

    expect(
      declaring.map((file) => path.relative(ROOT, file)),
      'Window.electronAPI must be declared once; a second copy drifts silently under skipLibCheck',
    ).toEqual(['src/vite-env.d.ts'])
  })
})
