import { app } from 'electron'
import { readAnalysisSidecar, VideoAnalysisService } from '../analysis/videoAnalysisService'
import type { IpcContext } from './context'
import { isReadablePathAllowed, normalizeVideoSourcePath } from './paths'

/**
 * Subtitle / rough-cut analysis jobs (native transcriber) and the analysis
 * sidecar read. Moved verbatim from `handlers.ts`.
 */

type StartVideoAnalysisOptions = {
  videoPath?: string
  locale?: string
  durationMs?: number
  videoWidth?: number
  subtitleWidthRatio?: number
}

export function registerAnalysisHandlers(ctx: IpcContext): void {
  const { ipcMain, session, recordingsDir } = ctx
  const analysisService = new VideoAnalysisService()

  ipcMain.handle('analysis-start', async (_, options?: StartVideoAnalysisOptions) => {
    try {
      const targetVideoPath = normalizeVideoSourcePath(options?.videoPath) ?? session.currentVideoPath

      if (!targetVideoPath) {
        return { success: false, message: 'No video selected for analysis.' }
      }
      // The path is handed to the native transcriber helper: same read policy as playback.
      if (!isReadablePathAllowed(targetVideoPath, { recordingsDir: recordingsDir })) {
        console.warn('Refused analysis for path outside approved locations:', targetVideoPath)
        return { success: false, message: 'Video path is not an approved readable file.' }
      }

      const job = analysisService.start({
        videoPath: targetVideoPath,
        locale: typeof options?.locale === 'string' && options.locale.trim().length > 0
          ? options.locale.trim()
          : app.getLocale(),
        durationMs: Number.isFinite(options?.durationMs) ? Number(options?.durationMs) : 0,
        videoWidth: Number.isFinite(options?.videoWidth) ? Number(options?.videoWidth) : 1920,
        subtitleWidthRatio: Number.isFinite(options?.subtitleWidthRatio)
          ? Number(options?.subtitleWidthRatio)
          : 0.82,
      })

      return {
        success: true,
        jobId: job.jobId,
      }
    } catch (error) {
      console.error('Failed to start analysis job:', error)
      return {
        success: false,
        message: error instanceof Error ? error.message : String(error),
      }
    }
  })

  ipcMain.handle('analysis-status', (_, jobId: string) => {
    const status = analysisService.getStatus(String(jobId || '').trim())
    if (!status) {
      return { success: false, message: 'Analysis job not found.' }
    }

    return {
      success: true,
      status,
    }
  })

  ipcMain.handle('analysis-result', (_, jobId: string) => {
    const normalizedJobId = String(jobId || '').trim()
    const status = analysisService.getStatus(normalizedJobId)
    if (!status) {
      return { success: false, message: 'Analysis job not found.' }
    }

    if (status.status === 'failed') {
      return {
        success: false,
        message: status.error || 'Analysis job failed.',
        status,
      }
    }

    if (status.status !== 'completed') {
      return {
        success: false,
        message: 'Analysis job is still running.',
        status,
      }
    }

    const result = analysisService.getResult(normalizedJobId)
    if (!result) {
      return {
        success: false,
        message: 'Analysis job completed without result payload.',
        status,
      }
    }

    return {
      success: true,
      status,
      result,
    }
  })

  ipcMain.handle('analysis-get-current', async (_, targetPath?: string) => {
    const videoPath = normalizeVideoSourcePath(targetPath) ?? session.currentVideoPath
    if (!videoPath) {
      return { success: false, message: 'No video selected for analysis.' }
    }
    if (!isReadablePathAllowed(videoPath, { recordingsDir: recordingsDir })) {
      console.warn('Refused analysis sidecar read for path outside approved locations:', videoPath)
      return { success: false, message: 'Video path is not an approved readable file.' }
    }

    try {
      const analysis = await readAnalysisSidecar(videoPath)
      return {
        success: true,
        analysis: analysis ?? undefined,
      }
    } catch (error) {
      console.error('Failed to read analysis sidecar:', error)
      return {
        success: false,
        message: error instanceof Error ? error.message : String(error),
      }
    }
  })
}
