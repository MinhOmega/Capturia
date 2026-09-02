import { ALL_FORMATS, AudioBufferSink, BlobSource, Input } from 'mediabunny';
import { MAX_CAPTION_AUDIO_SEC } from './captionConstants';

/**
 * Demux + WebCodecs audio decode through mediabunny (the same stack the exporter
 * uses for its audio track). Used when `decodeAudioData` can't handle the
 * container (e.g. WebM/Matroska with video, fragmented MP4).
 *
 * Upstream OpenScreen v1.7.0 used `web-demuxer` here; Capturia's tip does not
 * ship that wasm, so this is the mediabunny equivalent.
 *
 * @param maxReadSec  Optional cap on how much audio to decode. The decoded PCM is
 *   held in memory, so very long recordings must be capped below
 *   MAX_CAPTION_AUDIO_SEC to avoid exhausting the renderer heap. `capped`
 *   reports whether the cap actually cut the track short.
 */
export async function extractMonoPcmViaMediabunny(
  file: File,
  signal?: AbortSignal,
  maxReadSec?: number,
): Promise<{ mono: Float32Array; sampleRate: number; durationSec: number; capped: boolean }> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) {
      throw new Error('No audio track found in this video.');
    }
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const decodable = await track.canDecode();
    if (!decodable) {
      throw new Error(`Audio codec not supported for captions: ${track.codec ?? 'unknown'}`);
    }

    const sampleRate = track.sampleRate || 48_000;
    const reportedDurationSec = await track.computeDuration().catch(() => 0);
    const readCapSec = Math.min(maxReadSec ?? MAX_CAPTION_AUDIO_SEC, MAX_CAPTION_AUDIO_SEC);

    const chunks: Array<{ startSample: number; data: Float32Array }> = [];
    let maxEndSec = 0;
    const sink = new AudioBufferSink(track);
    for await (const wrapped of sink.buffers(0, readCapSec)) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const buffer = wrapped.buffer;
      const startSample = Math.round(wrapped.timestamp * sampleRate);
      chunks.push({ startSample, data: mixAudioBufferToMono(buffer) });
      maxEndSec = Math.max(maxEndSec, wrapped.timestamp + wrapped.duration);
    }

    if (chunks.length === 0) {
      throw new Error('Decoded zero audio frames from this video.');
    }

    // Prefer the extent implied by decoded frames (fixes bad container durations).
    const durationSec = maxEndSec > 0.02 ? maxEndSec : reportedDurationSec;
    const capped = reportedDurationSec > readCapSec + 0.5;
    const mono = mergeChunksToMonoLinear(chunks, sampleRate, durationSec);
    return { mono, sampleRate, durationSec, capped };
  } finally {
    try {
      input.dispose();
    } catch {
      // Already disposed.
    }
  }
}

/** Averages all channels of a decoded AudioBuffer down to one Float32Array. */
export function mixAudioBufferToMono(buffer: AudioBuffer): Float32Array {
  const { length, numberOfChannels } = buffer;
  const out = new Float32Array(length);
  if (numberOfChannels === 0) return out;
  for (let c = 0; c < numberOfChannels; c++) {
    const channel = buffer.getChannelData(c);
    for (let i = 0; i < length; i++) {
      out[i] += channel[i]!;
    }
  }
  if (numberOfChannels > 1) {
    for (let i = 0; i < length; i++) out[i] /= numberOfChannels;
  }
  return out;
}

/**
 * Places decoded chunks on a linear sample timeline (overlaps averaged, gaps
 * left silent) so odd container timestamps don't shift caption timing.
 */
export function mergeChunksToMonoLinear(
  chunks: Array<{ startSample: number; data: Float32Array }>,
  sampleRate: number,
  durationSec: number,
): Float32Array {
  const totalSamples = Math.max(1, Math.ceil(durationSec * sampleRate));
  const acc = new Float32Array(totalSamples);
  const weight = new Uint8Array(totalSamples);

  for (const chunk of chunks) {
    const { startSample, data } = chunk;
    for (let i = 0; i < data.length; i++) {
      const pos = startSample + i;
      if (pos >= 0 && pos < totalSamples) {
        acc[pos] += data[i]!;
        weight[pos] = Math.min(255, weight[pos]! + 1);
      }
    }
  }

  for (let i = 0; i < totalSamples; i++) {
    if (weight[i]! > 1) acc[i] /= weight[i]!;
  }
  return acc;
}
