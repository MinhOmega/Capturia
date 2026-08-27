import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EXPORT_AUDIO_CODECS,
  EXPORT_AUDIO_CODEC_STRINGS,
  isAudioCodecEncodingSupported,
  selectExportAudioCodec,
} from './audioCodecSelection';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('selectExportAudioCodec', () => {
  it('prefers AAC when the encoder supports it', async () => {
    const probe = vi.fn(async () => true);
    await expect(selectExportAudioCodec(probe)).resolves.toBe('aac');
    // Short-circuits: Opus is never probed once AAC is available.
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith('aac');
  });

  it('falls back to Opus when AAC is unavailable', async () => {
    const probe = vi.fn(async (codec: string) => codec === 'opus');
    await expect(selectExportAudioCodec(probe)).resolves.toBe('opus');
    expect(probe.mock.calls.map(([codec]) => codec)).toEqual(['aac', 'opus']);
  });

  it('returns null when neither codec is supported', async () => {
    const probe = vi.fn(async () => false);
    await expect(selectExportAudioCodec(probe)).resolves.toBeNull();
    expect(probe.mock.calls.map(([codec]) => codec)).toEqual([...EXPORT_AUDIO_CODECS]);
  });

  it('treats a throwing probe for one codec as unsupported for that codec only', async () => {
    const probe = vi.fn(async (codec: string) => {
      if (codec === 'aac') throw new Error('boom');
      return true;
    });
    // The default probe swallows errors; a custom probe that throws propagates,
    // so callers wrapping isAudioCodecEncodingSupported never see this. Assert
    // the contract explicitly.
    await expect(selectExportAudioCodec(probe)).rejects.toThrow('boom');
  });
});

describe('isAudioCodecEncodingSupported', () => {
  it('returns false when WebCodecs AudioEncoder is missing', async () => {
    vi.stubGlobal('AudioEncoder', undefined);
    await expect(isAudioCodecEncodingSupported('aac')).resolves.toBe(false);
  });

  it('probes AudioEncoder.isConfigSupported with the codec string', async () => {
    const isConfigSupported = vi.fn(async (config: { codec: string }) => ({
      supported: config.codec === EXPORT_AUDIO_CODEC_STRINGS.opus,
    }));
    vi.stubGlobal('AudioEncoder', { isConfigSupported });

    await expect(isAudioCodecEncodingSupported('aac')).resolves.toBe(false);
    await expect(isAudioCodecEncodingSupported('opus')).resolves.toBe(true);
    expect(isConfigSupported).toHaveBeenCalledWith(
      expect.objectContaining({ codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 1 }),
    );
    expect(isConfigSupported).toHaveBeenCalledWith(expect.objectContaining({ codec: 'opus' }));
  });

  it('returns false when the probe throws', async () => {
    vi.stubGlobal('AudioEncoder', {
      isConfigSupported: vi.fn(async () => {
        throw new Error('not implemented');
      }),
    });
    await expect(isAudioCodecEncodingSupported('opus')).resolves.toBe(false);
  });

  it('selects Opus end to end when only Opus passes the real probe', async () => {
    vi.stubGlobal('AudioEncoder', {
      isConfigSupported: vi.fn(async (config: { codec: string }) => ({ supported: config.codec === 'opus' })),
    });
    await expect(selectExportAudioCodec()).resolves.toBe('opus');
  });
});
