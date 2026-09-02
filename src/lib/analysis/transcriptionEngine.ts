import type { TrimRegion } from '@/components/video-editor/types';
import type { CaptionEngineSetting } from '@/lib/captioning/captionEngineSetting';
import {
  type CaptionModelApi,
  type EnsureCaptionModelOutcome,
  getCaptionModelDirUrl,
  getOrtWasmBaseUrl,
  isWhisperWebAvailable,
} from '@/lib/captioning/captionModel';
import { whisperLanguageForLocale } from '@/lib/captioning/captionConstants';
import { extractMono16kFromVideo } from '@/lib/captioning/extractMono16k';
import { shiftTrimRegionsMsForCaptionBuffer, trimLeadingSilenceMono16k } from '@/lib/captioning/leadingSilence';
import { type TranscribeMono16kResult, transcribeMono16kToSegments } from '@/lib/captioning/transcribe';
import type { TranscriptionEngineId, VideoAnalysisResult, VideoTranscriptionResult } from './types';
import { buildVideoAnalysisResult } from './videoAnalysisPipeline';
import { captionSegmentsToTranscriptWords } from './whisperWords';

/**
 * Engine seam for "Generate subtitles".
 *
 * - `macos-speech`: Capturia's native `SFSpeechRecognizer` helper, driven through the
 *   existing `analysis-start` / `analysis-status` / `analysis-result` IPC round trip.
 *   The main process builds and persists the analysis sidecar itself.
 * - `whisper-web`: upstream OpenScreen's in-browser Whisper (Transformers.js in a
 *   Web Worker). Runs entirely in the renderer; the analysis is built here with the
 *   same pure pipeline and persisted through `analysis-save-sidecar`.
 *
 * `runCaptionGeneration` picks the engine from the user setting + platform and
 * handles the native -> Whisper fallback.
 */

export type TranscriptionPhase = 'native' | 'audio' | 'model' | 'transcribe';

export interface TranscriptionRequest {
  /** Absolute path of the recording (main-process side reference). */
  videoPath: string;
  /** URL the editor plays (`local-media://`, `file://`, blob, ...). */
  videoUrl: string;
  /** Capturia UI locale, e.g. `en-US`, `zh-CN`, `vi`. */
  locale: string;
  durationMs: number;
  videoWidth: number;
  subtitleWidthRatio: number;
  trimRegions?: TrimRegion[];
  signal?: AbortSignal;
  onStatus?: (phase: TranscriptionPhase) => void;
}

/** Engine result; the native engine also returns the analysis main already built. */
export interface EngineTranscriptionResult extends VideoTranscriptionResult {
  analysis?: VideoAnalysisResult;
}

export interface TranscriptionEngine {
  id: TranscriptionEngineId;
  transcribe(request: TranscriptionRequest): Promise<EngineTranscriptionResult>;
}

/** Native failure codes that mean "this machine cannot run the native engine right now". */
export const NATIVE_FALLBACK_CODES: ReadonlySet<string> = new Set([
  'unsupported_platform',
  'speech_permission_denied',
  'recognizer_unavailable',
]);

export function shouldFallbackToWhisper(result: VideoTranscriptionResult): boolean {
  return !result.success && typeof result.code === 'string' && NATIVE_FALLBACK_CODES.has(result.code);
}

function abortError(): DOMException {
  return new DOMException('Aborted', 'AbortError');
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/* ----------------------------------------------------------------------------
 * macos-speech
 * -------------------------------------------------------------------------- */

/** The slice of `window.electronAPI` the native engine uses (mockable in tests). */
export type NativeAnalysisApi = Pick<
  Window['electronAPI'],
  'startVideoAnalysis' | 'getVideoAnalysisStatus' | 'getVideoAnalysisResult'
>;

export const NATIVE_POLL_INTERVAL_MS = 900;

export function createNativeSpeechEngine(
  api: NativeAnalysisApi = window.electronAPI,
  pollIntervalMs: number = NATIVE_POLL_INTERVAL_MS,
): TranscriptionEngine {
  return {
    id: 'macos-speech',
    async transcribe(request) {
      request.onStatus?.('native');
      const started = await api.startVideoAnalysis({
        videoPath: request.videoPath,
        locale: request.locale,
        durationMs: Math.max(0, Math.round(request.durationMs)),
        videoWidth: request.videoWidth,
        subtitleWidthRatio: request.subtitleWidthRatio,
      });
      if (!started.success || !started.jobId) {
        return { success: false, engine: 'macos-speech', code: 'analysis_start_failed', message: started.message };
      }

      const jobId = started.jobId;
      for (;;) {
        if (request.signal?.aborted) throw abortError();
        const statusResult = await api.getVideoAnalysisStatus(jobId);
        if (!statusResult.success || !statusResult.status) {
          return { success: false, engine: 'macos-speech', code: 'analysis_status_failed', message: statusResult.message };
        }
        const status = statusResult.status;
        if (status.status === 'failed') {
          return {
            success: false,
            engine: 'macos-speech',
            code: status.code ?? 'transcription_failed',
            message: status.error || statusResult.message,
          };
        }
        if (status.status === 'completed') break;
        await sleep(pollIntervalMs, request.signal);
      }

      const result = await api.getVideoAnalysisResult(jobId);
      if (!result.success || !result.result) {
        return { success: false, engine: 'macos-speech', code: 'analysis_result_missing', message: result.message };
      }
      const analysis = result.result as VideoAnalysisResult;
      return {
        success: true,
        engine: 'macos-speech',
        locale: analysis.transcript?.locale,
        text: analysis.transcript?.text,
        words: analysis.transcript?.words ?? [],
        analysis,
      };
    },
  };
}

/* ----------------------------------------------------------------------------
 * whisper-web
 * -------------------------------------------------------------------------- */

export interface WhisperWebEngineDeps {
  extractAudio: typeof extractMono16kFromVideo;
  transcribe: typeof transcribeMono16kToSegments;
  modelDirUrl: () => string | null;
  ortWasmBaseUrl: () => string;
}

function defaultWhisperDeps(): WhisperWebEngineDeps {
  return {
    extractAudio: extractMono16kFromVideo,
    transcribe: transcribeMono16kToSegments,
    modelDirUrl: () => getCaptionModelDirUrl(),
    ortWasmBaseUrl: () => getOrtWasmBaseUrl(),
  };
}

/** Shifts worker-relative segment times back by the leading-silence trim. */
export function shiftSegmentsBySeconds(result: TranscribeMono16kResult, offsetSec: number): TranscribeMono16kResult {
  if (offsetSec <= 0) return result;
  return {
    granularity: result.granularity,
    segments: result.segments.map((s) => ({
      ...s,
      startSec: s.startSec + offsetSec,
      endSec: s.endSec + offsetSec,
    })),
  };
}

export function createWhisperWebEngine(deps: Partial<WhisperWebEngineDeps> = {}): TranscriptionEngine {
  const resolved: WhisperWebEngineDeps = { ...defaultWhisperDeps(), ...deps };
  return {
    id: 'whisper-web',
    async transcribe(request) {
      const modelDirUrl = resolved.modelDirUrl();
      if (!modelDirUrl) {
        return {
          success: false,
          engine: 'whisper-web',
          code: 'whisper_unavailable',
          message: 'In-browser captions are not available in this window.',
        };
      }

      request.onStatus?.('audio');
      const audio = await resolved.extractAudio(
        { videoPath: request.videoPath, videoUrl: request.videoUrl },
        { signal: request.signal },
      );
      if (audio.samples.length === 0) {
        return { success: false, engine: 'whisper-web', code: 'no_audio_track', message: 'No audio to transcribe.' };
      }

      const trimmed = trimLeadingSilenceMono16k(audio.samples);
      const trimRegions = shiftTrimRegionsMsForCaptionBuffer(request.trimRegions ?? [], Math.round(trimmed.trimSec * 1000));

      const raw = await resolved.transcribe(trimmed.samples, {
        trimRegions,
        language: whisperLanguageForLocale(request.locale),
        modelDirUrl,
        ortWasmBaseUrl: resolved.ortWasmBaseUrl(),
        signal: request.signal,
        onStatus: (phase) => request.onStatus?.(phase),
      });
      const shifted = shiftSegmentsBySeconds(raw, trimmed.trimSec);
      const words = captionSegmentsToTranscriptWords(shifted.segments, shifted.granularity);
      if (words.length === 0) {
        return {
          success: false,
          engine: 'whisper-web',
          code: 'no_speech_detected',
          message: 'No speech was detected in this recording.',
        };
      }

      return {
        success: true,
        engine: 'whisper-web',
        locale: request.locale,
        text: words.map((w) => w.text).join(' ').trim(),
        words,
        truncated: audio.truncated,
      };
    },
  };
}

/* ----------------------------------------------------------------------------
 * Selection + fallback
 * -------------------------------------------------------------------------- */

export type CaptionGenerationOutcome =
  | {
      state: 'completed';
      engine: TranscriptionEngineId;
      analysis: VideoAnalysisResult;
      truncated: boolean;
      /** Native failure code that triggered the Whisper fallback, if any. */
      fallbackFrom?: string;
      /** Set when the analysis could not be written next to the video. */
      persistError?: string;
    }
  | { state: 'declined' }
  | { state: 'aborted' }
  | { state: 'failed'; engine?: TranscriptionEngineId; code?: string; message: string };

export interface CaptionGenerationOptions {
  request: TranscriptionRequest;
  setting: CaptionEngineSetting;
  engines: { native: TranscriptionEngine; whisper: TranscriptionEngine };
  /** Whether the Whisper engine can run here (desktop shell + preload arg). */
  whisperAvailable: boolean;
  /** Prompts for / performs the model download; only called before a Whisper run. */
  ensureModel: () => Promise<EnsureCaptionModelOutcome>;
  /** Writes `<video>.analysis.json`; only called for renderer-built analyses. */
  persistAnalysis: (videoPath: string, analysis: VideoAnalysisResult) => Promise<void>;
}

/** Engine to try first for a given setting. `auto` is native-first everywhere: on
 * Windows/Linux the native call answers `unsupported_platform` immediately. */
export function selectInitialEngine(setting: CaptionEngineSetting): TranscriptionEngineId {
  return setting === 'whisper' ? 'whisper-web' : 'macos-speech';
}

async function runWhisper(
  options: CaptionGenerationOptions,
  fallbackFrom?: string,
): Promise<CaptionGenerationOutcome> {
  const { request } = options;
  if (!options.whisperAvailable) {
    return {
      state: 'failed',
      engine: 'whisper-web',
      code: 'whisper_unavailable',
      message: 'In-browser captions are not available in this window.',
    };
  }

  request.onStatus?.('model');
  const model = await options.ensureModel();
  if (model.state === 'declined') return { state: 'declined' };
  if (model.state === 'aborted') return { state: 'aborted' };
  if (model.state === 'failed') {
    return { state: 'failed', engine: 'whisper-web', code: 'model_download_failed', message: model.message };
  }

  const result = await options.engines.whisper.transcribe(request);
  if (!result.success || !result.words?.length) {
    return {
      state: 'failed',
      engine: 'whisper-web',
      code: result.code,
      message: result.message || 'Automatic transcription failed.',
    };
  }

  const analysis = buildVideoAnalysisResult(result.words, {
    durationMs: request.durationMs,
    videoWidth: request.videoWidth,
    subtitleWidthRatio: request.subtitleWidthRatio,
    locale: request.locale,
  });

  let persistError: string | undefined;
  try {
    await options.persistAnalysis(request.videoPath, analysis);
  } catch (error) {
    persistError = error instanceof Error ? error.message : String(error);
  }

  return {
    state: 'completed',
    engine: 'whisper-web',
    analysis,
    truncated: Boolean(result.truncated),
    fallbackFrom,
    persistError,
  };
}

/**
 * Runs "Generate subtitles" end to end: native first (unless the setting says
 * Whisper), Whisper fallback on `NATIVE_FALLBACK_CODES` when the setting is `auto`.
 */
export async function runCaptionGeneration(options: CaptionGenerationOptions): Promise<CaptionGenerationOutcome> {
  const { request, setting } = options;
  try {
    if (selectInitialEngine(setting) === 'whisper-web') {
      return await runWhisper(options);
    }

    const native = await options.engines.native.transcribe(request);
    if (native.success && native.analysis) {
      return { state: 'completed', engine: 'macos-speech', analysis: native.analysis, truncated: false };
    }
    if (native.success && native.words?.length) {
      // Defensive: a native engine without a prebuilt analysis (not the case today).
      const analysis = buildVideoAnalysisResult(native.words, {
        durationMs: request.durationMs,
        videoWidth: request.videoWidth,
        subtitleWidthRatio: request.subtitleWidthRatio,
        locale: request.locale,
      });
      return { state: 'completed', engine: 'macos-speech', analysis, truncated: false };
    }

    if (setting === 'auto' && options.whisperAvailable && shouldFallbackToWhisper(native)) {
      return await runWhisper(options, native.code);
    }

    return {
      state: 'failed',
      engine: 'macos-speech',
      code: native.code,
      message: native.message || 'Automatic transcription failed.',
    };
  } catch (error) {
    if (isAbortError(error) || request.signal?.aborted) return { state: 'aborted' };
    return { state: 'failed', message: error instanceof Error ? error.message : String(error) };
  }
}

/** Default wiring for the editor window. */
export function createDefaultCaptionEngines(): { native: TranscriptionEngine; whisper: TranscriptionEngine } {
  return { native: createNativeSpeechEngine(), whisper: createWhisperWebEngine() };
}

export function whisperWebAvailable(api?: CaptionModelApi): boolean {
  return isWhisperWebAvailable(api);
}
