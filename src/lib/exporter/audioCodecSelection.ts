/**
 * Export audio codec selection for the MP4 muxer.
 *
 * AAC is the conventional MP4 audio codec but its WebCodecs encoder is missing
 * on some builds (notably Chromium on Linux without proprietary codecs). Opus
 * in MP4 (`dOps` sample entry) is supported by mediabunny and by every major
 * player, so it is used as a fallback before giving up on audio entirely.
 */

export type ExportAudioCodec = 'aac' | 'opus'

/** Preference order: AAC first for compatibility, Opus as fallback. */
export const EXPORT_AUDIO_CODECS: readonly ExportAudioCodec[] = ['aac', 'opus']

/** WebCodecs codec strings for the `AudioEncoder.isConfigSupported` probe. */
export const EXPORT_AUDIO_CODEC_STRINGS: Record<ExportAudioCodec, string> = {
  aac: 'mp4a.40.2',
  opus: 'opus',
}

export const EXPORT_AUDIO_BITRATE = 128_000

export type AudioCodecSupportProbe = (codec: ExportAudioCodec) => Promise<boolean>

/** Probes the real `AudioEncoder` for the given codec; false when WebCodecs is unavailable. */
export async function isAudioCodecEncodingSupported(codec: ExportAudioCodec): Promise<boolean> {
  if (typeof AudioEncoder === 'undefined') return false
  try {
    const result = await AudioEncoder.isConfigSupported({
      codec: EXPORT_AUDIO_CODEC_STRINGS[codec],
      sampleRate: 48000,
      numberOfChannels: 1,
      bitrate: EXPORT_AUDIO_BITRATE,
    })
    return result.supported === true
  } catch {
    return false
  }
}

/**
 * Returns the first codec in {@link EXPORT_AUDIO_CODECS} the encoder supports,
 * or null when none does (caller drops audio and warns). The probe is
 * injectable so the selection order can be unit-tested without WebCodecs.
 */
export async function selectExportAudioCodec(
  probe: AudioCodecSupportProbe = isAudioCodecEncodingSupported,
): Promise<ExportAudioCodec | null> {
  for (const codec of EXPORT_AUDIO_CODECS) {
    if (await probe(codec)) return codec
  }
  return null
}
