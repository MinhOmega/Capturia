import { describe, expect, it, vi } from "vitest";
import {
  buildAudioGainSegments,
  buildKeptRanges,
  clampAudioGain,
  VideoExporter,
  estimateRemainingSeconds,
  getSeekToleranceSeconds,
  normalizeTrimRanges,
  readExportDecodePathOverride,
  shouldSeekToTime,
  withTimeout,
  type VideoExporterConfig,
} from "./videoExporter";
import type { OnFrameCallback } from "./streamingDecoder";
import type { ExportResult } from "./types";

const BASE_EXPORTER_CONFIG = {
  videoUrl: "file:///tmp/mock.webm",
  width: 1920,
  height: 1080,
  frameRate: 60,
  bitrate: 20_000_000,
  wallpaper: "#000",
  zoomRegions: [],
  cropRegion: { x: 0, y: 0, width: 1, height: 1 },
  showShadow: false,
  shadowIntensity: 0,
  showBlur: false,
};

/** Private surface of VideoExporter exercised by the tests below. */
type ExporterInternals = {
  cancelled: boolean;
  decoderFallbackActive: boolean;
  resolveDecodePath(): string;
  getWarnings(): string[] | undefined;
  renderAndEncodeFrame: (
    source: unknown,
    frameIndex: number,
    totalFrames: number,
    sourceTimeMs: number,
  ) => Promise<void>;
  exportFramesByDecoding: (decoder: FakeDecoder, plan: unknown, totalFrames: number) => Promise<number>;
  runExportAttempt: () => Promise<ExportResult>;
  export: () => Promise<ExportResult>;
};

type FakeDecoder = {
  cancel: () => void;
  decodeAll: (
    frameRate: number,
    trims: unknown,
    speeds: unknown,
    onFrame: OnFrameCallback,
    onWarning?: (message: string) => void,
  ) => Promise<void>;
};

type FakeVideoFrame = { closed: number; close(): void };

const globalScope = globalThis as Record<string, unknown>;

function createTestExporter(overrides: Partial<VideoExporterConfig> = {}): ExporterInternals {
  return new VideoExporter({ ...BASE_EXPORTER_CONFIG, ...overrides }) as unknown as ExporterInternals;
}

function fakeVideoFrame(): FakeVideoFrame {
  return {
    closed: 0,
    close() {
      this.closed += 1;
    },
  };
}

function asVideoFrame(frame: FakeVideoFrame): VideoFrame {
  return frame as unknown as VideoFrame;
}

describe("videoExporter seek helpers", () => {
  it("normalizes and merges overlapping trim ranges", () => {
    const merged = normalizeTrimRanges(
      [
        { id: "a", startMs: 200, endMs: 400 },
        { id: "b", startMs: 300, endMs: 700 },
        { id: "c", startMs: -100, endMs: 100 },
      ],
      1000,
    );

    expect(merged).toEqual([
      { startMs: 0, endMs: 100 },
      { startMs: 200, endMs: 700 },
    ]);
  });

  it("builds kept ranges by subtracting trim ranges", () => {
    const kept = buildKeptRanges(
      1000,
      [
        { id: "a", startMs: 100, endMs: 300 },
        { id: "b", startMs: 500, endMs: 600 },
      ],
    );

    expect(kept).toEqual([
      { startMs: 0, endMs: 100 },
      { startMs: 300, endMs: 500 },
      { startMs: 600, endMs: 1000 },
    ]);
  });

  it("builds per-range audio gain segments from rough-cut edits", () => {
    const segments = buildAudioGainSegments(
      50,
      260,
      1,
      [
        { id: "a", startMs: 100, endMs: 200, mode: "mute", gain: 0 },
        { id: "b", startMs: 150, endMs: 250, mode: "duck", gain: 0.5 },
      ],
    );

    expect(segments).toEqual([
      { startMs: 50, endMs: 100, gain: 1 },
      { startMs: 100, endMs: 150, gain: 0 },
      { startMs: 150, endMs: 200, gain: 0 },
      { startMs: 200, endMs: 250, gain: 0.5 },
      { startMs: 250, endMs: 260, gain: 1 },
    ]);
  });

  it("applies region multiplier on top of base gain", () => {
    const segments = buildAudioGainSegments(
      0,
      1000,
      0.8,
      [{ id: "d1", startMs: 100, endMs: 400, mode: "duck", gain: 0.5 }],
    );

    expect(segments).toEqual([
      { startMs: 0, endMs: 100, gain: 0.8 },
      { startMs: 100, endMs: 400, gain: 0.4 },
      { startMs: 400, endMs: 1000, gain: 0.8 },
    ]);
  });

  it("clamps audio gain to supported bounds", () => {
    expect(clampAudioGain(undefined)).toBe(1);
    expect(clampAudioGain(-2)).toBe(0);
    expect(clampAudioGain(0.5)).toBe(0.5);
    expect(clampAudioGain(9)).toBe(2);
  });

  it("uses half-frame tolerance at common frame rates", () => {
    expect(getSeekToleranceSeconds(60)).toBeCloseTo(1 / 120, 6);
    expect(getSeekToleranceSeconds(30)).toBeCloseTo(1 / 60, 6);
  });

  it("clamps tolerance for high frame rates", () => {
    expect(getSeekToleranceSeconds(240)).toBeCloseTo(1 / 240, 6);
    expect(getSeekToleranceSeconds(120)).toBeCloseTo(1 / 240, 6);
  });

  it("falls back to a safe default when frame rate is invalid", () => {
    expect(getSeekToleranceSeconds(0)).toBeCloseTo(1 / 120, 6);
    expect(getSeekToleranceSeconds(Number.NaN)).toBeCloseTo(1 / 120, 6);
  });

  it("only seeks when current time drifts beyond tolerance", () => {
    const frameRate = 60;
    const target = 10;
    const tolerance = getSeekToleranceSeconds(frameRate);

    expect(shouldSeekToTime(target, target + tolerance * 0.9, frameRate)).toBe(false);
    expect(shouldSeekToTime(target, target + tolerance * 1.1, frameRate)).toBe(true);
  });

  it("resolves values when timeout is not exceeded", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 50, "test")).resolves.toBe("ok");
  });

  it("rejects when timeout is exceeded", async () => {
    const never = new Promise<void>(() => {});
    await expect(withTimeout(never, 10, "test-timeout")).rejects.toThrow("test-timeout timed out");
  });

  it("estimates remaining time from current throughput", () => {
    // 60 frames in 3s => 20fps, remain 60 frames => ~3s
    expect(estimateRemainingSeconds(60, 120, 3000)).toBe(3);
  });

  it("returns zero eta for invalid or terminal progress", () => {
    expect(estimateRemainingSeconds(0, 120, 3000)).toBe(0);
    expect(estimateRemainingSeconds(120, 120, 3000)).toBe(0);
    expect(estimateRemainingSeconds(80, 60, 3000)).toBe(0);
    expect(estimateRemainingSeconds(50, 120, Number.NaN)).toBe(0);
  });

  describe("buildKeptRanges boundary cases", () => {
    it("returns full range when no trims", () => {
      expect(buildKeptRanges(5000, undefined)).toEqual([{ startMs: 0, endMs: 5000 }]);
      expect(buildKeptRanges(5000, [])).toEqual([{ startMs: 0, endMs: 5000 }]);
    });

    it("returns empty when trim covers entire duration", () => {
      expect(buildKeptRanges(1000, [{ id: "a", startMs: 0, endMs: 1000 }])).toEqual([]);
    });

    it("returns empty for zero, NaN, or negative totalDurationMs", () => {
      expect(buildKeptRanges(0, undefined)).toEqual([]);
      expect(buildKeptRanges(Number.NaN, undefined)).toEqual([]);
      expect(buildKeptRanges(-100, undefined)).toEqual([]);
    });
  });

  describe("buildAudioGainSegments boundary cases", () => {
    it("returns single segment with baseGain when no audioEditRegions", () => {
      expect(buildAudioGainSegments(0, 1000, 0.8, undefined)).toEqual([
        { startMs: 0, endMs: 1000, gain: 0.8 },
      ]);
      expect(buildAudioGainSegments(0, 1000, 0.8, [])).toEqual([
        { startMs: 0, endMs: 1000, gain: 0.8 },
      ]);
    });

    it("returns empty when rangeStart equals rangeEnd", () => {
      expect(buildAudioGainSegments(500, 500, 1, undefined)).toEqual([]);
    });

    it("swaps inverted range and returns a valid segment", () => {
      // Implementation normalises: safeStart=min(600,400)=400, safeEnd=max(600,400)=600
      expect(buildAudioGainSegments(600, 400, 1, undefined)).toEqual([
        { startMs: 400, endMs: 600, gain: 1 },
      ]);
    });

    it("falls back to default gain 1 for NaN or undefined baseGain", () => {
      const result1 = buildAudioGainSegments(0, 100, Number.NaN, undefined);
      expect(result1).toEqual([{ startMs: 0, endMs: 100, gain: 1 }]);

      const result2 = buildAudioGainSegments(0, 100, undefined as any, undefined);
      expect(result2).toEqual([{ startMs: 0, endMs: 100, gain: 1 }]);
    });
  });

  describe("samplingMode constraint", () => {
    it("samplingMode is always seek-only", () => {
      const exporter = new VideoExporter({
        videoUrl: "file:///tmp/mock.webm",
        width: 1920,
        height: 1080,
        frameRate: 60,
        bitrate: 20_000_000,
        wallpaper: "#000",
        zoomRegions: [],
        cropRegion: { x: 0, y: 0, width: 1, height: 1 },
        showShadow: false,
        shadowIntensity: 0,
        showBlur: false,
      }) as any;

      expect(exporter.samplingMode).toBe("seek-only");
    });
  });

  it("does not call play() in seek-only frame export path", async () => {
    const exporter = new VideoExporter({
      videoUrl: "file:///tmp/mock.webm",
      width: 1920,
      height: 1080,
      frameRate: 60,
      bitrate: 20_000_000,
      wallpaper: "#000",
      zoomRegions: [],
      cropRegion: { x: 0, y: 0, width: 1, height: 1 },
      showShadow: false,
      shadowIntensity: 0,
      showBlur: false,
      trimRegions: [],
      annotationRegions: [],
    }) as any;

    let playCalls = 0;
    let seekCalls = 0;
    let rendered = 0;

    const video: any = {
      currentTime: 0,
      duration: 10,
      paused: true,
      muted: false,
      volume: 1,
      play() {
        playCalls += 1;
        this.paused = false;
        return Promise.resolve();
      },
    };

    exporter.seekVideoTo = async (vid: any, target: number) => {
      seekCalls += 1;
      vid.currentTime = target;
    };
    exporter.seekVideoToNonBlocking = async (vid: any, target: number) => {
      seekCalls += 1;
      vid.currentTime = target;
    };
    exporter.renderAndEncodeFrame = async () => {
      rendered += 1;
    };

    const result = await exporter.exportFramesBySeeking(video, 90);

    expect(result).toBe(90);
    expect(rendered).toBe(90);
    // Seek count includes initial seek + pipelined prefetch seeks
    expect(seekCalls).toBeGreaterThanOrEqual(90);
    expect(playCalls).toBe(0);
  });
});

describe("decode path selection", () => {
  it("defaults to the seek path", () => {
    expect(createTestExporter().resolveDecodePath()).toBe("seek");
  });

  it("honours an explicit webcodecs request only when VideoDecoder exists", () => {
    const exporter = createTestExporter({ decodePath: "webcodecs" });
    const original = globalScope.VideoDecoder;
    globalScope.VideoDecoder = class {};
    try {
      expect(exporter.resolveDecodePath()).toBe("webcodecs");
    } finally {
      if (original === undefined) delete globalScope.VideoDecoder;
      else globalScope.VideoDecoder = original;
    }
    expect(exporter.resolveDecodePath()).toBe("seek");
  });

  it("forces the seek path once the decoder fallback is active", () => {
    const exporter = createTestExporter({ decodePath: "webcodecs" });
    exporter.decoderFallbackActive = true;
    expect(exporter.resolveDecodePath()).toBe("seek");
  });

  it("reads the support override from localStorage", () => {
    const original = globalScope.localStorage;
    const store = new Map<string, string>();
    globalScope.localStorage = { getItem: (key: string) => store.get(key) ?? null };
    try {
      expect(readExportDecodePathOverride()).toBeUndefined();
      store.set("capturia.exportDecodePath", "webcodecs");
      expect(readExportDecodePathOverride()).toBe("webcodecs");
      store.set("capturia.exportDecodePath", "seek");
      expect(readExportDecodePathOverride()).toBe("seek");
      store.set("capturia.exportDecodePath", "bogus");
      expect(readExportDecodePathOverride()).toBeUndefined();
    } finally {
      if (original === undefined) delete globalScope.localStorage;
      else globalScope.localStorage = original;
    }
  });
});

describe("exportFramesByDecoding", () => {
  const plan = { segments: [{ startSec: 0, endSec: 1, speed: 1 }], trimRegions: [], speedRegions: [] };

  it("renders every delivered frame through renderAndEncodeFrame and closes it", async () => {
    const exporter = createTestExporter();
    const rendered: number[] = [];
    exporter.renderAndEncodeFrame = async (_source: unknown, frameIndex: number, _total: number, sourceMs: number) => {
      rendered.push(sourceMs);
      expect(frameIndex).toBe(rendered.length - 1);
    };
    const frames = [fakeVideoFrame(), fakeVideoFrame(), fakeVideoFrame()];
    const decoder: FakeDecoder = {
      cancel: vi.fn(),
      async decodeAll(_fps, _trims, _speeds, onFrame) {
        for (let i = 0; i < frames.length; i += 1) {
          await onFrame(asVideoFrame(frames[i]), i * 16_667, i * 16.667);
        }
      },
    };

    await expect(exporter.exportFramesByDecoding(decoder, plan, 3)).resolves.toBe(3);
    expect(rendered).toHaveLength(3);
    expect(frames.every((frame) => frame.closed === 1)).toBe(true);
  });

  it("converts a decoder failure before the first frame into a fallback request", async () => {
    const exporter = createTestExporter();
    exporter.renderAndEncodeFrame = vi.fn();
    const decoder: FakeDecoder = {
      cancel: vi.fn(),
      async decodeAll() {
        throw new Error("Unsupported codec: vp9");
      },
    };

    await expect(exporter.exportFramesByDecoding(decoder, plan, 10)).rejects.toMatchObject({
      name: "DecoderFallbackError",
      message: expect.stringContaining("Unsupported codec: vp9"),
    });
  });

  it("treats a decoder that delivers nothing as a fallback request", async () => {
    const exporter = createTestExporter();
    exporter.renderAndEncodeFrame = vi.fn();
    const decoder: FakeDecoder = { cancel: vi.fn(), decodeAll: async () => undefined };

    await expect(exporter.exportFramesByDecoding(decoder, plan, 10)).rejects.toMatchObject({
      name: "DecoderFallbackError",
    });
  });

  it("does not fall back once frames were delivered", async () => {
    const exporter = createTestExporter();
    exporter.renderAndEncodeFrame = vi.fn();
    const decoder: FakeDecoder = {
      cancel: vi.fn(),
      async decodeAll(_fps, _trims, _speeds, onFrame) {
        await onFrame(asVideoFrame(fakeVideoFrame()), 0, 0);
        throw new Error("VideoDecoder error: mid-stream");
      },
    };

    await expect(exporter.exportFramesByDecoding(decoder, plan, 10)).rejects.toThrow(
      "VideoDecoder error: mid-stream",
    );
  });

  it("propagates render/encode errors untouched and cancels the decoder", async () => {
    const exporter = createTestExporter();
    exporter.renderAndEncodeFrame = async () => {
      throw new Error("encoder exploded");
    };
    const decoder: FakeDecoder = {
      cancel: vi.fn(),
      async decodeAll(_fps, _trims, _speeds, onFrame) {
        await onFrame(asVideoFrame(fakeVideoFrame()), 0, 0);
      },
    };

    await expect(exporter.exportFramesByDecoding(decoder, plan, 10)).rejects.toThrow("encoder exploded");
    expect(decoder.cancel).toHaveBeenCalled();
  });

  it("records the decode-ended-early warning from the decoder", async () => {
    const exporter = createTestExporter();
    exporter.renderAndEncodeFrame = vi.fn();
    const decoder: FakeDecoder = {
      cancel: vi.fn(),
      async decodeAll(_fps, _trims, _speeds, onFrame, onWarning) {
        await onFrame(asVideoFrame(fakeVideoFrame()), 0, 0);
        onWarning?.("Decode ended early at 0.500s (needed 1.000s)");
      },
    };

    await expect(exporter.exportFramesByDecoding(decoder, plan, 10)).resolves.toBe(1);
    expect(exporter.getWarnings()).toEqual(["editor.exportWarningDecodeEndedEarly"]);
  });
});

describe("export() decoder fallback", () => {
  const failingDecoder: FakeDecoder = {
    cancel: () => undefined,
    async decodeAll() {
      throw new Error("Unsupported codec: av01");
    },
  };
  const emptyPlan = { segments: [], trimRegions: [], speedRegions: [] };

  it("re-runs on the seek path and reports the fallback warning", async () => {
    const exporter = createTestExporter({ decodePath: "webcodecs" });
    const attempts: string[] = [];
    exporter.runExportAttempt = async () => {
      attempts.push(exporter.decoderFallbackActive ? "seek" : "webcodecs");
      if (attempts.length === 1) {
        // Simulate the streaming decoder rejecting the codec before any frame.
        await exporter.exportFramesByDecoding(failingDecoder, emptyPlan, 10);
      }
      return { success: true, blob: new Blob(), warnings: exporter.getWarnings() };
    };

    const result = await exporter.export();
    expect(attempts).toEqual(["webcodecs", "seek"]);
    expect(result.success).toBe(true);
    expect(result.warnings).toEqual(["editor.exportWarningDecoderFallback"]);
  });

  it("reports a plain failure when the seek path also fails", async () => {
    const exporter = createTestExporter({ decodePath: "webcodecs" });
    let calls = 0;
    exporter.runExportAttempt = async () => {
      calls += 1;
      if (calls === 1) {
        await exporter.exportFramesByDecoding(failingDecoder, emptyPlan, 10);
      }
      throw new Error("Video element not available");
    };

    const result = await exporter.export();
    expect(calls).toBe(2);
    expect(result).toEqual({ success: false, error: "Video element not available" });
  });

  it("does not fall back when the export was cancelled", async () => {
    const exporter = createTestExporter({ decodePath: "webcodecs" });
    let calls = 0;
    exporter.runExportAttempt = async () => {
      calls += 1;
      exporter.cancelled = true;
      return { success: false, error: "Export cancelled" };
    };

    const result = await exporter.export();
    expect(calls).toBe(1);
    expect(result).toEqual({ success: false, error: "Export cancelled" });
  });
});
