import { DEFAULT_EXPORT_DECODE_PATH, type ExportDecodePath } from './types'

/**
 * Shared pieces of the WebCodecs -> seek fallback rule used by the MP4 and GIF
 * exporters: the warning keys surfaced through `ExportResult.warnings` and the
 * decode-path resolution (requested path, support check, active fallback).
 *
 * The fallback error itself lives in `exportErrors.ts` and is only re-exported
 * here. Both exporters must throw and catch the same class: a second class of
 * the same name would make `instanceof` false across module boundaries, so a
 * GIF fallback would escape the shared classifier as an unknown failure.
 */

/**
 * Raised when the WebCodecs decode path fails before delivering a single frame.
 * Render/encode failures inside the frame callback must not be wrapped in it.
 */
export { DecoderFallbackError } from './exportErrors'

/** Warning key: the WebCodecs decoder failed before its first frame; the seek path was used. */
export const EXPORT_WARNING_DECODER_FALLBACK = 'editor.exportWarningDecoderFallback'
/** Warning key: the decoder stopped short of the required end; the export is slightly shorter. */
export const EXPORT_WARNING_DECODE_ENDED_EARLY = 'editor.exportWarningDecodeEndedEarly'

export interface ResolveDecodePathInput {
  /** Path the caller asked for (config or the localStorage override); undefined = default. */
  requested: ExportDecodePath | undefined
  /** True once the WebCodecs path already failed in this export; forces the seek path. */
  fallbackActive: boolean
  /** `typeof VideoDecoder !== 'undefined'` in the calling context. */
  hasVideoDecoder: boolean
}

/**
 * Decode path for one export attempt: the seek path whenever a fallback is
 * active or the runtime has no `VideoDecoder`, otherwise the requested path
 * (default `DEFAULT_EXPORT_DECODE_PATH`).
 */
export function resolveExportDecodePath(input: ResolveDecodePathInput): ExportDecodePath {
  if (input.fallbackActive) return 'seek'
  const requested = input.requested ?? DEFAULT_EXPORT_DECODE_PATH
  if (requested === 'webcodecs' && !input.hasVideoDecoder) return 'seek'
  return requested
}
