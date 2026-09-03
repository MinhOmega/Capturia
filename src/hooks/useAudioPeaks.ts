import { useEffect, useRef, useState } from 'react'
import { materializeLocalSourceFile, releaseLocalSourceFile } from '@/lib/exporter/localSourceFile'
import { shouldStreamAudioPeaks, streamAudioPeaks } from './streamingAudioPeaks'

/**
 * Decoded waveform peaks for one media source. `peaks` is [min, max] per block
 * (see `audioPeaks.ts`); `durationMs` is the decoded audio's own duration, which
 * is the SOURCE timeline (Capturia maps it into effective time when drawing).
 */
export interface AudioPeaksResult {
  peaks: Float32Array
  durationMs: number
}

/**
 * `data` is the peaks decoded so far: partial while `status` is `'streaming'`,
 * so the timeline fills in as a huge recording is read. `'unavailable'` means
 * both decode paths failed and the caller should show a hint instead of a
 * waveform.
 */
export interface AudioPeaksState {
  data: AudioPeaksResult | null
  status: 'idle' | 'decoding' | 'streaming' | 'ready' | 'unavailable'
  /** 0..1 while streaming; 0 on the in-memory path, which has no milestones. */
  progress: number
}

export interface AudioPeaksSource {
  /** Raw filesystem path; read through the approved-file IPC when available. */
  filePath?: string | null
  /** `local-media://` (or blob/http) URL used as the fetch fallback. */
  url?: string | null
}

let _audioCtx: AudioContext | null = null
/** Returns the shared AudioContext, creating it lazily on first call. */
function getAudioCtx(): AudioContext {
  if (!_audioCtx) _audioCtx = new AudioContext()
  return _audioCtx
}

function abortError(): DOMException {
  return new DOMException('Aborted', 'AbortError')
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError()
}

/**
 * Loads the media file bytes. Prefers the preload `readBinaryFile` IPC (W1-c,
 * approved paths only); falls back to `fetch` on the URL, which the
 * `local-media://` protocol supports.
 */
async function loadSourceBytes(
  source: AudioPeaksSource,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const api = typeof window !== 'undefined' ? window.electronAPI : undefined
  if (source.filePath && api?.readBinaryFile) {
    try {
      const result = await api.readBinaryFile(source.filePath)
      throwIfAborted(signal)
      if (result.success && result.data) return result.data
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err
      // Fall through to fetch
    }
  }
  if (!source.url) throw new Error('No readable audio source')
  const response = await fetch(source.url, { signal })
  if (!response.ok) throw new Error(`Failed to fetch audio source (${response.status})`)
  return response.arrayBuffer()
}

/**
 * Offloads peak computation to a Web Worker (zero-copy via Transferable).
 * On abort, the worker is terminated and the promise rejects with AbortError.
 */
function computePeaksInWorker(
  audioBuffer: AudioBuffer,
  signal?: AbortSignal,
): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }

    const worker = new Worker(new URL('./audioPeaksWorker.ts', import.meta.url), {
      type: 'module',
    })

    const onAbort = () => {
      worker.terminate()
      reject(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    // slice() creates an owned copy so the transfer is safe and the
    // AudioBuffer remains valid if anything else holds a reference.
    const channels: Float32Array[] = []
    for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
      channels.push(audioBuffer.getChannelData(c).slice())
    }

    worker.onmessage = (e: MessageEvent<Float32Array>) => {
      signal?.removeEventListener('abort', onAbort)
      worker.terminate()
      resolve(e.data)
    }

    worker.onerror = (e) => {
      signal?.removeEventListener('abort', onAbort)
      worker.terminate()
      reject(e)
    }

    worker.postMessage(
      { channels, duration: audioBuffer.duration },
      channels.map((ch) => ch.buffer),
    )
  })
}

async function computeInMemoryPeaks(
  source: AudioPeaksSource,
  signal?: AbortSignal,
): Promise<AudioPeaksResult> {
  const bytes = await loadSourceBytes(source, signal)
  throwIfAborted(signal)
  const audioBuffer = await getAudioCtx().decodeAudioData(bytes)
  throwIfAborted(signal)
  const peaks = await computePeaksInWorker(audioBuffer, signal)
  return { peaks, durationMs: audioBuffer.duration * 1000 }
}

/**
 * Streams the recording's audio instead of reading it whole: the file is
 * materialized on demand (OPFS-backed for a huge source, so nothing multi-GB is
 * resident) and decoded chunk by chunk into peak columns.
 */
async function computeStreamedPeaks(
  filePath: string,
  signal: AbortSignal | undefined,
  onProgress: (partial: AudioPeaksResult, progress: number) => void,
): Promise<AudioPeaksResult> {
  const name = filePath.split(/[\\/]/).pop() || 'recording'
  const file = await materializeLocalSourceFile(filePath, name, { signal })
  try {
    return await streamAudioPeaks(file, {
      signal,
      onProgress: (update) =>
        onProgress({ peaks: update.peaks, durationMs: update.durationMs }, update.progress),
    })
  } finally {
    // Drops the OPFS cache reference taken for a large source (no-op otherwise).
    releaseLocalSourceFile(file.name)
  }
}

/** Size of the source when the desktop bridge can tell us; null otherwise. */
async function readSourceSize(filePath: string | null): Promise<number | null> {
  const api = typeof window !== 'undefined' ? window.electronAPI : undefined
  if (!filePath || !api?.getReadableFileInfo) return null
  try {
    const info = await api.getReadableFileInfo(filePath)
    return info.success && typeof info.size === 'number' ? info.size : null
  } catch {
    return null
  }
}

function sourceKey(source: AudioPeaksSource | undefined): string | null {
  if (!source) return null
  const key = source.filePath || source.url
  return key ? key : null
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

/**
 * Decodes the audio of a media source into waveform peaks.
 *
 * Two paths. Sources that fit in memory are read whole and decoded with
 * `decodeAudioData`, which is fastest and handles the common containers.
 * Anything above `MAX_IN_MEMORY_SOURCE_BYTES` would need the whole recording
 * plus its PCM resident at once, so it is demuxed and decoded chunk by chunk
 * instead (`streamingAudioPeaks.ts`), reporting partial columns as it goes so
 * the waveform draws progressively rather than after a long blank wait.
 *
 * A small source that fails the in-memory decode falls back to the streaming
 * path, which handles containers `decodeAudioData` refuses; a large one does
 * not fall back the other way, since reading it whole is what we are avoiding.
 * When neither works the status is `'unavailable'` and the caller shows a hint.
 *
 * In-flight work is aborted and stale peaks dropped as soon as the source
 * changes. Finished results are cached per source for the lifetime of the hook
 * instance, so toggling the waveform off and on does not decode again; partial
 * results are never cached.
 */
export function useAudioPeaks(source: AudioPeaksSource | undefined): AudioPeaksState {
  const cacheRef = useRef<Map<string, AudioPeaksResult>>(new Map())
  const key = sourceKey(source)
  const [state, setState] = useState<AudioPeaksState>(() => {
    const cached = key ? cacheRef.current.get(key) : undefined
    return cached
      ? { data: cached, status: 'ready', progress: 1 }
      : { data: null, status: 'idle', progress: 0 }
  })
  const filePath = source?.filePath ?? null
  const url = source?.url ?? null

  useEffect(() => {
    if (!key) {
      setState({ data: null, status: 'idle', progress: 0 })
      return
    }

    const cached = cacheRef.current.get(key)
    if (cached) {
      setState({ data: cached, status: 'ready', progress: 1 })
      return
    }

    let cancelled = false
    const controller = new AbortController()
    const signal = controller.signal

    const onPartial = (partial: AudioPeaksResult, progress: number) => {
      if (cancelled) return
      setState({ data: partial, status: 'streaming', progress })
    }

    ;(async () => {
      const size = await readSourceSize(filePath)
      if (cancelled) return
      const streamFirst = filePath !== null && shouldStreamAudioPeaks(size)
      setState({ data: null, status: streamFirst ? 'streaming' : 'decoding', progress: 0 })

      try {
        let next: AudioPeaksResult
        if (streamFirst && filePath) {
          next = await computeStreamedPeaks(filePath, signal, onPartial)
        } else {
          try {
            next = await computeInMemoryPeaks({ filePath, url }, signal)
          } catch (error) {
            if (isAbort(error) || !filePath) throw error
            // Containers `decodeAudioData` cannot open still demux fine.
            console.warn('useAudioPeaks: in-memory decode failed, streaming instead:', error)
            if (cancelled) return
            setState({ data: null, status: 'streaming', progress: 0 })
            next = await computeStreamedPeaks(filePath, signal, onPartial)
          }
        }
        if (cancelled) return
        cacheRef.current.set(key, next)
        setState({ data: next, status: 'ready', progress: 1 })
      } catch (error) {
        // AbortError means the effect cleaned up, so no state update needed.
        if (isAbort(error)) return
        console.warn('useAudioPeaks: could not decode audio for waveform:', error)
        if (!cancelled) setState({ data: null, status: 'unavailable', progress: 0 })
      }
    })()

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [key, filePath, url])

  return state
}
