import { DEFAULT_EXPORT_DECODE_PATH, type ExportDecodePath } from './types'

/**
 * Shared pieces of the WebCodecs -> seek fallback rule used by the MP4 and GIF
 * exporters: the error that requests a retry on the seek path, the warning
 * keys surfaced through `ExportResult.warnings`, and the decode-path
 * resolution (requested path, support check, active fallback).
 */

/** Warning key: the WebCodecs decoder failed before its first frame; the seek path was used. */
export const EXPORT_WARNING_DECODER_FALLBACK = 'editor.exportWarningDecoderFallback'
/** Warning key: the decoder stopped short of the required end; the export is slightly shorter. */
export const EXPORT_WARNING_DECODE_ENDED_EARLY = 'editor.exportWarningDecodeEndedEarly'

/**
 * Raised when the WebCodecs decode path fails before delivering a single frame
 * (demux/wasm load failure, unsupported codec, VideoDecoder error). The export
 * restarts on the seek path and reports `EXPORT_WARNING_DECODER_FALLBACK`.
 * Render/encode failures inside the frame callback must not be wrapped in it.
 */
export class DecoderFallbackError extends Error {
  readonly cause: unknown

  constructor(cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    super(`WebCodecs decode path unavailable: ${reason}`)
    this.name = 'DecoderFallbackError'
    this.cause = cause
  }
}

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
