import { describe, expect, it, vi } from 'vitest';
import type { CaptionSegment } from '@/lib/captioning/transcribe';
import {
  type CaptionGenerationOptions,
  createNativeSpeechEngine,
  createWhisperWebEngine,
  runCaptionGeneration,
  selectInitialEngine,
  shouldFallbackToWhisper,
  type TranscriptionEngine,
  type TranscriptionRequest,
} from './transcriptionEngine';
import type { VideoAnalysisResult } from './types';

function request(overrides: Partial<TranscriptionRequest> = {}): TranscriptionRequest {
  return {
    videoPath: '/tmp/rec.mp4',
    videoUrl: 'local-media:///tmp/rec.mp4',
    locale: 'en-US',
    durationMs: 5_000,
    videoWidth: 1920,
    subtitleWidthRatio: 0.82,
    ...overrides,
  };
}

function analysisFixture(): VideoAnalysisResult {
  return {
    transcript: { locale: 'en-US', text: 'native words', words: [{ text: 'native', startMs: 0, endMs: 300 }], createdAtMs: 1 },
    subtitleCues: [],
    roughCutSuggestions: [],
  };
}

function engine(id: TranscriptionEngine['id'], impl: TranscriptionEngine['transcribe']): TranscriptionEngine {
  return { id, transcribe: vi.fn(impl) };
}

function baseOptions(overrides: Partial<CaptionGenerationOptions> = {}): CaptionGenerationOptions {
  return {
    request: request(),
    setting: 'auto',
    whisperAvailable: true,
    engines: {
      native: engine('macos-speech', async () => ({ success: true, engine: 'macos-speech', analysis: analysisFixture() })),
      whisper: engine('whisper-web', async () => ({
        success: true,
        engine: 'whisper-web',
        words: [
          { text: 'hello', startMs: 0, endMs: 400 },
          { text: 'there', startMs: 400, endMs: 800 },
        ],
      })),
    },
    ensureModel: vi.fn(async () => ({ state: 'ready' as const })),
    persistAnalysis: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('shouldFallbackToWhisper / selectInitialEngine', () => {
  it('only falls back on the platform/permission/recognizer codes', () => {
    expect(shouldFallbackToWhisper({ success: false, code: 'unsupported_platform' })).toBe(true);
    expect(shouldFallbackToWhisper({ success: false, code: 'speech_permission_denied' })).toBe(true);
    expect(shouldFallbackToWhisper({ success: false, code: 'recognizer_unavailable' })).toBe(true);
    expect(shouldFallbackToWhisper({ success: false, code: 'no_speech_detected' })).toBe(false);
    expect(shouldFallbackToWhisper({ success: true })).toBe(false);
  });

  it('starts native unless the user forces Whisper', () => {
    expect(selectInitialEngine('auto')).toBe('macos-speech');
    expect(selectInitialEngine('native')).toBe('macos-speech');
    expect(selectInitialEngine('whisper')).toBe('whisper-web');
  });
});

describe('runCaptionGeneration', () => {
  it('uses the native analysis as-is when the native engine succeeds', async () => {
    const options = baseOptions();
    const outcome = await runCaptionGeneration(options);

    expect(outcome).toMatchObject({ state: 'completed', engine: 'macos-speech' });
    expect(options.engines.whisper.transcribe).not.toHaveBeenCalled();
    expect(options.ensureModel).not.toHaveBeenCalled();
    expect(options.persistAnalysis).not.toHaveBeenCalled();
  });

  it('falls back to Whisper on unsupported_platform, builds and persists the analysis', async () => {
    const options = baseOptions({
      engines: {
        native: engine('macos-speech', async () => ({ success: false, code: 'unsupported_platform', message: 'nope' })),
        whisper: baseOptions().engines.whisper,
      },
    });

    const outcome = await runCaptionGeneration(options);

    expect(outcome.state).toBe('completed');
    if (outcome.state !== 'completed') return;
    expect(outcome.engine).toBe('whisper-web');
    expect(outcome.fallbackFrom).toBe('unsupported_platform');
    expect(outcome.analysis.transcript.text).toBe('hello there');
    expect(outcome.analysis.subtitleCues.length).toBeGreaterThan(0);
    expect(options.ensureModel).toHaveBeenCalledTimes(1);
    expect(options.persistAnalysis).toHaveBeenCalledWith('/tmp/rec.mp4', outcome.analysis);
  });

  it('does not fall back for other native failures, nor when Whisper is unavailable, nor for setting=native', async () => {
    const nativeNoSpeech = engine('macos-speech', async () => ({ success: false, code: 'no_speech_detected', message: 'silent' }));
    const noFallback = await runCaptionGeneration(baseOptions({ engines: { native: nativeNoSpeech, whisper: baseOptions().engines.whisper } }));
    expect(noFallback).toMatchObject({ state: 'failed', engine: 'macos-speech', code: 'no_speech_detected', message: 'silent' });

    const nativeDenied = engine('macos-speech', async () => ({ success: false, code: 'speech_permission_denied' }));
    const unavailable = await runCaptionGeneration(
      baseOptions({ whisperAvailable: false, engines: { native: nativeDenied, whisper: baseOptions().engines.whisper } }),
    );
    expect(unavailable).toMatchObject({ state: 'failed', engine: 'macos-speech', code: 'speech_permission_denied' });

    const forcedNative = await runCaptionGeneration(
      baseOptions({ setting: 'native', engines: { native: nativeDenied, whisper: baseOptions().engines.whisper } }),
    );
    expect(forcedNative).toMatchObject({ state: 'failed', engine: 'macos-speech' });
  });

  it('setting=whisper skips native entirely', async () => {
    const options = baseOptions({ setting: 'whisper' });
    const outcome = await runCaptionGeneration(options);
    expect(outcome).toMatchObject({ state: 'completed', engine: 'whisper-web' });
    expect(options.engines.native.transcribe).not.toHaveBeenCalled();
  });

  it('reports declined / aborted / failed model downloads without running Whisper', async () => {
    for (const state of ['declined', 'aborted'] as const) {
      const options = baseOptions({ setting: 'whisper', ensureModel: async () => ({ state }) });
      expect(await runCaptionGeneration(options)).toEqual({ state });
      expect(options.engines.whisper.transcribe).not.toHaveBeenCalled();
    }
    const failed = await runCaptionGeneration(
      baseOptions({ setting: 'whisper', ensureModel: async () => ({ state: 'failed', message: 'offline' }) }),
    );
    expect(failed).toMatchObject({ state: 'failed', code: 'model_download_failed', message: 'offline' });
  });

  it('keeps the result when the sidecar write fails and surfaces the persist error', async () => {
    const options = baseOptions({
      setting: 'whisper',
      persistAnalysis: async () => {
        throw new Error('disk full');
      },
    });
    const outcome = await runCaptionGeneration(options);
    expect(outcome).toMatchObject({ state: 'completed', engine: 'whisper-web', persistError: 'disk full' });
  });

  it('maps AbortError to the aborted state', async () => {
    const controller = new AbortController();
    const options = baseOptions({
      request: request({ signal: controller.signal }),
      setting: 'whisper',
      engines: {
        native: baseOptions().engines.native,
        whisper: engine('whisper-web', async () => {
          controller.abort();
          throw new DOMException('Aborted', 'AbortError');
        }),
      },
    });
    expect(await runCaptionGeneration(options)).toEqual({ state: 'aborted' });
  });
});

describe('createNativeSpeechEngine', () => {
  it('starts a job, polls until completion and returns the analysis', async () => {
    let polls = 0;
    const api = {
      startVideoAnalysis: vi.fn(async () => ({ success: true, jobId: 'job-1' })),
      getVideoAnalysisStatus: vi.fn(async () => {
        polls += 1;
        return {
          success: true,
          status: { id: 'job-1', status: polls < 3 ? ('running' as const) : ('completed' as const), createdAt: 0 },
        };
      }),
      getVideoAnalysisResult: vi.fn(async () => ({ success: true, result: analysisFixture() })),
    };

    const result = await createNativeSpeechEngine(api, 1).transcribe(request());

    expect(result.success).toBe(true);
    expect(result.engine).toBe('macos-speech');
    expect(result.analysis?.transcript.text).toBe('native words');
    expect(result.words).toHaveLength(1);
    expect(api.startVideoAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({ videoPath: '/tmp/rec.mp4', locale: 'en-US', durationMs: 5_000 }),
    );
    expect(polls).toBe(3);
  });

  it('surfaces the failure code recorded on the job status', async () => {
    const api = {
      startVideoAnalysis: vi.fn(async () => ({ success: true, jobId: 'job-2' })),
      getVideoAnalysisStatus: vi.fn(async () => ({
        success: true,
        status: { id: 'job-2', status: 'failed' as const, createdAt: 0, error: 'denied', code: 'speech_permission_denied' },
      })),
      getVideoAnalysisResult: vi.fn(async () => ({ success: false })),
    };

    const result = await createNativeSpeechEngine(api, 1).transcribe(request());
    expect(result).toMatchObject({ success: false, code: 'speech_permission_denied', message: 'denied' });
  });

  it('stops polling when the request is aborted', async () => {
    const controller = new AbortController();
    const api = {
      startVideoAnalysis: vi.fn(async () => ({ success: true, jobId: 'job-3' })),
      getVideoAnalysisStatus: vi.fn(async () => {
        controller.abort();
        return { success: true, status: { id: 'job-3', status: 'running' as const, createdAt: 0 } };
      }),
      getVideoAnalysisResult: vi.fn(async () => ({ success: false })),
    };

    await expect(
      createNativeSpeechEngine(api, 1).transcribe(request({ signal: controller.signal })),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(api.getVideoAnalysisStatus).toHaveBeenCalledTimes(1);
  });
});

describe('createWhisperWebEngine', () => {
  it('extracts audio, trims leading silence, pins the language and shifts segments back', async () => {
    const samples = new Float32Array(16_000 * 3);
    for (let i = 16_000 * 2; i < samples.length; i++) samples[i] = 0.5; // speech from 2.0 s
    const transcribe = vi.fn(async (_s: Float32Array, opts: { language?: string; modelDirUrl: string }) => {
      expect(opts.language).toBe('vi');
      expect(opts.modelDirUrl).toBe('file:///models/');
      const segments: CaptionSegment[] = [{ startSec: 0.2, endSec: 1, text: 'xin chào' }];
      return { segments, granularity: 'phrase' as const };
    });

    const whisper = createWhisperWebEngine({
      extractAudio: async () => ({ samples, truncated: true, durationSec: 3 }),
      transcribe,
      modelDirUrl: () => 'file:///models/',
      ortWasmBaseUrl: () => 'http://localhost/ort/',
    });

    const phases: string[] = [];
    const result = await whisper.transcribe(request({ locale: 'vi', onStatus: (p) => phases.push(p) }));

    expect(result.success).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.words?.map((w) => w.text)).toEqual(['xin', 'chào']);
    // Leading silence trim = 2.0 s - 0.12 s pre-roll; segment start 0.2 s -> ~2.08 s.
    expect(result.words?.[0]?.startMs).toBe(2_080);
    expect(result.words?.every((w) => w.synthetic)).toBe(true);
    expect(phases).toEqual(['audio']);
  });

  it('fails cleanly when the model dir is unknown or nothing was recognised', async () => {
    const unavailable = createWhisperWebEngine({ modelDirUrl: () => null });
    expect(await unavailable.transcribe(request())).toMatchObject({ success: false, code: 'whisper_unavailable' });

    const silent = createWhisperWebEngine({
      extractAudio: async () => ({ samples: new Float32Array(16_000), truncated: false, durationSec: 1 }),
      transcribe: async () => ({ segments: [], granularity: 'phrase' as const }),
      modelDirUrl: () => 'file:///models/',
      ortWasmBaseUrl: () => 'http://localhost/ort/',
    });
    expect(await silent.transcribe(request())).toMatchObject({ success: false, code: 'no_speech_detected' });
  });
});
