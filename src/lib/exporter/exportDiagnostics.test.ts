import { describe, expect, it } from 'vitest'
import {
  buildExportDiagnosticMessage,
  buildSaveDiagnosticMessage,
  getFileNameForDiagnostics,
} from './exportDiagnostics'

describe('getFileNameForDiagnostics', () => {
  it('returns "unknown" for empty input', () => {
    expect(getFileNameForDiagnostics(undefined)).toBe('unknown')
    expect(getFileNameForDiagnostics(null)).toBe('unknown')
    expect(getFileNameForDiagnostics('')).toBe('unknown')
  })

  it('extracts the base name from posix and windows paths', () => {
    expect(getFileNameForDiagnostics('/Users/me/recordings/clip.webm')).toBe('clip.webm')
    expect(getFileNameForDiagnostics('C:\\Users\\me\\clip.mp4')).toBe('clip.mp4')
  })

  it('decodes file:// URLs', () => {
    expect(getFileNameForDiagnostics('file:///tmp/my%20clip.webm')).toBe('my clip.webm')
  })

  it('treats non-file URLs as plain paths', () => {
    expect(getFileNameForDiagnostics('local-media://host/rec/clip.webm')).toBe('clip.webm')
  })
})

describe('buildExportDiagnosticMessage', () => {
  it('lists every provided field in order with English defaults', () => {
    const message = buildExportDiagnosticMessage({
      formatLabel: 'Video',
      reason: 'Encoder stalled',
      sourcePath: '/rec/clip.webm',
      width: 1920,
      height: 1080,
      frameRate: 60,
      codec: 'avc1.640033',
      bitrate: 12_500_000,
      videoEncoderAvailable: true,
    })

    expect(message.split('\n')).toEqual([
      'Video export failed',
      'Reason: Encoder stalled',
      'Source: clip.webm',
      'Output: 1920x1080 @ 60 fps',
      'Codec: avc1.640033',
      'Bitrate: 13 Mbps',
      'VideoEncoder: available',
    ])
  })

  it('omits missing optional fields but always reports source and encoder', () => {
    const message = buildExportDiagnosticMessage({
      formatLabel: 'GIF',
      videoEncoderAvailable: false,
    })

    expect(message.split('\n')).toEqual([
      'GIF export failed',
      'Source: unknown',
      'VideoEncoder: unavailable',
    ])
  })

  it('omits fps when the frame rate is unknown', () => {
    const message = buildExportDiagnosticMessage({
      formatLabel: 'GIF',
      width: 640,
      height: 360,
      videoEncoderAvailable: true,
    })
    expect(message).toContain('Output: 640x360\n')
  })

  it('detects VideoEncoder availability from the global when not overridden', () => {
    const hasEncoder = typeof VideoEncoder !== 'undefined'
    const message = buildExportDiagnosticMessage({ formatLabel: 'Video' })
    expect(message).toContain(`VideoEncoder: ${hasEncoder ? 'available' : 'unavailable'}`)
  })

  it('uses injected labels for localisation', () => {
    const message = buildExportDiagnosticMessage(
      {
        formatLabel: 'Video',
        reason: 'x',
        sourcePath: 'a.mp4',
        videoEncoderAvailable: true,
      },
      {
        exportFailed: '{{format}} 导出失败',
        reason: '原因',
        source: '来源',
        videoEncoder: '视频编码器',
        available: '可用',
      },
    )

    expect(message.split('\n')).toEqual([
      'Video 导出失败',
      '原因: x',
      '来源: a.mp4',
      '视频编码器: 可用',
    ])
  })
})

describe('buildSaveDiagnosticMessage', () => {
  it('includes the reason on a second line when given', () => {
    expect(buildSaveDiagnosticMessage('GIF', 'EACCES')).toBe(
      'GIF export save failed\nReason: EACCES',
    )
  })

  it('is a single line without a reason', () => {
    expect(buildSaveDiagnosticMessage('Video')).toBe('Video export save failed')
  })

  it('honours injected labels', () => {
    expect(
      buildSaveDiagnosticMessage('Video', 'disk full', {
        saveFailed: 'Could not save {{format}}',
        reason: 'Why',
      }),
    ).toBe('Could not save Video\nWhy: disk full')
  })
})
