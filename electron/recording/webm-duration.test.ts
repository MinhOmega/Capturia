import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { WebmContainer, WebmFile, WebmString, WebmUint } from '@fix-webm-duration/parser'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { patchWebmDurationOnDisk } from './webm-duration'

type WebmContainerItem = NonNullable<WebmContainer['data']>[number]

interface WebmElementMock {
  getSectionById: (id: number) => WebmElementMock
  getValue: () => number
}

function readPatchedDuration(bytes: Uint8Array): WebmElementMock {
  const webm = new WebmFile(bytes)
  const segment = webm.getSectionById(0x8538067) as unknown as WebmElementMock
  const info = segment.getSectionById(0x549a966)
  return info.getSectionById(0x489)
}

describe('webm-duration patching', () => {
  let dir: string
  const pathFor = (name: string) => path.join(dir, name)

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'capturia-duration-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  function createDummyWebm(includeCluster = true, clusterSize = 100): Uint8Array {
    const ebml = new WebmContainer('EBML')
    ebml.data = []
    const docType = new WebmString('DocType')
    docType.setValue('webm')
    ebml.data.push({ id: 0x282, idHex: '282', data: docType })
    ebml.updateByData()

    const segment = new WebmContainer('Segment')
    segment.data = []
    segment.isInfinite = true

    const info = new WebmContainer('Info')
    info.data = []
    const timecodeScale = new WebmUint('TimecodeScale')
    timecodeScale.setValue(1000000)
    info.data.push({ id: 0xad7b1, idHex: 'ad7b1', data: timecodeScale })
    info.updateByData()
    segment.data.push({ id: 0x549a966, idHex: '549a966', data: info })

    if (includeCluster) {
      // Any WebmBase subclass works as an opaque byte holder; the container only
      // reads `.source` when serialising (WebmBase's own constructor is protected).
      const cluster = new WebmString('Cluster')
      // Cluster element: id 0x1f43b675 (stripped as 0xf43b675) + unknown-size VINT.
      const header = Buffer.from([0x1f, 0x43, 0xb6, 0x75, 0x01, 0x00])
      const body = Buffer.alloc(clusterSize, 0x42)
      cluster.setSource(new Uint8Array(Buffer.concat([header, body])))
      // Cluster is not in the parser's known-section id union.
      segment.data.push({
        id: 0xf43b675,
        idHex: 'f43b675',
        data: cluster,
      } as unknown as WebmContainerItem)
    }

    segment.updateByData()

    const file = new WebmContainer('File')
    file.data = []
    file.data.push({ id: 0xa45dfa3, idHex: 'a45dfa3', data: ebml })
    file.data.push({ id: 0x8538067, idHex: '8538067', data: segment })
    file.updateByData()
    const source = file.source
    if (!source) throw new Error('dummy WebM was not serialised')
    return source
  }

  it('patches small WebM files under 2MB in memory', async () => {
    const filePath = pathFor('small.webm')
    await writeFile(filePath, createDummyWebm(true, 100))

    const result = await patchWebmDurationOnDisk(filePath, 5000)
    expect(result.patched).toBe(true)

    const duration = readPatchedDuration(new Uint8Array(await readFile(filePath)))
    expect(duration).toBeDefined()
    expect(duration.getValue()).toBe(5000)
    // No scratch file is left behind.
    expect(await readdir(dir)).toEqual(['small.webm'])
  })

  it('patches large WebM files over 2MB by rewriting only the header chunk', async () => {
    const filePath = pathFor('large.webm')
    await writeFile(filePath, createDummyWebm(true, 2.5 * 1024 * 1024))

    const result = await patchWebmDurationOnDisk(filePath, 12000)
    expect(result.patched).toBe(true)

    const patchedBytes = await readFile(filePath)
    const duration = readPatchedDuration(new Uint8Array(patchedBytes))
    expect(duration).toBeDefined()
    expect(duration.getValue()).toBe(12000)

    // The Cluster payload (0x42 fill) is intact at the end.
    const lastBytes = patchedBytes.subarray(patchedBytes.length - 100)
    expect(lastBytes.every((b) => b === 0x42)).toBe(true)
    expect(await readdir(dir)).toEqual(['large.webm'])
  })

  it('falls back to in-memory patching when the large file header chunk has no Cluster', async () => {
    const padding = Buffer.alloc(2.5 * 1024 * 1024, 0)
    const filePath = pathFor('large_no_cluster.webm')
    await writeFile(filePath, Buffer.concat([Buffer.from(createDummyWebm(false)), padding]))

    const result = await patchWebmDurationOnDisk(filePath, 8000)
    expect(result.patched).toBe(true)

    const duration = readPatchedDuration(new Uint8Array(await readFile(filePath)))
    expect(duration).toBeDefined()
    expect(duration.getValue()).toBe(8000)
  })

  it('reports io-error for a missing file without creating a scratch file', async () => {
    const result = await patchWebmDurationOnDisk(pathFor('missing.webm'), 1000)
    expect(result).toEqual({ patched: false, reason: 'io-error' })
    expect(await readdir(dir)).toEqual([])
  })
})
