/**
 * Which video codecs this build can actually encode.
 *
 * H.264 is the floor: every player understands it and Capturia has always
 * produced it. HEVC is offered only when `VideoEncoder.isConfigSupported` says
 * yes for the exact size and bitrate the export will use, because support
 * varies by platform, by GPU driver and by whether the Chromium build shipped
 * the proprietary codecs at all — and an unsupported codec that is discovered
 * at `configure()` time costs the user a failed export instead of a menu entry
 * that was never shown.
 *
 * Even a successful probe is not a promise: `VideoExporter` falls back to H.264
 * if HEVC fails once encoding starts.
 */

export type ExportVideoCodec = 'h264' | 'hevc'

export const DEFAULT_EXPORT_VIDEO_CODEC: ExportVideoCodec = 'h264'

/**
 * WebCodecs codec strings.
 * - `avc1.640033` — H.264 High profile, level 5.1: the long-standing default.
 * - `hvc1.1.6.L123.B0` — HEVC Main profile, level 4.1, in the `hvc1` flavour
 *   the MP4 muxer writes (`hev1` is the fragmented-stream spelling).
 */
export const EXPORT_VIDEO_CODEC_STRINGS: Record<ExportVideoCodec, string> = {
  h264: 'avc1.640033',
  hevc: 'hvc1.1.6.L123.B0',
}

export function isExportVideoCodec(value: unknown): value is ExportVideoCodec {
  return value === 'h264' || value === 'hevc'
}

/** Maps a WebCodecs codec string back to the menu entry it belongs to. */
export function getExportVideoCodecFromString(codec: string | undefined): ExportVideoCodec {
  if (!codec) return DEFAULT_EXPORT_VIDEO_CODEC
  const lower = codec.toLowerCase()
  if (lower.startsWith('hvc1') || lower.startsWith('hev1')) return 'hevc'
  return 'h264'
}

export interface CodecProbeTarget {
  width: number
  height: number
  bitrate: number
  frameRate: number
}

/** The slice of `VideoEncoder` the probe needs; injectable so tests need no browser. */
export interface VideoEncoderProbe {
  isConfigSupported(config: VideoEncoderConfig): Promise<{ supported?: boolean }>
}

function defaultProbe(): VideoEncoderProbe | null {
  if (typeof VideoEncoder === 'undefined') return null
  return VideoEncoder as unknown as VideoEncoderProbe
}

/**
 * `true` when this browser reports it can encode `codec` at `target`.
 *
 * Never throws: a probe that rejects (some builds throw `TypeError` on an
 * unrecognised codec string instead of answering) means "not supported".
 */
export async function probeExportVideoCodec(
  codec: ExportVideoCodec,
  target: CodecProbeTarget,
  encoder: VideoEncoderProbe | null = defaultProbe(),
): Promise<boolean> {
  if (!encoder) return false
  try {
    const support = await encoder.isConfigSupported({
      codec: EXPORT_VIDEO_CODEC_STRINGS[codec],
      width: target.width,
      height: target.height,
      bitrate: target.bitrate,
      framerate: target.frameRate,
    })
    return support?.supported === true
  } catch {
    return false
  }
}

/**
 * The codecs to show in the export panel, in menu order. H.264 is always
 * listed even when its probe fails: without it there is nothing to export at
 * all, and the encoder's own error is a better message than an empty menu.
 */
export async function getSupportedExportVideoCodecs(
  target: CodecProbeTarget,
  encoder: VideoEncoderProbe | null = defaultProbe(),
): Promise<ExportVideoCodec[]> {
  const hevc = await probeExportVideoCodec('hevc', target, encoder)
  return hevc ? ['h264', 'hevc'] : ['h264']
}

/**
 * The codec to actually export with: the requested one when it is in
 * `supported`, else H.264.
 */
export function resolveExportVideoCodec(
  requested: ExportVideoCodec | undefined,
  supported: readonly ExportVideoCodec[],
): ExportVideoCodec {
  if (requested && supported.includes(requested)) return requested
  return DEFAULT_EXPORT_VIDEO_CODEC
}
