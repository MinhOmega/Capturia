export { VideoExporter } from './videoExporter';
export { VideoFileDecoder } from './videoDecoder';
export { FrameRenderer } from './frameRenderer';
export { VideoMuxer } from './muxer';
export { GifExporter, calculateOutputDimensions } from './gifExporter';
export {
  materializeLocalSourceFile,
  releaseLocalSourceFile,
  clearStaleSourceCache,
  type MaterializeOptions,
  type MaterializeProgress,
} from './localSourceFile';
export { MAX_IN_MEMORY_SOURCE_BYTES } from './sourceFileLimits';
export {
  EXPORT_AUDIO_CODECS,
  selectExportAudioCodec,
  isAudioCodecEncodingSupported,
  type ExportAudioCodec,
} from './audioCodecSelection';
export { calculateMp4ExportPlan, resolveExportFrameRate, normalizeExportSourceFrameRate } from './mp4ExportPlan';
export type { 
  ExportConfig, 
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
} from './types';
export { 
  GIF_SIZE_PRESETS, 
  GIF_FRAME_RATES, 
  VALID_GIF_FRAME_RATES, 
  isValidGifFrameRate 
} from './types';
