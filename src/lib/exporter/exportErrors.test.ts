import { describe, expect, it } from 'vitest'
import { BackgroundLoadError } from './backgroundErrors'
import { buildExportDiagnosticMessage } from './exportDiagnostics'
import {
  DecoderFallbackError,
  EXPORT_ERROR_MESSAGE_PREFIXES,
  EXPORT_ERROR_MESSAGES,
  ExportDecoderError,
  ExportEncoderError,
  type ExportErrorKind,
  classifyExportError,
  classifyExportErrorMessage,
  getExportErrorMessageKey,
} from './exportErrors'

describe('classifyExportErrorMessage', () => {
  it('maps every exporter-worded message to its kind', () => {
    const m = EXPORT_ERROR_MESSAGES
    expect(classifyExportErrorMessage(m.encoderStallHardware)).toBe('encoder-stall')
    expect(classifyExportErrorMessage(m.encoderStallSoftware)).toBe('encoder-stall')
    expect(classifyExportErrorMessage(m.encoderFlushTimeoutHardware)).toBe('encoder-flush-timeout')
    expect(classifyExportErrorMessage(m.encoderFlushTimeoutSoftware)).toBe('encoder-flush-timeout')
    expect(classifyExportErrorMessage(m.encoderUnsupportedHardware)).toBe('encoder-unsupported')
    expect(classifyExportErrorMessage(m.encoderUnsupportedSoftware)).toBe('encoder-unsupported')
  })

  it('recognises prefixed messages that carry a variable reason', () => {
    const p = EXPORT_ERROR_MESSAGE_PREFIXES
    expect(classifyExportErrorMessage(`${p.encoderFailed}OperationError: boom`)).toBe(
      'encoder-failed',
    )
    expect(classifyExportErrorMessage(`${p.encoderFlushFailed}closed`)).toBe('encoder-failed')
    expect(classifyExportErrorMessage(`${p.decoderFailed}Failed to load video`)).toBe(
      'decoder-failed',
    )
    expect(classifyExportErrorMessage(`${p.decoderUnavailable}Unsupported codec: vp9`)).toBe(
      'decoder-failed',
    )
  })

  it('returns unknown for foreign, empty or partial messages', () => {
    expect(classifyExportErrorMessage('Export cancelled')).toBe('unknown')
    expect(classifyExportErrorMessage('')).toBe('unknown')
    expect(classifyExportErrorMessage(null)).toBe('unknown')
    expect(classifyExportErrorMessage(undefined)).toBe('unknown')
    // A sentence that merely contains a prefix is not an exporter message: only
    // one leading label is stripped, and 'x Video encoder error' is not a label.
    expect(classifyExportErrorMessage('x Video encoder error: y')).toBe('unknown')
    expect(classifyExportErrorMessage('Reason: x Video encoder error: y')).toBe('unknown')
  })

  it('reads the message out of the diagnostic block the editor builds', () => {
    // What the export dialog actually receives: the reason wrapped in
    // buildExportDiagnosticMessage, not the bare message.
    const block = buildExportDiagnosticMessage({
      formatLabel: 'Video',
      reason: EXPORT_ERROR_MESSAGES.encoderStallSoftware,
      sourcePath: '/tmp/recording.mp4',
      width: 1920,
      height: 1080,
      frameRate: 60,
      codec: 'avc1.640033',
      bitrate: 12_000_000,
      videoEncoderAvailable: true,
    })
    expect(block).toContain('\n')
    expect(classifyExportErrorMessage(block)).toBe('encoder-stall')

    const prefixed = buildExportDiagnosticMessage({
      formatLabel: 'Video',
      reason: `${EXPORT_ERROR_MESSAGE_PREFIXES.decoderFailed}Failed to load video`,
      sourcePath: '/tmp/recording.mp4',
      videoEncoderAvailable: false,
    })
    expect(classifyExportErrorMessage(prefixed)).toBe('decoder-failed')
  })

  it('strips a translated reason label whatever language it is in', () => {
    for (const label of ['Reason', 'Lý do', '原因']) {
      expect(
        classifyExportErrorMessage(
          `Video export failed\n${label}: ${EXPORT_ERROR_MESSAGES.encoderUnsupportedHardware}\nSource: a.mp4`,
        ),
      ).toBe('encoder-unsupported')
    }
  })

  it('ignores diagnostic lines that carry no exporter message', () => {
    expect(
      classifyExportErrorMessage(
        'Video export failed\nSource: recording.mp4\nCodec: avc1.640033\nVideoEncoder: available',
      ),
    ).toBe('unknown')
  })
})

describe('classifyExportError', () => {
  it('prefers the kind carried by typed errors', () => {
    expect(
      classifyExportError(new ExportEncoderError('anything', undefined, 'encoder-stall')),
    ).toBe('encoder-stall')
    expect(
      classifyExportError(new ExportEncoderError('x', undefined, 'encoder-flush-timeout')),
    ).toBe('encoder-flush-timeout')
    expect(classifyExportError(new ExportEncoderError('x', undefined, 'encoder-unsupported'))).toBe(
      'encoder-unsupported',
    )
    expect(classifyExportError(new ExportEncoderError('x'))).toBe('encoder-failed')
    expect(classifyExportError(new ExportDecoderError(new Error('nope')))).toBe('decoder-failed')
    expect(classifyExportError(new DecoderFallbackError('wasm missing'))).toBe('decoder-failed')
    expect(classifyExportError(new BackgroundLoadError('file:///tmp/bg.png'))).toBe(
      'background-load',
    )
  })

  it('falls back to the message for plain errors and strings', () => {
    expect(classifyExportError(new Error(EXPORT_ERROR_MESSAGES.encoderStallSoftware))).toBe(
      'encoder-stall',
    )
    expect(classifyExportError(EXPORT_ERROR_MESSAGES.encoderUnsupportedHardware)).toBe(
      'encoder-unsupported',
    )
    expect(classifyExportError(new Error('Video element not available'))).toBe('unknown')
    expect(classifyExportError(undefined)).toBe('unknown')
    expect(classifyExportError({ message: 'not an Error' })).toBe('unknown')
  })

  it('keeps the raw message on the typed errors', () => {
    const decoder = new ExportDecoderError(new Error('Failed to load video'))
    expect(decoder.message).toBe('Video decoding failed: Failed to load video')
    expect(decoder.name).toBe('ExportDecoderError')
    const fallback = new DecoderFallbackError(new Error('Unsupported codec: vp9'))
    expect(fallback.message).toBe('WebCodecs decode path unavailable: Unsupported codec: vp9')
    expect(fallback.name).toBe('DecoderFallbackError')
    const encoder = new ExportEncoderError('msg', 'cause', 'encoder-stall')
    expect(encoder.cause).toBe('cause')
    expect(encoder.name).toBe('ExportEncoderError')
  })
})

describe('getExportErrorMessageKey', () => {
  it('has a dialogs.exportError key for every encoder/decoder kind and none for the rest', () => {
    const localised: ExportErrorKind[] = [
      'encoder-stall',
      'encoder-flush-timeout',
      'encoder-unsupported',
      'encoder-failed',
      'decoder-failed',
    ]
    for (const kind of localised) {
      expect(getExportErrorMessageKey(kind)).toMatch(/^dialogs\.exportError\./)
    }
    expect(getExportErrorMessageKey('background-load')).toBeNull()
    expect(getExportErrorMessageKey('unknown')).toBeNull()
  })
})
