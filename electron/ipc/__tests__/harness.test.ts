// Smoke test proving that vitest collects tests under `electron/**` (the
// include pattern in vitest.config.ts) and runs them in the default `node`
// environment with Node built-ins available.
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('electron test harness', () => {
  it('runs in the node environment', () => {
    expect(typeof process.versions.node).toBe('string')
    expect(typeof globalThis.document).toBe('undefined')
  })

  it('has node built-ins available', () => {
    expect(path.posix.join('recordings', '..', 'recording-1.webm')).toBe('recording-1.webm')
    expect(path.posix.join('/a/', '/b/', 'c.webm')).toBe('/a/b/c.webm')
    expect(path.posix.normalize('/a/b/../../c')).toBe('/c')
  })
})
