# Export compositor

How `src/lib/exporter/frameRenderer.ts` gets a frame from the decoder onto the
canvas the encoder reads, and which parts of that it refuses to redo per frame.

An export renders every frame of a recording. Anything the renderer allocates,
tessellates or blurs inside `renderFrame` is paid for once per frame — thousands
of times for a few minutes of 1080p — so the rule is: if an input has not
changed, the result is not recomputed.

## What is cached, and on what

All three keys live in `src/lib/exporter/compositorKeys.ts`, away from the WebGL
code, so the invalidation rules are unit-testable without a browser.

| Cache | Key | Invalidated by |
|---|---|---|
| Video texture (`ImageSource`) | source pixel size | a decoded frame of a different size |
| Mask tessellation (`Graphics.roundRect`) | `buildMaskGeometryKey` — canvas size, source size, crop rect, corner radius, padding, preview size | none of these change during an export, so it runs once |
| Drop-shadow layer | `buildShadowGeometryKey` — canvas size, shadow intensity, mask rect and radius, base offset, camera scale and position, 3D tilt | the zoom camera moving, or a tilt ramping |

### The video texture

Decoded frames arrive as one `VideoFrame` per exported frame. `Texture.from()`
builds a new `ImageSource`, a new `Texture` and a new GL texture for each of
them, registers it in Pixi's resource cache, and `destroy(true)` then deletes
all of that again — an allocate/free pair, and a `gl.deleteTexture`, per frame.

The renderer keeps one `ImageSource` instead and swaps the frame into
`.resource` before calling `update()`, which re-uploads into the same GL texture.
`ImageSource` is the class `Texture.from` would have picked for a `VideoFrame`
anyway (`ImageSource.test` matches it), so nothing about the upload changes. The
`<video>` decode path is unaffected: it already reused one Pixi `VideoSource`.

### The drop shadow

`ctx.filter = drop-shadow(...) drop-shadow(...) drop-shadow(...)` followed by
`drawImage(video)` draws `video over shadow`, so the expensive half — three
Gaussian blurs over the full canvas — is redone for every frame even though the
shadow only depends on the *shape* of the video, not on its content.

Source-over compositing is associative, so `(video over shadow) over background`
is the same picture as `video over (shadow over background)`. That lets the
shadow be cached as its own layer and the video simply drawn on top of it.
Extracting the layer works because every shadow in the chain is pure black:
filtering an opaque-black silhouette with the same alpha as the frame gives
`aFiltered = aSilhouette + aShadow * (1 - aSilhouette)`, which inverts exactly
for the alpha channel.

Rasterising the layer costs more than one filtered draw, so it is only done for
a silhouette that will be reused: the layer is rebuilt only after the same
geometry key has been seen on **two consecutive frames**. A camera in motion
produces a new key every frame, never reaches two in a row, and therefore pays
nothing beyond a string comparison — it stays on the per-frame filter path. An
earlier rule that rasterised on the first miss and gave up on a bad hit rate was
measured 25 % *slower* than no cache at all on a zoom-heavy sequence.

## Measurements

Method: `src/lib/exporter/frameRendererPerf.browser.test.ts`, opt-in with
`CAPTURIA_EXPORT_PERF=1`. It builds two `FrameRenderer`s over the same synthetic
1920x1080 frames — one with `legacyCompositor: true`, one without — and reports
wall time and median ms/frame for each. 60 frames, shadow intensity 0.8, corner
radius 24, padding 10, `platform: 'linux'` (so the `gl.readPixels` readback path
is exercised).

The browser lane runs headless Chromium on SwiftShader, i.e. software
rasterisation. That is not an artificial handicap for Linux: a packaged Capturia
on a Wayland session runs with `--disable-gpu` for the Electron startup crash
(see `electron/linuxGpu.ts`), so software rasterisation is what those installs
actually get. On an X11 session with the GPU path the absolute numbers are much
lower and the ratio will differ.

`CAPTURIA_EXPORT_PERF_FRAMES` sets the sequence length (default 60 frames = 2 s
of a 30 fps timeline; 120 = 4 s, which the zoom sequence needs to cover both of
its zoom regions rather than only the first).

Numbers on the development box (2026-09-04, 22-core, 46 GB):

| Sequence | legacy | cached | |
|---|---|---|---|
| static camera, 60 frames | 70 701 ms total, 1119.95 ms/frame median, 61 texture allocations | 26 697 ms total, 391.25 ms/frame median, 1 texture allocation, 1 shadow raster | **2.65x** |
| moving zoom camera, 60 frames | 73 503 ms total, 1200.50 ms/frame median | 47 594 ms total, 441.75 ms/frame median, 2 shadow rasters | **1.54x** |
| moving zoom camera, 120 frames | 172 378 ms total, 1326.00 ms/frame median | 103 532 ms total, 818.55 ms/frame median, 3 shadow rasters | **1.66x** |

The moving-camera rows are the ones that matter for the invalidation rule. The
first attempt at the shadow cache — rasterise on the first miss, give up if the
hit rate turned out bad — measured **0.75x** on the 120-frame zoom sequence
(301 186 ms legacy against 402 892 ms cached, 22 rasterisations): a real
regression for zoom-heavy exports, paid for by rasterising layers that the next
frame threw away. Waiting for the same key on two consecutive frames turns that
into 1.66x at the same length, with three rasterisations instead of 22 — the
camera-in-motion frames now stay on the per-frame filter path and the caching
only happens across the settled stretches, while the texture reuse applies
throughout.

Output parity is asserted, not assumed:
`src/lib/exporter/frameRendererCompositor.browser.test.ts` renders the same
frames through both compositors in a real browser and compares every pixel.

| Scenario | max per-channel delta | mean abs delta | pixels differing |
|---|---|---|---|
| static camera, default platform | 1 / 255 | 0.00117 | 0.39 % |
| static camera, `platform: 'linux'` | 1 / 255 | 0.00117 | 0.39 % |
| moving zoom camera | 0 (byte-identical) | 0 | 0 % |

The 1/255 comes from the antialiased outline of the rounded mask, where the
cached path composites in three 8-bit steps instead of two and the recovered
shadow alpha is quantised. The test fails above a per-channel delta of 2 or
above 2 % of pixels differing.

## Encoder queue depth

`resolveMaxEncodeQueue` allows 120 frames in the `VideoEncoder` queue for a
hardware encoder and 32 for a software one. A deep queue is only useful while
the encoder is the slower half of the pipeline — it lets the render loop run
ahead — and every queued frame keeps a `VideoFrame` alive, so the depth is paid
for in memory.

Measured on a real 1080p export of the generated fixture
(`src/lib/exporter/encoderQueueDepth.browser.test.ts`, 120 frames, shadow on,
Linux readback path), with renderer resident memory sampled from outside the
page by `scripts/sample-renderer-rss.mjs` (`performance.memory` only sees the JS
heap, and a queued frame lives in native memory):

| Depth | wall | ms/frame | peak queue occupancy | peak renderer RSS | mean renderer RSS |
|---|---|---|---|---|---|
| 120 | 218.8 s | 1823.3 | **2** | 823.1 MB | 774.8 MB |
| 32 | 309.0 s | 2574.7 | **2** | 794.8 MB | 725.8 MB |

The peak occupancy is the answer: **the queue never held more than two frames at
either setting**, so neither limit was ever reached and neither can have
affected anything. The renderer is far slower than the encoder on this path, and
the wall-time gap between the two runs is machine load, not queue depth — a
limit that is never hit cannot make an export 90 seconds slower. Memory differs
by 28 MB (3.4 %), which is the same noise.

**Nothing was changed.** Lowering the Linux value would have saved memory that
is not being used and risked capping a machine where the encoder *is* the
bottleneck. `capturia.exportEncoderQueueDepth` in localStorage (or
`VideoExporterConfig.maxEncodeQueue`) overrides it, and
`VideoExporter.peakEncodeQueue` reports the occupancy, so the question can be
re-measured on hardware where the balance is different.

## Escape hatch

`legacyCompositor` puts the renderer back on the allocate-per-frame path, so a
suspected compositing regression can be A/B'd in the field without a new build.
It follows the `capturia.exportDecodePath` precedent:

```js
// DevTools console in the editor window, then export again
localStorage.setItem('capturia.exportLegacyCompositor', '1')  // caches off
localStorage.removeItem('capturia.exportLegacyCompositor')    // back to default
```

`VideoExporterConfig.legacyCompositor` and `GifExporterConfig.legacyCompositor`
take precedence over the stored value; when both are absent the caches are on.

## Benchmark fixture

The end-to-end benchmark needs a 1080p source, which is ~5 MB and therefore
generated rather than committed:

```
node scripts/make-export-perf-fixture.mjs 4    # seconds, default 10
```

It writes `src/__fixtures__/perf-1080p.mp4` (git-ignored). The benchmark reports
that the fixture is missing and returns, rather than failing, when it is absent.
