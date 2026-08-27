# Export Silent Pipeline: Technical Debt Note

## Context

Issue: export could emit fragmented audible audio during MP4 rendering.

Root cause chain (confirmed in code review):

1. Export renderer used Pixi texture creation from `HTMLVideoElement`.
2. Pixi `VideoSource` defaults can trigger implicit playback.
3. Export pipeline previously had a playback-sampling path that explicitly called `video.play()`.

This conflicts with product expectation: export stage must be silent.

## Changes Applied

1. Export frame rendering is now seek-only (no playback-sampling path in main export flow).
2. Export decoder `video` element now enforces silent defaults:
   - `defaultMuted = true`
   - `muted = true`
   - `volume = 0`
3. Export decoder now blocks unexpected `play` events by immediately forcing pause and silent state.
4. Export frame renderer now uses `VideoSource.from(video)` with:
   - `autoPlay = false`
   - `autoUpdate = true`
   and re-applies silent media element state before texture creation.
5. Added targeted test coverage to assert seek-only path does not call `play()`.
6. **WebCodecs decode path (upstream sync batch D-4).** `VideoExporterConfig.decodePath`
   selects between:
   - `'seek'` (default for now): the `HTMLVideoElement` path described above
     (`videoDecoder.ts` + `exportFramesBySeeking`), unchanged.
   - `'webcodecs'`: `src/lib/exporter/streamingDecoder.ts` (web-demuxer + `VideoDecoder`)
     feeding `VideoFrame`s straight into `FrameRenderer` via `exportFramesByDecoding`.
     **No media element exists on this path at all**, so there is nothing that can play,
     no `play` event to guard, and no Pixi `VideoSource` involved: the renderer receives
     `VideoFrame`s and builds textures with `Texture.from(videoFrame)`. The silent-export
     guarantee holds by construction rather than by guard.

   Selection: `VideoEditor` passes `readExportDecodePathOverride()`, which reads
   `localStorage['capturia.exportDecodePath']` (`'webcodecs' | 'seek'`); otherwise
   `DEFAULT_EXPORT_DECODE_PATH` (`'seek'`) applies. When the WebCodecs decoder fails
   before its first frame the exporter restarts on the seek path and reports
   `editor.exportWarningDecoderFallback`, so the guarded path is still the safety net.

## Remaining Debt

1. `HTMLVideoElement` is still part of the export render path **while `'seek'` is the
   default** and whenever the WebCodecs path falls back to it.
   - Risk: browser/media-element behavior can vary by platform.
   - Exit: flip `DEFAULT_EXPORT_DECODE_PATH` to `'webcodecs'` once the browser-mode
     tests (batch D-7) pass on Linux, macOS and Windows; the seek path then only runs
     for sources the decoder rejects (unsupported codec, corrupt container).
2. Seek-only mode is safer for silence but may reduce throughput versus playback-driven
   sampling on some machines. The WebCodecs path is a single forward decode pass and is
   expected to be markedly faster; this is not yet measured in Capturia.
3. Pixi internals are still involved in video frame ingestion on the seek path
   (`VideoSource.from(video)`). On the WebCodecs path Pixi only wraps a `VideoFrame`
   texture; no media-element semantics are involved.
4. `GifExporter` still uses `VideoFileDecoder` (seek path) only; it has no `decodePath`
   yet and keeps the media-element guard.
5. The WebCodecs path ships `public/wasm/web-demuxer.wasm` (3.0 MiB) and loads it relative
   to `window.location`; a packaging regression that drops the asset degrades to the seek
   path with the fallback warning rather than failing the export.

## Follow-up Plan

1. Add an optional export benchmark to measure seek-only vs WebCodecs throughput on
   representative durations/resolutions.
2. Add an integration test harness in browser environment (D-7) to assert no `play`
   lifecycle during export on the seek path and frame/duration parity between the two
   decode paths.
3. ~~Evaluate migration to a fully explicit decode path (`WebCodecs` + `VideoFrame`) to
   remove media-element playback semantics from export.~~ Done behind `decodePath`;
   remaining work is flipping the default (item 1 above) and bringing `GifExporter`
   onto the same decoder (item 4 above).
