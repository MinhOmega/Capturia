import fs from 'node:fs/promises'
import type { IpcMain } from 'electron'
import { hasAllowedImportVideoExtension, isReadablePathAllowed, normalizeVideoSourcePath } from './paths'

/**
 * Cap renderer-requested chunk sizes so a buggy or compromised renderer cannot
 * make the main process allocate an arbitrarily large buffer.
 */
export const MAX_IPC_CHUNK_BYTES = 64 * 1024 * 1024

const NOT_APPROVED_MESSAGE = 'File path is not approved or is not a supported video file'

export interface FileReadHandlerContext {
  ipcMain: Pick<IpcMain, 'handle'>
  /** Recordings directory; everything below it is readable without explicit approval. */
  recordingsDir: string
}

/**
 * Turn a renderer-supplied video reference into an approved, normalized path or
 * null. Same policy as `local-media://` / `set-current-video-path`, further
 * restricted to video containers (sidecar JSON is read by the main process only).
 */
export function resolveReadableVideoPath(inputPath: unknown, recordingsDir: string): string | null {
  const normalizedPath = normalizeVideoSourcePath(inputPath)
  if (!normalizedPath) return null
  if (!hasAllowedImportVideoExtension(normalizedPath)) return null
  if (!isReadablePathAllowed(normalizedPath, { recordingsDir })) return null
  return normalizedPath
}

function toArrayBuffer(buffer: Buffer, length = buffer.byteLength): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + length) as ArrayBuffer
}

/**
 * Generic read access to approved video files (whole-file read, stat, byte
 * range). Used by the renderer to hand a recording to demuxers that need a
 * `File`/`ArrayBuffer` rather than a URL (see `src/lib/exporter/localSourceFile.ts`).
 */
export function registerFileReadHandlers(ctx: FileReadHandlerContext): void {
  const { ipcMain, recordingsDir } = ctx

  ipcMain.handle('read-binary-file', async (_, inputPath: string) => {
    // Resolved outside the try so a failed read can still report which path it was.
    let normalizedPath: string | null = null
    try {
      normalizedPath = resolveReadableVideoPath(inputPath, recordingsDir)
      if (!normalizedPath) {
        return { success: false, message: NOT_APPROVED_MESSAGE }
      }

      const data = await fs.readFile(normalizedPath)
      return {
        success: true,
        data: toArrayBuffer(data),
        path: normalizedPath,
      }
    } catch (error) {
      console.error('Failed to read binary file:', error)
      return {
        success: false,
        message: 'Failed to read binary file',
        error: String(error),
        path: normalizedPath,
      }
    }
  })

  // Stat an approved video file. Used to decide whether a recording is small
  // enough to slurp via read-binary-file, or large enough that it must be
  // streamed in chunks (Node's fs.readFile caps a single read at 2 GiB).
  ipcMain.handle('get-readable-file-info', async (_, inputPath: string) => {
    try {
      const normalizedPath = resolveReadableVideoPath(inputPath, recordingsDir)
      if (!normalizedPath) {
        return { success: false, message: NOT_APPROVED_MESSAGE }
      }

      const stat = await fs.stat(normalizedPath)
      return {
        success: true,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        path: normalizedPath,
      }
    } catch (error) {
      console.error('Failed to stat file:', error)
      return {
        success: false,
        message: 'Failed to stat file',
        error: String(error),
      }
    }
  })

  // Read a byte range [offset, offset+length) from an approved video file so the
  // renderer can stream a multi-GB recording into OPFS one chunk at a time.
  ipcMain.handle('read-file-chunk', async (_, inputPath: string, offset: number, length: number) => {
    try {
      const normalizedPath = resolveReadableVideoPath(inputPath, recordingsDir)
      if (!normalizedPath) {
        return { success: false, message: NOT_APPROVED_MESSAGE }
      }
      if (!Number.isFinite(offset) || offset < 0 || !Number.isFinite(length) || length <= 0) {
        return { success: false, message: 'Invalid chunk range' }
      }
      if (length > MAX_IPC_CHUNK_BYTES) {
        return { success: false, message: 'Requested chunk size exceeds limit' }
      }

      const handle = await fs.open(normalizedPath, 'r')
      try {
        const buffer = Buffer.allocUnsafe(length)
        const { bytesRead } = await handle.read(buffer, 0, length, offset)
        return {
          success: true,
          data: toArrayBuffer(buffer, bytesRead),
          bytesRead,
        }
      } finally {
        await handle.close()
      }
    } catch (error) {
      console.error('Failed to read file chunk:', error)
      return {
        success: false,
        message: 'Failed to read file chunk',
        error: String(error),
      }
    }
  })
}
