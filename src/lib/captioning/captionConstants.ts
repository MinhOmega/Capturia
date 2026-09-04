/**
 * Constants shared by the in-browser Whisper caption fallback (renderer, worker)
 * and the main-process model manager (`electron/ipc/captionHandlers.ts`).
 */

/** Max audio length for auto-captions (decode + transcribe); keep demuxer read aligned with this. */
export const MAX_CAPTION_AUDIO_SEC = 4 * 60 * 60

export interface CaptionModelChoice {
  /** Hugging Face repo of the weights, also the on-disk sub-path. */
  id: string
  /**
   * Git commit the download list and digests in `electron/ipc/captionHandlers.ts`
   * were captured against. Every file is fetched from this exact revision (never
   * from a branch name), so a later push to the Hub can neither change the
   * tokenizer under a verified ONNX graph nor break the SHA-256 checks. To move
   * to a newer revision, look up the new commit and recompute every digest for
   * that model (see docs/captions.md).
   */
  revision: string
  /** Total download size (config + tokenizer + the two quantized ONNX graphs). */
  approximateBytes: number
  /** Short label for the picker; the weights' own name, so not translated. */
  label: string
}

/**
 * The Whisper weights the in-browser engine can run. Bigger is more accurate
 * and slower; the size is shown in the picker because the user is committing to
 * a download that is not bundled with the app.
 */
export const CAPTION_MODEL_CHOICES: readonly CaptionModelChoice[] = [
  {
    id: 'Xenova/whisper-tiny',
    revision: '5332fcc35e32a33b86612b9a57a89be7906102b1',
    approximateBytes: 45_000_000,
    label: 'Tiny',
  },
  {
    id: 'Xenova/whisper-base',
    revision: '64da57285918e20ea79ea5c88eed7197933abaa8',
    approximateBytes: 81_268_136,
    label: 'Base',
  },
  {
    id: 'Xenova/whisper-small',
    revision: '2d67713f236afa48a18992566e7647f6ca848e13',
    approximateBytes: 253_465_551,
    label: 'Small',
  },
]

export const CAPTION_MODEL_IDS: readonly string[] = CAPTION_MODEL_CHOICES.map((choice) => choice.id)

/** What a profile with no stored preference runs; also the fallback for an unknown id. */
export const DEFAULT_CAPTION_MODEL_ID = CAPTION_MODEL_CHOICES[0].id

/** The descriptor for a model id, falling back to the default for anything unknown. */
export function captionModelChoice(modelId: string | null | undefined): CaptionModelChoice {
  return CAPTION_MODEL_CHOICES.find((choice) => choice.id === modelId) ?? CAPTION_MODEL_CHOICES[0]
}

/** Default model id. Kept as a named constant because several call sites read it. */
export const CAPTION_MODEL_ID = DEFAULT_CAPTION_MODEL_ID

/** Revision of the default model; per-model revisions live in `CAPTION_MODEL_CHOICES`. */
export const CAPTION_MODEL_REVISION = CAPTION_MODEL_CHOICES[0].revision

/** Download size of the default model; per-model sizes live in `CAPTION_MODEL_CHOICES`. */
export const CAPTION_MODEL_APPROX_BYTES = CAPTION_MODEL_CHOICES[0].approximateBytes

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
