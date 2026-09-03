import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { CAPTION_MODEL_ID, CAPTION_MODEL_REVISION } from '../../src/lib/captioning/captionConstants'
import { isVideoAnalysisResultLike, saveSidecar } from '../analysis/videoAnalysisService'
import {
  hasAllowedImportVideoExtension,
  isReadablePathAllowed,
  normalizeVideoSourcePath,
} from './paths'

/**
 * IPC for the in-browser Whisper caption fallback (C-1):
 *
 * - `caption-model-status`            is the model on disk? how much of it?
 * - `caption-model-download`          stream the Hugging Face files into
 *                                     `userData/caption-models/<repo>/`, with
 *                                     progress events, retry/backoff on 429/5xx,
 *                                     per-file resume and cancellation
 * - `caption-model-download-cancel`   abort the in-flight download
 * - `caption-model-dir`               absolute model root (the renderer also gets
 *                                     it as a file:// URL through the preload arg)
 * - `analysis-save-sidecar`           persist a renderer-built analysis next to
 *                                     the video (same format as the native path)
 *
 * The model is deliberately not bundled with the app (~45 MB on every platform
 * for a macOS-only fallback); it is fetched on first use instead.
 */

export interface CaptionModelFile {
  /** Path relative to the model directory, e.g. `onnx/encoder_model_quantized.onnx`. */
  name: string
  /** Size in bytes at the pinned revision (progress; 0 = unknown). */
  approximateBytes: number
  /** SHA-256 hex digest to verify after download; null skips verification. */
  expectedSha256: string | null
}

export interface CaptionModelDescriptor {
  /** Hugging Face repo id, also the on-disk sub-path (`Xenova/whisper-tiny`). */
  id: string
  /**
   * Git commit the file list and digests were captured against. Must be a full
   * 40-hex SHA so the download URLs are immutable (a branch name such as `main`
   * would let a Hub push change the files under a verified digest).
   */
  revision: string
  files: CaptionModelFile[]
}

const HEX_40 = /^[0-9a-f]{40}$/

/** True when `revision` is an immutable commit SHA rather than a branch or tag. */
export function isPinnedRevision(revision: string): boolean {
  return HEX_40.test(revision)
}

const HF_BASE = 'https://huggingface.co'

/**
 * Config/tokenizer/preprocessor files plus the quantized ONNX graphs the ASR
 * pipeline loads by default (encoder + merged decoder). Every metadata file is
 * listed so Transformers.js never asks for one that is missing (remote loading is
 * disabled in the worker).
 *
 * Sizes and SHA-256 digests were computed on 2026-09-03 from the bytes served at
 * `CAPTION_MODEL_REVISION`; the two ONNX digests also match the LFS `sha256`
 * the Hub API reports for that commit. Every download is verified, so bumping
 * the revision means recomputing every entry here (docs/captions.md).
 */
export const WHISPER_TINY_MODEL: CaptionModelDescriptor = {
  id: CAPTION_MODEL_ID,
  revision: CAPTION_MODEL_REVISION,
  files: [
    {
      name: 'config.json',
      approximateBytes: 2_248,
      expectedSha256: '2b2e4e519084e0ea028b19b153f95202735a971870d6844aa26e559edd292e94',
    },
    {
      name: 'generation_config.json',
      approximateBytes: 3_716,
      expectedSha256: '68ac791fcb4999461a313472125042934656240ba1cba7d1c2627fcbb19ac24c',
    },
    {
      name: 'preprocessor_config.json',
      approximateBytes: 339,
      expectedSha256: 'a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d',
    },
    {
      name: 'tokenizer.json',
      approximateBytes: 2_480_466,
      expectedSha256: '27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566',
    },
    {
      name: 'tokenizer_config.json',
      approximateBytes: 282_683,
      expectedSha256: '2a4c4281cf9f51ac6ccc406fdc711a087afe6530f671fa7b80953edc498275ce',
    },
    {
      name: 'added_tokens.json',
      approximateBytes: 2_082,
      expectedSha256: 'ce949fe720c14311cb6c446e69cfe340dc669d7b006077a6feed6ae571dd7e88',
    },
    {
      name: 'special_tokens_map.json',
      approximateBytes: 2_194,
      expectedSha256: 'e67ae3a0aaa99abcd9f187138e12db1f65c16a14761c50ef10eef2c174a7a691',
    },
    {
      name: 'normalizer.json',
      approximateBytes: 52_666,
      expectedSha256: 'bf1c507dc8724ca9cf9903640dacfb69dae2f00edee4f21ceba106a7392f26dd',
    },
    {
      name: 'merges.txt',
      approximateBytes: 493_869,
      expectedSha256: '2df2990a395e35e8dfbc7511e08c12d56018d8d04691e0133e5d63b21e154dc6',
    },
    {
      name: 'vocab.json',
      approximateBytes: 1_036_584,
      expectedSha256: '50d6a919f0a0601d56a04eb583c780d18553aa388254ba3158eb6a00f13e2c1a',
    },
    {
      name: 'quantize_config.json',
      approximateBytes: 2_840,
      expectedSha256: '5be0072d627cc8094c2051c38629aed10a509844f562de6d17277756ff0a602c',
    },
    {
      name: 'onnx/encoder_model_quantized.onnx',
      approximateBytes: 10_124_910,
      expectedSha256: 'fd9d995b9dcb0520f0dbf6cf68651af639fc385f594d9d876e69ca2802dc438e',
    },
    {
      name: 'onnx/decoder_model_merged_quantized.onnx',
      approximateBytes: 30_727_765,
      expectedSha256: '6c0c125986b007d2e3734bec84c18bda0152071b90b87fadac6d7764499927a0',
    },
  ],
}

export const CAPTION_MODELS: Record<string, CaptionModelDescriptor> = {
  [WHISPER_TINY_MODEL.id]: WHISPER_TINY_MODEL,
}

export function captionModelsRoot(userDataDir: string): string {
  return path.join(userDataDir, 'caption-models')
}

export function captionModelDir(userDataDir: string, model: CaptionModelDescriptor): string {
  return path.join(captionModelsRoot(userDataDir), ...model.id.split('/'))
}

export function modelFileUrl(model: CaptionModelDescriptor, file: CaptionModelFile): string {
  if (!isPinnedRevision(model.revision)) {
    throw new Error(
      `Caption model ${model.id} must be pinned to a commit SHA, got revision "${model.revision}"`,
    )
  }
  return `${HF_BASE}/${model.id}/resolve/${model.revision}/${file.name}`
}

export function totalApproximateBytes(model: CaptionModelDescriptor): number {
  return model.files.reduce((sum, file) => sum + file.approximateBytes, 0)
}

async function fileSize(filePath: string): Promise<number> {
  try {
    const stat = await fs.stat(filePath)
    return stat.isFile() ? stat.size : -1
  } catch {
    return -1
  }
}

export interface CaptionModelStatus {
  modelId: string
  present: boolean
  dir: string
  downloadedBytes: number
  totalBytes: number
  missingFiles: string[]
}

export async function getCaptionModelStatus(
  userDataDir: string,
  model: CaptionModelDescriptor,
): Promise<CaptionModelStatus> {
  const dir = captionModelDir(userDataDir, model)
  const missingFiles: string[] = []
  let downloadedBytes = 0
  for (const file of model.files) {
    const size = await fileSize(path.join(dir, file.name))
    if (size <= 0) missingFiles.push(file.name)
    else downloadedBytes += size
  }
  return {
    modelId: model.id,
    present: missingFiles.length === 0,
    dir: captionModelsRoot(userDataDir),
    downloadedBytes,
    totalBytes: Math.max(totalApproximateBytes(model), downloadedBytes),
    missingFiles,
  }
}

/* ----------------------------------------------------------------------------
 * Download
 * -------------------------------------------------------------------------- */

const MAX_ATTEMPTS = 6
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])
const USER_AGENT = 'capturia-captions'

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function abortError(): Error {
  const error = new Error('Caption model download cancelled')
  error.name = 'AbortError'
  return error
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

export function backoffMs(
  attempt: number,
  retryAfter: string | null,
  random: () => number = Math.random,
): number {
  // Honor Retry-After when the server sends it (seconds or an HTTP date).
  if (retryAfter) {
    const secs = Number(retryAfter)
    if (Number.isFinite(secs)) return Math.min(60_000, secs * 1000)
    const at = Date.parse(retryAfter)
    if (!Number.isNaN(at)) return Math.min(60_000, Math.max(0, at - Date.now()))
  }
  // Exponential backoff with jitter: ~2s, 4s, 8s, 16s, 32s, capped at 60s.
  return Math.min(60_000, 2_000 * 2 ** (attempt - 1)) + Math.floor(random() * 1000)
}

export class DownloadHttpError extends Error {
  constructor(
    readonly status: number,
    url: string,
    statusText: string,
  ) {
    super(`Failed to download ${url}: HTTP ${status} ${statusText}`)
    this.name = 'DownloadHttpError'
  }
}

export interface DownloadDeps {
  fetcher?: typeof fetch
  /** Override the backoff (tests). */
  backoff?: (attempt: number, retryAfter: string | null) => number
}

/**
 * GET with retry/backoff for transient failures. `rangeFrom` asks the server to
 * resume; the caller must handle a 200 (server ignored the range) by restarting.
 */
async function fetchWithRetry(
  url: string,
  rangeFrom: number,
  signal: AbortSignal | undefined,
  deps: DownloadDeps,
): Promise<Response> {
  const fetcher = deps.fetcher ?? fetch
  const backoff = deps.backoff ?? backoffMs
  let lastError: unknown
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (signal?.aborted) throw abortError()
    try {
      const headers: Record<string, string> = { 'user-agent': USER_AGENT }
      if (rangeFrom > 0) headers.range = `bytes=${rangeFrom}-`
      const res = await fetcher(url, { headers, signal, redirect: 'follow' })
      if ((res.status === 200 || res.status === 206) && res.body) return res
      if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_ATTEMPTS) {
        await sleep(backoff(attempt, res.headers.get('retry-after')), signal)
        continue
      }
      throw new DownloadHttpError(res.status, url, res.statusText)
    } catch (error) {
      if (isAbortError(error) || (error instanceof Error && error.name === 'AbortError'))
        throw abortError()
      if (error instanceof DownloadHttpError) throw error
      lastError = error
      if (attempt >= MAX_ATTEMPTS) break
      // Network/DNS error: back off and retry.
      await sleep(backoff(attempt, null), signal)
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

export async function sha256OfFile(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(filePath), hash)
  return hash.digest('hex')
}

export interface DownloadProgress {
  modelId: string
  file: string
  fileIndex: number
  fileCount: number
  downloadedBytes: number
  totalBytes: number
}

export interface DownloadModelOptions extends DownloadDeps {
  userDataDir: string
  model: CaptionModelDescriptor
  signal?: AbortSignal
  onProgress?: (progress: DownloadProgress) => void
}

/**
 * Streams one file to `<dest>.partial` (resuming a previous partial with a Range
 * request), verifies the digest when known, then renames into place.
 */
async function ensureFile(
  filePath: string,
  url: string,
  file: CaptionModelFile,
  signal: AbortSignal | undefined,
  deps: DownloadDeps,
  onBytes: (bytesOnDisk: number) => void,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.partial`

  let resumeFrom = Math.max(0, await fileSize(tmp))
  const res = await fetchWithRetry(url, resumeFrom, signal, deps)
  if (res.status !== 206) {
    // Server ignored the Range request (or nothing to resume): start over.
    resumeFrom = 0
  }

  let written = resumeFrom
  const source = Readable.fromWeb(res.body as never)
  source.on('data', (chunk: Buffer | Uint8Array) => {
    written += chunk.length
    onBytes(written)
  })
  try {
    await pipeline(source, createWriteStream(tmp, { flags: resumeFrom > 0 ? 'a' : 'w' }), {
      signal,
    })
  } catch (error) {
    if (isAbortError(error) || (error instanceof Error && error.name === 'AbortError'))
      throw abortError()
    throw error
  }

  if (file.expectedSha256) {
    const actual = await sha256OfFile(tmp)
    if (actual.toLowerCase() !== file.expectedSha256.toLowerCase()) {
      // Drop the bad download; a stale-but-valid copy (if any) stays in place.
      await fs.rm(tmp, { force: true }).catch(() => undefined)
      throw new Error(
        `Checksum mismatch for ${file.name}: expected ${file.expectedSha256}, got ${actual}`,
      )
    }
  }
  await fs.rename(tmp, filePath)
}

/** Ensures every model file is present; downloads what is missing, in order. */
export async function downloadCaptionModel(options: DownloadModelOptions): Promise<void> {
  const { model, userDataDir, signal } = options
  const dir = captionModelDir(userDataDir, model)
  const totalBytes = totalApproximateBytes(model)
  const fileCount = model.files.length
  let completedBytes = 0

  for (let fileIndex = 0; fileIndex < fileCount; fileIndex++) {
    const file = model.files[fileIndex]!
    if (signal?.aborted) throw abortError()
    const filePath = path.join(dir, file.name)
    const existing = await fileSize(filePath)
    if (existing > 0) {
      completedBytes += existing
      options.onProgress?.({
        modelId: model.id,
        file: file.name,
        fileIndex,
        fileCount,
        downloadedBytes: completedBytes,
        totalBytes,
      })
      continue
    }

    let lastReported = 0
    await ensureFile(filePath, modelFileUrl(model, file), file, signal, options, (bytesOnDisk) => {
      lastReported = bytesOnDisk
      options.onProgress?.({
        modelId: model.id,
        file: file.name,
        fileIndex,
        fileCount,
        downloadedBytes: completedBytes + bytesOnDisk,
        totalBytes: Math.max(totalBytes, completedBytes + bytesOnDisk),
      })
    })
    completedBytes += Math.max(lastReported, await fileSize(filePath))
  }
}

/* ----------------------------------------------------------------------------
 * IPC registration
 * -------------------------------------------------------------------------- */

export interface CaptionHandlerContext {
  ipcMain: Pick<IpcMain, 'handle'>
  /** Recordings directory; sidecars may only be written next to approved videos. */
  recordingsDir: string
  /** `app.getPath('userData')`; the model cache lives below it. */
  userDataDir: string
  /** Override fetch (tests). */
  fetcher?: typeof fetch
  backoff?: DownloadDeps['backoff']
}

function resolveModel(modelId: unknown): CaptionModelDescriptor | null {
  const id = typeof modelId === 'string' && modelId.trim() ? modelId.trim() : WHISPER_TINY_MODEL.id
  return CAPTION_MODELS[id] ?? null
}

/** Sidecar writes reuse the file-read policy: approved path + video extension. */
export function resolveSidecarVideoPath(inputPath: unknown, recordingsDir: string): string | null {
  const normalizedPath = normalizeVideoSourcePath(inputPath)
  if (!normalizedPath) return null
  if (!hasAllowedImportVideoExtension(normalizedPath)) return null
  if (!isReadablePathAllowed(normalizedPath, { recordingsDir })) return null
  return normalizedPath
}

export function registerCaptionHandlers(ctx: CaptionHandlerContext): void {
  const { ipcMain, recordingsDir, userDataDir } = ctx
  let activeDownload: {
    modelId: string
    controller: AbortController
    promise: Promise<void>
  } | null = null

  ipcMain.handle('caption-model-dir', () => {
    return { success: true, dir: captionModelsRoot(userDataDir) }
  })

  ipcMain.handle('caption-model-status', async (_, modelId?: string) => {
    const model = resolveModel(modelId)
    if (!model) return { success: false, message: `Unknown caption model: ${String(modelId)}` }
    try {
      return { success: true, status: await getCaptionModelStatus(userDataDir, model) }
    } catch (error) {
      return { success: false, message: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('caption-model-download', async (event: IpcMainInvokeEvent, modelId?: string) => {
    const model = resolveModel(modelId)
    if (!model) return { success: false, message: `Unknown caption model: ${String(modelId)}` }

    // A second window asking for the same model joins the in-flight download.
    if (activeDownload && activeDownload.modelId === model.id) {
      try {
        await activeDownload.promise
        return { success: true }
      } catch (error) {
        return isAbortError(error)
          ? { success: false, aborted: true, message: 'Download cancelled' }
          : { success: false, message: error instanceof Error ? error.message : String(error) }
      }
    }

    const controller = new AbortController()
    const sender = event.sender
    const promise = downloadCaptionModel({
      userDataDir,
      model,
      signal: controller.signal,
      fetcher: ctx.fetcher,
      backoff: ctx.backoff,
      onProgress: (progress) => {
        if (!sender.isDestroyed()) sender.send('caption-model-progress', progress)
      },
    })
    activeDownload = { modelId: model.id, controller, promise }
    try {
      await promise
      return { success: true }
    } catch (error) {
      if (isAbortError(error))
        return { success: false, aborted: true, message: 'Download cancelled' }
      console.error('Caption model download failed:', error)
      return { success: false, message: error instanceof Error ? error.message : String(error) }
    } finally {
      if (activeDownload?.controller === controller) activeDownload = null
    }
  })

  ipcMain.handle('caption-model-download-cancel', () => {
    if (!activeDownload) return { success: false }
    activeDownload.controller.abort()
    return { success: true }
  })

  ipcMain.handle('analysis-save-sidecar', async (_, inputPath: string, analysis: unknown) => {
    const videoPath = resolveSidecarVideoPath(inputPath, recordingsDir)
    if (!videoPath) {
      console.warn('Refused analysis sidecar write for path outside approved locations:', inputPath)
      return { success: false, message: 'Video path is not an approved readable file.' }
    }
    if (!isVideoAnalysisResultLike(analysis)) {
      return { success: false, message: 'Analysis payload is malformed.' }
    }
    try {
      const sidecarPath = await saveSidecar(videoPath, analysis)
      return { success: true, path: sidecarPath }
    } catch (error) {
      console.error('Failed to write analysis sidecar:', error)
      return { success: false, message: error instanceof Error ? error.message : String(error) }
    }
  })
}
