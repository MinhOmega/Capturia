export interface TranscriptWord {
  text: string;
  startMs: number;
  endMs: number;
  confidence?: number;
  /**
   * True for pseudo-words interpolated from a phrase-level caption segment
   * (whisper-web fallback without word timestamps). Their boundaries are
   * estimates, so consumers must not treat gaps between them as silence.
   */
  synthetic?: boolean;
  /** Index of the source phrase segment a synthetic word was split from. */
  phraseIndex?: number;
}

/** Engines that can produce `TranscriptWord[]` for the analysis pipeline. */
export type TranscriptionEngineId = 'macos-speech' | 'whisper-web';

/**
 * Outcome of one transcription run. Shared by the native macOS helper
 * (`electron/native/transcriber.ts`) and the renderer-side engines.
 * `code` is a stable machine-readable failure reason (e.g. `unsupported_platform`,
 * `speech_permission_denied`); `message` is human-readable.
 */
export type VideoTranscriptionResult = {
  success: boolean;
  code?: string;
  message?: string;
  locale?: string;
  text?: string;
  words?: TranscriptWord[];
  /** Engine that produced the result. Absent for legacy native payloads. */
  engine?: TranscriptionEngineId;
  /** Set when the engine could only transcribe a prefix of the audio. */
  truncated?: boolean;
};

export interface SubtitleCue {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
  source: 'asr' | 'manual' | 'agent';
  confidence?: number;
}

export interface SubtitleGenerationOptions {
  minCueDurationMs: number;
  maxCueDurationMs: number;
  splitOnSilenceMs: number;
  maxCharsPerLine: number;
  maxLines: 1 | 2;
  maxCps: number;
}

export type RoughCutReason = 'silence' | 'filler';

export interface RoughCutSuggestion {
  id: string;
  startMs: number;
  endMs: number;
  reason: RoughCutReason;
  confidence: number;
  label: string;
}

export interface RoughCutOptions {
  minSilenceMs: number;
  minFillerDurationMs: number;
  fillerWords: string[];
}

export interface TranscriptData {
  locale: string;
  text: string;
  words: TranscriptWord[];
  createdAtMs: number;
}

export interface VideoAnalysisResult {
  transcript: TranscriptData;
  subtitleCues: SubtitleCue[];
  roughCutSuggestions: RoughCutSuggestion[];
}
