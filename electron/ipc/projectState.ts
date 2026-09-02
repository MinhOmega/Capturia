import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { IpcContext } from './context'
import {
  type CurrentVideoMetadata,
  readCursorTrackSidecar,
  sanitizeVideoMetadata,
} from './cursorTrack'
import { isReadablePathAllowed, normalizeVideoSourcePath } from './paths'

/**
 * The "current video" the editor is working on, per-video project state under
 * `<userData>/projects`, and the editor keyboard-shortcuts file. Moved verbatim
 * from `handlers.ts`.
 */

export function registerProjectStateHandlers(ctx: IpcContext): void {
  const { ipcMain, session, recordingsDir, userDataDir } = ctx

  ipcMain.handle(
    'set-current-video-path',
    async (_, nextPath: string, metadata?: CurrentVideoMetadata) => {
      const normalizedPath = normalizeVideoSourcePath(nextPath)
      if (
        normalizedPath &&
        !isReadablePathAllowed(normalizedPath, { recordingsDir: recordingsDir })
      ) {
        // Only paths from the recordings dir or a file picker result are accepted;
        // the sidecar reads below would otherwise probe arbitrary locations.
        console.warn('Refused to set current video path outside approved locations:', nextPath)
        return { success: false, message: 'Video path is not an approved readable file' }
      }
      session.currentVideoPath = normalizedPath
      session.currentVideoMetadata = sanitizeVideoMetadata(metadata)
      if (session.currentVideoPath && !session.currentVideoMetadata?.cursorTrack) {
        const sidecarTrack = await readCursorTrackSidecar(session.currentVideoPath)
        if (sidecarTrack) {
          session.currentVideoMetadata = {
            ...(session.currentVideoMetadata ?? {}),
            cursorTrack: sidecarTrack,
          }
        }
      }
      return { success: true }
    },
  )

  ipcMain.handle('get-current-video-path', async () => {
    if (session.currentVideoPath && !session.currentVideoMetadata?.cursorTrack) {
      const sidecarTrack = await readCursorTrackSidecar(session.currentVideoPath)
      if (sidecarTrack) {
        session.currentVideoMetadata = {
          ...(session.currentVideoMetadata ?? {}),
          cursorTrack: sidecarTrack,
        }
      }
    }

    return session.currentVideoPath
      ? {
          success: true,
          path: session.currentVideoPath,
          metadata: session.currentVideoMetadata ?? undefined,
        }
      : { success: false }
  })

  ipcMain.handle('clear-current-video-path', () => {
    session.currentVideoPath = null
    session.currentVideoMetadata = null
    return { success: true }
  })

  // Project state persistence
  const projectsDir = path.join(userDataDir, 'projects')

  function getProjectStateKey(videoPath: string): string {
    const basename = path.basename(videoPath).replace(/[^a-zA-Z0-9._-]/g, '_')
    const hash = crypto.createHash('sha256').update(videoPath).digest('hex').slice(0, 16)
    return `${basename}_${hash}.json`
  }

  ipcMain.handle('save-project-state', async (_, videoPath: string, state: unknown) => {
    try {
      await fs.mkdir(projectsDir, { recursive: true })
      const filePath = path.join(projectsDir, getProjectStateKey(videoPath))
      // Atomic write: write to temp file then rename to avoid corruption on crash
      const tmpPath = filePath + '.tmp'
      await fs.writeFile(tmpPath, JSON.stringify(state), 'utf-8')
      await fs.rename(tmpPath, filePath)
      return { success: true }
    } catch (error) {
      console.error('Failed to save project state:', error)
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('load-project-state', async (_, videoPath: string) => {
    try {
      const filePath = path.join(projectsDir, getProjectStateKey(videoPath))
      const data = await fs.readFile(filePath, 'utf-8')
      const state = JSON.parse(data)
      return { success: true, state }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { success: false, notFound: true }
      }
      console.error('Failed to load project state:', error)
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('get-platform', () => {
    return process.platform
  })

  // --- Keyboard shortcuts persistence ---
  const SHORTCUTS_FILE = path.join(userDataDir, 'shortcuts.json')

  ipcMain.handle('get-shortcuts', async () => {
    try {
      const data = await fs.readFile(SHORTCUTS_FILE, 'utf-8')
      return JSON.parse(data)
    } catch {
      return null
    }
  })

  ipcMain.handle('save-shortcuts', async (_, shortcuts: unknown) => {
    try {
      await fs.writeFile(SHORTCUTS_FILE, JSON.stringify(shortcuts, null, 2), 'utf-8')
      return { success: true }
    } catch (error) {
      console.error('Failed to save shortcuts:', error)
      return { success: false, error: String(error) }
    }
  })
}
