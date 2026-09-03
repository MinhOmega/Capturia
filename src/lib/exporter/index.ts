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
  calculateEffectiveSourceDimensions,
  calculateMp4ExportPlan,
  resolveExportFrameRate,
  normalizeExportSourceFrameRate,
} from './mp4ExportPlan'
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
