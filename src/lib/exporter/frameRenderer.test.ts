import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { mockTextureConstructor, mockVideoSourceConstructor } = vi.hoisted(() => ({
  mockTextureConstructor: vi.fn(),
  mockVideoSourceConstructor: vi.fn(),
}));

vi.mock("pixi.js", () => {
  class MockApplication {}
  class MockContainer {
    addChild(): void {}
  }
  class MockSprite {
    texture: unknown;

    constructor(texture: unknown) {
      this.texture = texture;
    }
  }
  class MockGraphics {}
  class MockBlurFilter {}

  class MockVideoSource {
    options: unknown;
    autoUpdate = false;
    constructor(options: unknown) {
      this.options = options;
      mockVideoSourceConstructor(options);
    }
  }

  class MockTexture {
    source: unknown;
    constructor(options: { source?: unknown } = {}) {
      this.source = options.source;
      mockTextureConstructor(options);
    }
    static from = vi.fn((input: unknown) => new MockTexture({ source: input }));
  }

  return {
    Application: MockApplication,
    Container: MockContainer,
    Sprite: MockSprite,
    Graphics: MockGraphics,
    BlurFilter: MockBlurFilter,
    Texture: MockTexture,
    VideoSource: MockVideoSource,
  };
});

vi.mock("pixi-filters/motion-blur", () => ({
  MotionBlurFilter: class MockMotionBlurFilter {
    velocity = { x: 0, y: 0 };
    kernelSize = 5;
    offset = 0;
    resolution = 1;
  },
}));

import { FrameRenderer, compositeContextAttributes, flipPixelRowsInPlace } from "./frameRenderer";

describe("frameRenderer video texture setup", () => {
  beforeAll(() => {
    vi.stubGlobal("HTMLVideoElement", class MockHTMLVideoElement {});
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    mockTextureConstructor.mockClear();
    mockVideoSourceConstructor.mockClear();
  });

  it("creates VideoSource with autoplay disabled before source construction", () => {
    const renderer = new FrameRenderer({
      width: 1280,
      height: 720,
      wallpaper: "#000000",
      zoomRegions: [],
      showShadow: false,
      shadowIntensity: 0,
      showBlur: false,
      cropRegion: { x: 0, y: 0, width: 1, height: 1 },
      videoWidth: 1280,
      videoHeight: 720,
    }) as unknown as {
      createTextureFromVideoSource: (source: HTMLVideoElement | VideoFrame) => unknown;
    };

    const VideoElementCtor = (globalThis as typeof globalThis & { HTMLVideoElement: new () => HTMLVideoElement }).HTMLVideoElement;
    const videoElement = new VideoElementCtor();
    Object.assign(videoElement, {
      defaultMuted: false,
      muted: false,
      volume: 1,
      paused: true,
      currentTime: 0,
    });

    renderer.createTextureFromVideoSource(videoElement);

    expect(mockVideoSourceConstructor).toHaveBeenCalledTimes(1);
    expect(mockVideoSourceConstructor).toHaveBeenCalledWith(
      expect.objectContaining({
        resource: videoElement,
        autoPlay: false,
        autoLoad: true,
        muted: true,
      }),
    );
    expect(videoElement.defaultMuted).toBe(true);
    expect(videoElement.muted).toBe(true);
    expect(videoElement.volume).toBe(0);
    expect(mockTextureConstructor).toHaveBeenCalledTimes(1);
  });
});

describe("frameRenderer linux readback (D4)", () => {
  const baseConfig = {
    width: 4,
    height: 2,
    wallpaper: "#000000",
    zoomRegions: [],
    showShadow: false,
    shadowIntensity: 0,
    showBlur: false,
    cropRegion: { x: 0, y: 0, width: 1, height: 1 },
    videoWidth: 4,
    videoHeight: 2,
  };

  it("hints willReadFrequently only on linux", () => {
    expect(compositeContextAttributes("linux")).toEqual({ willReadFrequently: true });
    expect(compositeContextAttributes("darwin")).toEqual({ willReadFrequently: false });
    expect(compositeContextAttributes("win32")).toEqual({ willReadFrequently: false });
    expect(compositeContextAttributes(undefined)).toEqual({ willReadFrequently: false });
  });

  it("enables the readback path only when constructed with platform linux", () => {
    const linux = new FrameRenderer({ ...baseConfig, platform: "linux" }) as unknown as { isLinux: boolean };
    const mac = new FrameRenderer({ ...baseConfig, platform: "darwin" }) as unknown as { isLinux: boolean };
    const unset = new FrameRenderer(baseConfig) as unknown as { isLinux: boolean };

    expect(linux.isLinux).toBe(true);
    expect(mac.isLinux).toBe(false);
    expect(unset.isLinux).toBe(false);
  });

  it("flips readPixels rows bottom-to-top into canvas order", () => {
    // 2x3 RGBA image; each row filled with its index so the flip is visible.
    const width = 2;
    const height = 3;
    const buf = new Uint8Array(width * height * 4);
    for (let row = 0; row < height; row++) {
      buf.fill(row + 1, row * width * 4, (row + 1) * width * 4);
    }

    flipPixelRowsInPlace(buf, width, height);

    expect(Array.from(buf.subarray(0, 8))).toEqual([3, 3, 3, 3, 3, 3, 3, 3]);
    expect(Array.from(buf.subarray(8, 16))).toEqual([2, 2, 2, 2, 2, 2, 2, 2]);
    expect(Array.from(buf.subarray(16, 24))).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
  });

  it("is a no-op for a single row", () => {
    const buf = new Uint8Array([9, 8, 7, 6]);
    expect(Array.from(flipPixelRowsInPlace(buf, 1, 1))).toEqual([9, 8, 7, 6]);
  });
});
