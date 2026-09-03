/**
 * Export failure classification.
 *
 * `ExportResult.error` keeps the raw (English) message for diagnostics and
 * logs; `ExportResult.errorKind` says what went wrong in terms the UI can
 * translate (`dialogs.exportError.*`). The exporter tags its own failures
 * with typed errors; anything else is classified by message so callers that
 * only carry the string (the export dialog today) still get a localised line.
 */

import { isBackgroundLoadError } from './backgroundErrors'

export type ExportErrorKind =
  /** The encoder's queue stayed full past the stall budget. */
  | 'encoder-stall'
  /** The final `VideoEncoder.flush()` did not finish within its budget. */
  | 'encoder-flush-timeout'
  /** `VideoEncoder.isConfigSupported` rejected the export configuration. */
  | 'encoder-unsupported'
  /** The encoder's `error` callback fired or a flush failed for another reason. */
  | 'encoder-failed'
  /** The source could not be decoded (seek path load failure or a mid-stream decoder error). */
  | 'decoder-failed'
  /** A background image failed to load; the editor names the file itself. */
  | 'background-load'
  | 'unknown'

/** Kinds the encoder retry loop may raise; every one is retried with the next encoder preference. */
export type ExportEncoderErrorKind = Extract<
  ExportErrorKind,
  'encoder-stall' | 'encoder-flush-timeout' | 'encoder-unsupported' | 'encoder-failed'
>

/**
 * Raw messages the exporter emits. Kept in one table so the message-based
 * classifier and the throw sites can never drift apart.
 */
export const EXPORT_ERROR_MESSAGES = {
  encoderStallHardware:
    'The hardware video encoder stopped responding. Retrying with a safer encoder.',
  encoderStallSoftware: 'The video encoder stopped responding during export.',
  encoderFlushTimeoutHardware:
    'The hardware video encoder stopped responding while finalizing the export.',
  encoderFlushTimeoutSoftware: 'The video encoder stopped responding while finalizing the export.',
  encoderUnsupportedHardware: 'Hardware video encoding is not supported on this system.',
  encoderUnsupportedSoftware: 'Software video encoding is not supported on this system.',
} as const

/** Prefixes of raw messages that carry a variable reason after the colon. */
export const EXPORT_ERROR_MESSAGE_PREFIXES = {
  encoderFailed: 'Video encoder error: ',
  encoderFlushFailed: 'Video encoder flush failed: ',
  decoderFailed: 'Video decoding failed: ',
  decoderUnavailable: 'WebCodecs decode path unavailable: ',
} as const

/**
 * Marks a failure caused by the video encoder itself (unsupported config,
 * `error` callback, queue stall, flush timeout). Only these are retried with
 * the next encoder preference; decoder, renderer, mux and audio failures are
 * reported straight away because a different encoder would not fix them.
 */
export class ExportEncoderError extends Error {
  readonly kind: ExportEncoderErrorKind

  constructor(
    message: string,
    readonly cause?: unknown,
    kind: ExportEncoderErrorKind = 'encoder-failed',
  ) {
    super(message)
    this.name = 'ExportEncoderError'
    this.kind = kind
  }
}

/**
 * Raised when the WebCodecs decode path fails before delivering a single frame
 * (demux/wasm load failure, unsupported codec, VideoDecoder error). The export
 * restarts on the seek path and reports `editor.exportWarningDecoderFallback`.
 */
export class DecoderFallbackError extends Error {
  readonly cause: unknown

  constructor(cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    super(`${EXPORT_ERROR_MESSAGE_PREFIXES.decoderUnavailable}${reason}`)
    this.name = 'DecoderFallbackError'
    this.cause = cause
  }
}

/**
 * A decoder failure that ends the export: the seek path could not load the
 * source, or the WebCodecs decoder failed after it had already delivered
 * frames (too late to fall back without re-rendering).
 */
export class ExportDecoderError extends Error {
  readonly cause: unknown

  constructor(cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    super(`${EXPORT_ERROR_MESSAGE_PREFIXES.decoderFailed}${reason}`)
    this.name = 'ExportDecoderError'
    this.cause = cause
  }
}

/** Classifies one candidate string that is expected to *be* an exporter message. */
function classifyMessageCandidate(candidate: string): ExportErrorKind {
  const m = EXPORT_ERROR_MESSAGES
  switch (candidate) {
    case m.encoderStallHardware:
    case m.encoderStallSoftware:
      return 'encoder-stall'
    case m.encoderFlushTimeoutHardware:
    case m.encoderFlushTimeoutSoftware:
      return 'encoder-flush-timeout'
    case m.encoderUnsupportedHardware:
    case m.encoderUnsupportedSoftware:
      return 'encoder-unsupported'
    default:
      break
  }
  const p = EXPORT_ERROR_MESSAGE_PREFIXES
  if (candidate.startsWith(p.encoderFailed) || candidate.startsWith(p.encoderFlushFailed)) {
    return 'encoder-failed'
  }
  if (candidate.startsWith(p.decoderFailed) || candidate.startsWith(p.decoderUnavailable)) {
    return 'decoder-failed'
  }
  return 'unknown'
}

/**
 * Classifies a raw exporter message; `'unknown'` for anything the exporter did
 * not word itself.
 *
 * The editor does not hand the dialog the bare message: it wraps the failure in
 * the multi-line diagnostic block from `exportDiagnostics.ts`, where the message
 * is the value of a translated `Reason:` line. So each line is tried whole and
 * again after its first `': '` label separator, which strips that label whatever
 * language it is in. The label is only stripped once, so an arbitrary sentence
 * that merely happens to contain an exporter message stays `'unknown'`.
 */
export function classifyExportErrorMessage(message: string | null | undefined): ExportErrorKind {
  if (!message) return 'unknown'
  for (const line of message.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const direct = classifyMessageCandidate(trimmed)
    if (direct !== 'unknown') return direct
    const separator = trimmed.indexOf(': ')
    if (separator <= 0) continue
    const afterLabel = classifyMessageCandidate(trimmed.slice(separator + 2))
    if (afterLabel !== 'unknown') return afterLabel
  }
  return 'unknown'
}

/** Classifies whatever the export pipeline threw, preferring typed errors over their message. */
export function classifyExportError(error: unknown): ExportErrorKind {
  if (isBackgroundLoadError(error)) return 'background-load'
  if (error instanceof ExportEncoderError) return error.kind
  if (error instanceof ExportDecoderError || error instanceof DecoderFallbackError) {
    return 'decoder-failed'
  }
  if (error instanceof Error) return classifyExportErrorMessage(error.message)
  if (typeof error === 'string') return classifyExportErrorMessage(error)
  return 'unknown'
}

const EXPORT_ERROR_MESSAGE_KEYS: Record<ExportErrorKind, string | null> = {
  'encoder-stall': 'dialogs.exportError.encoderStall',
  'encoder-flush-timeout': 'dialogs.exportError.encoderFlushTimeout',
  'encoder-unsupported': 'dialogs.exportError.encoderUnsupported',
  'encoder-failed': 'dialogs.exportError.encoderFailed',
  'decoder-failed': 'dialogs.exportError.decoderFailed',
  // The editor builds its own message naming the background file.
  'background-load': null,
  unknown: null,
}

/** i18n key for the user-facing line of `kind`, or `null` when the raw message should be shown. */
export function getExportErrorMessageKey(kind: ExportErrorKind): string | null {
  return EXPORT_ERROR_MESSAGE_KEYS[kind]
}
