# Capturia upstream re-audit (post-sync, 2026-09-03)

Read-only. Repo `feat/upstream-sync-v1.7` @ `29d0ff3`. References: `/tmp/openscreen-base` (87735c27),
`/tmp/openscreen-v1.7.0`, `/tmp/openscreen-upstream` (main @ 059f4e89, v1.10.0).

Method: (1) all `docs/upstream-sync/{README,PLAN,PROGRESS}.md` + 23 review notes + 6 gap reports read,
deferred items collected; (2) `87735c27..v1.7.0` (418 first-parent / 808 commits) and `v1.7.0..HEAD`
(1011 commits, 416 touching shared paths) bucketed by path, every non-ai-edition/non-Rust commit
checked against the Capturia tree by grep; (3) `git diff v1.7.0..HEAD` on every file Capturia ported
at v1.7.0 level, plus per-file history of the v1.8+ modules ported (update-checker, about,
install-channel, edit-menu, main-process-errors, webcamDeviceIdentity, NotesWindow.css);
(4) upstream v1.7.0 `locales/en/*.json` (499 keys) flattened and compared with Capturia's 623 en keys
by name and by value; (5) upstream README (v1.7.0 + main) and ROADMAP claims verified in code.

Classification: **copy** = portable near-verbatim; **reimplement** = same behaviour on Capturia's
architecture; **skip** = v1.8+ editor/Rust, or contradicts a `PLAN.md` decision; **verify** = present,
but a runtime check is owed. Effort S < 0.5 d, M 0.5–2 d, L 2–5 d, XL > 5 d.

Hot files: `VideoEditor.tsx` (VE), `SettingsPanel.tsx` (SP), `VideoPlayback.tsx` (VP),
`frameRenderer.ts` (FR), `videoExporter.ts` (VX), `useScreenRecorder.ts` (USR), `electron/ipc/*` (IPC),
`electron/main.ts` (MAIN), `LaunchWindow.tsx` (LW), Swift helper (SWIFT).

Totals: **copy 17, reimplement 19, skip 21, verify 5** (excluding the wave-5 round-1 exclusions).

---

## A — Recording / HUD / native capture

| # | Item | Upstream ref | Capturia status (evidence) | Class | Effort | Batch |
|---|---|---|---|---|---|---|
| A-1 | **System audio, browser path**: HUD toggle, `getDisplayMedia({audio})`, main `setDisplayMediaRequestHandler` `audio:'loopback'` (win32), mic+system mix with 20 ms ramp | v1.7.0 `useScreenRecorder.ts:1197-1247,1335-1399`, `main.ts:547-557`, `src/lib/audioMix.ts`; keys `launch.audio.*`, `editor.recording.systemAudioUnavailable` | DONE (R5-A1 batch: `src/lib/audioMix.ts`, `systemAudioEnabled` in `useScreenRecorder.ts`, HUD toggle, win32 `audio:'loopback'` in the display-media handler; Linux via the desktop-audio constraint, macOS via the helper only; see `reviews/R5-A1-system-audio-hud.md`) | reimplement | M | **R5-A1** (USR, LW, MAIN) |
| A-2 | **System audio in the SCK helper**: `capturesAudio=true`, `.audio` stream output, AAC writer input, clock-driven audio PTS, single mixed track | v1.7.0 `main.swift:172,282,410-423,464-511`; v1.9 fixes 71428067, 7e6cde3f, 4adbec5d, 0d4637d4, efe5accc; HEAD `AudioTrackMixer.swift` | MISSING. `sck-recorder.swift:1119 config.capturesAudio = false` | reimplement | L (macOS) | **R5-SW** (SWIFT, sckRecorder.ts) |
| A-3 | CoreGraphics init before building a window `SCContentFilter` (`_ = CGMainDisplayID()` at helper start; SkyLight abort on macOS 26 / Electron 41) | b2973a89, 439ef59c → `ScreenCaptureRecorder.swift:813-819` | MISSING. No `CGMainDisplayID`/`CGDisplayPixelsWide` in `sck-recorder.swift` | copy | S (macOS) | **R5-SW** |
| A-4 | Exclude Capturia's own windows from `get-sources` ("recording inception": HUD/selector appear in the picker) | c8d4e867 (`BrowserWindow.getAllWindows().map(getMediaSourceId)`) | MISSING. `electron/ipc/permissions.ts:518-533` maps all sources; no `getMediaSourceId` in `electron/` | copy | S | **R5-IPC** (IPC) |
| A-5 | Dismiss HUD popovers when the window loses focus (click on the desktop never reaches the renderer; Escape undeliverable) | 54e12706 (`window.addEventListener('blur', closePopovers)`, 8 tests) | DONE (R5-A1 batch: all four popovers controlled and closed from a window `blur` listener, 6 tests; see `reviews/R5-A1-system-audio-hud.md`) | reimplement | S | **R5-HUD** (LW) |
| A-6 | Camera unplugged mid-recording: `track.onended` → toast, recording continues | #325 (1f99fcb4), key `editor.recording.cameraDisconnected` | DONE (R5-A1 batch: the overlay drops on the track's `ended` event, `editor.recordingCameraDisconnected`, recording continues; see `reviews/R5-A1-system-audio-hud.md`) | reimplement | S | **R5-A1** (USR) |
| A-7 | Camera/mic name matching on word boundaries, non-Latin names kept apart (substring match picks the wrong device) | de3fef6a, bdfeec7f → `electron/recording/deviceNameMatching.ts` | PARTIAL. `sck-recorder.swift:398-421 matchDevice` = exact → strip `(vid:pid)` → **substring `contains`** | reimplement | S (Swift) | **R5-SW** |
| A-8 | Native microphone device selection in the SCK helper (W3-e TODO) | v1.7.0 `main.swift:630-639` (by name, then id) | MISSING on native path; browser path has picker (`useMicrophoneDevices`) | reimplement | M (macOS) | **R5-SW** |
| A-9 | Drop `ideal 1280x720` camera constraints (respect native orientation) | b5c105b5 (gap W9) | DONE (R5-A1 batch: the ideal 1280x720 is gone, portrait cameras keep their native orientation; see `reviews/R5-A1-system-audio-hud.md`) | copy | S | **R5-A1** (USR) — low value while the overlay is burned in |
| A-10 | Wayland capture flags: `ozone-platform=wayland`, `enable-features=WaylandWindowDrag,WebRTCPipeWireCapturer` | #484 (f7d1bc6f) `main.ts:33-42`; PLAN: "re-test on Electron 41" | DIFFERENT. `electron/main.ts:74-75` only `--disable-gpu`/`--disable-gpu-compositing` | verify | S (Wayland box) | **R5-LX** (MAIN) |
| A-11 | `disable-features=MacCatapLoopbackAudioForScreenShare` (dev crash when `getDisplayMedia({audio})` on macOS) | v1.7.0 `main.ts:30` | DONE (R5-A1 batch: the switch is applied on darwin at startup; see `reviews/R5-A1-system-audio-hud.md`) | copy | S | **R5-A1** (MAIN) |
| A-12 | Notes teleprompter mode (auto-scroll, speed, font size, localized readouts) | 44e16483, e383f9be, 7dba0f94 → `notesTeleprompter.ts` (+177-line test), `NotesToolbar.tsx` | MISSING (`grep teleprompter src` empty) | copy | M | **R5-NOTES** (NotesWindow/Toolbar only) |
| A-13 | Tray carries Save Diagnostics / Check for Updates / About (menu bar is hidden on win/linux) | a6a22a9c, 56241090 | PARTIAL. App menu has them (`main.ts:521-650`); tray = stop/open/quit (`main.ts:347-354`) | copy | S | **R5-IPC** (MAIN) |
| A-14 | `LaunchWindow` reads `getStopRecordingShortcut()` on mount instead of localStorage (W3-c backlog) | Capturia-own | DONE (R5-A1 batch: main's registered accelerator wins on mount, the persisted value is only the fallback, 2 tests; see `reviews/R5-A1-system-audio-hud.md`) | reimplement | S | **R5-HUD** (LW) |
| A-15 | System-language suggestion prompt on first launch | #362, 3a81f554, b655acf9; keys `launch.systemLanguagePrompt.*` | MISSING (W1-a chose silent auto-detect for complete locales) | skip (decision W1-a) — revisit only if more locales become complete | S | — |
| A-16 | `openSourceSelectorFlow` retry after macOS not-determined prompt | #652 | skip (PLAN: Capturia permission checker) | skip | — | — |
| A-17 | `captureBounds` in helper ready line; `useScreenRecorder` detached-promise hardening | 3ef2001f; 135c360d | optional; Capturia has `windowBounds.ts` refresh loop | skip | — | — |
| A-18 | Webcam sidecar, click-through HUD, vertical tray, WGC helper, v1.8 HUD rewrite (`HudControls`, `hudGeometry`), `useCameraPreviewStream`, PipeWire native helper, CLI | — | wave-5 exclusions / v1.8+ | skip | — | — |

## B1 — Composite / backgrounds / preview

| # | Item | Upstream ref | Capturia status | Class | Effort | Batch |
|---|---|---|---|---|---|---|
| B1-1 | **Wallpaper picker thumbnails** (240 px `wallpapers/thumbs/*.jpg`; grid decoded 18 full-res originals ≈ 20 MB) | 792de0f3 → `wallpaper.ts WALLPAPER_THUMB_PATHS` | MISSING. `SettingsPanel.tsx:468,1739` resolves and renders `WALLPAPER_PATHS` originals | copy (+ one-off thumb generation script) | S | **R5-BG** (SP, wallpaper.ts, public/) |
| B1-2 | **Free-form crop with aspect-lock toggle + ratio select** (Free / 16:9 / …; lock/unlock) | v1.7.0 `SettingsPanel.tsx:541-592,1955-1998`; keys `settings.crop.{ratio,free,lockAspectRatio}` | MISSING. Crop is per-aspect and always locked (`PreviewAspectCropOverlay`, `aspectCrop.ts`); W3-d noted "Original stays aspect-locked" | reimplement | M | **R5-CROP** (SP, VE, aspectCrop.ts, PreviewAspectCropOverlay) |
| B1-3 | **WebGL context-loss recovery** for the Pixi preview (`webglcontextlost` → `preventDefault` + `pixiGeneration` bump → rebuild) | 1fd31855 (`createWebGLContextLostHandler` + test); ROADMAP #19 | MISSING. No `webglcontextlost` in `src/` | copy | S | **R5-VP** (VP) |
| B1-4 | 3D presets retuned: `iso -12/-18/-2`, `left -8/-16/-1`, `right -8/16/1`, perspective factor 2.6 → 1.6 ("recording looks truncated" ×3 reports: an edge parallel to the frame reads as clipping) | 19198dc6 (`types.ts` part; shadow/contain parts are Rust) | OLD VALUES. B1-e ported v1.7.0 constants | copy (constants + parity tests) | S | **R5-VP** (types.ts, threeDPass test) |
| B1-5 | `Switch` unchecked track `#52525b`, thumb white (unchecked toggles invisible on dark panels) | 96e178c4 | OLD. `src/components/ui/switch.tsx:13` `#23232a` | copy | S | **R5-UI** |
| B1-6 | Defaults on: roundness 40, shadow 0.2, motion blur 0.2 | 5cfea748 | Product choice; Capturia defaults kept | skip | — | — |
| B1-7 | Background image refused-by-MIME message | c44e978a | PRESENT. `backgroundImageUpload.ts` (W0-c) already falls back to extension; toast `settings.uploadJpgOnly` = "JPG or PNG" | — | — | — |
| B1-8 | Gradient editor, blur regions, webcam-in-editor W1–W10, dual-frame, reactive zoom, Full Camera | — | wave-5 exclusions / product decisions | skip | — | — |

## B2 — Zoom / cursor

| # | Item | Upstream ref | Capturia status | Class | Effort | Batch |
|---|---|---|---|---|---|---|
| B2-1 | "Clip to Canvas" info tooltip (`settings.cursor.clipToBoundsDescription`) | 1d7b677f | MISSING. `SettingsPanel.tsx:1312-1319` plain switch; `ui/tooltip.tsx` exists (only used by Notes) | copy | S | **R5-UI** (SP) |
| B2-2 | Hide click-effect controls where clicks cannot be observed (Wayland) | HEAD `cursorCapabilities.ts` | N/A-ish: Capturia tracker is off on Wayland and heuristic on X11; could gate highlight/ripple UI on `track.events.length` | reimplement | S | **R5-UI** (SP) — optional |
| B2-3 | C5 click bounce, C6 spring path smoothing | e49cc02d, d0341580 | skipped by W2-d decision (Capturia pulse/Gaussian) | skip | — | — |
| B2-4 | Cursor themes, real cursor bitmaps, Windows sampler, upstream SVG glyphs | b088a098, e6b96d3b, #621 | wave-5 exclusion / licence | skip | — | — |
| B2-5 | Scrub state + resolution drop, rafCoalescer, overlaySize, connected transitions, auto-follow | 7e00cdb1, #491, … | PRESENT (`VideoPlayback.tsx:212-214,942`, `:215-217`, `:769`) | — | — | — |

## B3 — Timeline / project / editor

| # | Item | Upstream ref | Capturia status | Class | Effort | Batch |
|---|---|---|---|---|---|---|
| B3-1 | **Preview at speed > 16×**: frame-stepped, muted preview + hint (`settings.speed.previewFrameSteppingHint`) instead of silently clamping | 27363e70 (raise cap to 100×, `VideoPlayback` frame stepping); gap B3 bug #6 | BUG OPEN. `videoEventHandlers.ts:117` clamps `playbackRate` at 16; `MAX_PLAYBACK_SPEED = 40` (`types.ts:348`) → 20×/40× segments preview at 16× | reimplement | M | **R5-VP** (VP, videoEventHandlers) |
| B3-2 | **Waveform for huge sources**: skip above `MAX_IN_MEMORY_SOURCE_BYTES` or stream peaks via web-demuxer + OPFS (`streamingAudioPeaks.ts`) | 3f07f3c6, a977187b, 654375b2; v1.7.0 `hooks/streamingAudioPeaks.ts` | MISSING. `useAudioPeaks.ts` reads the whole file via `readBinaryFile` with no threshold (W2-b skipped "needs web-demuxer" — now present) | copy | M (S for threshold-only) | **R5-WAVE** (useAudioPeaks, TimelineEditor prop) |
| B3-3 | **Editor shortcuts under modals**: `aria-modal="true"` on `DialogContent` + `isModalOpen()` guard before global shortcuts/undo | 1cc63df4, 65aa74ef, 95e350e0 (guard is ai-edition, dialog change is `ui/dialog.tsx`) | MISSING. `ui/dialog.tsx` has no `aria-modal`; `VideoEditor.tsx:2221` keydown only checks `isTextEditingTarget` | reimplement (dialog.tsx = copy) | S | **R5-KEYS** (VE keydown, dialog.tsx) |
| B3-4 | **Project state survives a moved/renamed recording** (size + head/tail fingerprint registry; relink on open) | 2c234456, a1cd8fc1, 53242cfa → `electron/media/mediaLinksRegistry.ts`, `projectMediaRelinker.ts` (+tests) | MISSING. `save-project-state` keyed by video path (`electron/ipc/projectState.ts`); moving the file orphans the sidecar and the `.cursor.json` | reimplement | M | **R5-PROJ** (projectState.ts, VE load path) |
| B3-5 | Speed typing → one undo entry per commit (`onSegmentSpeedCommit`) | W3-b backlog | OPEN | reimplement | S | **R5-KEYS** (SP, VE) |
| B3-6 | `resetDurationResolution` after project reload (duration cap stuck to first metadata) | a9cbfef4 | Capturia has its own probed-duration flow (D17); not reproduced | verify | S | manual smoke |
| B3-7 | T15 rAF-decoupled playhead; plain-wheel pan; right-click copy/paste menu | 760eea72, 8f41dbce; ROADMAP #24 half | skipped (hover-preview conflict) / never shipped upstream | skip | — | — |
| B3-8 | i18next + plural categories; `customPlaybackSpeed` `Number()` parser; editorDefaults sync | 9a95802c, 2852816a, 63fe45e7 | PLAN keeps the hand-rolled loader; parser change is cosmetic | skip | — | — |
| B3-9 | Studio dashboard, `.openscreen` files, unsaved-changes dialog, delete-project modal, New Recording dialog | #577, 210e5da2, #307 | PLAN: keep auto-save model | skip | — | — |
| B3-10 | `applyAutoZoomEdits` steals selection (#611) | 36ceca38 | N/A: Capturia's export is a dialog, not a panel gated on selection (`VideoEditor.tsx:1833-1855`) | skip | — | — |

## D — Export / audio

| # | Item | Upstream ref | Capturia status | Class | Effort | Batch |
|---|---|---|---|---|---|---|
| D-1 | **Mix every source audio track** (files with separate mic + system tracks: OBS, upstream native recordings, future A-2) | 42a14016, fcea2b15 (`audioEncoder.ts mixPlanarSources`, `decodeAudioStreamToPlanes`, fixture `sample-dual-audio.mp4`, browser test) | MISSING. `videoExporter.ts` opens one mediabunny `AudioBufferSink`; `streamingDecoder.ts:81,377` still reports `audioStreamCount` but nothing reads it | reimplement (one sink per `input.getAudioTracks()`, sum before the gain chain) | M | **R5-VX** (VX) |
| D-2 | `splitBySpeed` keeps segments disjoint when speed regions overlap (forward-only decode cursor would seek backwards) | a732ab49 (`timelineSegments.ts:86-94`) | ABSENT. `src/lib/exporter/timelineSegments.ts:72-100` has no `srEnd <= cursor` guard; the D-4 adapter feeds disjoint input so it is latent | copy (+test) | S | **R5-VX** |
| D-3 | GIF export on the webcodecs `decodePath` | D-4 follow-up | `gifExporter.ts` still uses `VideoFileDecoder` only | reimplement | M | **R5-GIF** (gifExporter) |
| D-4 | Flip `DEFAULT_EXPORT_DECODE_PATH` to `'webcodecs'` after the smoke list in `reviews/W4-D4-streaming-decoder.md` | — | default `'seek'` (`videoExporter.ts:690`) | verify | S | release gate |
| D-5 | Localise encoder stall / flush-timeout strings in `ExportResult.error` | D-4 follow-up | raw English | reimplement | S | **R5-VX** |
| D-6 | Source-copy fast path; `mp4ExportSettings` presets; letterbox-upscale fix 7076a7bf | — | wave-5 exclusion / keep `mp4ExportPlan.ts` | skip | — | — |
| D-7 | Swap caption demux fallback to `extractMono16kWebDemuxer.ts` (C-1 follow-up; `mixToMono` perf hoist already equivalent in Capturia `extractMono16k.ts:68-80`) | v1.7.0 file; 2d527453 | optional | copy | S | **R5-CAP** |
| D-8 | WSOLA limiter-before-stretch ordering | D-5 note | revisit only if clipping is heard | verify | — | smoke |

## C — Captions

| # | Item | Upstream ref | Capturia status | Class | Effort | Batch |
|---|---|---|---|---|---|---|
| C-1 | Pin the Hugging Face model revision (tokenizer/config unverified at `main`) | C-1 review follow-up | OPEN (`captionModel.ts`) | reimplement | S | **R5-CAP** (captionHandlers, captionModel) |
| C-2 | Bundle only `ort-wasm-simd.wasm` (−9 MB) | C-1 review | optional | reimplement | S | **R5-CAP** |
| C-3 | **Subtitle position/style controls**: anchor presets (top/bottom/…), margins, sliders that reach the true edge, band measured against the output frame | ede0b2c3, 4ba0e3e4, a7536fda, 84cd0f29, f83cab27, d585f3a3 (ai-edition captions pane) | MISSING as UI. `SettingsPanel.tsx` exposes only `settings.generateSubtitles`; layout fixed in `src/lib/rendering/subtitleLayout.ts` | reimplement (Capturia `SubtitleCue` layer) | M | **R5-SUBS** (SP, VP, FR subtitle layer) |
| C-4 | Subtitle → text-annotation conversion (`captionSegmentsToAnnotationRegions`) | v1.7.0 `annotationsFromCaptions.ts` (+tests) | optional (gap D C2) | copy | S | **R5-SUBS** |
| C-5 | whisper.cpp native STT, chunked progress/cancel, language list, translation, transcript editing | a9fdd97f, 5393e260, 63f072e5, 876e4692 | v1.8+ native engine; slot in later behind the `TranscriptionEngine` seam | skip | — | — |

## F — Electron / infra

| # | Item | Upstream ref | Capturia status | Class | Effort | Batch |
|---|---|---|---|---|---|---|
| F-1 | **Prebuild `window-bounds-helper`** instead of writing Swift source into `userData` and running `swiftc` at runtime (code-exec inside Capturia's TCC scope; silently fails without Xcode CLT) | gap F S9 (Capturia-own hardening) | OPEN. `electron/ipc/windowBounds.ts:69-116` | reimplement | M (macOS) | **R5-SW** (build script, extraResources) |
| F-2 | Synchronous `getPlatform()` from a preload snapshot (drops the async IPC and the `isMac` first-render flicker) | 593be5eb, 1bc24ada, 1bbbc007; `ShortcutsContext.tsx` follow-up | ASYNC. `src/utils/platformUtils.ts:6,32`; `ShortcutsContext.tsx:68` | copy | S | **R5-IPC** (preload, d.ts ×2, call sites) |
| F-3 | Use `electronAPI.assetBaseUrl` in `src/lib/assetPath.ts` (F7 residue) | 8458cbb4 | still `get-asset-base-path` IPC | reimplement | S | **R5-BG** |
| F-4 | Time desktop-source enumeration under `CAPTURIA_DIAGNOSTIC` | 03a348d9 | MISSING | copy | S | **R5-IPC** — optional |
| F-5 | `install-channel`: `offersUpdateCheck` vetoes rebuilt when recording flips; update check bounded by 30 s | 56241090, 04274381 | PARTIAL. `electron/install-channel.ts:112 offersUpdateCheck` exists; the menu-rebuild-on-recording and 30 s race are in `main.ts` upstream | verify | S | **R5-IPC** |
| F-6 | `publish` block + `*.zsync` (B8), `pacman` target (B9), composite `.github/actions/setup` | 7e298d3b, #484 | MISSING (F9 deferred) | copy | S | **R5-CI** — product decision |
| F-7 | electron-updater, webm-seek-index remux (needs the ffmpeg addon), seamless titlebar, light theme, CLI, Nix flake, PID lock | 01cb74a0, ac0e710d, d57e6e55, 4fa65d9f… | wave-5 exclusion / v1.8+ / decision | skip | — | — |
| F-8 | About box contributors list | 54b64f59 | single maintainer | skip | — | — |

## T — Tooling / tests

| # | Item | Upstream ref | Capturia status | Class | Effort | Batch |
|---|---|---|---|---|---|---|
| T-1 | **Browser-mode vitest** (`vitest.browser.config.ts`, `@vitest/browser` + playwright chromium, `*.browser.test.ts` for exporter/GIF/audio mix; asserts the silent-export invariant) | #383 (5a361794), 42a14016 | MISSING (`grep vitest/browser` empty) — gap D16 | copy | M | **R5-CI** |
| T-2 | **Export e2e spec** (`tests/e2e/gif-export.spec.ts`, `getTestId.ts` hooks) | #603, 9f6ef0f5 | Only `e2e/launch.spec.ts`; needs `data-testid` on export UI | reimplement | M | **R5-CI** (+ ExportDialog testids) |
| T-3 | CI validate job: add `i18n:check`, `format:check`, `vite build`; semantic-pr | upstream `ci.yml` | `.github/workflows/build.yml:33-43` runs lint/tsc/typecheck:test/test only | copy | S | **R5-CI** |
| T-4 | `lint` as `biome check` (lint + format + organize imports in one gate) | upstream package.json | separate `lint`/`format:check` | copy | S | **R5-CI** |
| T-5 | Lint warning burn-down (116), `vi` native read-through | W0-a/W1-a backlog | backlog | reimplement | M | — |
| T-6 | `scripts/check-docs.mjs` link check, `THIRD-PARTY-NOTICES.md`, `docs/tests/writing-tests.md` | 066a2f7d, HEAD | optional | copy | S | — |

---

## Post-v1.7.0 upstream fixes that apply to code Capturia ported

| Upstream commit | File (upstream) | Applies? | Capturia evidence |
|---|---|---|---|
| a732ab49 keep speed segments non-overlapping | `src/lib/exporter/timelineSegments.ts` | **yes** (latent) | `timelineSegments.ts:72-100` lacks the `srEnd <= cursor` / `effectiveStart` guard |
| 19198dc6 3D presets + perspective 1.6 | `src/components/video-editor/types.ts` | **yes** | `ROTATION_3D_PRESETS` / factor 2.6 at v1.7.0 values |
| 1fd31855 WebGL context loss | `VideoPlayback.tsx` | **yes** | no `webglcontextlost` handler |
| 792de0f3 wallpaper thumbs | `src/lib/wallpaper.ts` (+assets) | **yes** | picker decodes originals |
| 54e12706 HUD popovers on blur | `LaunchWindow.tsx` | **yes** (reimplement on Radix) | no `blur` listener |
| c8d4e867 own windows out of `get-sources` (pre-1.7 but missed) | `handlers.ts` | **yes** | `permissions.ts:518` |
| b2973a89 CG init before window filter | SCK helper | **yes** | no CG call in `sck-recorder.swift` |
| de3fef6a / bdfeec7f device-name matching | `deviceNameMatching.ts` (Capturia: Swift `matchDevice`) | **yes** | substring match at `sck-recorder.swift:417-420` |
| 1cc63df4 `aria-modal` on `DialogContent` | `ui/dialog.tsx` | **yes** | absent |
| 96e178c4 Switch colours | `ui/switch.tsx` | yes (cosmetic) | `#23232a` |
| 593be5eb / 1bc24ada sync platform via preload | `platformUtils.ts`, `ShortcutsContext.tsx` | yes | async |
| 2d527453 `mixToMono` hoist | `captioning/extractMono16k.ts` | no — Capturia already loops per channel (`:68-80`) | — |
| 29df2e0e / 70c5b6f8 camera preferred-id race; c43d1e87 mic effect re-running `getUserMedia` | `useCameraDevices.ts`, `useMicrophoneDevices.ts` | no — Capturia seeds from `initialDeviceId` and depends on `[enabled]` only | `src/hooks/useCameraDevices.ts:18-25`, `useMicrophoneDevices.ts:18-25,73` |
| 5cfea748 defaults on | `editorDefaults.ts` | product choice, no | — |
| 63fe45e7 `customPlaybackSpeed` parser | `customPlaybackSpeed.ts` | no (cosmetic) | — |
| 9a95802c / 8e0a6268 / 2852816a i18next + plural | `i18n/loader.ts` | no (PLAN keeps v1.7.0 loader) | — |
| 56241090 `electron/i18n.ts` pt-BR in main | `electron/i18n.ts` | already present | `electron/i18n.ts:23-45` |
| 411171ce / 4613c283 webm-duration; f3c5b8a6 recordingStream; 59c9a192 globalShortcut; 09f6348d main-log-buffer; dee0452f update-checker; d68ab84a main-process-errors; adaba8ef NotesWindow.css | those files | no later change upstream | per-file `git log` |
| 54b64f59 About contributors; 04274381/56241090 main.ts update-check vetoes | `about.ts`, `main.ts` | skip / verify (F-5) | — |
| 7076a7bf letterbox rows counted as upscale | `mp4ExportSettings.ts` | no (Capturia keeps `mp4ExportPlan.ts`) | — |
| cf0241ae / 5bd02bd2 deletion of the web MP4 pipeline and pixi | — | no (Capturia keeps the React/Pixi editor) | — |

---

## Suggested batches (no two touch the same hot file)

| Batch | Items | Hot files |
|---|---|---|
| **R5-A1** browser system audio + camera hardening | A-1, A-6, A-9, A-11 | USR, LW (popover-free area), MAIN (`setDisplayMediaRequestHandler`, switches) |
| **R5-HUD** | A-5, A-14 | LW only |
| **R5-IPC** | A-4, A-13, F-2, F-4, F-5 | permissions.ts, preload, d.ts, MAIN menu/tray, platformUtils call sites |
| **R5-SW** (needs macOS) | A-2, A-3, A-7, A-8, F-1 | SWIFT, sckRecorder.ts, windowBounds.ts, build script |
| **R5-VP** | B1-3, B1-4, B3-1 | VP, videoEventHandlers, types.ts (3D constants), threeDPass test |
| **R5-VX** | D-1, D-2, D-5 | VX, timelineSegments |
| **R5-GIF** | D-3 | gifExporter only |
| **R5-BG** | B1-1, F-3 | SP (wallpaper grid), wallpaper.ts, assetPath.ts, public/wallpapers/thumbs |
| **R5-CROP** | B1-2 | SP (crop section), VE, aspectCrop.ts, PreviewAspectCropOverlay — run after R5-BG merges (both touch SP) |
| **R5-UI** | B1-5, B2-1, B2-2 | switch.tsx, SP cursor section — after R5-CROP |
| **R5-KEYS** | B3-3, B3-5 | VE keydown + speed commit, dialog.tsx, SP speed input — after R5-UI |
| **R5-WAVE** | B3-2 | useAudioPeaks, TimelineEditor prop |
| **R5-PROJ** | B3-4 | electron/ipc/projectState.ts, electron/media/*, VE load path |
| **R5-SUBS** | C-3, C-4 | SP subtitles section, VP subtitle overlay, FR `renderSubtitleLayer`, subtitleLayout.ts — after R5-KEYS |
| **R5-CAP** | C-1, C-2, D-7 | captionHandlers, captionModel, extractMono16k, vite plugin |
| **R5-NOTES** | A-12 | NotesWindow/NotesToolbar + i18n |
| **R5-CI** | T-1, T-2, T-3, T-4, F-6 | workflows, vitest configs, e2e, ExportDialog testids |
| **R5-LX** (needs Wayland) | A-10 | MAIN switches |

## Top 15 by user value / effort

1. **A-1** browser-path system audio (M) — the only README v1.7.0 headline feature still missing on all three platforms.
2. **B1-3** WebGL context-loss recovery (S) — Linux "only the background remains after export" (upstream #8/#19).
3. **A-4** own windows out of the source picker (S).
4. **B3-1** >16× preview frame-stepping + hint (M) — silent 16× clamp is a live bug against `MAX_PLAYBACK_SPEED = 40`.
5. **D-1** mix all source audio tracks (M) — imported dual-track files lose the mic today.
6. **A-3** CoreGraphics init in the SCK helper (S) — window capture abort on macOS 26 / Electron 41.
7. **B1-1** wallpaper thumbnails (S) — picker opens 20 MB of JPEGs.
8. **A-5** HUD popovers close on blur (S).
9. **B3-3** `aria-modal` + modal guard for editor shortcuts (S) — Space/Delete/Z act under the export dialog.
10. **B1-2** free-form crop with lock toggle (M).
11. **B3-2** waveform threshold / streaming peaks (S–M) — whole-file read OOMs on long recordings.
12. **B3-4** project state survives moved recordings (M).
13. **F-1** prebuilt window-bounds helper, no runtime `swiftc` (M, macOS).
14. **B1-4** 3D preset retune (S) — "truncated" look reported three times upstream.
15. **T-1** browser-mode vitest (M) — the D-4/D-5 paths have never run in a browser; gates the `decodePath` flip (D-4).

Next tier: A-7 device-name matching, A-2 SCK system audio (L), C-3 subtitle position controls, D-2, D-3, F-2, A-12 teleprompter, B2-1.

## Already planned in wave 5 round 1 (excluded from the tables)

electron-updater, source-copy fast path (D13), HUD click-through + vertical tray (A24/A25), gradient
editor (B1 B2), blur regions (X1), webcam sidecar + editor composite (A11/B1-f, W1–W10, Full Camera,
dual-frame, reactive zoom), cursor themes (C10), Windows WGC helper (A27/C9 + all `wgc-capture`
commits).

## Verified present (spot checks that came back clean)

Picker filters `m4v wmv flv ts` (`exportFiles.ts:314`); gif worker count (`gifExporter.ts:127`);
tray icon 16/24 (`main.ts:145`); `select` clears annotation selection (`VideoEditor.tsx:1505-1513`);
undo guard in text fields (`VideoEditor.tsx:3592`); scrub state + resolution drop
(`VideoPlayback.tsx:212-214,942`); overlaySize ResizeObserver (`VideoPlayback.tsx:215-217`);
mic 20 ms ramp (`useScreenRecorder.ts:917`); auto-focus lock disclaimer (`SettingsPanel.tsx:755-774`);
entitlement keys + `notarize:false` + Continuity flag; `set-locale` + `mainT`; Save Diagnostics in
the app menu; content protection gate; 720p/1080p/source presets; canonical wallpaper persistence;
`mixToMono` already hoisted.

---

## Tóm tắt (VI)

- Đã rà lại toàn bộ 1.429 commit upstream (87735c27→v1.7.0→main) và diff từng file đã port ở mức
  v1.7.0. Kết quả: **17 mục copy, 19 mục reimplement, 21 mục skip, 5 mục cần verify**.
- Lỗ hổng lớn nhất còn lại: **thu system audio** (cả đường browser lẫn SCK helper), **preview >16×
  bị kẹp âm thầm**, **mix nhiều track audio khi export**, **khôi phục Pixi khi mất WebGL context trên
  Linux**, cửa sổ HUD/selector **vẫn hiện trong danh sách nguồn**, thumbnail wallpaper, crop tự do.
- Fix upstream sau v1.7.0 áp dụng cho code đã port: `splitBySpeed` (a732ab49), hằng số 3D
  (19198dc6), WebGL loss (1fd31855), thumbs (792de0f3), popover blur (54e12706), CG init trong SCK
  (b2973a89), match tên camera theo từ (de3fef6a), `aria-modal` (1cc63df4), màu Switch, platform sync.
- Đã nhóm thành 18 batch R5-* không đụng chung hot file; đề xuất làm A-1, B1-3, A-4, B3-1, D-1 trước.
