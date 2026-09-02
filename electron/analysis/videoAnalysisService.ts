import fs from 'node:fs/promises'
import path from 'node:path'
import { type AnalysisJobStatus, AnalysisJobQueue } from '../../src/lib/analysis/analysisQueue'
import {
  buildVideoAnalysisResult,
  type BuildVideoAnalysisInput,
} from '../../src/lib/analysis/videoAnalysisPipeline'
import type { VideoAnalysisResult } from '../../src/lib/analysis/types'
import { transcribeVideoFile } from '../native/transcriber'

export interface StartVideoAnalysisInput {
  videoPath: string
  locale: string
  durationMs: number
  videoWidth: number
  subtitleWidthRatio?: number
}

const ANALYSIS_SIDECAR_SUFFIX = '.analysis.json'

function validateVideoPath(videoPath: string): string {
  const normalized = String(videoPath ?? '').trim()
  if (!normalized) {
    throw new Error('Video path is required.')
  }
  return normalized
}

export function resolveAnalysisSidecarPath(videoPath: string): string {
  const parsed = path.parse(videoPath)
  return path.join(parsed.dir, `${parsed.name}${ANALYSIS_SIDECAR_SUFFIX}`)
}

export async function readAnalysisSidecar(videoPath: string): Promise<VideoAnalysisResult | null> {
  const sidecarPath = resolveAnalysisSidecarPath(videoPath)
  try {
    const raw = await fs.readFile(sidecarPath, 'utf-8')
    const parsed = JSON.parse(raw) as { analysis?: VideoAnalysisResult } | VideoAnalysisResult
    const analysis =
      (parsed as { analysis?: VideoAnalysisResult }).analysis ?? (parsed as VideoAnalysisResult)
    if (
      !analysis ||
      !analysis.transcript ||
      !Array.isArray(analysis.subtitleCues) ||
      !Array.isArray(analysis.roughCutSuggestions)
    ) {
      return null
    }
    return analysis
  } catch {
    return null
  }
}

/**
 * Writes `<video>.analysis.json`. Exported for the renderer-side Whisper engine
 * (`analysis-save-sidecar`), which builds the analysis itself and must persist it
 * in the same format so `analysis-get-current` keeps working across sessions.
 */
export async function saveSidecar(
  videoPath: string,
  analysis: VideoAnalysisResult,
): Promise<string> {
  const sidecarPath = resolveAnalysisSidecarPath(videoPath)
  const payload = JSON.stringify(
    {
      version: 1,
      analysis,
    },
    null,
    2,
  )
  await fs.writeFile(sidecarPath, payload, 'utf-8')
  return sidecarPath
}

/** Minimal shape check so a malformed renderer payload never lands on disk. */
export function isVideoAnalysisResultLike(value: unknown): value is VideoAnalysisResult {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<VideoAnalysisResult>
  return (
    Boolean(candidate.transcript) &&
    typeof candidate.transcript === 'object' &&
    Array.isArray(candidate.transcript.words) &&
    Array.isArray(candidate.subtitleCues) &&
    Array.isArray(candidate.roughCutSuggestions)
  )
}

/**
 * Thrown by the analysis job so the failure *code* survives the queue: the renderer
 * decides on the Whisper fallback from `code` (see `transcriptionEngine.ts`), not
 * from the human-readable message.
 */
export class TranscriptionFailureError extends Error {
  readonly code: string

  constructor(code: string | undefined, message: string) {
    super(message)
    this.name = 'TranscriptionFailureError'
    this.code = code || 'transcription_failed'
  }
}

export type VideoAnalysisJobStatus = AnalysisJobStatus & { code?: string }

function formatTranscriptionFailure(args: { code?: string; message?: string }): string {
  const code = String(args.code || '').trim()
  const message = String(args.message || '').trim()
  switch (code) {
    case 'speech_permission_denied':
      return 'Speech recognition permission denied. Open System Settings > Privacy & Security > Speech Recognition, allow Capturia, then retry.'
    case 'recognizer_unavailable':
      return 'Speech recognizer is currently unavailable. Please retry later.'
    case 'transcription_timeout':
      return message || 'Speech transcription timed out. Please retry.'
    case 'no_speech_detected':
      return 'No speech was detected in this recording.'
    case 'transcription_failed':
    case 'audio_export_failed':
    case 'transcriber_execution_failed':
      return message || `Transcription failed (${code || 'unknown'}).`
    default:
      return message || 'Automatic transcription failed.'
  }
}

export class VideoAnalysisService {
  private queue = new AnalysisJobQueue<StartVideoAnalysisInput, VideoAnalysisResult>()
  private failureCodes = new Map<string, string>()

  start(input: StartVideoAnalysisInput): { jobId: string } {
    const normalizedInput: StartVideoAnalysisInput = {
      ...input,
      videoPath: validateVideoPath(input.videoPath),
      locale: String(input.locale || 'en-US'),
      durationMs: Math.max(0, Math.round(Number(input.durationMs) || 0)),
      videoWidth: Math.max(320, Math.round(Number(input.videoWidth) || 1920)),
      subtitleWidthRatio: Number.isFinite(input.subtitleWidthRatio)
        ? Number(input.subtitleWidthRatio)
        : 0.82,
    }

    const { id, promise } = this.queue.enqueueWithId(normalizedInput, async (jobInput) => {
      const transcription = await transcribeVideoFile({
        inputPath: jobInput.videoPath,
        locale: jobInput.locale,
        durationMs: jobInput.durationMs,
      })

      if (!transcription.success || !transcription.words?.length) {
        const code = transcription.success ? 'no_speech_detected' : transcription.code
        throw new TranscriptionFailureError(
          code,
          formatTranscriptionFailure({
            code,
            message: transcription.message,
          }),
        )
      }

      const pipelineConfig: BuildVideoAnalysisInput = {
        durationMs: jobInput.durationMs,
        videoWidth: jobInput.videoWidth,
        subtitleWidthRatio: Number.isFinite(jobInput.subtitleWidthRatio)
          ? Number(jobInput.subtitleWidthRatio)
          : 0.82,
        locale: jobInput.locale,
      }
      const analysis = buildVideoAnalysisResult(transcription.words, pipelineConfig)
      await saveSidecar(jobInput.videoPath, analysis)
      return analysis
    })

    void promise.catch((error: unknown) => {
      // Job failure is tracked in queue status and consumed through IPC polling;
      // only the machine-readable code needs to be kept alongside.
      if (error instanceof TranscriptionFailureError) {
        this.failureCodes.set(id, error.code)
      }
    })

    return { jobId: id }
  }

  getStatus(jobId: string): VideoAnalysisJobStatus | null {
    const status = this.queue.getStatus(jobId)
    if (!status) return null
    const code = this.failureCodes.get(jobId)
    return code ? { ...status, code } : status
  }

  getResult(jobId: string): VideoAnalysisResult | null {
    return this.queue.getResult(jobId) ?? null
  }
}
