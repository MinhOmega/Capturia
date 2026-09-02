/**
 * Web Worker running in-browser Whisper transcription off the renderer's main
 * thread so the editor UI never blocks during model load or transcription.
 *
 * Input:  `TranscribeWorkerRequest` (samples, trims, model + wasm locations, language)
 * Output: `TranscribeWorkerResponse` status / result / error messages.
 *
 * The caller terminates this worker to abort (model load and inference can't be
 * cooperatively cancelled), so there is no in-worker abort handling.
 */

import type { TranscribeWorkerRequest, TranscribeWorkerResponse } from './transcribe'
import { runTranscription, type TranscriberFn } from './transcribeCore'

function post(message: TranscribeWorkerResponse): void {
  ;(self as unknown as Worker).postMessage(message)
}

/**
 * ONNX Runtime's wasm bundle treats `process.versions.node` (which can leak into
 * an Electron worker) as Node and tries `require("fs")`, which Vite doesn't
 * support. Mask it only while Transformers/ORT run. No-op when `process` is
 * undefined (the usual case in a Web Worker).
 */
function withoutNodeVersion<T>(fn: () => Promise<T>): Promise<T> {
  const versions =
    typeof process !== 'undefined' && process.versions && typeof process.versions === 'object'
      ? process.versions
      : null
  const hadNode = versions !== null && 'node' in versions
  const savedNode = hadNode ? (versions as { node?: string }).node : undefined
  if (hadNode && versions) {
    try {
      Reflect.deleteProperty(versions, 'node')
    } catch {
      ;(versions as { node?: string }).node = undefined
    }
  }
  return fn().finally(() => {
    if (hadNode && versions && savedNode !== undefined) {
      ;(versions as { node: string }).node = savedNode
    }
  })
}

async function loadTranscriber(opts: {
  modelId: string
  modelDirUrl: string
  ortWasmBaseUrl: string
}): Promise<TranscriberFn> {
  return withoutNodeVersion(async () => {
    const { pipeline, env } = await import('@xenova/transformers')
    // The model is downloaded by the main process into userData (see
    // electron/ipc/captionHandlers.ts) and read back here over file://. Remote
    // fetches are disabled so a missing file fails fast instead of hitting the Hub.
    env.allowLocalModels = true
    env.allowRemoteModels = false
    env.localModelPath = opts.modelDirUrl
    // The files are already on disk next to the app data; the Cache API would
    // only duplicate ~45 MB per profile (and is unavailable on file:// origins).
    env.useBrowserCache = false
    env.useFSCache = false
    env.backends.onnx.wasm.wasmPaths = opts.ortWasmBaseUrl
    // Non-threaded wasm: SharedArrayBuffer isn't available under file:// (no cross-origin isolation).
    env.backends.onnx.wasm.numThreads = 1
    // Default quantized tiny weights only: the `output_attentions` revision regresses
    // inference in some environments (empty chunks, thrown errors) while phrase mode
    // works on this model.
    const transcriber = (await pipeline(
      'automatic-speech-recognition',
      opts.modelId,
    )) as unknown as TranscriberFn
    return transcriber
  })
}

self.onmessage = async (event: MessageEvent<TranscribeWorkerRequest>) => {
  const { samples, trimRegions, modelId, modelDirUrl, ortWasmBaseUrl, language } = event.data
  try {
    post({ type: 'status', phase: 'model' })
    const transcriber = await loadTranscriber({ modelId, modelDirUrl, ortWasmBaseUrl })

    post({ type: 'status', phase: 'transcribe' })
    const { segments, granularity } = await runTranscription(
      transcriber,
      samples,
      trimRegions ?? [],
      {
        language,
      },
    )

    post({ type: 'result', segments, granularity })
  } catch (e) {
    post({ type: 'error', message: e instanceof Error ? e.message : String(e) })
  }
}
