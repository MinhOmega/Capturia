/**
 * Source-copy fast path: when an MP4 export changes neither pixels nor audio,
 * the source file is copied verbatim into the output instead of being decoded,
 * rendered and re-encoded. Seconds instead of minutes, and no generation loss.
 *
 * Two gates, both of which must pass:
 *   1. `getSourceCopyFastPathBlockers` - pure, over the export configuration.
 *      Every editor feature that could alter a frame or a sample is a blocker;
 *      the list errs on the side of re-encoding (a shadow that would be
 *      invisible at padding 0 still blocks, because proving invisibility is
 *      more code than it saves).
 *   2. `probeSourceCopyCandidate` - over the actual file: the container must
 *      already be MP4 with a single H.264/HEVC/AV1 video track and at most one
 *      AAC/Opus audio track, and the probed frame size must equal the planned
 *      output size. WebM/Matroska and GIF never qualify: turning them into an
 *      MP4 needs a remux whose result has not been verified in every player.
 */

import type {
  AnnotationRegion,
  AudioEditRegion,
  CropRegion,
  TrimRegion,
  VideoSegment,
  ZoomRegion,
} from '@/components/video-editor/types'
import type { SubtitleCue } from '@/lib/analysis/types'
import type { CursorTrack } from '@/lib/cursor'
import type { AspectRatio } from '@/utils/aspectRatioUtils'
import type { ExportAudioProcessingConfig, ExportQuality } from './types'

const EPSILON = 1e-6

/** The subset of `VideoExporterConfig` the eligibility decision reads. */
export interface SourceCopyFastPathInput {
  /** Editor aspect ratio; only `'native'` exports at the cropped source size with no padding. */
  aspectRatio?: AspectRatio
  /** Export quality preset; only `'source'` keeps the source resolution and frame rate. */
  quality?: ExportQuality
  padding?: number
  videoPadding?: number
  borderRadius?: number
  showShadow?: boolean
  shadowIntensity?: number
  showBlur?: boolean
  motionBlurAmount?: number
  cropRegion?: CropRegion
  zoomRegions?: ZoomRegion[]
  trimRegions?: TrimRegion[]
  segments?: VideoSegment[]
  playbackSpeed?: number
  annotationRegions?: AnnotationRegion[]
  subtitleCues?: SubtitleCue[]
  cursorTrack?: CursorTrack | null
  audioEditRegions?: AudioEditRegion[]
  audioEnabled?: boolean
  audioGain?: number
  audioProcessing?: ExportAudioProcessingConfig
  /** Reserved for the webcam composite; any value blocks. */
  webcamVideoUrl?: string
}

function hasTimeRange(regions: ReadonlyArray<{ startMs: number; endMs: number }> | undefined) {
  return (regions ?? []).some((region) => region.endMs > region.startMs)
}

function isFullCrop(crop: CropRegion | undefined): boolean {
  if (!crop) return true
  return (
    Math.abs(crop.x) <= EPSILON &&
    Math.abs(crop.y) <= EPSILON &&
    Math.abs(crop.width - 1) <= EPSILON &&
    Math.abs(crop.height - 1) <= EPSILON
  )
}

/**
 * Human-readable reasons the export must go through the render pipeline. An
 * empty list means the source can be copied as-is (subject to the file probe).
 */
export function getSourceCopyFastPathBlockers(config: SourceCopyFastPathInput): string[] {
  const blockers: string[] = []

  if (config.aspectRatio === undefined) blockers.push('aspect ratio is unknown')
  else if (config.aspectRatio !== 'native') {
    blockers.push(`aspect ratio ${config.aspectRatio} is not native`)
  }
  if (config.quality === undefined) blockers.push('quality preset is unknown')
  else if (config.quality !== 'source') {
    blockers.push(
      `quality preset ${config.quality} re-encodes at a different resolution or bitrate`,
    )
  }

  if (!isFullCrop(config.cropRegion)) blockers.push('crop is not the full source')
  if ((config.padding ?? 0) > EPSILON) blockers.push('padding is not zero')
  if ((config.videoPadding ?? 0) > EPSILON) blockers.push('video padding is not zero')
  if ((config.borderRadius ?? 0) > EPSILON) blockers.push('corner radius is not zero')
  if (config.showShadow || (config.shadowIntensity ?? 0) > EPSILON)
    blockers.push('shadow is enabled')
  if (config.showBlur) blockers.push('background blur is enabled')
  if ((config.motionBlurAmount ?? 0) > EPSILON) blockers.push('motion blur is enabled')

  if (hasTimeRange(config.trimRegions)) blockers.push('trim regions are present')
  if ((config.segments ?? []).some((segment) => segment.deleted)) {
    blockers.push('deleted segments are present')
  }
  if ((config.segments ?? []).some((segment) => Math.abs(segment.speed - 1) > EPSILON)) {
    blockers.push('segments with a speed other than 1x are present')
  }
  if (config.playbackSpeed !== undefined && Math.abs(config.playbackSpeed - 1) > EPSILON) {
    blockers.push(`playback speed ${config.playbackSpeed}x is not 1x`)
  }
  // Zoom regions carry the 3D tilt preset too, so this also covers rotation.
  if (hasTimeRange(config.zoomRegions)) blockers.push('zoom regions are present')
  if (hasTimeRange(config.annotationRegions)) blockers.push('annotations are present')
  if (hasTimeRange(config.subtitleCues)) blockers.push('subtitles are present')
  if ((config.cursorTrack?.samples?.length ?? 0) > 0) blockers.push('cursor overlay is enabled')
  if (config.webcamVideoUrl) blockers.push('webcam overlay is enabled')

  if (config.audioEnabled === false) blockers.push('audio is muted')
  if (hasTimeRange(config.audioEditRegions)) blockers.push('audio edit regions are present')
  if (config.audioGain !== undefined && Math.abs(config.audioGain - 1) > EPSILON) {
    blockers.push(`audio gain ${config.audioGain} is not 1`)
  }
  // Normalisation would need the loudness measurement to know whether it is a
  // no-op; measuring costs a full audio decode, so it simply blocks.
  if (config.audioProcessing?.normalizeLoudness) blockers.push('loudness normalisation is enabled')

  return blockers
}

export function isSourceCopyFastPathEligible(config: SourceCopyFastPathInput): boolean {
  return getSourceCopyFastPathBlockers(config).length === 0
}

// ── File probe ────────────────────────────────────────────────────────────

/** Video codecs an `.mp4` player is expected to handle without a remux. */
export const SOURCE_COPY_VIDEO_CODECS: ReadonlySet<string> = new Set(['avc', 'hevc', 'av1'])
/** Audio codecs allowed inside the copied MP4. */
export const SOURCE_COPY_AUDIO_CODECS: ReadonlySet<string> = new Set(['aac', 'opus'])

/** Facts read from the source file (see `probeSourceCopyCandidate`). */
export interface SourceCopyProbe {
  /** `true` only for an ISO BMFF file with the MP4 brand (not QuickTime `.mov`, not WebM). */
  isMp4: boolean
  videoTrackCount: number
  audioTrackCount: number
  videoCodec: string | null
  audioCodec: string | null
  width: number
  height: number
}

export interface SourceCopyTarget {
  width: number
  height: number
}

/** Reasons the probed file cannot be handed over verbatim; empty when it can. */
export function getSourceCopyProbeBlockers(
  probe: SourceCopyProbe,
  target: SourceCopyTarget,
): string[] {
  const blockers: string[] = []
  if (!probe.isMp4) blockers.push('source container is not MP4')
  if (probe.videoTrackCount !== 1) {
    blockers.push(`source has ${probe.videoTrackCount} video tracks`)
  }
  if (probe.videoCodec === null || !SOURCE_COPY_VIDEO_CODECS.has(probe.videoCodec)) {
    blockers.push(`source video codec ${probe.videoCodec ?? 'unknown'} is not H.264/HEVC/AV1`)
  }
  // Several audio tracks (system + mic written separately) must be mixed:
  // most players play only the first one.
  if (probe.audioTrackCount > 1) {
    blockers.push(`source has ${probe.audioTrackCount} audio tracks (must be mixed)`)
  }
  if (
    probe.audioTrackCount === 1 &&
    (probe.audioCodec === null || !SOURCE_COPY_AUDIO_CODECS.has(probe.audioCodec))
  ) {
    blockers.push(`source audio codec ${probe.audioCodec ?? 'unknown'} is not AAC/Opus`)
  }
  if (probe.width !== target.width || probe.height !== target.height) {
    blockers.push(
      `output size ${target.width}x${target.height} differs from source ${probe.width}x${probe.height}`,
    )
  }
  return blockers
}

/** The slice of a mediabunny `Input` the probe reads (kept narrow so tests can fake it). */
export interface ProbeableInput {
  getFormat(): Promise<{ name: string }>
  getVideoTracks(): Promise<
    Array<{ codec: string | null; displayWidth: number; displayHeight: number }>
  >
  getAudioTracks(): Promise<Array<{ codec: string | null }>>
}

/** Mediabunny's `Mp4InputFormat.name`; QuickTime reports `'QuickTime File Format'`. */
const MP4_FORMAT_NAME = 'MP4'

/** Reads container and track facts from an opened source. */
export async function probeSourceCopyCandidate(input: ProbeableInput): Promise<SourceCopyProbe> {
  const [format, videoTracks, audioTracks] = await Promise.all([
    input.getFormat(),
    input.getVideoTracks(),
    input.getAudioTracks(),
  ])
  const video = videoTracks[0]
  return {
    isMp4: format.name === MP4_FORMAT_NAME,
    videoTrackCount: videoTracks.length,
    audioTrackCount: audioTracks.length,
    videoCodec: video?.codec ?? null,
    audioCodec: audioTracks[0]?.codec ?? null,
    width: video?.displayWidth ?? 0,
    height: video?.displayHeight ?? 0,
  }
}
