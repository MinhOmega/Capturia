import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_EXPORT_VIDEO_CODEC,
  EXPORT_VIDEO_CODEC_STRINGS,
  getExportVideoCodecFromString,
  getSupportedExportVideoCodecs,
  isExportVideoCodec,
  probeExportVideoCodec,
  resolveExportVideoCodec,
  type VideoEncoderProbe,
} from './videoCodecSupport'

const TARGET = { width: 1920, height: 1080, bitrate: 12_000_000, frameRate: 30 }

function probeThatSays(supported: boolean): VideoEncoderProbe {
  return { isConfigSupported: vi.fn(async () => ({ supported })) }
}

describe('isExportVideoCodec', () => {
  it.each([['h264'], ['hevc']])('accepts %s', (value) => {
    expect(isExportVideoCodec(value)).toBe(true)
  })

  it.each([['av1'], [''], [null], [undefined], [42]])('rejects %j', (value) => {
    expect(isExportVideoCodec(value)).toBe(false)
  })
})

describe('getExportVideoCodecFromString', () => {
  it.each([
    ['avc1.640033', 'h264'],
    ['hvc1.1.6.L123.B0', 'hevc'],
    ['hev1.1.6.L93.B0', 'hevc'],
    ['HVC1.1.6.L123.B0', 'hevc'],
  ])('maps %s to %s', (codec, expected) => {
    expect(getExportVideoCodecFromString(codec)).toBe(expected)
  })

  it('falls back to H.264 for an unknown or missing string', () => {
    expect(getExportVideoCodecFromString(undefined)).toBe('h264')
    expect(getExportVideoCodecFromString('vp09.00.10.08')).toBe('h264')
  })
})

describe('probeExportVideoCodec', () => {
  it('asks the encoder about the exact configuration the export will use', async () => {
    const encoder = probeThatSays(true)
    await probeExportVideoCodec('hevc', TARGET, encoder)
    expect(encoder.isConfigSupported).toHaveBeenCalledWith({
      codec: EXPORT_VIDEO_CODEC_STRINGS.hevc,
      width: 1920,
      height: 1080,
      bitrate: 12_000_000,
      framerate: 30,
    })
  })

  it('is true only when the encoder says supported', async () => {
    await expect(probeExportVideoCodec('hevc', TARGET, probeThatSays(true))).resolves.toBe(true)
    await expect(probeExportVideoCodec('hevc', TARGET, probeThatSays(false))).resolves.toBe(false)
  })

  it('reads a missing `supported` field as no', async () => {
    const encoder = { isConfigSupported: async () => ({}) }
    await expect(probeExportVideoCodec('hevc', TARGET, encoder)).resolves.toBe(false)
  })

  it('reads a throwing probe as no', async () => {
    // Some builds throw TypeError on an unrecognised codec string rather than
    // answering; that is still "cannot encode this".
    const encoder = {
      isConfigSupported: async () => {
        throw new TypeError('unsupported codec')
      },
    }
    await expect(probeExportVideoCodec('hevc', TARGET, encoder)).resolves.toBe(false)
  })

  it('is false when the platform has no VideoEncoder at all', async () => {
    await expect(probeExportVideoCodec('hevc', TARGET, null)).resolves.toBe(false)
  })
})

describe('getSupportedExportVideoCodecs', () => {
  it('offers HEVC only when its probe passes', async () => {
    await expect(getSupportedExportVideoCodecs(TARGET, probeThatSays(true))).resolves.toEqual([
      'h264',
      'hevc',
    ])
  })

  it('always keeps H.264, even when nothing probes as supported', async () => {
    // Without it the menu would be empty and the export impossible; the
    // encoder's own error is a better message than no choice at all.
    await expect(getSupportedExportVideoCodecs(TARGET, probeThatSays(false))).resolves.toEqual([
      'h264',
    ])
    await expect(getSupportedExportVideoCodecs(TARGET, null)).resolves.toEqual(['h264'])
  })
})

describe('resolveExportVideoCodec', () => {
  it('keeps a request that is supported', () => {
    expect(resolveExportVideoCodec('hevc', ['h264', 'hevc'])).toBe('hevc')
  })

  it('drops a request that is not, so a stale preference cannot break an export', () => {
    expect(resolveExportVideoCodec('hevc', ['h264'])).toBe('h264')
  })

  it('falls back to the default when nothing was requested', () => {
    expect(resolveExportVideoCodec(undefined, ['h264', 'hevc'])).toBe(DEFAULT_EXPORT_VIDEO_CODEC)
  })
})
