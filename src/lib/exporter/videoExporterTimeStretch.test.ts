import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioEditRegion, VideoSegment } from '@/components/video-editor/types';
import { normalizeAudioEditRegions } from '@/lib/audio/audioEditRegions';
import { segmentsToTrimRegions } from '@/lib/trim/timeMapping';
import { frameIndexToTimestampUs } from './frameClock';
import { buildDecodeTimelinePlan, segmentsToSpeedTimeline } from './segmentAdapter';
import { computeExportMetrics } from './streamingDecoder';
import type { SpeedTimelineSegment } from './timelineSegments';

// Lightweight AudioBuffer polyfill for Node (no Web Audio API available).
class FakeAudioBuffer {
  readonly numberOfChannels: number;
  readonly length: number;
  readonly sampleRate: number;
  readonly duration: number;
  private channels: Float32Array[];

  constructor(opts: { length: number; numberOfChannels: number; sampleRate: number }) {
    this.length = opts.length;
    this.numberOfChannels = opts.numberOfChannels;
    this.sampleRate = opts.sampleRate;
    this.duration = opts.length / opts.sampleRate;
    this.channels = Array.from({ length: opts.numberOfChannels }, () => new Float32Array(opts.length));
  }

  getChannelData(channel: number): Float32Array {
    return this.channels[channel];
  }
}

Object.assign(globalThis, { AudioBuffer: FakeAudioBuffer });

type WrappedBuffer = { buffer: FakeAudioBuffer; timestamp: number; duration: number };

/** Private exporter state `runExportAttempt` fills in before `exportAudioTrack()`. */
type ExporterInternals = {
  sourceAudioTrack: unknown;
  sourceDurationMs: number;
  sourceAudioEditRegions: AudioEditRegion[];
  samplingMode: 'seek-only' | 'webcodecs';
  audioTimeline: SpeedTimelineSegment[];
  audioTotalFrames: number;
  muxer: { addAudioBuffer(buffer: FakeAudioBuffer): Promise<void> } | null;
  exportAudioTrack(): Promise<void>;
};

// The fake sink mirrors mediabunny's `AudioBufferSink.buffers(start, end)`:
// every decoded buffer overlapping [start, end) is yielded in source order.
const sinkState: { buffers: WrappedBuffer[] } = { buffers: [] };

vi.mock('mediabunny', async (importOriginal) => {
  const actual = await importOriginal<typeof import('mediabunny')>();
  return {
    ...actual,
    AudioBufferSink: class FakeAudioBufferSink {
      async *buffers(start: number, end: number): AsyncGenerator<WrappedBuffer> {
        for (const wrapped of sinkState.buffers) {
          const bufferStart = wrapped.timestamp;
          const bufferEnd = wrapped.timestamp + wrapped.duration;
          if (bufferEnd <= start || bufferStart >= end) continue;
          yield wrapped;
        }
      }
    },
  };
});

const { VideoExporter, buildAudioSegmentSampleBudget, buildVideoFrameCountsForTimeline } = await import('./videoExporter');

const SR = 48000;
const FPS = 60;

/** Synthetic decoded track: `chunkSec` buffers from `startSec`, sample = `fill(absoluteIndex)`. */
function makeSource(opts: {
  durationSec: number;
  channels?: number;
  chunkSec?: number;
  startSec?: number;
  fill: (absoluteIndex: number, channel: number) => number;
}): WrappedBuffer[] {
  const channels = opts.channels ?? 1;
  const chunkSec = opts.chunkSec ?? 0.1;
  const startSec = opts.startSec ?? 0;
  const buffers: WrappedBuffer[] = [];
  for (let t = startSec; t < opts.durationSec - 1e-9; t += chunkSec) {
    const duration = Math.min(chunkSec, opts.durationSec - t);
    const length = Math.round(duration * SR);
    const buffer = new FakeAudioBuffer({ length, numberOfChannels: channels, sampleRate: SR });
    const base = Math.round(t * SR);
    for (let c = 0; c < channels; c++) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < length; i++) data[i] = opts.fill(base + i, c);
    }
    buffers.push({ buffer, timestamp: t, duration });
  }
  return buffers;
}

const sine440 = (index: number) => Math.sin((2 * Math.PI * 440 * index) / SR);

interface HarnessOptions {
  durationMs: number;
  segments?: VideoSegment[];
  playbackSpeed?: number;
  audioEditRegions?: AudioEditRegion[];
  decodePath: 'webcodecs' | 'seek';
  normalizeLoudness?: boolean;
}

/**
 * Wires a `VideoExporter` the way `runExportAttempt` does before
 * `exportAudioTrack()` runs: resolved duration, kept-span timeline and the
 * frame count the chosen video path renders for it.
 */
function makeHarness(opts: HarnessOptions) {
  const trimRegions = opts.segments ? segmentsToTrimRegions(opts.segments) : undefined;
  const exporter = new VideoExporter({
    videoUrl: 'file:///tmp/mock.webm',
    width: 1920,
    height: 1080,
    frameRate: FPS,
    bitrate: 20_000_000,
    wallpaper: '#000',
    zoomRegions: [],
    cropRegion: { x: 0, y: 0, width: 1, height: 1 },
    showShadow: false,
    shadowIntensity: 0,
    showBlur: false,
    segments: opts.segments,
    trimRegions,
    playbackSpeed: opts.playbackSpeed,
    audioEditRegions: opts.audioEditRegions,
    audioProcessing: { normalizeLoudness: opts.normalizeLoudness ?? false },
  }) as unknown as ExporterInternals;
  exporter.sourceAudioTrack = {};
  exporter.sourceDurationMs = opts.durationMs;
  exporter.sourceAudioEditRegions = normalizeAudioEditRegions(opts.audioEditRegions, opts.durationMs);

  let timeline: SpeedTimelineSegment[];
  let totalFrames: number;
  if (opts.decodePath === 'webcodecs') {
    const plan = buildDecodeTimelinePlan({
      segments: opts.segments,
      trimRegions,
      playbackSpeed: opts.playbackSpeed,
      sourceDurationMs: opts.durationMs,
    });
    timeline = plan.segments;
    totalFrames = computeExportMetrics(opts.durationMs / 1000, FPS, plan.trimRegions, plan.speedRegions).totalFrames;
    exporter.samplingMode = 'webcodecs';
  } else {
    timeline = segmentsToSpeedTimeline(opts.segments, trimRegions, opts.durationMs / 1000, opts.playbackSpeed);
    const effectiveSec = timeline.reduce((sum, s) => sum + (s.endSec - s.startSec) / s.speed, 0);
    totalFrames = Math.ceil(effectiveSec * FPS);
    exporter.samplingMode = 'seek-only';
  }
  exporter.audioTimeline = timeline;
  exporter.audioTotalFrames = totalFrames;

  const added: FakeAudioBuffer[] = [];
  exporter.muxer = {
    addAudioBuffer: async (buffer: FakeAudioBuffer) => {
      added.push(buffer);
    },
  };
  return { exporter, added, timeline, totalFrames };
}

function concatChannel(buffers: FakeAudioBuffer[], channel = 0): Float32Array {
  const total = buffers.reduce((sum, b) => sum + b.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const buffer of buffers) {
    out.set(buffer.getChannelData(channel), offset);
    offset += buffer.length;
  }
  return out;
}

function rms(signal: Float32Array, from = 0, to = signal.length): number {
  let sum = 0;
  for (let i = from; i < to; i++) sum += signal[i] * signal[i];
  return Math.sqrt(sum / Math.max(1, to - from));
}

function crossingsPerSecond(signal: Float32Array, from: number, to: number): number {
  let crossings = 0;
  for (let i = from + 1; i < to; i++) {
    if ((signal[i - 1] < 0 && signal[i] >= 0) || (signal[i - 1] >= 0 && signal[i] < 0)) crossings++;
  }
  return crossings / ((to - from) / SR);
}

function expectedTotalSamples(totalFrames: number): number {
  return Math.round((frameIndexToTimestampUs(totalFrames, FPS) * SR) / 1_000_000);
}

beforeEach(() => {
  sinkState.buffers = [];
});

describe('buildVideoFrameCountsForTimeline', () => {
  const timeline: SpeedTimelineSegment[] = [
    { startSec: 0, endSec: 1, speed: 1 },
    { startSec: 1, endSec: 3, speed: 2 },
    { startSec: 3.5, endSec: 4, speed: 0.5 },
  ];

  it('matches the streaming decoder quantisation on the webcodecs path', () => {
    // ceil((dur - 0.001) / speed * fps) per segment, as computeExportMetrics.
    expect(buildVideoFrameCountsForTimeline(timeline, FPS, 180, 'webcodecs')).toEqual([60, 60, 60]);
  });

  it('assigns seek-path frames by cumulative output time', () => {
    const uneven: SpeedTimelineSegment[] = [
      { startSec: 0, endSec: 0.35, speed: 1 }, // 21 frames -> cumulative 21
      { startSec: 0.35, endSec: 1, speed: 3 }, // 0.2167 s -> cumulative 34.0 frames
    ];
    const totalFrames = Math.ceil(((0.35 + 0.65 / 3) * FPS) - 1e-6);
    expect(buildVideoFrameCountsForTimeline(uneven, FPS, totalFrames, 'seek')).toEqual([21, totalFrames - 21]);
  });

  it('lets the last segment absorb the difference to the rendered frame count', () => {
    expect(buildVideoFrameCountsForTimeline(timeline, FPS, 182, 'webcodecs')).toEqual([60, 60, 62]);
    expect(buildVideoFrameCountsForTimeline(timeline, FPS, 119, 'seek')).toEqual([60, 60, 0]);
    expect(buildVideoFrameCountsForTimeline([], FPS, 10, 'seek')).toEqual([]);
  });
});

describe('buildAudioSegmentSampleBudget', () => {
  it('converts frame counts to samples through the frame clock', () => {
    expect(buildAudioSegmentSampleBudget([60, 60, 120], FPS, SR)).toEqual([48000, 48000, 96000]);
  });

  it('telescopes to the exact total even when frames do not divide the sample rate', () => {
    const counts = [7, 11, 13];
    const budget = buildAudioSegmentSampleBudget(counts, 30, 44100);
    const total = budget.reduce((sum, n) => sum + n, 0);
    expect(total).toBe(Math.round((frameIndexToTimestampUs(31, 30) * 44100) / 1_000_000));
    for (let i = 0; i < counts.length; i++) {
      expect(Math.abs(budget[i] - (counts[i] / 30) * 44100)).toBeLessThanOrEqual(1);
    }
  });
});

describe('VideoExporter exportAudioTrack at 1x (passthrough)', () => {
  it('emits the same slices as the untouched pipeline: one buffer per kept range chunk, samples copied verbatim', async () => {
    // 1 s mono source in 0.25 s buffers, sample value encodes its absolute index.
    const value = (index: number) => ((index % 997) / 997) * 0.5;
    sinkState.buffers = makeSource({ durationSec: 1, chunkSec: 0.25, fill: value });
    const segments: VideoSegment[] = [
      { id: 'a', startMs: 0, endMs: 300, deleted: false, speed: 1 },
      { id: 'b', startMs: 300, endMs: 600, deleted: true, speed: 1 },
      { id: 'c', startMs: 600, endMs: 1000, deleted: false, speed: 1 },
    ];
    const { exporter, added } = makeHarness({ durationMs: 1000, segments, decodePath: 'seek' });

    await exporter.exportAudioTrack();

    // Kept [0,300ms] -> buffer0 [0,250ms) + buffer1 [250,300ms);
    // kept [600,1000ms] -> buffer2 [600,750ms) + buffer3 [750,1000ms).
    expect(added.map((b) => b.length)).toEqual([12000, 2400, 7200, 12000]);
    const expectedStarts = [0, 12000, 28800, 36000];
    added.forEach((buffer, i) => {
      expect(buffer.numberOfChannels).toBe(1);
      const data = buffer.getChannelData(0);
      for (let k = 0; k < buffer.length; k += 97) {
        expect(data[k]).toBe(Math.fround(value(expectedStarts[i] + k)));
      }
    });
  });
});

describe('VideoExporter exportAudioTrack with speed segments (WSOLA)', () => {
  const segments: VideoSegment[] = [
    { id: 'a', startMs: 0, endMs: 1000, deleted: false, speed: 1 },
    { id: 'b', startMs: 1000, endMs: 3000, deleted: false, speed: 2 },
    { id: 'c', startMs: 3000, endMs: 3500, deleted: true, speed: 1 },
    { id: 'd', startMs: 3500, endMs: 4000, deleted: false, speed: 0.5 },
  ];

  for (const decodePath of ['webcodecs', 'seek'] as const) {
    it(`locks the audio length to the video frame count on the ${decodePath} path (1x, 2x, 0.5x + trim)`, async () => {
      sinkState.buffers = makeSource({ durationSec: 4, channels: 2, fill: sine440 });
      const { exporter, added, timeline, totalFrames } = makeHarness({ durationMs: 4000, segments, decodePath });

      await exporter.exportAudioTrack();

      expect(timeline.map((s) => s.speed)).toEqual([1, 2, 0.5]);
      expect(totalFrames).toBe(180);
      const out = concatChannel(added);
      expect(out.length).toBe(expectedTotalSamples(totalFrames));
      expect(out.length).toBe(144000);
      // Every segment contributes its own frame budget (+/- 1 sample of frames / fps * sr).
      const counts = buildVideoFrameCountsForTimeline(timeline, FPS, totalFrames, decodePath);
      const budget = buildAudioSegmentSampleBudget(counts, FPS, SR);
      budget.forEach((samples, i) => {
        expect(Math.abs(samples - (counts[i] / FPS) * SR)).toBeLessThanOrEqual(1);
      });
      expect(budget.reduce((sum, n) => sum + n, 0)).toBe(out.length);
      for (const buffer of added) {
        expect(buffer.numberOfChannels).toBe(2);
        expect(buffer.sampleRate).toBe(SR);
      }
      // Audio is present across all three segments and the 2x segment keeps its pitch.
      expect(rms(out, 0, 48000)).toBeGreaterThan(0.5);
      expect(rms(out, 48000, 96000)).toBeGreaterThan(0.4);
      expect(rms(out, 96000, 144000)).toBeGreaterThan(0.4);
      const pitch = crossingsPerSecond(out, 50000, 94000);
      expect(pitch).toBeGreaterThan(880 * 0.85);
      expect(pitch).toBeLessThan(880 * 1.15);
      // The 1x head is a verbatim copy of the source.
      expect(out[1000]).toBe(Math.fround(sine440(1000)));
    });
  }

  it('applies audio-edit mute regions before stretching', async () => {
    sinkState.buffers = makeSource({ durationSec: 4, fill: sine440 });
    const audioEditRegions: AudioEditRegion[] = [
      { id: 'mute', startMs: 1000, endMs: 3000, mode: 'mute', gain: 0 },
    ];
    const { exporter, added } = makeHarness({ durationMs: 4000, segments, audioEditRegions, decodePath: 'webcodecs' });

    await exporter.exportAudioTrack();

    const out = concatChannel(added);
    expect(out.length).toBe(144000);
    expect(rms(out, 0, 48000)).toBeGreaterThan(0.5);
    expect(rms(out, 48000 + 2400, 96000 - 2400)).toBe(0);
    expect(rms(out, 96000, 144000)).toBeGreaterThan(0.4);
  });

  it('pads an underrun with silence and fills a late-starting track with leading silence', async () => {
    // Audio only exists from 0.5 s to 1.0 s; the timeline plays 0..2 s at 2x.
    sinkState.buffers = makeSource({ durationSec: 1, startSec: 0.5, fill: sine440 });
    const { exporter, added, totalFrames } = makeHarness({ durationMs: 2000, playbackSpeed: 2, decodePath: 'webcodecs' });

    await exporter.exportAudioTrack();

    const out = concatChannel(added);
    expect(totalFrames).toBe(60);
    expect(out.length).toBe(48000);
    // 0.5 s of source silence at 2x -> first 0.25 s of output is silent.
    expect(rms(out, 0, 12000)).toBe(0);
    expect(rms(out, 12000, 24000)).toBeGreaterThan(0.4);
    // Source ends at 1.0 s (output 0.5 s); the remaining 0.5 s is padded silence.
    expect(rms(out, 26000, 48000)).toBe(0);
  });

  it('renders segments the source never reaches as silence of the right length', async () => {
    sinkState.buffers = makeSource({ durationSec: 1, fill: sine440 });
    const gapSegments: VideoSegment[] = [
      { id: 'a', startMs: 0, endMs: 1000, deleted: false, speed: 2 },
      { id: 'b', startMs: 1000, endMs: 2000, deleted: false, speed: 4 },
    ];
    const { exporter, added, totalFrames } = makeHarness({ durationMs: 2000, segments: gapSegments, decodePath: 'webcodecs' });

    await exporter.exportAudioTrack();

    const out = concatChannel(added);
    expect(totalFrames).toBe(45);
    expect(out.length).toBe(expectedTotalSamples(45));
    expect(rms(out, 0, 24000)).toBeGreaterThan(0.4);
    expect(rms(out, 24000, out.length)).toBe(0);
  });

  it('downmixes a 5.1 source to stereo on the stretched path', async () => {
    sinkState.buffers = makeSource({ durationSec: 1, channels: 6, fill: (i, c) => (c < 2 ? sine440(i) : 0) });
    const { exporter, added } = makeHarness({ durationMs: 1000, playbackSpeed: 2, decodePath: 'seek' });

    await exporter.exportAudioTrack();

    expect(added.length).toBeGreaterThan(0);
    for (const buffer of added) expect(buffer.numberOfChannels).toBe(2);
    expect(concatChannel(added).length).toBe(24000);
  });

  it('runs the loudness measurement over the same kept ranges before stretching', async () => {
    sinkState.buffers = makeSource({ durationSec: 2, fill: (i) => sine440(i) * 0.05 });
    const { exporter, added } = makeHarness({ durationMs: 2000, playbackSpeed: 2, decodePath: 'webcodecs', normalizeLoudness: true });

    await exporter.exportAudioTrack();

    const out = concatChannel(added);
    expect(out.length).toBe(48000);
    // Normalisation lifts the quiet source well above its raw -26 dBFS level.
    expect(rms(out)).toBeGreaterThan(0.05 * 2);
  });
});
