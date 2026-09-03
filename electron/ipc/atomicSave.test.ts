import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { atomicWriteFile, atomicWriteJson, waitForPendingAtomicWrites } from './atomicSave'

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'capturia-atomic-save-'))
})

afterEach(async () => {
  await waitForPendingAtomicWrites()
  await fs.rm(dir, { recursive: true, force: true })
})

async function listDir(): Promise<string[]> {
  return (await fs.readdir(dir)).sort()
}

describe('atomicWriteFile', () => {
  it('writes the file and leaves no temporary files behind', async () => {
    const target = path.join(dir, 'state.json')
    await atomicWriteFile(target, '{"a":1}')

    expect(await fs.readFile(target, 'utf-8')).toBe('{"a":1}')
    expect(await listDir()).toEqual(['state.json'])
  })

  it('creates the target directory when it does not exist yet', async () => {
    const target = path.join(dir, 'projects', 'nested', 'state.json')
    await atomicWriteFile(target, 'hello')

    expect(await fs.readFile(target, 'utf-8')).toBe('hello')
  })

  it('serialises concurrent saves of the same path so the last call wins', async () => {
    const target = path.join(dir, 'state.json')
    const writes = ['first', 'second', 'third', 'fourth', 'fifth'].map((body) =>
      atomicWriteFile(target, body),
    )

    await Promise.all(writes)

    expect(await fs.readFile(target, 'utf-8')).toBe('fifth')
    expect(await listDir()).toEqual(['state.json'])
  })

  it('keeps saves to different paths independent', async () => {
    const a = path.join(dir, 'a.json')
    const b = path.join(dir, 'b.json')

    await Promise.all([atomicWriteFile(a, 'A'), atomicWriteFile(b, 'B')])

    expect(await fs.readFile(a, 'utf-8')).toBe('A')
    expect(await fs.readFile(b, 'utf-8')).toBe('B')
  })

  it('leaves the previous file intact when the save fails before the rename', async () => {
    const target = path.join(dir, 'state.json')
    await atomicWriteFile(target, 'original')

    await expect(
      atomicWriteFile(target, 'replacement', {
        beforeRename: () => {
          throw new Error('simulated crash between write and rename')
        },
      }),
    ).rejects.toThrow('simulated crash between write and rename')

    expect(await fs.readFile(target, 'utf-8')).toBe('original')
    expect(await listDir()).toEqual(['state.json'])
  })

  it('lets a later save succeed after an earlier one failed', async () => {
    const target = path.join(dir, 'state.json')
    await atomicWriteFile(target, 'original')

    const failing = atomicWriteFile(target, 'doomed', {
      beforeRename: () => {
        throw new Error('nope')
      },
    })
    const following = atomicWriteFile(target, 'recovered')

    await expect(failing).rejects.toThrow('nope')
    await following

    expect(await fs.readFile(target, 'utf-8')).toBe('recovered')
    expect(await listDir()).toEqual(['state.json'])
  })

  it('keeps one backup of the previous content when asked', async () => {
    const target = path.join(dir, 'state.json')
    await atomicWriteFile(target, 'v1', { keepBackup: true })
    await atomicWriteFile(target, 'v2', { keepBackup: true })
    await atomicWriteFile(target, 'v3', { keepBackup: true })

    expect(await fs.readFile(target, 'utf-8')).toBe('v3')
    expect(await fs.readFile(`${target}.bak`, 'utf-8')).toBe('v2')
    expect(await listDir()).toEqual(['state.json', 'state.json.bak'])
  })

  it('does not fail the first save when there is nothing to back up', async () => {
    const target = path.join(dir, 'state.json')
    await atomicWriteFile(target, 'v1', { keepBackup: true })

    expect(await listDir()).toEqual(['state.json'])
  })

  it('writes binary payloads unchanged', async () => {
    const target = path.join(dir, 'blob.bin')
    const bytes = new Uint8Array([0, 1, 2, 250, 255])
    await atomicWriteFile(target, bytes)

    expect(new Uint8Array(await fs.readFile(target))).toEqual(bytes)
  })
})

describe('atomicWriteJson', () => {
  it('serialises the value with the requested indentation', async () => {
    const target = path.join(dir, 'shortcuts.json')
    await atomicWriteJson(target, { play: 'Space' }, { space: 2 })

    expect(await fs.readFile(target, 'utf-8')).toBe('{\n  "play": "Space"\n}')
  })

  it('defaults to compact JSON', async () => {
    const target = path.join(dir, 'state.json')
    await atomicWriteJson(target, { zooms: [1, 2] })

    expect(await fs.readFile(target, 'utf-8')).toBe('{"zooms":[1,2]}')
  })
})
