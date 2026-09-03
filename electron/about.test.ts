import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  type AboutFacts,
  COPYRIGHT,
  formatAboutDetail,
  usesNativeAboutPanel,
  WEBSITE_URL,
} from './about'

function facts(overrides: Partial<AboutFacts> = {}): AboutFacts {
  return {
    version: '1.5.4',
    channel: 'dmg',
    platform: 'darwin',
    arch: 'arm64',
    electron: '39.2.0',
    chrome: '142.0.7444.52',
    node: '22.20.0',
    ...overrides,
  }
}

describe('formatAboutDetail', () => {
  it('lays the runtime, the install and the project out one per line', () => {
    expect(formatAboutDetail(facts())).toBe(
      [
        'Electron 39.2.0 · Chromium 142.0.7444.52 · Node 22.20.0',
        'darwin arm64 · dmg',
        WEBSITE_URL,
      ].join('\n'),
    )
  })

  it('leaves the copyright line to the caller', () => {
    expect(formatAboutDetail(facts())).not.toContain(COPYRIGHT)
  })

  it('names the install channel, not just the platform', () => {
    expect(
      formatAboutDetail(facts({ platform: 'win32', arch: 'x64', channel: 'store' })),
    ).toContain('win32 x64 · store')
    expect(
      formatAboutDetail(facts({ platform: 'linux', arch: 'x64', channel: 'appimage' })),
    ).toContain('linux x64 · appimage')
  })
})

describe('COPYRIGHT', () => {
  it('matches the copyright electron-builder stamps into the bundle', () => {
    const config = readFileSync(new URL('../electron-builder.json5', import.meta.url), 'utf8')
    const declared = config.match(/["']?copyright["']?\s*:\s*["']([^"']*)["']/)?.[1]
    expect(declared).toBe(COPYRIGHT)
  })
})

describe('usesNativeAboutPanel', () => {
  it('sends macOS to its own panel', () => {
    expect(usesNativeAboutPanel('darwin')).toBe(true)
  })

  it('leaves every other platform on the message box we build', () => {
    expect(usesNativeAboutPanel('win32')).toBe(false)
    expect(usesNativeAboutPanel('linux')).toBe(false)
  })
})
