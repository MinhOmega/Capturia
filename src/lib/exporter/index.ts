export {
  VideoExporter,
  ExportEncoderError,
  SOFTWARE_FIRST_ENCODER_PLATFORMS,
  getEncoderPreferences,
  readExportDecodePathOverride,
  waitForEncoderQueueSpace,
  type VideoExporterConfig,
} from './videoExporter'
export { VideoFileDecoder } from './videoDecoder'
export {
  StreamingVideoDecoder,
  computeExportMetrics,
  loadFileAsArrayBuffer,
  shouldFailDecodeEndedEarly,
  validateDuration,
  type DecodedVideoInfo,
  type ExportMetrics,
} from './streamingDecoder'
export {
  buildSpeedSegments,
  computeKeepSegments,
  maxTimelineSpeed,
  splitBySpeed,
  type SpeedRegion,
  type SpeedTimelineSegment,
  type TimelineSegment,
} from './timelineSegments'
export {
  buildDecodeTimelinePlan,
  getSpeedTimelineDurationSec,
  segmentsToSpeedTimeline,
  type DecodeTimelineInput,
  type DecodeTimelinePlan,
} from './segmentAdapter'
export { FrameRenderer } from './frameRenderer'
export {
  EXPORT_LEGACY_COMPOSITOR_STORAGE_KEY,
  buildMaskGeometryKey,
  buildShadowFilter,
  buildShadowGeometryKey,
  canReuseTextureSource,
  getFrameSourceSize,
  readLegacyCompositorOverride,
  type MaskGeometryInput,
  type ShadowGeometryInput,
} from './compositorKeys'
export { VideoMuxer } from './muxer'
export { GifExporter, calculateOutputDimensions } from './gifExporter'
export {
  getSourceCopyFastPathBlockers,
  getSourceCopyProbeBlockers,
  isSourceCopyFastPathEligible,
  probeSourceCopyCandidate,
  type SourceCopyFastPathInput,
  type SourceCopyProbe,
} from './sourceCopyFastPath'
export {
  materializeLocalSourceFile,
  loadLocalSourceBlob,
  releaseLocalSourceFile,
  clearStaleSourceCache,
  type MaterializeOptions,
  type MaterializeProgress,
} from './localSourceFile'
export { MAX_IN_MEMORY_SOURCE_BYTES } from './sourceFileLimits'
export { resolveSourceDurationMs } from './sourceDuration'
export {
  buildExportDiagnosticMessage,
  buildSaveDiagnosticMessage,
  describeExportEncoder,
  getFileNameForDiagnostics,
  type ExportDiagnostics,
  type ExportDiagnosticLabels,
  type ExportFormatLabel,
} from './exportDiagnostics'
export {
  EXPORT_AUDIO_CODECS,
  selectExportAudioCodec,
  isAudioCodecEncodingSupported,
  type ExportAudioCodec,
} from './audioCodecSelection'
export {
  EXPORT_FRAME_RATE_CHOICES,
  calculateEffectiveSourceDimensions,
  calculateMp4ExportPlan,
  getAvailableExportFrameRates,
  isSupportedExportFrameRate,
  resolveExportFrameRate,
  normalizeExportSourceFrameRate,
  type Mp4ExportPlan,
  type Mp4ExportPlanInput,
} from './mp4ExportPlan'
export {
  DEFAULT_EXPORT_VIDEO_CODEC,
  EXPORT_VIDEO_CODEC_STRINGS,
  getExportVideoCodecFromString,
  getSupportedExportVideoCodecs,
  isExportVideoCodec,
  probeExportVideoCodec,
  resolveExportVideoCodec,
  type ExportVideoCodec,
  type CodecProbeTarget,
  type VideoEncoderProbe,
} from './videoCodecSupport'
export {
  buildExportTimingSummary,
  formatExportClock,
  type ExportTimingSummary,
} from './exportTiming'
export type {
  ExportConfig,
  ExportDecodePath,
  ExportProgress,
  ExportResult,
  VideoFrameData,
  ExportQuality,
  ExportAudioProcessingConfig,
  ExportFormat,
  GifFrameRate,
  GifSizePreset,
  GifExportConfig,
  ExportSettings,
  ExportEncoderReport,
} from './types'
export {
  DEFAULT_EXPORT_DECODE_PATH,
  EXPORT_DECODE_PATH_STORAGE_KEY,
  isExportDecodePath,
} from './types'
export {
  GIF_SIZE_PRESETS,
  GIF_FRAME_RATES,
  VALID_GIF_FRAME_RATES,
  isValidGifFrameRate,
} from './types'
