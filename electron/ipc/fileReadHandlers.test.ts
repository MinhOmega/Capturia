import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  MAX_IPC_CHUNK_BYTES,
  registerFileReadHandlers,
  resolveReadableVideoPath,
} from './fileReadHandlers'
import { approvedReadPaths } from './paths'

type Handler = (event: unknown, ...args: unknown[]) => Promise<Record<string, unknown>>

function createIpcMainStub() {
  const handlers = new Map<string, Handler>()
  return {
    ipcMain: {
      handle: vi.fn((channel: string, handler: Handler) => {
        handlers.set(channel, handler)
      }),
    },
    invoke: (channel: string, ...args: unknown[]) => {
      const handler = handlers.get(channel)
      if (!handler) throw new Error(`No handler for ${channel}`)
      return handler({}, ...args)
    },
  }
}

describe('file read IPC handlers', () => {
  let recordingsDir: string
  let outsideDir: string
  let recordingPath: string
  let outsidePath: string
  const bytes = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])

  beforeAll(async () => {
    recordingsDir = await mkdtemp(path.join(os.tmpdir(), 'capturia-rec-'))
    outsideDir = await mkdtemp(path.join(os.tmpdir(), 'capturia-outside-'))
    recordingPath = path.join(recordingsDir, 'clip.webm')
    outsidePath = path.join(outsideDir, 'clip.mp4')
    await writeFile(recordingPath, bytes)
    await writeFile(outsidePath, bytes)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterAll(async () => {
    vi.restoreAllMocks()
    approvedReadPaths.clear()
    await rm(recordingsDir, { recursive: true, force: true })
    await rm(outsideDir, { recursive: true, force: true })
  })

  it('registers the three read channels', () => {
    const stub = createIpcMainStub()
    registerFileReadHandlers({ ipcMain: stub.ipcMain, recordingsDir })
    const channels = stub.ipcMain.handle.mock.calls.map(([channel]) => channel)
    expect(channels).toEqual(['read-binary-file', 'get-readable-file-info', 'read-file-chunk'])
  })

  describe('resolveReadableVideoPath', () => {
    it('accepts recordings-dir files and file:// URLs', () => {
      expect(resolveReadableVideoPath(recordingPath, recordingsDir)).toBe(recordingPath)
      expect(resolveReadableVideoPath(`file://${recordingPath}`, recordingsDir)).toBe(recordingPath)
    })

    it('rejects files outside the recordings dir unless approved', () => {
      expect(resolveReadableVideoPath(outsidePath, recordingsDir)).toBeNull()
      approvedReadPaths.approveFile(outsidePath)
      expect(resolveReadableVideoPath(outsidePath, recordingsDir)).toBe(outsidePath)
      approvedReadPaths.clear()
    })

    it('rejects sidecars, relative paths and non-strings', () => {
      expect(
        resolveReadableVideoPath(path.join(recordingsDir, 'clip.cursor.json'), recordingsDir),
      ).toBeNull()
      expect(resolveReadableVideoPath('clip.webm', recordingsDir)).toBeNull()
      expect(resolveReadableVideoPath(undefined, recordingsDir)).toBeNull()
      expect(resolveReadableVideoPath('', recordingsDir)).toBeNull()
    })
  })

  describe('read-binary-file', () => {
    it('returns the whole file for an approved path', async () => {
      const stub = createIpcMainStub()
      registerFileReadHandlers({ ipcMain: stub.ipcMain, recordingsDir })
      const result = await stub.invoke('read-binary-file', recordingPath)
      expect(result.success).toBe(true)
      expect(result.path).toBe(recordingPath)
      expect(new Uint8Array(result.data as ArrayBuffer)).toEqual(new Uint8Array(bytes))
    })

    it('refuses unapproved paths without touching the disk', async () => {
      const stub = createIpcMainStub()
      registerFileReadHandlers({ ipcMain: stub.ipcMain, recordingsDir })
      const result = await stub.invoke('read-binary-file', outsidePath)
      expect(result).toEqual({
        success: false,
        message: 'File path is not approved or is not a supported video file',
      })
    })

    it('reports the resolved path when the read itself fails', async () => {
      const stub = createIpcMainStub()
      registerFileReadHandlers({ ipcMain: stub.ipcMain, recordingsDir })
      const missing = path.join(recordingsDir, 'missing.webm')
      const result = await stub.invoke('read-binary-file', missing)
      expect(result.success).toBe(false)
      expect(result.message).toBe('Failed to read binary file')
      expect(result.path).toBe(missing)
      expect(String(result.error)).toContain('ENOENT')
    })
  })

  describe('get-readable-file-info', () => {
    it('stats an approved file', async () => {
      const stub = createIpcMainStub()
      registerFileReadHandlers({ ipcMain: stub.ipcMain, recordingsDir })
      const result = await stub.invoke('get-readable-file-info', recordingPath)
      expect(result.success).toBe(true)
      expect(result.size).toBe(bytes.byteLength)
      expect(typeof result.mtimeMs).toBe('number')
      expect(result.path).toBe(recordingPath)
    })

    it('refuses unapproved paths', async () => {
      const stub = createIpcMainStub()
      registerFileReadHandlers({ ipcMain: stub.ipcMain, recordingsDir })
      const result = await stub.invoke('get-readable-file-info', outsidePath)
      expect(result.success).toBe(false)
    })
  })

  describe('read-file-chunk', () => {
    it('reads a byte range and reports a short final read', async () => {
      const stub = createIpcMainStub()
      registerFileReadHandlers({ ipcMain: stub.ipcMain, recordingsDir })

      const first = await stub.invoke('read-file-chunk', recordingPath, 2, 4)
      expect(first.success).toBe(true)
      expect(first.bytesRead).toBe(4)
      expect(Array.from(new Uint8Array(first.data as ArrayBuffer))).toEqual([3, 4, 5, 6])

      const tail = await stub.invoke('read-file-chunk', recordingPath, 8, 4)
      expect(tail.bytesRead).toBe(2)
      expect(Array.from(new Uint8Array(tail.data as ArrayBuffer))).toEqual([9, 10])
    })

    it('rejects invalid ranges and oversized chunks', async () => {
      const stub = createIpcMainStub()
      registerFileReadHandlers({ ipcMain: stub.ipcMain, recordingsDir })

      expect((await stub.invoke('read-file-chunk', recordingPath, -1, 4)).message).toBe(
        'Invalid chunk range',
      )
      expect((await stub.invoke('read-file-chunk', recordingPath, 0, 0)).message).toBe(
        'Invalid chunk range',
      )
      expect((await stub.invoke('read-file-chunk', recordingPath, Number.NaN, 4)).message).toBe(
        'Invalid chunk range',
      )
      expect(
        (await stub.invoke('read-file-chunk', recordingPath, 0, MAX_IPC_CHUNK_BYTES + 1)).message,
      ).toBe('Requested chunk size exceeds limit')
    })

    it('refuses unapproved paths', async () => {
      const stub = createIpcMainStub()
      registerFileReadHandlers({ ipcMain: stub.ipcMain, recordingsDir })
      const result = await stub.invoke('read-file-chunk', outsidePath, 0, 4)
      expect(result.success).toBe(false)
    })
  })
})
