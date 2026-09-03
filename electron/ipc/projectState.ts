import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { MediaFingerprint } from '../media/mediaLinksRegistry'
import {
  findLinkedCursorSidecar,
  registerProjectMedia,
  relinkProjectStateForVideo,
} from '../media/projectMediaRelinker'
import { atomicWriteJson } from './atomicSave'
import type { IpcContext } from './context'
import {
  type CurrentVideoMetadata,
  readCursorTrackSidecar,
  readCursorTrackSidecarFile,
  sanitizeVideoMetadata,
} from './cursorTrack'
import { isReadablePathAllowed, normalizeVideoSourcePath } from './paths'

/**
 * The "current video" the editor is working on, per-video project state under
 * `<userData>/projects`, and the editor keyboard-shortcuts file. Moved verbatim
 * from `handlers.ts`.
 *
 * Project state is keyed by the recording's path. A moved or renamed recording
 * would orphan it, so every save also records the recording's content
 * fingerprint in `<userData>/media-links.json` and a load with no state file
 * falls back to that registry (see `../media/projectMediaRelinker`).
 */

/** `<basename>_<sha256(path)[0..16]>.json` under `<userData>/projects`. */
export function projectStateFileName(videoPath: string): string {
  const basename = path.basename(videoPath).replace(/[^a-zA-Z0-9._-]/g, '_')
  const hash = crypto.createHash('sha256').update(videoPath).digest('hex').slice(0, 16)
  return `${basename}_${hash}.json`
}

export function registerProjectStateHandlers(ctx: IpcContext): void {
  const { ipcMain, session, recordingsDir, userDataDir } = ctx
  const projectsDir = path.join(userDataDir, 'projects')

  /** Sidecar next to the video, else the one the registry last saw for the same bytes. */
  async function readCursorTrackForVideo(
    videoPath: string,
  ): Promise<CurrentVideoMetadata['cursorTrack'] | undefined> {
    const adjacent = await readCursorTrackSidecar(videoPath)
    if (adjacent) return adjacent
    const linked = await findLinkedCursorSidecar({
      registryDir: userDataDir,
      recordingsDir,
      videoPath,
    })
    return linked ? readCursorTrackSidecarFile(linked) : undefined
  }

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
        const sidecarTrack = await readCursorTrackForVideo(session.currentVideoPath)
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
      const sidecarTrack = await readCursorTrackForVideo(session.currentVideoPath)
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

  // Fingerprint cache for the registry refresh on auto-save: the save fires
  // every couple of seconds while editing, the file does not change.
  const fingerprintCache = new Map<
    string,
    { size: number; mtimeMs: number; fingerprint: MediaFingerprint }
  >()

  async function refreshMediaLink(videoPath: string, projectStateFile: string): Promise<void> {
    try {
      const stat = await fs.stat(videoPath)
      const cached = fingerprintCache.get(videoPath)
      const fingerprint =
        cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs && cached.fingerprint
          ? cached.fingerprint
          : undefined
      const result = await registerProjectMedia({
        registryDir: userDataDir,
        recordingsDir,
        videoPath,
        projectStateFile,
        fingerprint,
      })
      if (result) {
        fingerprintCache.set(videoPath, {
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          fingerprint: result,
        })
      }
    } catch (error) {
      // The registry is a convenience for moved files; a failure here must
      // never turn a successful save into an error.
      console.warn('Failed to record the media link for project state:', error)
    }
  }

  ipcMain.handle('save-project-state', async (_, videoPath: string, state: unknown) => {
    try {
      const fileName = projectStateFileName(videoPath)
      const filePath = path.join(projectsDir, fileName)
      // Durable and serialised: the editor auto-saves on a debounce while the
      // close handler flushes one last time, and the close-time write has no
      // later save to repair it. `keepBackup` leaves one generation of the
      // edit history behind for a few KB of JSON.
      await atomicWriteJson(filePath, state, { keepBackup: true })
      await refreshMediaLink(videoPath, fileName)
      return { success: true }
    } catch (error) {
      console.error('Failed to save project state:', error)
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('load-project-state', async (_, videoPath: string) => {
    const fileName = projectStateFileName(videoPath)
    try {
      const filePath = path.join(projectsDir, fileName)
      const data = await fs.readFile(filePath, 'utf-8')
      const state = JSON.parse(data)
      return { success: true, state }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('Failed to load project state:', error)
        return { success: false, error: String(error) }
      }
    }

    // No state for this path: the recording may have been moved or renamed.
    try {
      const relink = await relinkProjectStateForVideo({
        registryDir: userDataDir,
        projectsDir,
        recordingsDir,
        videoPath,
        projectStateFile: fileName,
      })
      if (relink.relinked) {
        if (
          relink.cursorSidecarWritten &&
          session.currentVideoPath === videoPath &&
          !session.currentVideoMetadata?.cursorTrack
        ) {
          const sidecarTrack = await readCursorTrackSidecar(videoPath)
          if (sidecarTrack) {
            session.currentVideoMetadata = {
              ...(session.currentVideoMetadata ?? {}),
              cursorTrack: sidecarTrack,
            }
          }
        }
        return { success: true, state: relink.state, relinked: true, relinkedFrom: relink.fromPath }
      }
    } catch (error) {
      console.warn('Project state relink failed:', error)
    }
    return { success: false, notFound: true }
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
      await atomicWriteJson(SHORTCUTS_FILE, shortcuts, { space: 2 })
      return { success: true }
    } catch (error) {
      console.error('Failed to save shortcuts:', error)
      return { success: false, error: String(error) }
    }
  })
}
