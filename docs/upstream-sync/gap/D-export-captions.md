# Gap report D - Exporter, audio, captions

Status: analysis complete (2026-08-27). Read-only; no source changed.
Refs: fork base `/tmp/openscreen-base` (87735c27), target `/tmp/openscreen-v1.7.0`, history `/tmp/openscreen-upstream`.

## 0. The one finding that shapes everything else

Capturia's exporter and upstream's exporter **diverged at the decoder layer at the fork**:

| | Upstream v1.7.0 | Capturia (main @ 4cab381) |
|---|---|---|
| Video source | `src/lib/exporter/streamingDecoder.ts` - `web-demuxer` (ffmpeg wasm) + WebCodecs `VideoDecoder`, single forward pass, VFR->CFR resampling, trim/speed segments | `src/lib/exporter/videoDecoder.ts` - `HTMLVideoElement` seek-only (`VideoFileDecoder`), pipelined seek in `videoExporter.ts:exportFramesBySeeking`, silent-playback guard (`docs/technical-debt/export-silent-pipeline.md`) |
| Timeline model | `TrimRegion[]` + `SpeedRegion[]` -> `timelineSegments.ts` (`computeKeepSegments`, `splitBySpeed`) | `VideoSegment[]` (`{startMs,endMs,deleted,speed}`) + `TrimRegion[]` + `playbackSpeed`, mapped by `src/lib/trim/timeMapping.ts` |
| Audio | `audioEncoder.ts` `AudioProcessor` (1550 lines): WebCodecs decode -> re-encode, speed via `<audio>` capture (<=16x) or WSOLA offline (>16x / multi-track), multi-track mix, surround downmix, AAC->Opus fallback | `videoExporter.ts` + `src/lib/audio/*`: mediabunny `AudioBufferSink` PCM -> per-region gain (`audioEditRegions`), loudness normalisation + limiter (`exportAudioProcessing.ts`) -> mediabunny `AudioBufferSource` AAC. **No audio when any speed != 1** (`EXPORT_WARNING_SPEED_AUDIO_UNAVAILABLE`) |
| Source loading | Electron IPC `read-binary-file` / `get-readable-file-info` / `read-file-chunk` + OPFS streaming for >256 MB (`localSourceFile.ts`) | URL passed straight to `<video>`/`UrlSource`; no file-read IPC at all |
| Muxer | mediabunny `EncodedAudioPacketSource` (aac \| opus) | mediabunny `AudioBufferSource` (`aac` only, PCM in) - this is what makes Capturia's gain/normalisation possible |

Base 87735c27 already had `streamingDecoder.ts` + `web-demuxer` + `public/wasm/web-demuxer.wasm`; Capturia's squashed initial commit (5752f38) dropped all three and kept the seek path. Consequently roughly half of the upstream "exporter fixes" in the brief are fixes **inside** `StreamingVideoDecoder`/`AudioProcessor` and are not portable as patches - they come only if we port the decoder (D1). Capturia's own debt note already lists "migration to a fully explicit decode path (WebCodecs + VideoFrame)" as follow-up item 3, so D1 is the sync and the debt payoff at once. The seek path stays as fallback.

## 1. Summary table

Status legend: MISSING / PARTIAL / PRESENT-DIFFERENT (PD) / PRESENT-SAME (PS) / NOT-APPLICABLE (NA). Effort S (<0.5d), M (1-2d), L (3-5d), XL (>5d).

| # | Feature | Upstream files (v1.7.0) | Capturia status | Effort | Recommendation |
|---|---|---|---|---|---|
| D1 | WebCodecs streaming decoder (single-pass decode, trim/speed segments, VFR->CFR, codec normalisation VP8/VP9/avc1/av01, AV1 config record, packet-scan `validateDuration`, `requiredEndSec`/`shouldFailDecodeEndedEarly`, epsilon frame count, always-release frames, monotonic trim cursor) | `exporter/streamingDecoder.ts`, `timelineSegments.ts`, `videoExporter.ts:decodeAll` callback | MISSING (seek path instead) | XL | Port as new `decodePath: 'webcodecs'` with seek fallback; adapter from `VideoSegment[]` to `SpeedTimelineSegment[]` |
| D2 | Local source read via IPC + OPFS streaming for large files + size limits | `exporter/localSourceFile.ts`, `sourceFileLimits.ts`, `electron/ipc/handlers.ts` (`read-binary-file`, `get-readable-file-info`, `read-file-chunk`, `approveReadableVideoPath`), `preload.ts` | MISSING | M | Port with a Capturia path-approval guard; prerequisite for D1 fast-path, D13 and captions |
| D3a | Audio at speed != 1 (WSOLA time-stretch, offline timeline render, `PlanarChunkQueue`, leading-silence placement) | `exporter/audioTimeStretch.ts`, `planarChunkQueue.ts`, `audioEncoder.ts:renderOfflineTimelineAudio` | MISSING (audio dropped with warning) | L | Port WSOLA + offline path only; feed it Capturia's gain/normalisation slices; drop upstream's real-time `<audio>` capture path |
| D3b | Multichannel downmix (5.1/7.1 Windows order, mono->stereo) | `audioEncoder.ts:downmixPlanarChannelsForExport`, `getStereoDownmixWeights` | PARTIAL (Capturia passes source channel count straight into AAC; >2 ch untested) | S | Port the pure functions + test; apply in `createAudioSlice` |
| D3c | Multi-track mix (system + mic as separate tracks, #108) | `audioEncoder.ts:mixPlanarSources`, `decodeAudioStreamToPlanes` | NA today (Capturia's `sck-recorder.swift` writes one mono mic track; browser recorder pre-mixes) | M | Defer until Stream A adds a second audio track; port pure `mixPlanarSources` + tests only if imported files matter |
| D3d | AAC->Opus fallback inside MP4 when AAC encoder unavailable (Linux) | `audioEncoder.ts:EXPORT_AUDIO_CODECS`, `muxer.ts` codec param | PARTIAL (Capturia drops audio with `EXPORT_WARNING_AUDIO_CODEC_UNSUPPORTED`) | S | Add `codec: 'opus'` fallback to Capturia's `AudioBufferSource`; keep PCM path |
| D4 | Linux/Wayland green-frame fix: `gl.readPixels` readback + `VideoFrame` from `ImageData`, gated on `platform === 'linux'` | `frameRenderer.ts:readbackVideoCanvas`, `videoExporter.ts` (linux branch), `gifExporter.ts` (`platform`) | MISSING (dev-only `--disable-gpu` in `vite.config.ts`) | S | Port; export `getPlatform` from `src/utils/platformUtils.ts` |
| D5 | Encoder robustness: hardware->software retry (software-first on Windows), `waitForEncoderQueueSpace` stall timeout, smaller queue for software, fatal-encoder-error propagation, flush timeout | `videoExporter.ts:export`, `waitForEncoderQueueSpace`, `getEncoderPreferences` | PARTIAL (Capturia: hw/sw chosen once at configure; 120s finalize timeout; microtask spin on queue) | M | Port retry loop + stall timeout; keep Capturia's `latencyMode: 'realtime'` and 4 s keyframe interval |
| D6 | Frame counter / epsilon totalFrames (d21dd1cb, 46c611bd, 14bbe8f1) | `streamingDecoder.ts:getExportMetrics` | NA on seek path (loop is bounded); arrives with D1 | - | Nothing separate |
| D7 | MP4 resolution presets clarified (5e761703) | `exporter/mp4ExportSettings.ts` (+test) | PD - Capturia `mp4ExportPlan.ts` is stricter (never upscales, fps-aware bitrate, source fps) | S | Keep Capturia's; take only `calculateEffectiveSourceDimensions` (crop-aware) for D8 |
| D8 | "Native"/"Original" aspect ratio (export at cropped dimensions, padding 0) | `utils/aspectRatioUtils.ts` (`'native'`, `getNativeAspectRatioValue`), `VideoEditor.tsx`, `VideoPlayback.tsx`, `gifExporter.ts:calculateOutputDimensions(aspect)` | MISSING (Capturia `ASPECT_RATIOS` has 7 fixed ratios, per-aspect crop/zoom maps, batch export) | M | Port; per-aspect maps must accept `'native'`; coordinate with B3 (timeline/project state) |
| D9 | GIF worker count from `hardwareConcurrency` | `gifExporter.ts` (`WORKER_COUNT = clamp(cores-1, 1, 8)`) | MISSING (`workers: 4`) | S | Port (3 lines) |
| D10 | Re-save exported blob after save cancel/failure; remembered export folder; normalised + guarded save path | `VideoEditor.tsx` (`unsavedExport`, `handleSaveUnsavedExport`), `lib/userPreferences.ts` (`exportFolder`), `handlers.ts` (`pick-export-save-path`, `write-export-to-path`) | PARTIAL (Capturia is save-first via `pick-save-file-path`, so cancel-after-export is rare; batch path uses directory picker; `save-exported-video` accepts any renderer path unguarded; no folder memory) | S-M | Add folder memory + `unsavedExport` retry for save failures; add `isAbsolute` + extension guard + `path.normalize` in `save-exported-video` |
| D11 | Export failure diagnostics (reason, source, output, codec, bitrate, VideoEncoder availability; pre-line error box) | `VideoEditor.tsx:buildExportDiagnosticMessage`, `buildSaveDiagnosticMessage`, `ExportDialog.tsx` | MISSING | S | Port as helper + i18n; keep Capturia dialog layout |
| D12 | Export composited shadow fix (98a32372) | `frameRenderer.ts:compositeWithShadows` | PS (upstream removed a rounded-clip hack Capturia never had) | - | Nothing |
| D13 | Source-copy fast path (verbatim MP4 when no edits) | `videoExporter.ts:getSourceCopyFastPathBlockers`, `trySourceCopyFastPath`, `loadSourceBlob` (+ `videoExporter.test.ts`) | MISSING | M | Port after D2; add Capturia blockers (`audioEditRegions`, `audioGain != 1`, `normalizeLoudness`, `subtitleCues`, `cursorTrack`, segments) - note loudness normalisation defaults **on**, so the path rarely triggers unless we treat it as a no-op when stats say gain ~1 |
| D14 | Webcam export queues teardown, `timestampedVideoFrameQueue.ts`, `asyncVideoFrameQueue.ts`, `webcamFrameDrawing.ts` | those files + tests | NA until B1 lands webcam overlay | S (with B1) | Port with B1; classes are self-contained. `asyncVideoFrameQueue.ts` is unused upstream - skip |
| D15 | `threeDPass.ts` | `exporter/threeDPass.ts` | B1 owns | - | Note: on linux it also uses `readPixels` (D4 pattern) |
| D16 | Browser-mode vitest (`*.browser.test.ts`, swiftshader chromium) | `vitest.browser.config.ts`, `videoExporter.browser.test.ts`, `gifExporter.browser.test.ts`, `audioMixExport.browser.test.ts` | MISSING | M | Port infra; also satisfies Capturia debt item 2 (assert no `play()` during export in a real browser) |
| D17 | Duration validation for inflated WebM (packet scan vs container) | `streamingDecoder.ts:validateDuration` (+test) | PARTIAL (recorder root-cause fixed in 5749ea7; `VideoPlayback.tsx:1062` background probe for preview; exporter still trusts `video.duration`) | S interim / arrives with D1 | Interim: pass the probed duration from `VideoPlayback` into `VideoExporterConfig.sourceDurationMs` |
| D18 | Export progress `'preparing'` phase (OPFS copy) | `types.ts`, `ExportDialog.tsx` | MISSING | S (with D2) | Add to Capturia's `ExportProgress.phase` union + dialog string |
| D19 | Recording-side mic/system mix with 20 ms fade-in (`audioMix.ts`, e736ff4a, f698bba6) | `src/lib/audioMix.ts` (+test) | PD (Capturia `useScreenRecorder.ts:773` has user gain + DynamicsCompressor limiter, no fade-in) | S | Stream A decides; port only the `linearRampToValueAtTime` fade-in into `buildAdjustedMicrophoneStream`; keep limiter and user gain, drop fixed `MIC_GAIN_BOOST` |
| D20 | Voiceover mix (v1.8+) | out of scope | - | - | Note only |
| C1 | In-browser Whisper auto-captions (Web Worker, `@xenova/transformers`, bundled model) | `src/lib/captioning/*`, `scripts/fetch-caption-model.mjs`, `scripts/before-pack.cjs`, `src/lib/vite-stubs/*`, `vite.config.ts`, `electron-builder.json5` (`caption-assets`), `windows.ts` (`--asset-base-url`) | PD on macOS (native `SFSpeechRecognizer` -> `TranscriptWord[]` -> `subtitleEngine`), MISSING on win/linux (`transcriber.ts` returns `unsupported_platform`) | L | Add as fallback engine behind a `TranscriptionEngine` seam feeding `buildVideoAnalysisResult`; see section 3 |
| C2 | Captions rendered as editable annotation regions | `captioning/annotationsFromCaptions.ts` (+6 tests) | PD (Capturia renders `SubtitleCue[]` in `frameRenderer.ts:renderSubtitleLayer` and `VideoPlayback`) | S (optional) | Keep subtitle track; optionally add "convert cues to annotations" using `captionSegmentsToAnnotationRegions` |
| C3 | whisper.cpp native STT (v1.8+) | `electron/native/whisper-stt`, `electron/stt/*` | out of scope | - | Design C1 so the engine can be swapped; Capturia's `transcriber.ts` spawn-helper pattern matches it |

## 2. Per-feature detail

### D1 - WebCodecs streaming decoder

**What it does.** `StreamingVideoDecoder.loadMetadata()` demuxes with `web-demuxer`, scans video packets for the true end (`validateDuration`), reports `{width,height,duration,streamDuration,frameRate,codec,hasAudio,audioCodec,audioStreamCount}`. `decodeAll(fps, trims, speeds, onFrame)` feeds `EncodedVideoChunk`s into one `VideoDecoder` with backpressure (`decodeQueueSize > 10 || pending > 24`), routes decoded frames into `SpeedTimelineSegment`s, emits `ceil((dur - 0.001)/speed * fps)` output frames per segment by holding the nearest decoded frame (midpoint handoff), and finally checks `shouldFailDecodeEndedEarly` (tolerates metadata tails up to `max(2 s, 1 %)`). Codec strings are normalised (`av01` -> parsed `AV1CodecConfigurationRecord`, `vp08`->`vp8`, `vp09`->`vp9`, `avc1`/`h264`->`avc1.640033`, retry `avc1.640033` if unsupported; AV1/VP9 prefer software decode).

**Upstream final-state commits** (all v1.2.0..v1.7.0): 4f68df1d, 2a2d7e7a, de18a2f4, 3d2d0a4d, 05da56fd, d40f40d6, 08aff313, 5e62ad32, 33783829, 61e895a7, 83ea025e, 0c01db7a, 4d4b08db, dd8c001f, d21dd1cb, 46c611bd, 14bbe8f1, 6577a544, cae71ed4, f9401f05, 21361d9b, 2712d8a4, 2a723f11, c2d56ab0, 22db7fae, 8ced98dc, dfdcbc62 (+OPFS chain). Port from `/tmp/openscreen-v1.7.0/src/lib/exporter/streamingDecoder.ts` (767 lines) verbatim; it already contains all of them.

**Capturia mapping.** `src/lib/exporter/videoExporter.ts:exportFramesBySeeking` + `seekVideoToNonBlocking` + `waitForVideoFrame(80 ms)` + `getSourceTimeMsForFrame` (segment-aware via `effectiveToSourceMsWithSegments`). Frame timing comes from `frameClock.ts`. Renderer already accepts `VideoFrame` (`frameRenderer.ts:createTextureFromVideoSource` -> `Texture.from(videoFrame)`), so the render side needs no change.

**Port notes.**
- Add `web-demuxer@^4` and copy `web-demuxer.wasm` to `public/wasm/` (base had it; Capturia removed it). Vite `manualChunks` needs no change; the wasm is loaded by URL relative to `window.location`.
- Timeline adapter (new, small, unit-tested): `segmentsToSpeedTimeline(segments: VideoSegment[], trimRegions, durationSec): SpeedTimelineSegment[]` - Capturia segments are already a partition, so this is `segments.filter(!deleted).map(...)`, intersected with `computeKeepSegments(duration, trimRegions)`. `getExportMetrics` then replaces `getEffectiveDuration`. Keep `playbackSpeed` (global) as a multiplier when `segments` is empty.
- `VideoExporterConfig` gets `decodePath?: 'webcodecs' | 'seek'` (default `'webcodecs'`, env/localStorage override `capturia.exportDecodePath` for support). On `Unsupported codec` / `VideoDecoder error` before the first frame, fall back to the seek path automatically and add a warning key.
- Progress: map `decodeAll` frame callback onto Capturia's `updateProgress` (keep ETA, heartbeat, `phaseDetailKey`).
- The silent-export guarantee is stronger on this path (no media element at all); update `docs/technical-debt/export-silent-pipeline.md` accordingly.
- `onWarning` strings are raw English upstream; map to Capturia i18n keys (`editor.exportWarningDecodeEndedEarly`).

**Tests to bring.** `streamingDecoder.test.ts` (13 cases: `validateDuration`, `shouldFailDecodeEndedEarly`), `timelineSegments.test.ts` (16 cases), `videoExporter.test.ts` `waitForEncoderQueueSpace` block (5 cases). Write new: adapter tests, decodePath fallback test.

**Risks.** `web-demuxer` wasm is ~3 MB and must ship in `dist`; WebM from Capturia's browser recorder (VP9/Opus) exercises the codec-normalisation branches - test on Linux where hardware VP9 decode is absent. Hot files: `videoExporter.ts`, `videoDecoder.ts` (kept), `types.ts`, `index.ts`.

### D2 - Local source read via IPC + OPFS streaming

**What it does.** `materializeLocalSourceFile(url, name, {onProgress, signal})` stats the file (`get-readable-file-info`), reads it whole below `MAX_IN_MEMORY_SOURCE_BYTES` (256 MB, `sourceFileLimits.ts`), otherwise streams 32 MB chunks (`read-file-chunk`, main caps at 64 MB) into an OPFS-backed `File` keyed by `hash(url)-size-mtime`, dedupes concurrent copies, refcounts live readers (`releaseLocalSourceFile`), prunes stale entries (`clearStaleSourceCache` at startup). Main process guards every read through `approveReadableVideoPath` (extension allowlist + approved-path set).

**Final commits.** ea683006, dfdcbc62, a0c0875f, 53589d0d, 3f07f3c6, a977187b, 654375b2, 69d0aa4d, db1d6bfe, d06bf374.

**Capturia mapping.** None. Capturia's `electron/ipc/handlers.ts` has no generic file-read IPC; `RECORDINGS_DIR` + `currentVideoPath` are the only known-good paths. `save-exported-video` is the only path-taking handler and it is unguarded.

**Port notes.** Add to `electron/ipc/handlers.ts`: `read-binary-file`, `get-readable-file-info`, `read-file-chunk` plus a Capturia `approveReadableVideoPath` = (inside `RECORDINGS_DIR`) OR (=== `currentVideoPath`) OR (picked via `open-video-file-picker`), with the upstream extension allowlist. Add to `electron/preload.ts` + `src/vite-env.d.ts` + `electron/electron-env.d.ts`. Port `localSourceFile.ts`, `sourceFileLimits.ts`. Call `clearStaleSourceCache()` from `VideoEditor` mount. Add `'preparing'` to `ExportProgress.phase` and a string in `src/i18n/index.tsx`.

**Tests to bring.** `localSourceFile.test.ts` (15 cases; stubs `window.electronAPI` and OPFS - needs `// @vitest-environment jsdom` in Capturia since default env is node).

### D3 - Audio

**D3a WSOLA + offline timeline (MISSING).** `WsolaTimeStretcher` (`audioTimeStretch.ts`, streaming, grain shrink for short high-speed regions, window-sum normalisation) and `AudioProcessor.renderOfflineTimelineAudio` (routes source PCM into `SpeedTimelineSegment`s, one stretcher per segment, clamps each segment to `round(ceil((dur-eps)/speed*fps)/fps*sr)` samples so A/V never drift, pads underrun with silence, leading-silence fill at segment 0 - 77618ccc, O(1) `PlanarChunkQueue` - 3cb4dd8c, 100x cap - 27363e70). Final commits: 16dea49f, 5e62ad32, 4d4b08db, 27363e70, 3cb4dd8c, 77618ccc, 42a14016, fcea2b15.

Capturia mapping: `videoExporter.ts:forEachAudioFrameSlice` walks `buildKeptRanges` with `AudioBufferSink`, applies `buildAudioGainSegments` (audio edit regions), a two-pass loudness measurement (`accumulateAudioEnergyStats` -> `resolveExportAudioNormalizationGain`), `createAudioSlice` (gain + hard limiter), `muxer.addAudioBuffer`. When `exportSpeed !== 1 || hasSegmentSpeed` it disables audio.

Port plan: keep Capturia's slice pipeline as the *source* and insert the stretcher between slice and mux: for each `SpeedTimelineSegment` (same adapter as D1) create a `WsolaTimeStretcher({sampleRate, channels, speed, expectedOutputSamples})`, push gain-applied planar slices, collect output into `AudioBuffer`s (`PlanarChunkQueue.take` -> `AudioBuffer.copyToChannel`) and call `addAudioBuffer`. Passthrough (`|speed-1|<1e-3`) keeps today's behaviour byte-identical. This removes `EXPORT_WARNING_SPEED_AUDIO_UNAVAILABLE`. Do **not** port `renderPitchPreservedTimelineAudio` (real-time `<audio>` + `MediaRecorder`, wall-clock dependent, calls `media.play()`); upstream itself already routes >16x and multi-track through the offline path, so offline-for-everything is a strict simplification.

Tests: `audioTimeStretch.test.ts` (8), `planarChunkQueue.test.ts` (6). Add: A/V length lock test using `frameClock` + adapter.

**D3b downmix (PARTIAL).** Port `downmixPlanarChannelsForExport` + `getStereoDownmixWeights` (b349c0a2, ac2e34e5) and apply in `createAudioSlice` when `numberOfChannels > 2` (target 2) so AAC config never sees 6/8 channels. Tests: `audioEncoder.test.ts` `downmixPlanarChannelsForExport` block (2). `selectSupportedExportCodec` channel fallback (1 test) folds into D3d.

**D3c multi-track (NA for now).** `sck-recorder.swift:465` writes a single mono AAC track (mic only, `AVNumberOfChannelsKey: 1`); browser recorder mixes before `MediaRecorder`. Nothing to mix. If Stream A adds system audio as a second track, port `mixPlanarSources` + `decodeAudioStreamToPlanes` (mediabunny equivalent: iterate `input.getAudioTracks()` with one `AudioBufferSink` each) and the `audioMixExport.browser.test.ts` cases.

**D3d AAC->Opus fallback (PARTIAL).** Capturia: `isAacEncodingSupported()` false -> audio dropped. Change `muxer.ts` to accept `audioCodec: 'aac' | 'opus'` and pick `'opus'` when `AudioEncoder.isConfigSupported({codec:'mp4a.40.2'})` fails but `'opus'` passes (mediabunny `AudioBufferSource` supports Opus in MP4). Keep the warning only when neither works.

### D4 - Linux canvas readback

Upstream: `FrameRenderer` takes `platform`; on linux `compositeWithShadows` draws `readbackVideoCanvas()` (WebGL `readPixels` + vertical flip into `rasterCanvas`) instead of the Pixi canvas, 2D contexts use `willReadFrequently: true`, and `videoExporter.ts` builds the `VideoFrame` from `getImageData()` bytes rather than the canvas. Commits: 914a3c7f, 3b5ad506, d12f3980, 934f05cc, 2f24038c. Capturia: none of this; `vite.config.ts` passes `--disable-gpu` on Wayland in dev only, packaged builds are unprotected. Port into `frameRenderer.ts` (`initialize`, `compositeWithShadows`, new `readbackVideoCanvas`), `videoExporter.ts:renderAndEncodeFrame`, `gifExporter.ts` (pass `platform`); export `getPlatform` from `src/utils/platformUtils.ts`. Perf cost is linux-only. No upstream unit test; add a small `frameRenderer.test.ts` case asserting `willReadFrequently` is set only for linux.

### D5 - Encoder robustness

Upstream `export()` iterates `getEncoderPreferences()` (`['prefer-software','prefer-hardware']` on Windows, reverse elsewhere), rebuilding everything per attempt; `waitForEncoderQueueSpace` throws after 15 s of a full queue with a preference-specific message; software attempts cap the queue at 32; encoder `error` callback sets `fatalEncoderError` and cancels decoders; flush has a 20 s timeout. Commits: 2a2d7e7a, b5cc7777, c2d56ab0, 22db7fae. Capturia: `initializeEncoder` tries hw then sw via `isConfigSupported` only; encoder errors set `muxingError` + `cancelled`; queue wait is an unbounded `queueMicrotask` spin (`renderAndEncodeFrame`); 120 s finalize timeouts. Port the retry loop and `waitForEncoderQueueSpace` (with its 5 tests); keep `latencyMode: 'realtime'`, 4 s GOP, Capturia's heartbeat/ETA. Windows software-first ordering: keep as upstream (it was the fix for 2a2d7e7a stalls) but make it a constant so it can be flipped.

### D7 / D8 - Presets and Native aspect

Keep `mp4ExportPlan.ts`. For D8 port `'native'` into `src/utils/aspectRatioUtils.ts` (`ASPECT_RATIOS`, `getNativeAspectRatioValue`, `getAspectRatioLabel` -> "Original", `formatAspectRatioForCSS`), `calculateEffectiveSourceDimensions` from upstream `mp4ExportSettings.ts`, and the `aspectRatio === 'native'` branches in `VideoEditor.tsx` (`handleExport`, `handleOpenExportDialog`, padding forced to 0 - c8ebef02, 9348b9c7) and `VideoPlayback.tsx:2060`. Capturia specifics: `normalizedExportAspectRatios`, `zoomRegionsByAspect`, `cropRegionsByAspect`, `resolveAspectCropRegion` must tolerate `'native'` as a key, and the GIF `calculateOutputDimensions` gains the upstream `aspectRatioValue` parameter (upstream `gifExporter.test.ts`, 2 cases). Persisted project state (B3) must accept the new value.

### D10 / D11 - Save flow and diagnostics

Capturia already picks the path first (`pick-save-file-path`, e22e141) and reveals in folder (b86d073). Gaps: (1) `save-exported-video` writes any `targetFilePath` the renderer sends - add the `write-export-to-path` checks (absolute, `.mp4|.gif`, `path.normalize`) from 08aff313; (2) remember the last folder (`userPreferences.exportFolder` upstream; Capturia has `localStorage` prefs under `capturia.*` - add `capturia.exportFolder` and pass it to `pick-save-file-path`/`pick-export-directory` as `defaultPath`, validated in main with `fs.stat`); (3) keep the finished blob in `unsavedExport` state when the write fails and offer "Save again" (c3228259); (4) diagnostics helpers from 156e9c1e + `whitespace-pre-line` on the error box (559e97dd). All S; touch `VideoEditor.tsx`, `ExportDialog.tsx`, `handlers.ts`, `preload.ts`.

### D13 - Source-copy fast path

`getSourceCopyFastPathBlockers` returns human-readable blockers (size mismatch, multi-track audio, webcam, trims, speed, zoom, annotations, cursor overlay, crop, padding, radius, shadow, blur, motion blur); if none and the source is an MP4 <= 256 MB, `loadSourceBlob()` (IPC read) is returned as the export. Commits 34e22d00, 0d9e8211, 4e5b7a4f, 238fc97c. Capturia blockers to add: `subtitleCues`, `cursorTrack`, `audioEditRegions`, `audioGain !== 1`, `audioEnabled === false` with source audio present, `segments` with `deleted || speed !== 1`, `audioProcessing.normalizeLoudness` (default **true**, so either skip the fast path or measure first and allow it when `appliedGain ~= 1`). Only macOS SCK recordings are MP4; browser/Linux recordings are WebM, so benefit is macOS-only. Tests: `videoExporter.test.ts` `isSourceCopyFastPathEligible` + blockers (5 cases).

### D16 - Browser-mode vitest

`vitest.browser.config.ts` (`@vitest/browser` + `@vitest/browser-playwright`, chromium with swiftshader flags, 120 s timeout, `assetsInclude ['**/*.webm']`), `npm run test:browser`, `test:browser:install`. Capturia gains a way to run `VideoExporter.export()` end to end and to assert the silent-pipeline invariant (`play` never fires) in a real browser. Dev deps: `@vitest/browser@^4.1`, `@vitest/browser-playwright@^4.1`, `playwright`; CI needs `playwright install --with-deps chromium-headless-shell`. Bring `videoExporter.browser.test.ts` (3, rewrite for Capturia config) and `gifExporter.browser.test.ts` (3); the `BackgroundLoadError` cases only apply if B1 ports `src/lib/wallpaper` (Capturia's `setupBackground` silently falls back to black - a behaviour difference B1 should decide).

### D19 - Recording mix fade-in (Stream A decides)

`audioMix.ts:mixAudioTracks` ramps mic gain 0 -> target over 20 ms to hide the first-packet click (e736ff4a, f698bba6). Capturia's `useScreenRecorder.ts:buildAdjustedMicrophoneStream` applies user gain + a DynamicsCompressor limiter with no ramp. Port only `gain.setValueAtTime(0); linearRampToValueAtTime(userGain, now + 0.02)`; skip the fixed 1.4x boost (Capturia exposes `microphoneGain`). Tests: adapt 3 of the 5 `audioMix.test.ts` cases.

## 3. Captions architecture decision

### 3.1 What each side has

**Capturia (keep as primary).** `electron/native/macos/speech-transcriber.swift` (`SFSpeechURLRecognitionRequest`, word timestamps + confidence, optional `--start-ms/--duration-ms`) driven by `electron/native/transcriber.ts:transcribeVideoFile` (auto-compiles in dev, 90 s overlapping segments for >6 min, `no_speech_detected`/`speech_permission_denied` codes). `electron/analysis/videoAnalysisService.ts` queues jobs (`AnalysisJobQueue`), runs `buildVideoAnalysisResult(words, {durationMs, videoWidth, subtitleWidthRatio, locale})` (`src/lib/analysis/videoAnalysisPipeline.ts`) which yields `SubtitleCue[]` (`subtitleEngine.ts`: CPS/char/duration constraints, CJK-aware) and `RoughCutSuggestion[]` (`roughCutEngine.ts`: silences >= 800 ms, filler runs, en + zh fillers), writes `<video>.analysis.json`. Renderer: `VideoEditor.tsx:handleGenerateSubtitles` -> `analysis-start` -> poll `analysis-status`/`analysis-result` -> `applyAnalysis` -> `subtitleCues` state, rendered by `VideoPlayback` and `frameRenderer.ts:renderSubtitleLayer` (`subtitleLayout.ts`), persisted in project state; rough cuts become `AudioEditRegion`s (`roughCutApply.ts`). On Windows/Linux `transcribeVideoFile` returns `unsupported_platform` and the feature is dead.

**Upstream v1.7.0 (add as fallback).** Renderer-only: `extractMono16kFromVideoUrl` (decodeAudioData, else web-demuxer + `AudioDecoder`, 16 kHz mono, 4 h cap, 30 min cap for >256 MB sources) -> `trimLeadingSilenceMono16k` -> `transcribeMono16kToSegments` (Web Worker `transcribe.worker.ts`, `@xenova/transformers` `pipeline('automatic-speech-recognition','Xenova/whisper-tiny')`, `transcribeCore.runTranscription`: 12-min slices, 30 s chunking, tries word timestamps then phrase, trim-aware retries) -> `CaptionSegment[]` + `granularity` -> `captionSegmentsToAnnotationRegions` (text annotations, `annotationSource: 'auto-caption'`). Packaged builds load model + ORT wasm from `caption-assets/` (`fetch-caption-model.mjs` at `beforePack`, `extraResources`, `--asset-base-url` preload arg, `numThreads=1` because no SAB under `file://`). Commits: 7216f255, 1c431fe4, 2b7e6f16, 3a48e54d, a0bcd9fe, 2ee00a7c, e5462f1a, 3e3a8168, 5f71979e, c539e9ba, + OPFS chain.

**Upstream v1.8+ (note only).** Replaced by native whisper.cpp helper (`electron/native/whisper-stt`, `electron/stt/{index,modelManager,gpuDetector,chunking,transcriptionContract}.ts`, DTW word timestamps, model download manager, chunked cancellable runs) and captions became a transcript-derived layer (876e4692). `@xenova/transformers` and `fetch-caption-model.mjs` were removed (a9fdd97f). This is the better engine but it is a native build (CMake, per-platform binaries, GPU detection) - out of scope now; design the seam so it can slot in later.

### 3.2 Decision

**Keep Capturia's native macOS transcriber as the primary engine. Add upstream's in-browser Whisper as the cross-platform fallback engine, feeding Capturia's existing `TranscriptWord[]` pipeline (not the annotation path).** Feasible; the seam is narrow.

**Seam.** Introduce `src/lib/analysis/transcriptionEngine.ts`:

```ts
export interface TranscriptionRequest { videoPath: string; videoUrl: string; locale: string; durationMs: number; trimRegions?: TrimRegion[]; signal?: AbortSignal; onStatus?: (phase: 'model'|'transcribe'|'native') => void }
export interface TranscriptionEngine { id: 'macos-speech' | 'whisper-web'; transcribe(req): Promise<VideoTranscriptionResult> } // VideoTranscriptionResult is electron/native/transcriber.ts's type, moved to src/lib/analysis/types.ts
```

- `macos-speech` engine = existing IPC round trip (`analysis-start` ... `analysis-result`), unchanged.
- `whisper-web` engine = ported `captioning/` modules + a new adapter `captionSegmentsToTranscriptWords(segments, granularity): TranscriptWord[]`:
  - `granularity === 'word'`: 1 segment -> 1 word (`startMs/endMs` rounded, `confidence` undefined).
  - `granularity === 'phrase'`: split each phrase with upstream's `expandPhraseSegmentToPseudoWords` (char-weight interpolation, already in `annotationsFromCaptions.ts`) and mark them `synthetic: true` (new optional field on `TranscriptWord`). `roughCutEngine.generateRoughCutSuggestions` must ignore gaps between synthetic words of the same phrase (otherwise interpolated pseudo-words create no gaps, fine, but phrase boundaries still give real silences - acceptable), and `subtitleEngine` works unchanged.
  - Feed `buildVideoAnalysisResult(words, config)` in the renderer (it is pure `src/lib` code), then persist through a new IPC `analysis-save-sidecar(videoPath, analysis)` so `analysis-get-current` keeps working across sessions. Reuse `analysisJobId`/polling UI by wrapping the renderer run in a local job object, or simplify to a promise with the existing toasts.
- Selection in `VideoEditor.tsx:handleGenerateSubtitles`: call native first; if `result.code in {unsupported_platform, speech_permission_denied, recognizer_unavailable}` and `whisper-web` is available (feature flag + assets present), run the fallback and tell the user which engine produced the result. Optional setting `captions.engine: 'auto' | 'native' | 'whisper'`.

**Audio extraction.** If D2 lands first, port `extractMono16k.ts` + `extractMono16kWebDemuxer.ts` as-is. If captions ship before D1/D2, replace the web-demuxer branch with mediabunny (`Input` + `AudioBufferSink`, already used in `videoExporter.ts`) to avoid the wasm dependency; the `decodeAudioData` primary path needs the file bytes, which requires the `read-binary-file` IPC either way (fetch of `file://` is unreliable in the renderer - ea683006). So **D2's IPC handlers are a hard prerequisite** for C1 regardless.

**Packaging and dependencies.**
- `@xenova/transformers@^2.17.2` (Apache-2.0). Pulls `onnxruntime-web` (wasm ~10 MB shipped, only the two non-threaded files are copied) and an optional `sharp` native dep that upstream had to special-case in `electron-builder.json5` ("sharp ships ABI-stable ... breaks on CI") - expect the same friction with Capturia's `electron-builder@24`; consider `--config.npmRebuild=false` or `"asarUnpack"`.
- Model `Xenova/whisper-tiny` quantized: upstream's own UI string says "first use downloads ~75 MB"; bundled via `caption-assets/` (`fetch-caption-model.mjs`, idempotent, retry/backoff for HF 429) + `beforePack` hook + `extraResources` + `.gitignore`. Adds ~85 MB to every installer on every platform (also macOS, where it is only a fallback) - decide whether to bundle only on win/linux targets (electron-builder per-target `extraResources` in `win`/`linux` blocks is possible) or download on first use to `userData` (upstream v1.8 `modelManager.ts` pattern; simpler UX cost).
- Vite: aliases for `fs/path/url` -> `src/lib/vite-stubs/empty-node-module.ts`, `onnxruntime-node` -> `onnxruntime-node-stub.ts`, `optimizeDeps.exclude`, `worker.format = 'es'`; `electron/windows.ts` must pass `--asset-base-url=<file URL of resources>` in `additionalArguments` and `preload.ts` exposes `assetBaseUrl` (Capturia has `get-asset-base-path` IPC instead; the worker cannot call IPC, so the preload arg is needed).
- `process.versions.node` masking in the worker (`withoutNodeVersion`) is required under Electron - keep.

**Quality caveats (be explicit in the UI).** whisper-tiny is weak for Chinese (Capturia supports `zh-CN`, `subtitleEngine` has CJK rules); word-level timestamps depend on the `output_attentions` revision that upstream found unreliable, so Windows/Linux users will mostly get phrase-level timing split proportionally - subtitles fine, rough-cut silence detection coarser. Model id and size should be a constant so `whisper-base`/`small` can be offered later (base ~150 MB, small ~500 MB). Whisper has no `locale` input in upstream's call; pass `language` from Capturia's locale (`transformers` supports `language`/`task` options) to stop auto-detection flips.

**Effort.** L: ~2 days engine + adapter + IPC, ~1 day packaging (assets, builder, CI), ~1 day tests and both-platform smoke. Files: new `src/lib/captioning/{transcribe,transcribeCore,transcribe.worker,extractMono16k,extractMono16kWebDemuxer|Mediabunny,leadingSilence,captionConstants}.ts`, new `src/lib/analysis/{transcriptionEngine,whisperWords}.ts`, `src/lib/analysis/types.ts` (+`synthetic`), `src/lib/analysis/roughCutEngine.ts` (synthetic guard), `electron/analysis/videoAnalysisService.ts` (`saveSidecar` export), `electron/ipc/handlers.ts` (+`analysis-save-sidecar`, D2 reads), `electron/preload.ts`, `electron/windows.ts`, `src/vite-env.d.ts`, `electron/electron-env.d.ts`, `vite.config.ts`, `src/lib/vite-stubs/*`, `electron-builder.json5`, `scripts/{fetch-caption-model.mjs,before-pack.cjs}`, `.gitignore`, `package.json`, `src/i18n/index.tsx` (`autoCaptions.*` en + zh), `VideoEditor.tsx` (engine selection).

**Tests to bring / write.** Upstream has only `annotationsFromCaptions.test.ts` (6) - bring the grouping/split cases if C2 is done; `transcribeCore.ts` has none in v1.7 - write tests for `runTranscription` with a fake `TranscriberFn` (slicing, word->phrase fallback, trim filtering), `trimLeadingSilenceMono16k`, `shiftTrimRegionsMsForCaptionBuffer`, the `captionSegmentsToTranscriptWords` adapter, and `videoAnalysisPipeline` with synthetic words.

### 3.3 C2 - captions as annotations (optional)

Capturia's subtitle track is the right primary model (styled, layout-constrained, exported by `renderSubtitleLayer`). If users want editable/movable captions, add a "Convert subtitles to text annotations" action that maps `SubtitleCue[]` through `captionSegmentsToAnnotationRegions` (S). Not a sync blocker.

## 4. Recommended implementation order

Each batch is independently reviewable/testable; "hot" marks shared files that other streams also touch.

| Batch | Contents | Hot files touched | Depends on |
|---|---|---|---|
| **D-0** (S) | D9 GIF workers; D3d AAC->Opus; D11 diagnostics; D10 save-path guard + folder memory + `unsavedExport`; D17 interim duration override; D19 fade-in (if A agrees) | `ExportDialog.tsx`, `handlers.ts`, `preload.ts`, `VideoEditor.tsx`, `muxer.ts` | - |
| **D-1** (S) | D4 Linux readback | `frameRenderer.ts`, `videoExporter.ts`, `gifExporter.ts` | - |
| **D-2** (M) | D8 Native/Original aspect (+ `calculateEffectiveSourceDimensions`, GIF aspect param) | `VideoEditor.tsx`, `VideoPlayback.tsx`, `aspectRatioUtils.ts`, project-state schema (B3) | coordinate with B3 |
| **D-3** (M) | D2 file-read IPC + path approval + `localSourceFile` + `sourceFileLimits` + `'preparing'` phase | `handlers.ts`, `preload.ts`, `types.ts`, `vite-env.d.ts`, `electron-env.d.ts` | - |
| **D-4** (XL) | D1 streaming decoder + segment adapter + D5 encoder retry/stall + D6/D17 via `getExportMetrics`, behind `decodePath` with seek fallback; update debt note | `videoExporter.ts`, `videoDecoder.ts`, `types.ts`, `index.ts`, `package.json`, `public/wasm` | D-3 (for local loading), D-1 |
| **D-5** (L) | D3a WSOLA offline audio + D3b downmix, integrated with gain/normalisation; remove speed warning | `videoExporter.ts`, `muxer.ts`, `src/lib/audio/*` | D-4 (segment adapter) - can start on the adapter in parallel |
| **D-6** (M) | D13 source-copy fast path with Capturia blockers | `videoExporter.ts`, `VideoEditor.tsx` | D-3 |
| **D-7** (M) | D16 browser-mode vitest + silent-export browser assertion + CI job | `package.json`, CI workflow | none (best after D-4 so the decoder is covered) |
| **C-1** (L) | Whisper fallback engine + adapter + sidecar IPC + packaging | `handlers.ts`, `preload.ts`, `windows.ts`, `vite.config.ts`, `electron-builder.json5`, `VideoEditor.tsx` | D-3 (IPC reads) |
| **C-2** (S, optional) | Subtitle -> annotation conversion | `VideoEditor.tsx` | - |
| with B1 | D14 webcam frame queues + `webcamFrameDrawing.ts`, D15 `threeDPass.ts` linux readback | `videoExporter.ts`, `frameRenderer.ts` | B1 webcam composite |

Rationale for order: D-0..D-3 are low-risk and unblock both the decoder and captions; D-4 is the big one and should run on its own worktree with the `decodePath` flag defaulting to `'seek'` until the browser tests (D-7) pass on all three platforms, then flipped.

## 5. Do NOT port / keep Capturia's version

| Upstream item | Why not |
|---|---|
| `mp4ExportSettings.ts` (resolution/bitrate presets) | Capturia `mp4ExportPlan.ts` never upscales and scales bitrate with fps; upstream still upscales short sources to 1080p. Take only `calculateEffectiveSourceDimensions`. |
| `muxer.ts` `EncodedAudioPacketSource`-only design | Capturia's `AudioBufferSource` PCM path is what enables gain, audio-edit regions, loudness normalisation and the limiter. Extend it (codec param), do not replace. |
| `AudioProcessor.renderPitchPreservedTimelineAudio` / `muxRenderedAudioBlob` / `startAudioRecording` | Real-time `<audio>` + `MediaRecorder` capture: wall-clock bound, calls `play()`, non-deterministic, capped at 16x. WSOLA offline covers all speeds. |
| `AudioProcessor.processTrimOnlyAudio` decode->re-encode path | Capturia's mediabunny slice path already does trim + gain in one pass with fewer moving parts. |
| `latencyMode: 'quality'`, keyframe every 150 frames, `MAX_ENCODE_QUEUE` microtask replaced by 5 ms sleeps | Capturia's `'realtime'` + 4 s GOP came from the measured 2-3x perf work (7a66962). Keep; only add the stall timeout. |
| Upstream `ExportProgress` (no ETA/heartbeat) and `VideoEditor.tsx` export flow (single aspect, save-after-export, `saveUserPreferences`) | Capturia has save-first, multi-aspect batch, background float (`ExportProgressFloat.tsx`), heartbeat/ETA/stall detection. Port only the small pieces listed in D10/D11. |
| Raw-string export warnings | Capturia uses i18n keys (`editor.exportWarning*`); map ported warnings to keys. |
| `frameRenderer.ts` wholesale | Upstream file carries webcam/3D/native-cursor/motion-blur (B1/B2 scope). Cherry-pick D4 only. |
| `asyncVideoFrameQueue.ts` | Unused in upstream v1.7.0 (only `TimestampedVideoFrameQueue` is referenced). |
| Captions as annotation regions as the *primary* caption model | Capturia's `SubtitleCue` track + `subtitleEngine` constraints + `renderSubtitleLayer` are richer and already exported/persisted. |
| `@xenova/transformers` Whisper as primary on macOS | Native `SFSpeechRecognizer` gives real word timestamps + confidence and no 75 MB model. Fallback only. |
| `audioMix.ts` fixed `MIC_GAIN_BOOST = 1.4` | Capturia exposes user `microphoneGain` with a limiter; take only the fade-in. |
| Upstream vitest `jsdom` default | Capturia defaults to `node` (faster); opt in per file. |
| `loadFileAsArrayBuffer` (waveform loading) | Belongs to B3's `useAudioPeaks` decision; not needed by the exporter after D2. |
| `videoDecoder.ts` deletion | Keep Capturia's `VideoFileDecoder` (silent guard + tests) as the fallback decode path. |

## 6. Open points / uncertain

- Whether the team wants `web-demuxer` (ffmpeg wasm, exact upstream code + tests) or a mediabunny-based decoder (one dependency, new code, no upstream tests). This report recommends `web-demuxer` for fidelity; revisit if packaging the wasm is a problem.
- Model bundling policy for C1 (bundle everywhere vs win/linux only vs first-use download) - product decision, affects installer size by ~85 MB.
- `sharp` optional dependency of `@xenova/transformers` under Capturia's `electron-builder@24` - verify on a real build before committing to C1 batch scope.
- D13 value is macOS-only today (only SCK writes MP4); may not be worth M effort until Windows native capture (Stream A) lands.
- D3c multi-track becomes relevant only if Stream A adds system audio as a second track in `sck-recorder.swift`.
