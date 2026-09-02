/**
 * Constants shared by the in-browser Whisper caption fallback (renderer, worker)
 * and the main-process model manager (`electron/ipc/captionHandlers.ts`).
 */

/** Max audio length for auto-captions (decode + transcribe); keep demuxer read aligned with this. */
export const MAX_CAPTION_AUDIO_SEC = 4 * 60 * 60

/**
 * Hugging Face repo of the model loaded by the worker. Kept as one constant so a
 * larger model (`Xenova/whisper-base` ~150 MB, `Xenova/whisper-small` ~500 MB)
 * can be offered later without touching the pipeline.
 */
export const CAPTION_MODEL_ID = 'Xenova/whisper-tiny'

/** Approximate download size of the quantized tiny model (config + tokenizer + 2 ONNX graphs). */
export const CAPTION_MODEL_APPROX_BYTES = 45_000_000

/** Prefix of the `additionalArguments` entry that carries the model root as a `file://` URL. */
export const CAPTION_MODEL_DIR_ARG_PREFIX = '--caption-model-dir='

/** Prefix of the `additionalArguments` entry that carries the resources dir as a `file://` URL. */
export const ASSET_BASE_URL_ARG_PREFIX = '--asset-base-url='

/** Relative path (from the renderer page) of the ONNX Runtime wasm files bundled by Vite. */
export const ORT_WASM_PUBLIC_DIR = 'ort/'

/**
 * Whisper language code for a Capturia UI locale. `undefined` lets Whisper
 * auto-detect, which is what we want for locales the app does not map yet.
 */
export function whisperLanguageForLocale(locale: string | null | undefined): string | undefined {
  const normalized = String(locale ?? '')
    .trim()
    .toLowerCase()
  if (!normalized) return undefined
  const base = normalized.split(/[-_]/)[0]
  switch (base) {
    case 'en':
      return 'en'
    case 'zh':
      return 'zh'
    case 'vi':
      return 'vi'
    case 'ja':
      return 'ja'
    case 'ko':
      return 'ko'
    case 'fr':
      return 'fr'
    case 'de':
      return 'de'
    case 'es':
      return 'es'
    case 'pt':
      return 'pt'
    case 'ru':
      return 'ru'
    default:
      return undefined
  }
}
