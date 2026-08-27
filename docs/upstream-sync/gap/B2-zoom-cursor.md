# B2 - Zoom behaviour, cursor pipeline, motion: gap analysis

Status: analysis complete (2026-08-27). Read-only; no code changed.

Sources diffed:

| Ref | Path |
|-----|------|
| Capturia (`feat/upstream-sync-v1.7`) | `/home/minhvnq/Desktop/Apps/Capturia` |
| upstream fork base `87735c27` | `/tmp/openscreen-base` |
| upstream `v1.7.0` (sync target) | `/tmp/openscreen-v1.7.0` |
| upstream `main` (history only) | `/tmp/openscreen-upstream` |

Scope note: "timeline zoom" (Capturia `d8d6cd1` playhead-centred wheel zoom, `3400172` zoom
slider) is a *timeline viewport* feature and belongs to B3. Everything below is about the
*camera* zoom applied to the video and the cursor overlay.

---

## 0. Architecture snapshot (what each side has today)

### Capturia

**Zoom engine** (identical to fork base, untouched by upstream v1.3-v1.7 work):

- `src/components/video-editor/types.ts`: `ZoomRegion { id, startMs, endMs, depth: 1..6, focus }`,
  `ZOOM_DEPTH_SCALES`. No `customScale`, `focusMode`, `source`.
- `videoPlayback/zoomRegionUtils.ts`: `computeRegionStrength` = 320 ms `smoothStep` lead-in/out
  (`TRANSITION_WINDOW_MS = 320`), `findDominantRegion -> { region, strength }`.
- `videoPlayback/constants.ts`: `resolveAdaptiveSmoothingAlpha(deltaMs)` - exponential low-pass,
  0.12 at 60 fps, re-framed by *content-time* delta.
- `VideoPlayback.tsx:944-1017` ticker and `src/lib/exporter/frameRenderer.ts:updateAnimationState`
  are copies of the same loop -> preview/export parity by construction, **except** that the preview
  keeps easing while paused (`deltaMs = 0 -> alpha = 0.12/tick`), so a frame seen paused
  mid-transition is not the frame export produces.
- `zoomTransform.ts`: focus is stage-normalised (`focusX * stageSize.width`) - this is already the
  post-`b713b6a9` behaviour. Motion blur = isotropic Pixi `BlurFilter`, strength
  `min(6, intensity*120)` where `intensity` is per-*tick* delta (fps dependent).
- Capturia-only: `src/lib/zoom/aspectZoomState.ts` (zoom regions **per aspect ratio**),
  `src/lib/autoEdit/screenStudioAutoZoom.ts` (click / selection / movement candidate generator,
  476 lines, 7 tests), silent auto-apply on first load (`VideoEditor.tsx:1549-1564`),
  "Auto Edit" button, undo/redo snapshots include `zoomRegionsByAspect`.

**Cursor pipeline** (entirely Capturia's own; base had none):

- Recording: `electron/ipc/handlers.ts` `cursor-tracker-start/stop` - 16 ms tick on
  `screen.getCursorScreenPoint()`, stores when click / moved >= 0.2 px / >= 33 ms; bounds via
  `src/lib/cursor/captureSpace.ts` + native window bounds refreshed every 120 ms; macOS cursor
  kind (`arrow | ibeam`) from `electron/native/macos/cursor-kind-monitor.swift` (NSCursor TIFF
  SHA-256 hash table); macOS clicks from `mouse-button-monitor.swift`
  (`NSEvent.pressedMouseButtons` polled at 8 ms) -> click vs **selection gestures with bounds**;
  Windows/Linux-X11 clicks by heuristic (still frames after speed > 950 px/s); Wayland: tracking
  disabled with warning; editor fallback `src/lib/analysis/videoMouseAnalyzer.ts` (frame diff).
  Persisted as `<video>.cursor.json` sidecar + `metadata.cursorTrack`.
- Data: `src/lib/cursor/types.ts` `CursorTrack { samples: {timeMs,x,y,click?,visible?,cursorKind?},
  events: click|selection, space, stats, capture }`.
- Rendering: `src/lib/cursor/cursorComposer.ts` `resolveCursorState` (Gaussian window smoothing
  <= 220 ms, movement-style presets, auto-hide static, loop blend, click pulse 420 ms -> +10 %
  scale + highlight + ripple, time/x/y offsets) + `drawCompositedCursor` (Path2D macOS arrow /
  I-beam, drop shadow). Drawn on a 2D canvas overlay above Pixi in preview
  (`VideoPlayback.tsx:678-731`) and on `compositeCtx` in export
  (`frameRenderer.ts:renderCursorLayer`). `projectCursorToViewport` re-normalises by crop and
  applies camera transform. Same functions in both paths -> parity by construction.
- Settings: `SettingsPanel.tsx:587-830` (enable, movement style, auto-hide, loop, size, highlight,
  ripple, smoothing, time offset, offset X/Y, "Analyze Video Cursor"). Persisted in
  `ProjectState.cursorStyle`.

### Upstream v1.7.0

- Zoom: `ZoomRegion` gains `focusMode?: 'manual'|'auto'`, `customScale?`, `rotationPreset?` (3D,
  B1), `source?: 'auto'|'manual'`. `getZoomScale()`. `zoomRegionUtils.ts` rewritten: Screen-Studio
  easing (`TRANSITION_WINDOW_MS = 1015.05`, zoom-in window x1.5 with 500 ms overlap into the
  region, `easeOutScreenStudio = cubicBezier(0.16,1,0.3,1)`), **connected regions** (gap <= 1500 ms
  -> 1000 ms pan between them instead of zoom-out/in), cursor-follow focus via
  `cursorFollowUtils.ts` (`advanceFollowFocus`, content-time corrected), single-slot result cache.
  `zoomTransform.ts` gains `computeZoomTransform`/`computeFocusFromTransform`, `transformOverride`,
  velocity-based directional `MotionBlurFilter` (`pixi-filters`). `zoomSpring.ts` +
  `motionSmoothing.ts` (uses `spring` from `motion`) chase the eased target with an
  overshoot-clamped spring; snap on seek/pause/scrub. `frameRenderer.updateAnimationState` mirrors
  the ticker 1:1 (`53f9851a`, `02b4e1b4`).
- Cursor: two renderers. (1) `videoPlayback/cursorRenderer.ts` `PixiCursorOverlay` (SVG assets,
  spring smoothing, click bounce, motion blur) - **effectively unreachable in v1.7.0**:
  `VideoEditor.tsx:329-334` only shows the cursor when `hasNativeCursorRecordingData`, and the
  overlay is updated with `visible = showCursor && !hasNativeCursorRecording`. (2) Native path
  `src/lib/cursor/nativeCursor.ts` + `cursorPathSmoothing.ts` + `cursorThemes.ts`: samples carry
  `cursorType` (16 types) and optional `assetId` -> captured system bitmap (Windows
  `cursor-sampler.cpp` via `GetCursorInfo`/`DrawIconEx`, low-level mouse hook for clicks; macOS
  `OpenScreenMacOSCursorHelper/main.swift` via `NSCursor.currentSystem` PNG + AX-API cursor type
  + CGEvent tap for clicks). Rendered as an `<img>` in preview and `drawImage` in export with the
  same offline 240 Hz spring path, click bounce (260 ms press/rebound), speed-based CSS blur,
  optional clip to camera-aware mask. Linux: telemetry only and the overlay is **hidden**
  (`nativePlatform` gate). Data flows through `src/native/*` bridge + `electron/native-bridge/*`.
  Cursor settings are not persisted except `cursorTheme`.

---

## 1. Summary table

Status legend: MISSING / PARTIAL / PRESENT-DIFFERENT / PRESENT-SAME / N-A.
Effort: S < 0.5 d, M 0.5-1.5 d, L 2-4 d, XL > 4 d (incl. tests, review).

| # | Feature | Upstream final files / commits | Capturia status | Effort | Recommendation |
|---|---------|-------------------------------|-----------------|--------|----------------|
| Z1 | Custom zoom scale slider (continuous 1.0-5.0) | `types.ts getZoomScale`, `SettingsPanel.tsx:940-980`, `overlayUtils.ts`, `focusUtils.clampFocusToScale`, `timeline/Item.tsx:149`; `37215531` + `f30090bf` `f3dcbf28` `42127e64` | MISSING | M | Port (batch 1) |
| Z2 | Zoom precision position (X/Y % inputs) | `SettingsPanel.tsx:168-230, 1046-1110`; `68c35ff0` | MISSING | S | Port (batch 1) |
| Z3 | Hold-to-preview zoom button | `2993a578`, `b25c2c83` (preview current frame, not selected region) | MISSING | S | Port (batch 1) |
| Z4 | Auto zoom `source` tagging + non-destructive wand toggle | `VideoEditor.tsx:1158-1233`, `projectPersistence.ts:270`, `TimelineEditor.tsx:1692`; `1b5de03f` | PRESENT-DIFFERENT (Capturia auto edit *replaces* all regions of the aspect) | M | Port semantics, keep Capturia generator (batch 1) |
| Z5 | Screen-Studio easing + connected zoom transitions + result cache | `zoomRegionUtils.ts`, `mathUtils.ts`, `constants.ts`, `zoomTransform.ts`; `7a8d0f44`, `8f35cf09`, `e1c67c4e` (revert of #373) | PRESENT-DIFFERENT (320 ms smoothStep, no connected pans) | L | Port (batch 2), retune `screenStudioAutoZoom` constants |
| Z6 | Zoom spring chase + snap on seek/pause/scrub | `zoomSpring.ts(+test)`, `motionSmoothing.ts`; `02b4e1b4`, `358d4af4`, `53f9851a` | MISSING (also fixes Capturia's paused-drift parity gap) | M (with Z5) | Port (batch 2) |
| Z7 | Auto-follow focus (`focusMode:'auto'`) with export parity, adaptive smoothing | `cursorFollowUtils.ts`, `constants.ts AUTO_FOLLOW_PARAMS`, `VideoPlayback.tsx` ticker, `frameRenderer.ts`; `3be195cc`, `54df5971`, `163b12d6`, `53f9851a` | MISSING | L | Port (batch 3), feed from Capturia `CursorTrack` |
| Z8 | Global "Auto-Focus all" toggle + per-zoom Focus Mode UI + locked disclaimer | `VideoEditor.tsx:1235-1247`, `SettingsPanel.tsx:982-1020`, `TimelineEditor.tsx:1705` | MISSING | S (on top of Z7) | Port (batch 3) |
| Z9 | Auto-zoom timeline marker (cursor icon on auto-focus items) | `timeline/Item.tsx:153`; `1fefde88` | MISSING | S | Port (batch 3; B3 owns `Item.tsx` - coordinate) |
| Z10 | Zoom focus matches indicator incl. wallpaper edges | `b713b6a9` | PRESENT-SAME (`zoomTransform.ts` already stage-normalised) | - | Nothing |
| Z11 | Dwell-based zoom suggestions (`zoomSuggestionUtils.ts`) | `timeline/zoomSuggestionUtils.ts` | PRESENT-DIFFERENT (Capturia generator is richer: click/selection/movement) | - | Do not port |
| Z12 | Reactive webcam zoom (`a806e34f`) | `compositeLayout.reactiveWebcamScale` | N-A (webcam = B1) | - | B1 |
| C1 | Cursor size normalised to output width (parity) | `cursorRenderer.ts getCursorViewportScale`, `frameRenderer.drawNativeCursor sizeNorm`; `65bb5bc8` | **Capturia bug**: glyph is `28 * size * cameraScale` px in *both* stage px and export px -> cursor visibly smaller in 4K export than in preview | S | Fix (batch 4) |
| C2 | `cursorClipToBounds` (clip to camera-aware rounded mask) | `65bb5bc8`, `58722a1d`, `788b0a2e` (default off), `85167078` | MISSING (Capturia always overflows = upstream default) | S | Port (batch 4) |
| C3 | Hide cursor when outside crop | `0cdbb35b` (`mapCursorToCroppedViewport`, +test), `7f025c86` (+test) | PARTIAL (crop re-normalised, but only stage bounds checked) | S | Port check (batch 4) |
| C4 | Cursor motion blur (speed-based) | `nativeCursor.getNativeCursorMotionBlurPx`; `d0341580` | MISSING | S | Port (batch 4) |
| C5 | Click bounce curve + intensity slider | `nativeCursor.getNativeCursorClickBounceScale`; `f91300a1`, `d0341580` | PRESENT-DIFFERENT (420 ms pulse + ripple + highlight) | S | Optional add as extra param (batch 4) |
| C6 | Offline spring cursor path smoothing (240 Hz, memoised) | `src/lib/cursor/cursorPathSmoothing.ts(+test)`; `e49cc02d`, `358d4af4` | PRESENT-DIFFERENT (Gaussian window, symmetric, no lag) | S/M | Optional as `smoothingMode: 'spring'` (batch 4, low priority) |
| C7 | Cursor type set (16 kinds) + bundled SVG glyphs + trim/hotspot table | `src/assets/cursors/*.svg`, `uploadedCursorAssets.ts`, `nativeCursor.ts PRETTY_NATIVE_CURSOR_ASSETS`; `6f099b34` | PARTIAL (`arrow | ibeam` only, Path2D) | M renderer + M mac helper | Port in two steps (batch 5) |
| C8 | macOS native cursor type via AX API + real cursor bitmaps | `OpenScreenMacOSCursorHelper/main.swift`, `macNativeCursorRecordingSession.ts`; `b2f9afab`, `e82fc0d8`, `3ef2001f` | PARTIAL (hash-based arrow/ibeam only; no bitmaps) | M (type) / L (bitmaps) | Type detection: batch 5. Bitmaps: defer |
| C9 | Windows native cursor capture + low-level click hook | `electron/native/wgc-capture/src/cursor-sampler.cpp`, `windowsNativeRecordingSession.ts`; `248ebabc`, `49ee3ac0`, `b8eeef55`, `b67811f2`, `b31bb71f` | MISSING (Windows = heuristic clicks, always arrow) | XL (C++/CMake build; needs F + A) | Defer to cross-stream batch 6 |
| C10 | Custom cursor themes (17 PNG packs) | `src/lib/cursor/cursorThemes.ts`, `public/cursors/**`, `SettingsPanel.tsx:1594-1630`; `b088a098` | MISSING | M | Defer; **licensing must be checked** (art from sweezy-cursors.com) |
| C11 | Native bridge (`src/native/*`, `electron/native-bridge/*`, `useCursorTelemetry`) | `44f59bfa` | PRESENT-DIFFERENT (Capturia IPC + sidecar) | - | Do not port (F-stream infra) |
| C12 | `cursorTelemetryBuffer.ts` | `84ec5a7e`, `fac0b405`, `3b9b4192` | N-A - **unused in v1.7.0** (only its test references it) | - | Do not port |
| C13 | Remove macOS cursor highlight (`b41c4f49`), cursor highlighting (`8d79a14e`) | - | N-A (Capturia keeps highlight/ripple) | - | Do not port |
| C14 | `PixiCursorOverlay` class | `cursorRenderer.ts` | N-A (dead path upstream; Capturia composer is the equivalent) | - | Do not port; take `mapCursorToCroppedViewport` semantics only |
| M1 | `rafCoalescer.ts` for `onTimeUpdate` | `rafCoalescer.ts(+test)`, `videoEventHandlers.ts:86`; `760eea72`, `8f41dbce` | PRESENT-DIFFERENT (33 ms wall-clock throttle, `force` on every seek -> commit burst while dragging) | S | Port (batch 2) |
| M2 | Scrub state (`isScrubbing`, 150 ms tail, renderer resolution drop) | `videoEventHandlers.ts`, `VideoPlayback.tsx` | MISSING | S | Port with Z6 (batch 2) |
| M3 | Playback choppiness fix `5e994d21` | - | N-A (blur-annotation snapshot; Capturia has no blur regions) | - | Nothing |
| M4 | Init timing fix `9a361a9f` (overlay size state for annotations, viewportRatio) | `VideoPlayback.tsx overlaySize` | PARTIAL (Capturia still reads `overlayRef.current?.clientWidth \|\| 800` at render) | S | Port overlaySize part (batch 2 or B3) |
| M5 | Motion blur intensity slider + directional `MotionBlurFilter` + ticker caching | `dd84edaf`, `c35a3320`, `a26eb3cb`, `8e1c7e03`, `zoomTransform.ts` | PRESENT-DIFFERENT; Capturia blur is per-tick (fps dependent -> export blur != preview) | - | **B1 owns**; batch 2 must pass content `frameTimeMs` so B1 can hook in |

---

## 2. Zoom - detail

### Z1 Custom zoom scale (`#513`)

What: `customScale?: number` on `ZoomRegion`; `getZoomScale(region)` prefers it over
`ZOOM_DEPTH_SCALES[depth]`; Radix slider 1.0-5.0 (step 0.01) under the preset buttons; preset
button is "active" when scale equals it; timeline label shows `2.35x`; `handleZoomDepthChange`
also sets `customScale = ZOOM_DEPTH_SCALES[depth]`.

Upstream final state = `37215531` + review fixes `f30090bf` (NaN/clamp sanitising in
`getZoomScale`), `f3dcbf28`, `42127e64` (NaN guard in `handleZoomCustomScaleChange`). All in v1.7.0.

Capturia mapping / files to change:
- `src/components/video-editor/types.ts` (+`customScale`, `MIN/MAX_ZOOM_SCALE`, `getZoomScale`)
- `videoPlayback/focusUtils.ts` (+`getFocusBoundsForScale`, `clampFocusToScale`; keep
  `clampFocusToStage` as wrapper)
- `videoPlayback/overlayUtils.ts` (use `getZoomScale`, `clampFocusToScale`)
- `VideoPlayback.tsx:958-959, 410` (ticker + drag clamp use `getZoomScale`)
- `src/lib/exporter/frameRenderer.ts:updateAnimationState` (same)
- `SettingsPanel.tsx` zoom section (slider; `@radix-ui/react-slider` already a dependency)
- `VideoEditor.tsx` (`handleZoomCustomScaleChange`, set `customScale` in `handleZoomDepthChange`;
  undo snapshot unaffected; **restore sanitiser at `VideoEditor.tsx:686-712` must pass the field
  through**), timeline `Item.tsx` label (B3 file - coordinate), i18n `settings.zoomCustomScale`.
- `src/lib/autoEdit/screenStudioAutoZoom.ts` drafts keep `depth` only - fine.

Parity: both paths already read one scale source; swapping to `getZoomScale` in both keeps it.
Tests: upstream `src/components/video-editor/types.test.ts` (getZoomScale cases) - bring over.

### Z2 Precision position

X/Y percentage inputs shown only for manual focus; clamp with `getFocusBoundsForScale`; commit on
blur/Enter creates one history entry (`onZoomFocusCoordinateCommit`). Capturia files:
`SettingsPanel.tsx` (new `ZoomFocusCoordInput`), `VideoEditor.tsx` (pass `selectedZoomFocus`,
reuse `handleZoomFocusChange`), i18n. No parity concern.

### Z3 Hold-to-preview

`isPreviewingZoom` prop; `shouldShowUnzoomedView = hasSelectedZoom && !isPlaying &&
!isPreviewingZoom` (`VideoPlayback.tsx:955`). Final behaviour after `b25c2c83`: previews the
dominant region *at the playhead*, not the selected one (the override was reverted). Button uses
pointer down/up/leave/cancel + keyboard (`a686fa01`). Capturia: `VideoPlayback.tsx:953-957`,
`VideoEditor.tsx` state, `SettingsPanel.tsx`, i18n. S.

### Z4 Auto-zoom source tagging and toggle semantics

Upstream: regions created by the suggestion pass are tagged `source: 'auto'`; editing any
attribute promotes to `'manual'`; wand OFF removes only `source === 'auto'`; wand ON re-suggests
*around* existing regions; on-load auto-suggest runs once per source and never for loaded
projects. Capturia: `applyAutoZoomEdits` (`VideoEditor.tsx:1239-1280`) **replaces** every region of
the active aspect and is wired to a plain button plus a silent first-load pass per aspect.

Recommendation: keep `generateAutoZoomDrafts` as the generator (it is better: click/selection
events, movement percentile), but adopt the upstream lifecycle: tag drafts `source:'auto'`,
`existingRegions` exclusion (add an `avoidSpans` option to `generateAutoZoomDrafts`), wand toggle
in the timeline toolbar, promotion to manual in `handleZoomSpanChange/FocusChange/DepthChange`,
persist `autoZoomEnabled` in `ProjectState`. Files: `screenStudioAutoZoom.ts` (+option, +test),
`VideoEditor.tsx`, `TimelineEditor.tsx` (B3 file), `types.ts` (`source`), i18n
(`buttons.autoZoomOn/Off`). Risk: undo stack - upstream uses `pushState` batches; Capturia's
snapshot undo works as long as the toggle is one state update.

### Z5 Screen-Studio easing + connected transitions (+ Z6 spring)

Final `zoomRegionUtils.ts` (`7a8d0f44` narrowed PR, `8f35cf09`, then `#373` "adjust zoom speed"
was **reverted** in `e1c67c4e` - so `TRANSITION_WINDOW_MS = 1015.05` is the final value):

- `computeRegionStrength`: lead-in starts `(startMs + 500) - 1.5*1015` = ~1022 ms *before*
  `startMs`, reaches 1 at `startMs + 500`, holds, then 1015 ms ease-out after `endMs`.
- `getConnectedRegionPairs` (gap <= 1500 ms): between `endMs` and `endMs + 1000` the camera pans
  linearly in *transform space* (`computeZoomTransform` of start/end, lerp, then
  `computeFocusFromTransform`) with `cubicBezier(0.1,0,0.2,1)`; from `endMs + 1000` to next
  `startMs` it holds the next region ("connected hold").
- Single-slot cache keyed on `(regions ref, round(timeMs), telemetry ref, connectZooms,
  viewportRatio)` - saves the O(N) scan at 60 fps.
- `zoomSpring.ts`: per-axis spring (`stiffness 320, damping 40, mass 0.92`) over the eased
  target, overshoot clamp; `resetZoomSpring` when `!animating || dt <= 0 || dt > 80`.
  `frameRenderer` steps the same spring by content `dtMs` and feeds `transformOverride` -> export
  glides like preview (`53f9851a` fixed the earlier mismatch).
- `motionSmoothing.ts` uses `spring()` from `motion`. Capturia has `motion ^12.23.24`
  (upstream `^12.38.0`); verify `spring({keyframes, velocity, ...}).next(ms)` exists in 12.23
  before relying on it, otherwise bump.

Capturia files: `zoomRegionUtils.ts` (rewrite; keep the `{region, strength}` shape that
`cursorComposer.getFallbackFocus` consumes), `constants.ts`, `mathUtils.ts` (+`cubicBezier`,
`easeOutScreenStudio`), `zoomTransform.ts` (+`computeZoomTransform`, `computeFocusFromTransform`,
`transformOverride`, `frameTimeMs`; keep the existing BlurFilter branch until B1 replaces it), new
`zoomSpring.ts` + `motionSmoothing.ts` (+tests), `VideoPlayback.tsx` ticker (lines 916-1025 ->
upstream `VideoPlayback.tsx:1500-1900` shape), `frameRenderer.ts:updateAnimationState`,
`videoEventHandlers.ts` (`isScrubbingRef` so the spring snaps while dragging).

Risks:
1. `screenStudioAutoZoom.ts` constants were tuned for a 320 ms transition
   (`CLICK_HOLD_MS 1400`, `MIN_REGION_DURATION_MS 420`, `MERGE_GAP_MS 140`). With a ~1.5 s ease-in
   a 420 ms region never reaches full zoom, and regions 140-1500 ms apart become connected pans
   (probably desirable). Add a test that drafts reach strength 1 under the new window; expect to
   raise `MIN_REGION_DURATION_MS` / holds. Manual smoke required.
2. Capturia's preview ticker uses `currentTimeRef` in ms; keep content-time everywhere (segments
   with per-segment speed: `2b91ae6` maps region time via `sourceToEffectiveMsWithSegments` in
   `VideoEditor`, so the ticker's `currentTimeRef` is already the correct domain).
3. Export `effectTimeMs` vs `sampledTimeMs` (`frameRenderer.renderFrame`) - spring `dtMs` must use
   `effectTimeMs` (the same clock the preview ticker uses).
4. B1 will touch `zoomTransform.ts` for the motion-blur slider; land Z5/Z6 first, B1 rebases.

Parity: preview and export share `findDominantRegion`, `computeZoomTransform`, `stepZoomSpring`;
the only divergence is `animating` (preview snaps while paused/seeking; export always steps).
Recommend a parity unit test that drives both `updateAnimationState`-style loops with the same
time series and asserts equal transforms.

Tests to bring: `zoomSpring.test.ts` (5), `zoomRegionUtils.test.ts` (2, need Z7 for the
telemetry cases - adapt to `CursorTrack`), plus new tests for connected pairs/hold.

### Z7 Auto-follow focus (+ Z8 UI, Z9 marker)

What: `focusMode: 'auto'` regions resolve focus from cursor telemetry at `timeMs`
(`interpolateCursorAt`, binary search + lerp, clamped with `clampFocusToScale`). In the
ticker/export: at full zoom `advanceFollowFocus(prev, raw, dtMs, AUTO_FOLLOW_PARAMS)`
(`minFactor 0.1, maxFactor 0.25, rampDistance 0.15, referenceMs 25`) - distance-adaptive factor
made frame-rate independent by `1 - (1-f)^(dt/referenceMs)`; while zooming in, track raw;
while zooming out, keep smoothing. `smoothedAutoFocus` reset to null for manual regions. Preview
snaps (uses `raw`) when not actively playing. Focus indicator hidden for auto regions
(`overlayUtils.ts:17`), drag disabled (`VideoPlayback.tsx` pointer-down guard).

Final commits: `3be195cc` -> `54df5971` (adaptive) -> `163b12d6` -> `53f9851a` (content-time
`timeCorrectedFollowFactor`, export sync) -> `1b5de03f` (auto-suggested regions default to
`'auto'`, +tests).

Capturia mapping: no equivalent. Feed from `CursorTrack.samples` (`x,y` -> `cx,cy`; skip
`visible === false` samples or hold last visible). Note Capturia's cursor *render* smoothing
(Gaussian) is not applied to the follow target upstream either - keep them independent.
Capturia's `screenStudioAutoZoom` drafts should stay `'manual'` by default (their focus is the
click/selection centroid, which is the point of that generator); offer `focusMode:'auto'` for
`reason === 'movement'` drafts behind the global Auto-Focus toggle. That deviates from
`1b5de03f` intentionally (ground rule 1).

Files: `videoPlayback/cursorFollowUtils.ts` (new), `constants.ts` (+`AUTO_FOLLOW_*`),
`zoomRegionUtils.ts` (`DominantRegionOptions.cursorTelemetry`), `VideoPlayback.tsx` (ticker
branch + `smoothedAutoFocusRef`, `prevTargetProgressRef`), `frameRenderer.ts` (same fields in
`AnimationState`; `FrameRenderConfig.cursorTelemetry`), `videoExporter.ts` / `gifExporter.ts`
(pass telemetry), `SettingsPanel.tsx` (Focus Mode segmented control, hidden when no track),
`VideoEditor.tsx` (`handleZoomFocusModeChange`, `handleToggleAutoFocusAll`, `autoFocusAll` in
`ProjectState`), `types.ts` (`ZoomFocusMode`), `TimelineEditor.tsx`/`Item.tsx` (marker; B3),
i18n (`zoom.focusMode.*`, `buttons.autoFocusAllOn/Off`).

Parity: `advanceFollowFocus` keyed on content dt in both loops; export must never take the
"snap" branch. Tests: `zoomRegionUtils.test.ts` auto-follow pair, plus new
`cursorFollowUtils.test.ts` asserting fps-independence (same convergence at 30 vs 60 fps steps).

---

## 3. Cursor - detail

### C1 Cursor size parity (Capturia bug)

`drawCompositedCursor(ctx, point, state, style, contentScale)` draws a 28-unit glyph scaled by
`style.size * cameraScale` in **canvas pixels** of whichever canvas it is on. Preview canvas is
the stage (~900-1400 px wide at DPR), export canvas is 1920/2560/3840 px. Result: cursor,
highlight and ripple are ~2-3x smaller relative to the video in export than in preview. Upstream
normalises with `maskRect.width / croppedVideoWidth` (native path) or `viewport.width / 1920`.
Fix: multiply `contentScale` by `(maskRect.width / videoSize.width)` (cursor as a fraction of the
video) in both `VideoPlayback.renderCursorOverlay` and `frameRenderer.renderCursorLayer`, and
rescale the default `size` so the preview look is unchanged. Add a test that renders the same
state at two canvas widths and asserts proportional glyph size (mock ctx).

### C2 `cursorClipToBounds` + C3 hide outside crop

Upstream: `cameraAwareMaskRect()` (`frameRenderer.ts`) = `{camX + s*mask.x, ..., br: radius*s}`;
preview uses CSS `inset(... round ...)` on a wrapper div. Default **off** after `788b0a2e`.
Capturia: preview overlay canvas is full-stage, so implement as `ctx.clip()` on a `roundRect` in
both paths (identical code path -> parity). `layoutUtils.ts` lacks `maskBorderRadius`; compute
from `borderRadius` the same way `layoutVideoContent` scales it. Hide when the re-normalised crop
coordinate leaves `[0,1]` (upstream `mapCursorToCroppedViewport` returns null) - today
`projectCursorToViewport.inViewport` only checks stage +-32 px. Persist in
`ProjectState.cursorStyle.clipToBounds`. Tests: port `cursorRenderer.test.ts`
`mapCursorToCroppedViewport` cases against `projectCursorToViewport`.

### C4 Cursor motion blur

`getNativeCursorMotionBlurPx({motionBlur 0..1, point, state, timeMs})` = `clamp(speed_px_s *
blur * 0.004, 0, 6)` with snap on backwards time; applied as `ctx.filter = blur(px)` (export) /
CSS filter (preview). For Capturia both are Canvas2D -> use `ctx.filter` in
`drawCompositedCursor`. Content-time based -> parity. Add `motionBlur` to `CursorStyleConfig`
(default 0 to preserve Capturia look), slider in the cursor section. Note `ctx.filter` on
Canvas2D is unsupported in Safari only; Electron is fine.

### C5 Click bounce / C6 spring path smoothing (optional)

Both are alternatives to things Capturia already has. If wanted, add
`clickBounce` (0-5) using `getNativeCursorClickBounceScale` (press to 0.76 then rebound to 1.16
at intensity 5) multiplied into `CursorResolvedState.scale`, and `smoothingMode: 'gaussian' |
'spring'` where spring uses `getSmoothedCursorPath` (deterministic, memoised per track+strength,
respects `visible` gaps). Bring `cursorPathSmoothing.test.ts` (5) and the two click-bounce tests
from `nativeCursor.test.ts` if ported. Low priority: Capturia's defaults already read well.

### C7 Cursor type set + SVG glyphs, C8 macOS type detection

Upstream sample `cursorType` values: arrow, text, pointer, crosshair, open-hand, closed-hand,
resize-ew/ns/nesw/nwse, move, not-allowed, wait, app-starting, help, up-arrow. Assets
`src/assets/cursors/Cursor=*.svg` (26 files, `6f099b34`); hotspot table
`PRETTY_NATIVE_CURSOR_ASSETS` (`nativeCursor.ts`) and trim table `uploadedCursorAssets.ts`.
macOS detection in `main.swift:177-231` `currentCursorType()` = AX element under the cursor
(`kAXRoleAttribute` text field -> `text`, link/button -> `pointer`, etc.) and falls back to nil so
the captured bitmap is used (`e82fc0d8`).

Capturia: `CursorKind = 'arrow' | 'ibeam'` from image hashes (`cursor-kind-monitor.swift`), Path2D
glyphs. Port plan (batch 5):
1. Widen `CursorKind` to upstream's union (keep `'ibeam'` as alias of `'text'` in
   `sanitizeCursorTrack` for old sidecars), load SVG glyphs into `HTMLImageElement`s with the
   trim/hotspot tables, `drawCursorGlyph` -> `drawImage` (preload before export like
   `frameRenderer.getCursorImage`; keep Path2D as fallback when assets fail).
2. Merge upstream's AX-based `currentCursorType()` into `cursor-kind-monitor.swift` (keep the hash
   table for I-beam as first check), extend `parseCursorKindLine` in `cursorKindMonitor.ts`.
   Accessibility permission is already needed for the mouse monitor? - **no**: Capturia's
   `mouse-button-monitor.swift` polls `NSEvent.pressedMouseButtons`, which does not need AX trust,
   whereas AX role lookup does (`AXIsProcessTrusted`). Falls back to arrow/ibeam when untrusted;
   surface it in the permissions diagnostics (A stream).
3. Real bitmaps (`assets[]`, `sample.assetId`, `scaleFactor`) - defer; needs `CursorTrack`
   schema v2 and image caching in both renderers.

### C9 Windows native cursor + clicks

`cursor-sampler.cpp` (479 lines): `GetCursorInfo` -> `standardCursorType` (compares against
`LoadCursor(IDC_*)`), `GetIconInfo`/`DrawIconEx` PNG capture per shape (SHA id), `GetAsyncKeyState`
+ `WH_MOUSE_LL` hook for press/release, window-handle bounds. Follow-ups `b67811f2`
(`screen.dipToScreenRect` multi-monitor), `b31bb71f` (physical bounds), `e72fb825`. Capturia has
no Windows native code or build (`npm run build:native:win` does not exist). Value is high (real
clicks + cursor kinds on Windows) but it is an XL cross-stream item: needs F (CMake/MSVC in CI,
`extraResources`) and A (recording start/stop wiring, pause compaction
`compactPendingCursorTelemetryPauseRanges`). Recommend a spike after A/F land.

### C10 Cursor themes

`cursorThemes.ts` (17 packs, arrow+pointer only), PNGs in `public/cursors/<id>/`,
`resolveNativeCursorRenderAsset` classifies untyped bitmaps by hotspot to pick themed
arrow/pointer, `normalizeCursorThemeId` on load. All art is credited to sweezy-cursors.com with
no licence file in the repo - **verify redistribution rights before bundling in Capturia**.
Depends on C7 (image-based glyphs). Defer.

---

## 4. Motion / perf - detail

- **M1 rafCoalescer**: `createRafCoalescer(flush)` - latest value per animation frame,
  `cancel()` on dispose. Upstream `emitTime` always coalesces; Capturia's `emitTime(value, force)`
  forces a commit on every `seeking`/`seeked`/pause. Port into
  `videoEventHandlers.ts` keeping Capturia's segment/speed logic; return `dispose` and call it in
  the `VideoPlayback` cleanup (`VideoPlayback.tsx:884-913`). Check Capturia's hover-preview seek
  queue (`0065fbd`, relies on `seeked`, not `onTimeUpdate`) still restores the playhead - it
  suppresses `setCurrentTime` during hover, so a one-frame-late commit is harmless. Bring
  `rafCoalescer.test.ts` (5).
- **M2 scrub state**: `isScrubbingRef` + 150 ms tail + `setIsScrubbing` -> preview drops
  `renderer.resolution` to 1 while dragging and the zoom spring snaps. Small; do with Z6.
- **M4 `9a361a9f`**: `overlaySize` state fed by `ResizeObserver` instead of reading
  `overlayRef.current?.clientWidth || 800` during render (`VideoPlayback.tsx:1218-1219`) - fixes
  annotation overlays sized at 800x600 on first paint. Capturia has the same code; S. B3 may
  prefer to own it since it is annotation sizing - decide in PLAN.
- **M5 motion blur**: note only. Capturia's `applyZoomTransform` blur strength is per-tick, so a
  30 fps export blurs about twice as hard as a 60 fps preview for the same pan. Upstream computes
  px/s from content `frameTimeMs` (`zoomTransform.ts:150-215`, `motionBlurState`), caches filter
  attachment in the ticker (`a26eb3cb`/`8e1c7e03`), and needs `pixi-filters` (not in Capturia's
  deps). B1 owns the slider/filter; batch 2 must expose `frameTimeMs` and the applied transform
  deltas so B1 does not re-touch the ticker.

---

## 5. Recommended implementation order

Hot shared files: **VideoEditor.tsx**, **SettingsPanel.tsx**, **VideoPlayback.tsx**,
**frameRenderer.ts**, **types.ts**, **i18n/index.tsx**, plus B3's `TimelineEditor.tsx`/`Item.tsx`.

| Batch | Items | Hot files touched | Tests | Independently testable by |
|-------|-------|-------------------|-------|---------------------------|
| B2-1 zoom model + UI | Z1, Z2, Z3, Z4 | types.ts, SettingsPanel.tsx, VideoEditor.tsx, VideoPlayback.tsx (small), frameRenderer.ts (getZoomScale only), i18n, Item.tsx/TimelineEditor.tsx (B3) | port `types.test.ts` getZoomScale; new `screenStudioAutoZoom` avoid-spans test | slider changes zoom in preview and export at the same scale; wand off removes only auto regions |
| B2-2 zoom engine | Z5, Z6, M1, M2, M4 | VideoPlayback.tsx (ticker rewrite), frameRenderer.ts, zoomRegionUtils/zoomTransform/constants/mathUtils, videoEventHandlers.ts | port `zoomSpring.test.ts`, `rafCoalescer.test.ts`; new connected-transition + preview/export parity tests; retune `screenStudioAutoZoom.test.ts` | export of an auto-edited clip matches preview frame-by-frame at region boundaries; no jerk at zoom-in |
| B2-3 auto-follow | Z7, Z8, Z9 | VideoPlayback.tsx, frameRenderer.ts, SettingsPanel.tsx, VideoEditor.tsx, types.ts, zoomRegionUtils.ts, exporters, i18n, Item.tsx (B3) | port `zoomRegionUtils.test.ts` auto cases (adapted to CursorTrack); new `cursorFollowUtils.test.ts` | a region set to Auto pans with the cursor identically in preview and export |
| B2-4 cursor polish + parity | C1, C2, C3, C4, (C5, C6 optional) | cursorComposer.ts, VideoPlayback.tsx (renderCursorOverlay), frameRenderer.ts (renderCursorLayer), SettingsPanel.tsx, types.ts (ProjectState.cursorStyle), i18n | extend `cursorComposer.test.ts`; port `cursorRenderer.test.ts` crop cases, `cursorPathSmoothing.test.ts` if C6 | cursor size/clip identical at 1080p and 4K export vs preview |
| B2-5 cursor kinds | C7, C8 (type only) | cursorComposer.ts, electron/native/macos/cursor-kind-monitor.swift, electron/native/cursorKindMonitor.ts, handlers.ts `sanitizeCursorTrack`, preload/env types, src/assets/cursors/*.svg | port asset-resolution tests from `nativeCursor.test.ts`; parser test for new kind lines | pointer/text/resize glyphs appear in preview + export on macOS; old sidecars still load |
| B2-6 cross-stream (later) | C9 Windows sampler, C8 bitmaps, C10 themes, M5 (B1) | electron native build (F), recording (A), B1 | upstream `nativeCursor.test.ts` remainder, Windows checklist e2e | needs Windows machine / licence decision |

Order rationale: B2-1 is UI-only and unblocks B3's timeline label work; B2-2 is the biggest
behavioural change and must land before B2-3 (auto-follow reads `transition`) and before B1's
motion-blur slider; B2-4 is independent of zoom and can run in parallel with B2-2 on a separate
worktree (touches different functions in `VideoPlayback.tsx`/`frameRenderer.ts` but the same
files - rebase cost only).

---

## 6. Do NOT port / keep Capturia's version

| Item | Reason |
|------|--------|
| `timeline/zoomSuggestionUtils.ts` dwell suggestions | `screenStudioAutoZoom.ts` uses clicks, selection gestures with bounds and movement percentiles; dwell-only would regress. Keep ours, adopt only the lifecycle (Z4). |
| `videoPlayback/cursorRenderer.ts` `PixiCursorOverlay` | Unreachable in v1.7.0 (gated off by `effectiveShowCursor`); Capturia's `cursorComposer` is the equivalent and shares one code path for preview and export. |
| `src/native/*`, `electron/native-bridge/*`, `useCursorTelemetry`, `useCursorRecordingData` | Infrastructure for upstream's `.cursor.json` v2 format. Capturia's `startCursorTracking/stopCursorTracking` IPC + `metadata.cursorTrack` + sidecar already work, and `captureSpace.ts` handles multi-display/window bounds better than upstream's `getSelectedSourceBounds`. F-stream may revisit. |
| `src/lib/cursorTelemetryBuffer.ts` | Not referenced by any non-test file in v1.7.0. |
| `b41c4f49` (remove cursor highlight) / `8d79a14e` (cursor highlighting) | Capturia's highlight + ripple are a feature; keep. |
| Upstream Linux gating (`nativePlatform === win32 \|\| darwin`) | Capturia tracks the cursor on X11 and has `VideoMouseAnalyzer` for Wayland; strictly more capable. |
| Upstream cursor settings not persisted (only theme) | Capturia persists `ProjectState.cursorStyle`; keep and extend. |
| Single `zoomRegions[]` list | Capturia's `zoomRegionsByAspect` + `selectedZoomIdByAspect` stay; every ported handler must go through `setZoomRegionsForActiveAspect`. |
| `5e994d21` | Blur-annotation snapshot fix; no blur annotations in Capturia (B3 decides). |
| 16x seek-stepping in `videoEventHandlers.ts` | Speed regions are B3's; Capturia has per-segment speed already. |
| Cursor themes PNGs | Blocked on licence check; low product value vs. cost. |
| Cursor-kind hash table in `cursor-kind-monitor.swift` | Keep as first-pass detector even after adding AX types (works without Accessibility trust). |

---

## 7. Open points / uncertainty

- `motion` 12.23 vs 12.38: confirm `spring()` generator API before B2-2 (tsc will tell).
- Whether upstream's 1015 ms transition feels right on Capturia's shorter auto regions needs a
  manual smoke; keep `TRANSITION_WINDOW_MS` and the auto-zoom hold constants adjustable in one
  place and note the outcome in `reviews/`.
- C1 (cursor size parity) is asserted from reading `drawCompositedCursor`/`renderCursorLayer`;
  not reproduced with an actual export in this pass.
- Nothing here was executed: no tsc/vitest runs, all findings are from static reading.

---

## Tom tat (VI)

- Zoom: Capturia van dung engine cua fork base (320 ms smoothStep + low-pass). Upstream v1.7.0
  co easing kieu Screen Studio, chuyen canh noi giua cac vung gan nhau, spring chase, snap khi
  seek/pause, `customScale`, `focusMode: auto` (camera bam theo con tro, dong bo preview/export),
  hold-to-preview, nhap toa do focus, danh dau `source: auto`. Tat ca deu la gap that; de xuat
  port theo 3 batch (model + UI -> engine -> auto-follow), giu `screenStudioAutoZoom` va
  `zoomRegionsByAspect` cua Capturia, chi lay lifecycle wand toggle cua upstream.
- Cursor: Capturia da co pipeline rieng kha sau (composer Gaussian, highlight/ripple, auto-hide,
  selection gesture tren macOS, X11 + phan tich video). Gap that: kich thuoc con tro trong export
  khong chuan hoa theo do rong output (bug parity, sua S), clip to bounds, an khi ra ngoai crop,
  motion blur con tro, bo glyph 16 loai + nhan dien loai con tro qua AX tren macOS; Windows
  native sampler/click hook la XL va phu thuoc stream A/F; theme PNG can kiem tra ban quyen.
- Khong port: native bridge, `cursorTelemetryBuffer` (upstream khong dung), `PixiCursorOverlay`
  (duong chet), dwell suggestions, gating an con tro tren Linux.
- Motion: chi port `rafCoalescer` + scrub state; motion blur slider/directional filter de B1, nhung
  batch engine phai truyen `frameTimeMs` de B1 noi vao.
