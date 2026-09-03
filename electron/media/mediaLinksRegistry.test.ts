import { copyFile, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  computeMediaFingerprint,
  FINGERPRINT_SAMPLE_BYTES,
  findMediaLinksByFingerprint,
  fingerprintsMatch,
  type MediaLinkEntry,
  mediaLinksRegistryPath,
  normalizeMediaLinkEntry,
  pruneMediaLinkEntries,
  readMediaLinksRegistry,
  upsertMediaLink,
  whenMediaLinksIdle,
} from './mediaLinksRegistry'

const SHA = 'a'.repeat(64)

function fingerprint(sizeBytes = 10, head = SHA, tail = SHA) {
  return { sizeBytes, headSha256: head, tailSha256: tail }
}

describe('computeMediaFingerprint', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'capturia-fingerprint-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('is stable across a copy and a rename', async () => {
    const original = path.join(dir, 'recording.webm')
    await writeFile(original, Buffer.from('head-bytes-then-some-body-then-tail-bytes'))
    const copied = path.join(dir, 'moved.webm')
    await copyFile(original, copied)

    const a = await computeMediaFingerprint(original)
    const b = await computeMediaFingerprint(copied)
    expect(fingerprintsMatch(a, b)).toBe(true)
    expect(a.sizeBytes).toBe(41)
    expect(a.headSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(a.tailSha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('changes when the head, the tail or the size changes', async () => {
    const file = path.join(dir, 'a.webm')
    await writeFile(file, Buffer.from('0123456789'))
    const base = await computeMediaFingerprint(file)

    await writeFile(file, Buffer.from('X123456789'))
    expect(fingerprintsMatch(base, await computeMediaFingerprint(file))).toBe(false)

    await writeFile(file, Buffer.from('012345678X'))
    expect(fingerprintsMatch(base, await computeMediaFingerprint(file))).toBe(false)

    await writeFile(file, Buffer.from('01234567890'))
    expect(fingerprintsMatch(base, await computeMediaFingerprint(file))).toBe(false)
  })

  it('samples only the head and tail of a large file', async () => {
    const file = path.join(dir, 'big.webm')
    const size = FINGERPRINT_SAMPLE_BYTES * 4
    await writeFile(file, Buffer.alloc(size, 7))
    const before = await computeMediaFingerprint(file)

    // Flip a byte in the body: outside both samples, so the fingerprint holds.
    const handle = await open(file, 'r+')
    try {
      await handle.write(Buffer.from([1]), 0, 1, FINGERPRINT_SAMPLE_BYTES * 2)
    } finally {
      await handle.close()
    }
    expect(fingerprintsMatch(before, await computeMediaFingerprint(file))).toBe(true)

    // Flip the last byte: inside the tail sample.
    const tail = await open(file, 'r+')
    try {
      await tail.write(Buffer.from([1]), 0, 1, size - 1)
    } finally {
      await tail.close()
    }
    expect(fingerprintsMatch(before, await computeMediaFingerprint(file))).toBe(false)
  })

  it('rejects directories', async () => {
    await expect(computeMediaFingerprint(dir)).rejects.toThrow()
  })
})

describe('media-links registry file', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'capturia-media-links-'))
  })

  afterEach(async () => {
    await whenMediaLinksIdle(dir)
    await rm(dir, { recursive: true, force: true })
  })

  it('reads an empty registry when the file is missing or corrupt', async () => {
    await expect(readMediaLinksRegistry(dir)).resolves.toEqual({ version: 1, entries: [] })
    await writeFile(mediaLinksRegistryPath(dir), '{not json')
    await expect(readMediaLinksRegistry(dir)).resolves.toEqual({ version: 1, entries: [] })
  })

  it('round-trips an entry and finds it by fingerprint', async () => {
    const fp = fingerprint(123)
    await upsertMediaLink(dir, {
      fingerprint: fp,
      lastKnownPath: '/videos/a.webm',
      projectStateFile: 'a.webm_deadbeef.json',
      cursorSidecarPath: '/videos/a.cursor.json',
    })

    const [found] = await findMediaLinksByFingerprint(dir, fp)
    expect(found).toMatchObject({
      lastKnownPath: '/videos/a.webm',
      projectStateFile: 'a.webm_deadbeef.json',
      cursorSidecarPath: '/videos/a.cursor.json',
    })
    expect(found?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    await expect(findMediaLinksByFingerprint(dir, fingerprint(124))).resolves.toEqual([])

    const onDisk = JSON.parse(await readFile(mediaLinksRegistryPath(dir), 'utf-8'))
    expect(onDisk.version).toBe(1)
    expect(onDisk.entries).toHaveLength(1)
  })

  it('refreshes the entry for the same path and keeps fields the update omits', async () => {
    const fp = fingerprint(5)
    await upsertMediaLink(dir, {
      fingerprint: fp,
      lastKnownPath: '/old/a.webm',
      projectStateFile: 'old.json',
      cursorSidecarPath: '/old/a.cursor.json',
    })
    await upsertMediaLink(dir, {
      fingerprint: fp,
      lastKnownPath: '/old/./a.webm',
      projectStateFile: 'refreshed.json',
    })

    const registry = await readMediaLinksRegistry(dir)
    expect(registry.entries).toHaveLength(1)
    expect(registry.entries[0]).toMatchObject({
      lastKnownPath: '/old/./a.webm',
      projectStateFile: 'refreshed.json',
      cursorSidecarPath: '/old/a.cursor.json',
    })
  })

  it('keeps one entry per path so two copies of the same bytes stay distinguishable', async () => {
    const fp = fingerprint(5)
    await upsertMediaLink(dir, {
      fingerprint: fp,
      lastKnownPath: '/old/a.webm',
      projectStateFile: 'old.json',
    })
    await upsertMediaLink(dir, {
      fingerprint: fp,
      lastKnownPath: '/new/b.webm',
      projectStateFile: 'new.json',
    })

    const found = await findMediaLinksByFingerprint(dir, fp)
    expect(found.map((entry) => entry.projectStateFile).sort()).toEqual(['new.json', 'old.json'])
  })

  it('removes the paths the caller reports as stale', async () => {
    const fp = fingerprint(5)
    await upsertMediaLink(dir, {
      fingerprint: fp,
      lastKnownPath: '/old/a.webm',
      projectStateFile: 'old.json',
    })
    await upsertMediaLink(dir, { fingerprint: fingerprint(6), lastKnownPath: '/other/c.webm' })
    await upsertMediaLink(
      dir,
      { fingerprint: fp, lastKnownPath: '/new/b.webm', projectStateFile: 'new.json' },
      { removePaths: ['/old/a.webm'] },
    )

    const registry = await readMediaLinksRegistry(dir)
    expect(registry.entries.map((entry) => entry.lastKnownPath).sort()).toEqual([
      '/new/b.webm',
      '/other/c.webm',
    ])
  })

  it('serialises concurrent writes instead of losing one', async () => {
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        upsertMediaLink(dir, { fingerprint: fingerprint(i), lastKnownPath: `/v/${i}.webm` }),
      ),
    )
    const registry = await readMediaLinksRegistry(dir)
    expect(registry.entries.map((entry) => entry.fingerprint.sizeBytes).sort()).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7,
    ])
  })
})

describe('normalizeMediaLinkEntry', () => {
  it('accepts a well-formed entry and drops unknown fields', () => {
    const entry = normalizeMediaLinkEntry({
      fingerprint: fingerprint(1),
      lastKnownPath: '/a.webm',
      projectStateFile: 'a.json',
      cursorSidecarPath: '/a.cursor.json',
      updatedAt: '2026-01-01T00:00:00.000Z',
      extra: true,
    })
    expect(entry).toEqual({
      fingerprint: fingerprint(1),
      lastKnownPath: '/a.webm',
      projectStateFile: 'a.json',
      cursorSidecarPath: '/a.cursor.json',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
  })

  it('rejects entries with a malformed fingerprint or path', () => {
    expect(normalizeMediaLinkEntry(null)).toBeNull()
    expect(normalizeMediaLinkEntry({ lastKnownPath: '/a.webm' })).toBeNull()
    expect(normalizeMediaLinkEntry({ lastKnownPath: '', fingerprint: fingerprint(1) })).toBeNull()
    expect(
      normalizeMediaLinkEntry({
        lastKnownPath: '/a.webm',
        fingerprint: { sizeBytes: 1, headSha256: 'nope', tailSha256: SHA },
      }),
    ).toBeNull()
    expect(
      normalizeMediaLinkEntry({ lastKnownPath: '/a.webm', fingerprint: fingerprint(-1) }),
    ).toBeNull()
  })
})

describe('pruneMediaLinkEntries', () => {
  it('keeps the newest entries when over the cap', () => {
    const entries: MediaLinkEntry[] = [0, 1, 2, 3].map((i) => ({
      fingerprint: fingerprint(i),
      lastKnownPath: `/v/${i}.webm`,
      updatedAt: `2026-01-0${i + 1}T00:00:00.000Z`,
    }))
    const kept = pruneMediaLinkEntries(entries, 2)
    expect(kept.map((entry) => entry.fingerprint.sizeBytes)).toEqual([3, 2])
    expect(pruneMediaLinkEntries(entries, 10)).toBe(entries)
  })
})
