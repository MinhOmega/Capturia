import { describe, expect, it } from 'vitest'
import { mergeUpdateFeeds, parseUpdateFeed } from '../../scripts/merge-update-feeds.mjs'

const X64 = `version: 1.7.0
files:
  - url: Capturia-Mac-x64-1.7.0-Installer.zip
    sha512: aaa
    size: 100
    blockMapSize: 10
  - url: Capturia-Mac-x64-1.7.0-Installer.dmg
    sha512: bbb
    size: 200
path: Capturia-Mac-x64-1.7.0-Installer.zip
sha512: aaa
releaseDate: '2026-09-03T00:00:00.000Z'
`

const ARM64 = `version: 1.7.0
files:
  - url: Capturia-Mac-arm64-1.7.0-Installer.zip
    sha512: ccc
    size: 300
    blockMapSize: 30
  - url: Capturia-Mac-arm64-1.7.0-Installer.dmg
    sha512: ddd
    size: 400
path: Capturia-Mac-arm64-1.7.0-Installer.zip
sha512: ccc
releaseDate: '2026-09-03T00:10:00.000Z'
`

describe('parseUpdateFeed', () => {
  it('splits the feed into head, file entries and tail', () => {
    const parsed = parseUpdateFeed(X64)
    expect(parsed.version).toBe('1.7.0')
    expect(parsed.head).toEqual(['version: 1.7.0', 'files:'])
    expect(parsed.entries).toHaveLength(7)
    expect(parsed.tail).toEqual([
      'path: Capturia-Mac-x64-1.7.0-Installer.zip',
      'sha512: aaa',
      "releaseDate: '2026-09-03T00:00:00.000Z'",
    ])
  })

  it('rejects text without a files sequence', () => {
    expect(() => parseUpdateFeed('version: 1.0.0\npath: x\n')).toThrow(/files/)
  })
})

describe('mergeUpdateFeeds', () => {
  it('keeps the first feed and splices in the other architecture entries', () => {
    const merged = mergeUpdateFeeds([X64, ARM64])
    expect(merged).toBe(`version: 1.7.0
files:
  - url: Capturia-Mac-x64-1.7.0-Installer.zip
    sha512: aaa
    size: 100
    blockMapSize: 10
  - url: Capturia-Mac-x64-1.7.0-Installer.dmg
    sha512: bbb
    size: 200
  - url: Capturia-Mac-arm64-1.7.0-Installer.zip
    sha512: ccc
    size: 300
    blockMapSize: 30
  - url: Capturia-Mac-arm64-1.7.0-Installer.dmg
    sha512: ddd
    size: 400
path: Capturia-Mac-x64-1.7.0-Installer.zip
sha512: aaa
releaseDate: '2026-09-03T00:00:00.000Z'
`)
  })

  it('is a no-op for a single feed and drops duplicate entries', () => {
    expect(mergeUpdateFeeds([X64])).toBe(X64)
    expect(mergeUpdateFeeds([X64, X64])).toBe(X64)
  })

  it('tolerates CRLF input', () => {
    expect(mergeUpdateFeeds([X64.replace(/\n/g, '\r\n'), ARM64])).toContain('arm64-1.7.0')
  })

  it('refuses to merge feeds for different versions', () => {
    expect(() => mergeUpdateFeeds([X64, ARM64.replace('1.7.0\n', '1.7.1\n')])).toThrow(
      /disagree on the version/,
    )
  })
})
