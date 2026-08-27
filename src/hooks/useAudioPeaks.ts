import { useEffect, useRef, useState } from 'react';

/**
 * Decoded waveform peaks for one media source. `peaks` is [min, max] per block
 * (see `audioPeaks.ts`); `durationMs` is the decoded audio's own duration, which
 * is the SOURCE timeline (Capturia maps it into effective time when drawing).
 */
export interface AudioPeaksResult {
  peaks: Float32Array;
  durationMs: number;
}

export interface AudioPeaksSource {
  /** Raw filesystem path; read through the approved-file IPC when available. */
  filePath?: string | null;
  /** `local-media://` (or blob/http) URL used as the fetch fallback. */
  url?: string | null;
}

let _audioCtx: AudioContext | null = null;
/** Returns the shared AudioContext, creating it lazily on first call. */
function getAudioCtx(): AudioContext {
  if (!_audioCtx) _audioCtx = new AudioContext();
  return _audioCtx;
}

function abortError(): DOMException {
  return new DOMException('Aborted', 'AbortError');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

/**
 * Loads the media file bytes. Prefers the preload `readBinaryFile` IPC (W1-c,
 * approved paths only); falls back to `fetch` on the URL, which the
 * `local-media://` protocol supports.
 */
async function loadSourceBytes(source: AudioPeaksSource, signal?: AbortSignal): Promise<ArrayBuffer> {
  const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
  if (source.filePath && api?.readBinaryFile) {
    try {
      const result = await api.readBinaryFile(source.filePath);
      throwIfAborted(signal);
      if (result.success && result.data) return result.data;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      // Fall through to fetch
    }
  }
  if (!source.url) throw new Error('No readable audio source');
  const response = await fetch(source.url, { signal });
  if (!response.ok) throw new Error(`Failed to fetch audio source (${response.status})`);
  return response.arrayBuffer();
}

/**
 * Offloads peak computation to a Web Worker (zero-copy via Transferable).
 * On abort, the worker is terminated and the promise rejects with AbortError.
 */
function computePeaksInWorker(audioBuffer: AudioBuffer, signal?: AbortSignal): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }

    const worker = new Worker(new URL('./audioPeaksWorker.ts', import.meta.url), {
      type: 'module',
    });

    const onAbort = () => {
      worker.terminate();
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    // slice() creates an owned copy so the transfer is safe and the
    // AudioBuffer remains valid if anything else holds a reference.
    const channels: Float32Array[] = [];
    for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
      channels.push(audioBuffer.getChannelData(c).slice());
    }

    worker.onmessage = (e: MessageEvent<Float32Array>) => {
      signal?.removeEventListener('abort', onAbort);
      worker.terminate();
      resolve(e.data);
    };

    worker.onerror = (e) => {
      signal?.removeEventListener('abort', onAbort);
      worker.terminate();
      reject(e);
    };

    worker.postMessage(
      { channels, duration: audioBuffer.duration },
      channels.map((ch) => ch.buffer),
    );
  });
}

async function computePeaksForSource(
  source: AudioPeaksSource,
  signal?: AbortSignal,
): Promise<AudioPeaksResult> {
  const bytes = await loadSourceBytes(source, signal);
  throwIfAborted(signal);
  const audioBuffer = await getAudioCtx().decodeAudioData(bytes);
  throwIfAborted(signal);
  const peaks = await computePeaksInWorker(audioBuffer, signal);
  return { peaks, durationMs: audioBuffer.duration * 1000 };
}

function sourceKey(source: AudioPeaksSource | undefined): string | null {
  if (!source) return null;
  const key = source.filePath || source.url;
  return key ? key : null;
}

/**
 * Decodes the audio of a media source into waveform peaks. Returns `null`
 * while decoding (or when `source` is undefined), and stays `null` on no audio
 * track / decode failure (silent degradation, logged). Stale peaks are cleared
 * as soon as the source changes; in-flight work is aborted. Results are cached
 * per source for the lifetime of the hook instance so toggling the waveform
 * off and on does not re-decode.
 */
export function useAudioPeaks(source: AudioPeaksSource | undefined): AudioPeaksResult | null {
  const cacheRef = useRef<Map<string, AudioPeaksResult>>(new Map());
  const key = sourceKey(source);
  const [result, setResult] = useState<AudioPeaksResult | null>(() =>
    key ? (cacheRef.current.get(key) ?? null) : null,
  );
  const filePath = source?.filePath ?? null;
  const url = source?.url ?? null;

  useEffect(() => {
    if (!key) {
      setResult(null);
      return;
    }

    const cached = cacheRef.current.get(key);
    if (cached) {
      setResult(cached);
      return;
    }

    setResult(null);
    let cancelled = false;
    const controller = new AbortController();

    (async () => {
      try {
        const next = await computePeaksForSource({ filePath, url }, controller.signal);
        if (cancelled) return;
        cacheRef.current.set(key, next);
        setResult(next);
      } catch (err) {
        // AbortError means the effect cleaned up, so no state update needed.
        if (err instanceof DOMException && err.name === 'AbortError') return;
        console.warn('useAudioPeaks: could not decode audio for waveform:', err);
        if (!cancelled) setResult(null);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [key, filePath, url]);

  return result;
}
