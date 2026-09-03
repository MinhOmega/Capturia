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
7. **Audio at non-1x speed (upstream sync batch D-5).** The audio track never touches a
   media element on either decode path: it is read with mediabunny's `AudioBufferSink`
   (kept ranges -> audio-edit gain -> loudness gain + limiter -> stereo downmix in
   `createAudioSlice`) and written as PCM through `AudioBufferSource`. When any timeline
   segment plays at a speed other than 1x, `exportTimeStretchedAudio` sends each
   `SpeedTimelineSegment` (same adapter the video path uses) through its own
   `WsolaTimeStretcher` (`src/lib/audio/audioTimeStretch.ts`, pitch-preserving, offline)
   and clamps the output to the sample budget of the frames the video path rendered for
   that segment (`buildVideoFrameCountsForTimeline` + `buildAudioSegmentSampleBudget`
   over `frameClock` timestamps), padding underrun with silence. Timelines that are 1x
   everywhere keep the previous slice-to-muxer path unchanged. Nothing here plays
   audio, depends on wall-clock time or on `MediaRecorder`; the upstream real-time
   `<audio>` capture path was deliberately not ported. Known limits: the hard limiter
   runs before the stretch, so WSOLA overlap-add may overshoot it by a few percent on
   transients; WSOLA quality below ~0.5x and above ~20x is speech-oriented (music
   smears); output sample rate/channels are fixed by the first decoded slice.

8. **Every source audio track is mixed (batch R5-VX).** A recording that keeps the
   microphone and the system audio as separate tracks used to export with only the
   first one. The exporter now opens one `AudioBufferSink` per decodable track at the
   primary track's sample rate and sums them in `src/lib/audio/multiTrackMix.ts`
   before the existing chain runs: alignment is sample-accurate on the source time
   grid (a track that starts late is padded, a track that ends early stops holding the
   output back), mono is upmixed and anything above stereo is folded to the mix layout
   by `src/lib/audio/downmix.ts`, per-track gain is applied, and a soft limiter caps
   the sum. Output is released only once every live track has covered it, so memory
   stays bounded on long recordings. The gain / loudness / limiter / stretch chain
   downstream is untouched, and a single-track source still takes the one-sink
   pass-through path sample for sample (asserted with exact equality in
   `videoExporterMultiTrack.test.ts`). Still no media element and no real-time
   capture: mixing is offline arithmetic over decoded buffers. Tracks that cannot be
   decoded, or that use a different sample rate, are dropped with the
   `editor.exportWarningAudioTracksSkipped` warning rather than resampled.

9. **Export failures are classified and localised (batch R5-VX).** Encoder stalls,
   flush timeouts, unsupported encoder configurations, encoder `error` callbacks and
   decoder failures used to reach the user as raw English strings. `ExportResult` now
   carries `errorKind` (`src/lib/exporter/exportErrors.ts`): `'encoder-stall'`,
   `'encoder-flush-timeout'`, `'encoder-unsupported'`, `'encoder-failed'`,
   `'decoder-failed'`, the pre-existing `'background-load'`, and `'unknown'`. Throw
   sites tag themselves through `ExportEncoderError.kind`, `ExportDecoderError` and
   `DecoderFallbackError`; `classifyExportError` prefers those typed errors and falls
   back to matching the message against the one table of exporter-worded strings that
   the throw sites themselves use, so the two cannot drift. `ExportDialog` maps the
   kind to `dialogs.exportError.*` and keeps the raw message underneath for
   diagnostics. `'background-load'` and `'unknown'` deliberately map to no key: the
   editor already builds its own localised line naming the background file, and an
   unrecognised failure is more useful shown verbatim.

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
6. The editor does not pass `ExportResult.errorKind` down to the export dialog: it
   folds the failure into the multi-line diagnostic block first, so the dialog
   re-derives the kind by parsing that block (each line whole, then again after its
   first `': '` label separator). That works and is tested, but it is string matching
   where a field would do. Exit: thread `errorKind` through the editor's export error
   state and let the dialog's `errorKind` prop, which already exists, carry it.
7. Only the video encoder and decoder are classified. Mux, renderer, audio-decode and
   save failures still fall through to `'unknown'` and are shown raw.
8. `GifExporter` sets `'background-load'` only; its own failures are not classified.

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
