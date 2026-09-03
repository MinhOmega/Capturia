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

/**
 * Git commit of `CAPTION_MODEL_ID` the download list and digests in
 * `electron/ipc/captionHandlers.ts` were captured against. Every file is fetched
 * from this exact revision (never from a branch name), so a later push to the
 * Hub can neither change the tokenizer under a verified ONNX graph nor break the
 * SHA-256 checks. To move to a newer revision, look up the new commit and
 * recompute every digest in `WHISPER_TINY_MODEL` (see docs/captions.md).
 */
export const CAPTION_MODEL_REVISION = '5332fcc35e32a33b86612b9a57a89be7906102b1'

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
