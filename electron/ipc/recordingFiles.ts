import fs from 'node:fs/promises'
import path from 'node:path'
import {
  forceTerminateNativeMacRecorder,
  getNativeMacRecorderOutputPath,
  isNativeMacRecorderActive,
  pauseNativeMacRecorder,
  resumeNativeMacRecorder,
  startNativeMacRecorder,
  stopNativeMacRecorder,
} from '../native/sckRecorder'
import { patchWebmDurationOnDisk } from '../recording/webm-duration'
import { scheduleRecordingsCleanup } from '../recordingsCleanup'
import type { CaptureSourceRef } from '../../src/lib/cursor/captureSpace'
import type { IpcContext, SelectedSource } from './context'
import {
  type CurrentVideoMetadata,
  resolveCursorSidecarPath,
  sanitizeVideoMetadata,
  writeCursorTrackSidecar,
} from './cursorTrack'
import { normalizeSourceRef } from './cursorTracker'
import { resolveRecordingOutputPath } from './paths'
import { applyLongEdgeLimit, clampRecorderDimension } from './permissions'
import { RecordingStreamRegistry, registerRecordingStreamHandlers } from './recordingStream'

/**
 * Source selection, the HUD -> editor hand-off, and everything that writes a
 * recording into the recordings dir: MediaRecorder streams/buffers and the
 * native ScreenCaptureKit recorder. Moved verbatim from `handlers.ts`.
 */

type NativeRecorderStartOptions = {
  source?: CaptureSourceRef | SelectedSource | null
  cursorMode?: 'always' | 'never'
  microphoneEnabled?: boolean
  microphoneGain?: number
  cameraEnabled?: boolean
  cameraShape?: 'rounded' | 'square' | 'circle'
  cameraSizePercent?: number
  cameraDeviceId?: string
  cameraDeviceName?: string
  frameRate?: number
  maxLongEdge?: number
  bitrateScale?: number
  width?: number
  height?: number
}

/** Device ids/labels travel to the native helper as argv: keep them short and printable. */
function normalizeDeviceArgument(input: unknown): string | undefined {
  if (typeof input !== 'string') return undefined
  const trimmed = input.replace(/[\r\n\0]/g, '').trim()
  if (!trimmed) return undefined
  return trimmed.slice(0, 256)
}

function isValidDurationMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/**
 * Finalize one recording file: flush/close the stream if it was streamed, else write
 * the buffered bytes (short recording, or the stream failed to open and the renderer
 * fell back to memory). Returns whether it was streamed, so the caller knows if the
 * WebM duration still needs patching on disk.
 */
async function finalizeRecordingFile(
  registry: RecordingStreamRegistry,
  fileName: string,
  filePath: string,
  videoData?: ArrayBuffer,
): Promise<boolean> {
  const streamed = await registry.finalize(fileName)
  if (!streamed) {
    if (!videoData || videoData.byteLength === 0) {
      throw new Error('Recording was not streamed and no video data was provided')
    }
    await fs.writeFile(filePath, Buffer.from(videoData))
  }
  return streamed
}

export type RecordingFilesRegistration = {
  /** Stops a native recorder that is still running; used at shutdown. */
  shutdownNativeRecorder: () => Promise<void>
}

export function registerRecordingFilesHandlers(ctx: IpcContext): RecordingFilesRegistration {
  const {
    ipcMain,
    session,
    recordingsDir,
    createEditorWindow,
    createSourceSelectorWindow,
    getMainWindow,
    getSourceSelectorWindow,
    onRecordingStateChange,
    onSourceSelectionChange,
  } = ctx

  // On-disk write streams for in-progress MediaRecorder recordings, keyed by output
  // file name. Chunks append as they arrive so the renderer never buffers the full video.
  const recordingStreams = new RecordingStreamRegistry()
  registerRecordingStreamHandlers(ipcMain, recordingStreams, (fileName) =>
    resolveRecordingOutputPath(recordingsDir, fileName),
  )

  ipcMain.handle('select-source', (_, source) => {
    session.selectedSource = source
    onSourceSelectionChange?.(session.selectedSource)
    // Push the change to the HUD so a record click that opened the picker can
    // chain straight into recording instead of waiting for the 500 ms poll.
    const mainWin = getMainWindow()
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.webContents.send('selected-source-changed', session.selectedSource)
    }
    const sourceSelectorWin = getSourceSelectorWindow()
    if (sourceSelectorWin) {
      sourceSelectorWin.close()
    }
    return session.selectedSource
  })

  ipcMain.handle('get-selected-source', () => {
    return session.selectedSource
  })

  ipcMain.handle('open-source-selector', () => {
    const sourceSelectorWin = getSourceSelectorWindow()
    if (sourceSelectorWin) {
      sourceSelectorWin.focus()
      return
    }
    createSourceSelectorWindow()
  })

  ipcMain.handle('switch-to-editor', () => {
    const mainWin = getMainWindow()
    if (mainWin) {
      mainWin.close()
    }
    createEditorWindow()
  })

  ipcMain.handle(
    'store-recorded-video',
    async (_, videoData: ArrayBuffer, fileName: string, metadata?: CurrentVideoMetadata) => {
      try {
        // The renderer only ever sends `recording-<timestamp>.webm`; refuse anything
        // that could escape the recordings dir.
        const videoPath = resolveRecordingOutputPath(recordingsDir, fileName)
        // Streamed recordings are already on disk: close the stream. Otherwise (short
        // recording, or the stream failed to open) write the renderer's buffer.
        const streamed = await finalizeRecordingFile(
          recordingStreams,
          fileName,
          videoPath,
          videoData,
        )
        if (streamed) {
          // The renderer never held the whole blob, so it could not fix the WebM
          // Duration header itself. Best-effort: the file plays either way, the
          // editor just needs the duration for seeking.
          if (isValidDurationMs(metadata?.durationMs)) {
            const patch = await patchWebmDurationOnDisk(videoPath, metadata.durationMs)
            if (!patch.patched) {
              console.warn(
                `[store-recorded-video] duration patch skipped for ${fileName}: ${patch.reason}`,
              )
            }
          } else {
            console.warn(
              `[store-recorded-video] streamed recording ${fileName} has no durationMs; header left unpatched`,
            )
          }
        }
        session.currentVideoPath = videoPath
        session.currentVideoMetadata = sanitizeVideoMetadata(metadata)
        if (session.currentVideoMetadata?.cursorTrack) {
          await writeCursorTrackSidecar(videoPath, session.currentVideoMetadata.cursorTrack)
        }
        scheduleRecordingsCleanup({
          recordingsDir: recordingsDir,
          excludePaths: [videoPath],
          reason: 'post-recording',
        })
        return {
          success: true,
          path: videoPath,
          metadata: session.currentVideoMetadata ?? undefined,
          message: 'Video stored successfully',
        }
      } catch (error) {
        console.error('Failed to store video:', error)
        return {
          success: false,
          message: 'Failed to store video',
          error: String(error),
        }
      }
    },
  )

  ipcMain.handle('get-recorded-video-path', async () => {
    try {
      const files = await fs.readdir(recordingsDir)
      const videoFiles = files.filter((file) => file.endsWith('.webm'))

      if (videoFiles.length === 0) {
        return { success: false, message: 'No recorded video found' }
      }

      const latestVideo = videoFiles.sort().reverse()[0]
      const videoPath = path.join(recordingsDir, latestVideo)

      return { success: true, path: videoPath }
    } catch (error) {
      console.error('Failed to get video path:', error)
      return { success: false, message: 'Failed to get video path', error: String(error) }
    }
  })

  ipcMain.handle('set-recording-state', (_, recording: boolean) => {
    const sourceName = session.selectedSource?.name || 'Screen'
    if (onRecordingStateChange) {
      onRecordingStateChange(recording, sourceName)
    }
  })

  ipcMain.handle(
    'native-screen-recorder-start',
    async (_, options?: NativeRecorderStartOptions) => {
      try {
        if (process.platform !== 'darwin') {
          return {
            success: false,
            message: 'Native ScreenCaptureKit recorder is only supported on macOS.',
          }
        }

        const sourceRef =
          normalizeSourceRef(options?.source) ?? normalizeSourceRef(session.selectedSource)
        const cursorMode = options?.cursorMode === 'never' ? 'never' : 'always'
        const microphoneEnabled = options?.microphoneEnabled !== false
        const microphoneGain = Number.isFinite(options?.microphoneGain)
          ? Math.max(0.5, Math.min(2, Number(options?.microphoneGain)))
          : 1
        const cameraEnabled = options?.cameraEnabled === true
        const cameraShape =
          options?.cameraShape === 'square' || options?.cameraShape === 'circle'
            ? options.cameraShape
            : 'rounded'
        const cameraSizePercent = Number.isFinite(options?.cameraSizePercent)
          ? Number(options?.cameraSizePercent)
          : 22
        const cameraDeviceId = normalizeDeviceArgument(options?.cameraDeviceId)
        const cameraDeviceName = normalizeDeviceArgument(options?.cameraDeviceName)
        const frameRate = Number.isFinite(options?.frameRate) ? Number(options?.frameRate) : 60
        const maxLongEdge = Number.isFinite(options?.maxLongEdge)
          ? Math.max(2, Math.round(Number(options?.maxLongEdge)))
          : undefined
        const bitrateScale = Number.isFinite(options?.bitrateScale)
          ? Math.max(0.5, Math.min(2, Number(options?.bitrateScale)))
          : 1
        let width = Number.isFinite(options?.width)
          ? clampRecorderDimension(Number(options?.width))
          : undefined
        let height = Number.isFinite(options?.height)
          ? clampRecorderDimension(Number(options?.height))
          : undefined
        if ((!width || !height) && maxLongEdge && sourceRef?.id?.startsWith('screen:')) {
          const sourceWidth = Number(
            (options?.source as SelectedSource | undefined)?.width ?? session.selectedSource?.width,
          )
          const sourceHeight = Number(
            (options?.source as SelectedSource | undefined)?.height ??
              session.selectedSource?.height,
          )
          if (
            Number.isFinite(sourceWidth) &&
            Number.isFinite(sourceHeight) &&
            sourceWidth > 1 &&
            sourceHeight > 1
          ) {
            const limited = applyLongEdgeLimit(sourceWidth, sourceHeight, maxLongEdge)
            width = limited.width
            height = limited.height
          }
        }
        const outputPath = path.join(recordingsDir, `recording-${Date.now()}.mp4`)

        const result = await startNativeMacRecorder({
          outputPath,
          sourceId: typeof sourceRef?.id === 'string' ? sourceRef.id : undefined,
          displayId: sourceRef?.display_id ? String(sourceRef.display_id) : undefined,
          cursorMode,
          microphoneEnabled,
          microphoneGain,
          cameraEnabled,
          cameraShape,
          cameraSizePercent,
          cameraDeviceId,
          cameraDeviceName,
          frameRate,
          bitrateScale,
          width,
          height,
        })

        if (!result.success || !result.ready) {
          return {
            success: false,
            code: result.code,
            message: result.message ?? 'Failed to start native ScreenCaptureKit recorder.',
          }
        }

        const sourceName = session.selectedSource?.name || 'Screen'
        onRecordingStateChange?.(true, sourceName)

        return {
          success: true,
          width: result.ready.width,
          height: result.ready.height,
          frameRate: result.ready.frameRate,
          sourceKind: result.ready.sourceKind,
          hasMicrophoneAudio: result.ready.hasMicrophoneAudio,
          // False for a helper built before the stdin protocol: the HUD hides Pause.
          canPause: result.capabilities?.pause === true,
        }
      } catch (error) {
        return {
          success: false,
          message: error instanceof Error ? error.message : String(error),
        }
      }
    },
  )

  // A5: pause / resume the native helper over its stdin. Both answer
  // `{ success, supported }`; `supported: false` means the running helper has no
  // pause command (old binary) and the renderer must keep recording normally.
  ipcMain.handle('pause-native-recording', async () => {
    try {
      return await pauseNativeMacRecorder()
    } catch (error) {
      return {
        success: false,
        supported: false,
        message: error instanceof Error ? error.message : String(error),
      }
    }
  })

  ipcMain.handle('resume-native-recording', async () => {
    try {
      return await resumeNativeMacRecorder()
    } catch (error) {
      return {
        success: false,
        supported: false,
        message: error instanceof Error ? error.message : String(error),
      }
    }
  })

  ipcMain.handle('native-screen-recorder-stop', async (_, options?: { discard?: boolean }) => {
    try {
      const discard = options?.discard === true
      // Grab the path before stopping: a discarded helper that produced an empty
      // file reports no path, but the file still has to go.
      const activeOutputPath = getNativeMacRecorderOutputPath()
      const result = await stopNativeMacRecorder()
      // Tray + main-window restore run for a discard too: the recording has ended
      // either way. Only the editor switch (renderer side) is skipped.
      const sourceName = session.selectedSource?.name || 'Screen'
      onRecordingStateChange?.(false, sourceName)

      if (discard) {
        const outputPath = result.path ?? activeOutputPath
        if (outputPath) {
          await fs.rm(outputPath, { force: true }).catch((error) => {
            console.warn(
              '[native-screen-recorder-stop] failed to delete discarded recording:',
              error,
            )
          })
          await fs.rm(resolveCursorSidecarPath(outputPath), { force: true }).catch(() => undefined)
        }
        return { success: true, discarded: true }
      }

      if (result.success && result.path) {
        scheduleRecordingsCleanup({
          recordingsDir: recordingsDir,
          excludePaths: [result.path],
          reason: 'post-native-recording',
        })
      }
      return result
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : String(error),
      }
    }
  })

  const shutdownNativeRecorder = async (): Promise<void> => {
    try {
      if (isNativeMacRecorderActive()) {
        const result = await stopNativeMacRecorder()
        if (!result.success) {
          console.warn(
            '[ipc] native recorder stop during shutdown reported failure:',
            result.message,
          )
          forceTerminateNativeMacRecorder()
        }
      }
    } catch (error) {
      console.warn('[ipc] failed to shutdown native recorder cleanly:', error)
      forceTerminateNativeMacRecorder()
    }
  }

  return { shutdownNativeRecorder }
}
