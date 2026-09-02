import type { TrimRegion } from '@/components/video-editor/types'
import { CAPTION_MODEL_ID } from './captionConstants'

/**
 * Renderer entry point for in-browser Whisper transcription (upstream OpenScreen
 * v1.7.0 `transcribe.ts`, adapted). The heavy lifting runs in
 * `transcribe.worker.ts`; this module only owns the worker lifecycle and the
 * message contract.
 */

export interface CaptionSegment {
  startSec: number
  endSec: number
  text: string
}

/** How caption consumers should interpret `CaptionSegment` times. */
export type CaptionTimestampGranularity = 'word' | 'phrase'

export interface TranscribeMono16kResult {
  segments: CaptionSegment[]
  granularity: CaptionTimestampGranularity
}

/** Request payload posted from the renderer to the transcription worker. */
export interface TranscribeWorkerRequest {
  samples: Float32Array
  trimRegions: TrimRegion[]
  /** Hugging Face model id, resolved below `modelDirUrl` (e.g. `Xenova/whisper-tiny`). */
  modelId: string
  /**
   * `file://` URL (trailing slash) of the directory that contains `<modelId>/...`.
   * The worker cannot reach `window.electronAPI`, so the renderer resolves this.
   */
  modelDirUrl: string
  /** Base URL (trailing slash) of the bundled ONNX Runtime wasm files. */
  ortWasmBaseUrl: string
  /** Whisper language code (`en`, `zh`, ...). `undefined` = auto-detect. */
  language?: string
}

/** Messages the transcription worker posts back to the renderer. */
export type TranscribeWorkerResponse =
  | { type: 'status'; phase: 'model' | 'transcribe' }
  | { type: 'result'; segments: CaptionSegment[]; granularity: CaptionTimestampGranularity }
  | { type: 'error'; message: string }

export interface TranscribeMono16kOptions {
  trimRegions?: TrimRegion[]
  language?: string
  modelId?: string
  /** Required: where the model files live (see `captionModel.ts`). */
  modelDirUrl: string
  /** Required: where the ORT wasm files live (see `captionModel.ts`). */
  ortWasmBaseUrl: string
  onStatus?: (phase: 'model' | 'transcribe') => void
  signal?: AbortSignal
}

/**
 * Transcribes mono 16 kHz audio into timed caption segments using in-browser Whisper.
 *
 * Runs in a Web Worker so the editor's main thread stays responsive (WASM inference
 * doesn't yield). Aborting via `options.signal` terminates the worker, since load
 * and inference can't be cooperatively cancelled.
 */
export function transcribeMono16kToSegments(
  samples: Float32Array,
  options: TranscribeMono16kOptions,
): Promise<TranscribeMono16kResult> {
  if (options.signal?.aborted) {
    return Promise.reject(new DOMException('Aborted', 'AbortError'))
  }

  return new Promise<TranscribeMono16kResult>((resolve, reject) => {
    const worker = new Worker(new URL('./transcribe.worker.ts', import.meta.url), {
      type: 'module',
    })

    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      options.signal?.removeEventListener('abort', onAbort)
      worker.terminate()
      fn()
    }

    const onAbort = () => finish(() => reject(new DOMException('Aborted', 'AbortError')))
    options.signal?.addEventListener('abort', onAbort, { once: true })

    worker.onmessage = (e: MessageEvent<TranscribeWorkerResponse>) => {
      const msg = e.data
      if (msg.type === 'status') {
        options.onStatus?.(msg.phase)
        return
      }
      if (msg.type === 'result') {
        finish(() => resolve({ segments: msg.segments, granularity: msg.granularity }))
        return
      }
      finish(() => reject(new Error(msg.message)))
    }

    worker.onerror = (e) => {
      finish(() => reject(new Error(e.message || 'Caption transcription worker failed')))
    }

    // Structured-clone copy, not a transfer: the caller may reuse `samples` after
    // this call (e.g. a retry), so the buffer must stay valid here.
    const request: TranscribeWorkerRequest = {
      samples,
      trimRegions: options.trimRegions ?? [],
      modelId: options.modelId ?? CAPTION_MODEL_ID,
      modelDirUrl: options.modelDirUrl,
      ortWasmBaseUrl: options.ortWasmBaseUrl,
      language: options.language,
    }
    worker.postMessage(request)
  })
}
