# B3 gap report: Timeline, annotations, project lifecycle, shortcuts, i18n

Status: analysis complete (2026-08-27). Read-only; no source changed.

References: fork base `/tmp/openscreen-base` (`87735c27`), target `/tmp/openscreen-v1.7.0`,
history `/tmp/openscreen-upstream` (`git -C /tmp/openscreen-upstream show <hash>`).

## 0. Architectural context (read first)

The fork base `87735c27` had **none** of: i18n, configurable shortcuts, undo/redo, project
files, snap guides, waveform. Both sides built these independently after the fork, so most
items below are PRESENT-DIFFERENT rather than MISSING, and the port is a merge, not a copy.

| Concern | Capturia (`main` @ 4cab381) | Upstream v1.7.0 |
|---|---|---|
| Timeline model | `VideoSegment[]` (split / delete / per-segment speed, `be7e959`), timeline drawn in **effective time** via `src/lib/trim/timeMapping.ts`; rows: zoom, segments, annotation, subtitle, audio | `trimRegions`, `speedRegions`, `cameraFullscreenRegions` as draggable items in **source time**; rows: zoom, camera, trim, annotation, (blur), speed |
| Zoom state | `zoomRegionsByAspect` (`src/lib/zoom/aspectZoomState.ts`) | flat `zoomRegions` |
| Undo/redo | effect-based snapshot stack in `VideoEditor.tsx` (`566e481`), refs only, max 50 | `src/hooks/useEditorHistory.ts` (`pushState/updateState/commitState`, `canUndo/canRedo`, max 80) |
| Persistence | auto-save `ProjectState` v1 to `userData/projects/<key>.json` keyed by video path (`save-project-state`), debounce 2 s, immediate on close-editor | explicit `.openscreen` project files (`projectPersistence.ts` v2, `save-project-file` / `load-project-file*`), unsaved-changes tracking |
| Editor entry | always with a video (HUD "Open" -> `openVideoFilePicker` -> `switchToEditor`); back arrow -> `switchToLaunch` | Studio dashboard (`EditorEmptyState`) when nothing loaded; `EditorMenuBar` + native app menu |
| Shortcuts | `src/lib/shortcuts.ts` (8 actions incl. `toggleScissors`, `speedUp/Down`), `ShortcutsContext`, capture-UI dialog, `shortcuts.json` in userData; separate stop-recording global accelerator in HUD | 12 actions incl. `openApp` global, `addTrim/addSpeed/addBlur/addCameraFullscreen`, `copySelected/paste`; `electron/globalShortcut.ts` |
| i18n | `src/i18n/index.tsx`: one flat `Record<key,string>` per locale, **en + zh-CN**, 419 keys, `useI18n().t("ns.key")` | `src/i18n/{config,loader}.ts` + `I18nContext`, 13 locales x 7 namespace JSON files, ~499 en keys, `useScopedT(ns)`; main-process `electron/i18n.ts`; `scripts/i18n-check.mjs` |

Upstream main (v1.10.0) replaced the editor; only `electron/i18n.ts`, locale JSON, and a few
libs still exist there. Post-1.7 follow-ups on files in this stream:
`9a95802c` (i18n loader -> i18next), `8e0a6268` (i18n fallback fix), `f2ab698f` (drops
phantom `addBlur` shortcut string), `593be5eb`/`1bc24ada` (sync platform via preload),
`33e9641b`/`d0c7b3db`/`9e00d11a` (waveform decoded natively by ffmpeg, not portable).

## 1. Summary table

Effort: XS < 1 h, S <= half day, M 1-2 days, L 3-5 days, XL > 1 week.

| # | Feature | Upstream files (final) | Capturia status | Effort | Recommendation |
|---|---|---|---|---|---|
| T1 | Snap guides + drag/resize tooltip + clamp-to-neighbours | `timeline/TimelineWrapper.tsx` (`SnapGuide`, `snapSpanToTargets`, `clampToNeighbours`, `inferResizeMode`, tooltip) | MISSING (Capturia's wrapper = base version: reject on overlap, no snap) | M | Port; feed Capturia targets (segment boundaries, keyframes, playhead) |
| T2 | Audio waveform on timeline + Timeline settings toggle | `timeline/BackgroundWaveform.tsx`, `hooks/useAudioPeaks.ts`, `hooks/audioPeaksWorker.ts`, `hooks/streamingAudioPeaks.ts`, `timeline/Row.tsx` (`background`), `SettingsPanel.tsx` Timeline section, `showTrimWaveform` in `EditorState`/persistence | MISSING (AUDIO row is a static gradient bar) | M (+L for streaming path) | Port decode+worker path into Capturia's AUDIO row, mapped to effective time; skip streaming path unless stream D brings `web-demuxer`/OPFS |
| T3 | Region copy/paste + shared `isTextEditingTarget` | `regionClipboard.ts`(+test), `regionPlacement.ts`(+test), `lib/shortcuts.ts` (`copySelected`, `paste`, `isTextEditingTarget`), `VideoEditor.tsx` `handleCopySelected/handlePaste` | MISSING | M | Port; kinds = zoom, annotation, **segment speed** (Capturia-specific) |
| T4 | `findFreeGapAt` placement helper | `regionPlacement.ts` | PRESENT-DIFFERENT (inline in `TimelineEditor.handleAddZoom`) | S | Extract + port test; prerequisite for T3 paste-as-new |
| T5 | Empty-timeline scrubbing (press-drag on empty lane) | `TimelineEditor.tsx` `handleTimelinePointerDown/Move`, `shouldStartTimelineScrub`, pointer capture | PARTIAL (click-to-seek, playhead drag, hover ghost preview `129ee0a`) | S-M | Port, gated to coexist with ghost cursor / scissors mode |
| T6 | Pan timeline when dragging playhead to edges | `TimelineEditor.tsx` `PlaybackCursor` edge overflow -> `onRangeChange` | MISSING | S | Port |
| T7 | Pan timeline on plain wheel | `TimelineEditor.tsx` `handleTimelineWheel` | PRESENT-DIFFERENT (Capturia: Ctrl+wheel zoom on playhead `d8b6cd1`, Shift+Ctrl pan, plain wheel scrolls rows vertically `b079239`) | - | Keep Capturia's; optionally map horizontal `deltaX` to pan |
| T8 | Trim handle clamp to timeline end | `TimelineWrapper.tsx` `clampSpanToBounds` (`c771bf8b`) | MISSING (same base bug) | XS | Port the one-liner |
| T9 | Frame-step arrow navigation | `src/lib/frameStep.ts`, `lib/__tests__/frameStepNavigation.test.ts`, `FIXED_SHORTCUTS` frameBack/Forward, keydown guard (`cd0f2ab3`) | PRESENT-DIFFERENT (arrows = `seekStepSeconds`, Shift = 1 s, `3400172`) | S | Keep Capturia arrows; add frame step on `,`/`.` using `frameStep.ts` at real source fps; port test |
| T10 | Custom speed input, higher presets, decimal speeds | `customPlaybackSpeed.ts`(+test), `types.ts` `MIN/MAX_PLAYBACK_SPEED`, `clampPlaybackSpeed`, `SettingsPanel.tsx` `CustomSpeedInput` | PRESENT-DIFFERENT (per-segment presets 0.25-40 + naive `parseFloat` form) | S | Port parser + `CustomSpeedInput` into Capturia's segment speed section; keep segment model |
| T11 | Stale selection fix (`d856a523`) | `VideoEditor.tsx` select handlers clear all other kinds | PARTIAL (Capturia `handleSelectZoom` does not clear `selectedAnnotationId`) | XS | Fix locally |
| T12 | "clip tooltip" (`1d7b677f`) | Info tooltip on cursor "Clip to Canvas" setting | NOT-APPLICABLE here (B2 cursor setting; needs `ui/tooltip`) | - | Hand to B2 |
| T13 | Zoom/trim/speed region controls rewrite (`112f02fe`) | `timeline/Item.tsx` (time-range label, `MIN_ITEM_PX`), `SettingsPanel` speed section, trim/speed rows | PRESENT-DIFFERENT (segments instead of trim/speed items) | S (label only) | Port only the Item hover time label + min-width; do not port trim/speed rows |
| T14 | Row empty hints ("Press Z to add zoom") | `timeline/Row.tsx` `hint`/`isEmpty` | MISSING | S | Bundle with T2 (same file) |
| T15 | Playhead decoupled from React re-renders (`760eea72`, `8f41dbce`) | `PlaybackCursor` rAF reading `getPlaybackTimeMs` | MISSING | M | Defer; conflicts with hover-preview seek trick |
| T16 | Timeline i18n | `locales/*/timeline.json` | PRESENT-SAME (Capturia `timeline.*` keys) | - | Covered by i18n section |
| A1 | Duplicate annotation | `VideoEditor.tsx` `handleAnnotationDuplicate`, `AnnotationSettingsPanel.tsx` `onDuplicate`, `SettingsPanel` plumbing | MISSING | S | Port |
| A2 | Text animation presets | `src/lib/annotationTextAnimation.ts`(+test), `types.ts` `AnnotationTextAnimation`, `AnnotationOverlay.tsx`, `lib/exporter/annotationRenderer.ts`, `AnnotationSettingsPanel.tsx`, persistence normaliser | MISSING | M | Port (preview + export parity) |
| A3 | More built-in fonts | `AnnotationSettingsPanel.tsx` `FONT_FAMILIES` (16 Google fonts), `src/index.css` `@import` Google Fonts | MISSING (8 system stacks) | S | Port, but bundle fonts locally or accept CDN dependency (offline export risk) |
| A4 | Text wrapping + CJK wrapping in export renderer | `annotationRenderer.ts` `tokenizeForWrap`, `CJK_CHAR` (`4b3afcf5`, `f04c2b7c`, `dd622f83`) | MISSING (Capturia export does not wrap at all; preview does via CSS) | M | Port; high value for zh-CN users |
| A5 | Color wheel for annotations/background | `@uiw/react-color-colorful` | (B1 overlap) | - | Note only |
| A6 | Empty text on new annotation (`createTextAnnotationRegion`, #127) | `types.ts` (+`types.test.ts`) | MISSING (`content: 'Enter text...'` baked in) | XS | Port |
| P1 | Studio dashboard empty state + New Project | `EditorEmptyState.tsx`, `UnsavedChangesDialog.tsx` variants, `VideoEditor.tsx` `doNewProject` | PRESENT-DIFFERENT (editor always has a video; HUD is the dashboard) | L if faithful | Do not port wholesale; optional S "no video" empty state with Import button |
| P2 | Project import / new-project IPC + menu wiring | `preload.ts` `getPathForFile`, `loadProjectFileFromPath`, `onMenuNewProject/ImportVideo`; `handlers.ts` broader video filters | MISSING; only the file-filter broadening applies | XS (filters) | Port filters (`.m4v .wmv .flv .ts`); rest tied to P1/P4 |
| P3 | Custom in-app close dialog | `UnsavedChangesDialog.tsx`, `main.ts` close interception (`set-has-unsaved-changes`, `request-close-confirm`, `close-confirm-response`, `request-save-before-close`) | NOT-APPLICABLE (auto-save) but Capturia can lose <= 2 s of edits on window X | S | Do not port dialog; add flush-pending-save on window close |
| P4 | Unsaved-changes tracking, project save/close fix, `projectPersistence.ts` | `projectPersistence.ts` (+266-line test), `hasProjectUnsavedChanges` | NOT-APPLICABLE (auto-save, `ProjectState` v1) | - | Skip; borrow normaliser idea for restore hardening |
| P5 | User preferences across sessions, last export folder, project folder | `src/lib/userPreferences.ts` (+136-line test), `handlers.ts` `pick-export-save-path(fileName, exportFolder)` | PARTIAL (per-project persistence only; no cross-session defaults, no remembered export folder) | S | Port with Capturia field set; `projectFolder` not applicable |
| P6 | EditorMenuBar + native app menu | `EditorMenuBar.tsx` (+176-line jsdom test), `electron/main.ts` `setupApplicationMenu`, `windows.ts` `setAutoHideMenuBar(true)` | MISSING (no app menu at all) | M | Port with Capturia items (Import video, Return to recorder, Export, Undo/Redo, panels, Reload) |
| P7 | `editorDefaults.ts` | `editorDefaults.ts` (+test) | PRESENT-DIFFERENT (inline defaults) | S | Port slimmed; prerequisite of P5 |
| P8 | `featureFlags.ts` | `BLUR_REGIONS_ENABLED=false` | NOT-APPLICABLE unless B1 ports blur row | XS | Skip |
| P9 | `useEditorHistory.ts` undo/redo | `src/hooks/useEditorHistory.ts` | PRESENT-DIFFERENT (Capturia `566e481`) | XL to swap | Keep Capturia's; expose `canUndo/canRedo` state; widen snapshot |
| P10 | Lazy-load editor bundle | `src/App.tsx` `React.lazy` + `Suspense` | MISSING | XS | Port |
| P11 | Fullscreen video player | `PlaybackControls.tsx`, `VideoEditor` `isFullscreen` | PRESENT (Capturia `3400172` is a superset: Fullscreen API, F11, auto-hide) | - | Keep Capturia's |
| P12 | `PlaybackControls` component | `PlaybackControls.tsx` | PRESENT (Capturia superset: zoom slider, speed dropdown) | - | Keep Capturia's |
| S1 | Blur shortcut | `addBlur` | NOT-APPLICABLE (see P8) | - | Skip |
| S2 | Frame-step entries in `FIXED_SHORTCUTS` | `lib/shortcuts.ts` | with T9 | - | with T9 |
| S3 | Undo/redo in shortcut list | `FIXED_SHORTCUTS` | PRESENT-SAME | - | - |
| S4 | Configurable global shortcut to open app | `electron/globalShortcut.ts`, `update-global-shortcut` IPC, `ShortcutsContext.persistShortcuts` -> `boolean`, dialog `registrationFailed` toast | PRESENT-DIFFERENT (Capturia has a stop-recording global accelerator configured from the HUD, not in `ShortcutsConfig`) | M | Port `globalShortcut.ts` generalised to `{openApp, stopRecording}`; fold stop-recording into `ShortcutsConfig` |
| S5 | `isTextEditingTarget` guard + form-control arrow guard | `lib/shortcuts.ts`, `VideoEditor.tsx` keydown | PRESENT-DIFFERENT (inline `instanceof` checks x8) | S | Port with T3 |
| S6 | `ShortcutsConfigDialog` changes (i18n keys, failure toast) | `ShortcutsConfigDialog.tsx` | PRESENT-SAME (Capturia already uses `labelKey`) | - | Only S4's failure handling |
| I1 | i18n system + 13 locales + `i18n-check` + main-process i18n + dynamic menu | see section 3 | PRESENT-DIFFERENT | L | Adopt upstream's **structure** (namespaced JSON, loader, check script), keep Capturia's `useI18n().t("ns.key")` call-site contract; import translations key-by-key |

## 2. Per-feature detail

### T1 Snap guides, drag tooltip, clamp-to-neighbours

- Upstream: `3aad05ab` (initial), PR #515 `180a1eaf` (`33bb7511` review fixes, `d802473d`
  guide colour), tooltip lives in the same file by v1.7.0. Final:
  `/tmp/openscreen-v1.7.0/src/components/video-editor/timeline/TimelineWrapper.tsx`.
  Props added: `allRegionSpans` (hard: zoom/trim/speed), `softSnapSpans` (annotation),
  `currentTimeMs`, `keyframeTimesMs`. Threshold = max(50 ms, 1 % of visible range).
  `inferResizeMode` diffs the live span against the committed span because dnd-timeline's
  resize event has no direction.
- Capturia: `src/components/video-editor/timeline/TimelineWrapper.tsx` is still the base
  version (rejects overlapping drop instead of clamping; no move handlers).
- Port notes:
  - Hard spans = `zoomRegions` (already effective-time in `TimelineEditor`); soft spans =
    annotations; extra snap targets = segment boundaries (`sourceToEffectiveMsWithSegments(seg.startMs)`,
    the orange split lines) and keyframes; `currentTimeMs` = effective playhead.
  - **Conflict:** Capturia's `hasOverlap` in `TimelineEditor.tsx` treats a gap <= 2 ms as an
    overlap ("snap if gap is 2ms or less"). With snapping, items land exactly adjacent and
    that check would reject the drop. Replace with upstream's strict intersection
    (`newSpan.end > region.startMs && newSpan.start < region.endMs`).
  - Capturia `Item.tsx` height 40 / Row minHeight 48 vs upstream 30/36; the guide uses
    `top-0 bottom-0`, no change needed.
  - Tooltip text uses `formatTooltipMs`; no i18n keys.
- Tests: none upstream (DOM-heavy). Add a pure-function test for `snapSpanToTargets` by
  extracting it (upstream keeps it inside the component).

### T2 Audio waveform

- Upstream chain: `8413095a` -> `70c7d20d` (moved to a dedicated "Timeline" settings panel,
  default **off**) -> `a72aa1a5`/`f67e9976` (hook + worker) -> `98f7441d` (rename to
  `BackgroundWaveform`) -> `0d39f65a`..`fca17f90` (rectified polygon style) -> `0e3bd174`
  (gamma + per-track normalisation, default back to **on** in `editorDefaults.ts`) ->
  `a977187b`/`654375b2` (streaming path for > `MAX_IN_MEMORY_SOURCE_BYTES`, abort signal).
- Final files: `timeline/BackgroundWaveform.tsx` (canvas, `peaks` = `[min,max]*N`,
  `N = min(24000, ceil(duration*200))`), `hooks/useAudioPeaks.ts` (decodeAudioData ->
  worker; OPFS streaming for huge files), `hooks/audioPeaksWorker.ts`,
  `hooks/streamingAudioPeaks.ts` (needs `web-demuxer` + `lib/captioning/extractMono16kWebDemuxer`
  + `lib/exporter/localSourceFile` + `sourceFileLimits`, all stream D).
  `Row.tsx` gained `background`, `hint`, `isEmpty`. `SettingsPanel` gained a "timeline"
  `SettingsPanelMode` with a `Switch` (`settings.timeline.waveform`).
- Capturia: `TimelineEditor.tsx` AUDIO row (`AUDIO_ROW_ID`) renders a gradient bar with gain
  text plus `audio-edit` items; `Row.tsx` is the base version.
- Port notes:
  - Put the waveform behind Capturia's AUDIO row, not the segments row.
  - **Time-space mismatch:** peaks are indexed in source time; Capturia rows are in effective
    time with per-segment speed. In `BackgroundWaveform`'s per-column loop convert
    `startMs/endMs` with `effectiveToSourceMsWithSegments` (pass `segments` as a prop);
    deleted segments simply never map. This is the only real adaptation.
  - `useAudioPeaks(videoUrl)` takes the `local-media://` URL; `loadFileAsArrayBuffer` is
    upstream's; in Capturia use `fetch(videoUrl).arrayBuffer()` (the protocol supports fetch)
    for the in-memory path. Skip `getReadableFileInfo`/streaming until D lands web-demuxer.
  - Gate on `hasAudioTrack` (Capturia already knows `hasMicrophoneAudio`).
  - `showTrimWaveform` -> add to `ProjectState` (optional field, no migration) and to the
    Capturia undo snapshot? Upstream made it undoable; not necessary.
  - Worker URL: `new Worker(new URL("./audioPeaksWorker.ts", import.meta.url), {type:"module"})`
    works under Vite 5 in Capturia (check the electron renderer build emits the chunk).
- Tests: none upstream for the worker/hook. Write a node test for the peak bucketing by
  extracting the loop from `audioPeaksWorker.ts`.

### T3 / T4 / S5 Region copy/paste, placement helper, text-editing guard

- Upstream: `5293b998` (first), `33cf5c3d` (final shape, lifts `isTextEditingTarget` to
  `lib/shortcuts.ts`), `7a6ccd32` (CodeRabbit review: toast ids), `86a08dfe` (blur data
  deep clone). Files: `regionClipboard.ts` (module-level clipboard; `extract*Attributes`,
  `buildZoomRegion`, `buildSpeedRegion`, `replaceAnnotationAttributes`,
  `buildPastedAnnotation`), `regionPlacement.ts` (`findFreeGapAt`), `VideoEditor.tsx`
  `handleCopySelected`/`handlePaste` (paste onto same-kind selection = attributes only;
  otherwise create at playhead), keydown only intercepts Ctrl+C/V when a region is selected
  or clipboard non-empty so native text copy keeps working. i18n keys `editor.regionClipboard.*`.
- Capturia: nothing. `ShortcutsConfig` lacks `copySelected`/`paste`; add them (defaults
  Ctrl+C / Ctrl+V; `mergeWithDefaults` handles old `shortcuts.json`).
- Adaptation: `CopiedZoom` = `{depth, focus}` (Capturia has no `customScale`/`focusMode`/
  `rotationPreset` unless B2 adds them); replace `CopiedSpeed` with
  `{kind:"segmentSpeed", speed}` applied via `handleSegmentSpeedChange`; paste-as-new zoom
  must go through the effective->source conversion that `handleZoomAdded` already does.
  `findFreeGapAt` replaces the inline block in `TimelineEditor.handleAddZoom` (lines ~1000-1020).
- Tests to bring: `regionClipboard.test.ts` (203 lines, adapt kinds), `regionPlacement.test.ts` (54).

### T5 Empty-timeline scrubbing

- Upstream `c9985a08` + `c4eb3003`: pointer-capture scrub starting on empty lane space
  (`shouldStartTimelineScrub` walks up the DOM and refuses when inside an item/handle/`group`).
- Capturia has click-to-seek + `PlaybackCursor` drag + rAF hover preview with a ghost cursor
  and scissors-mode click-to-split (`129ee0a`). Port as: on `pointerdown` in empty space
  (not scissors mode) -> `onHoverCommit()`, hide ghost, capture pointer, seek on move.
  `handleMouseMove` must early-return while `isScrubbingTimelineRef` is set.

### T6 / T7 / T8 Playhead edge pan, wheel pan, handle clamp

- T6: upstream `d8871d92`; in v1.7.0 `PlaybackCursor` receives `onRangeChange` and shifts the
  visible range by the overflow in px * ms/px. Capturia's `PlaybackCursor` already has
  `onDragStateChange`; add `onRangeChange={setRange}` and the overflow block. Use
  `clampVisibleRange` (pure, copy it).
- T7: keep Capturia's mapping (plain wheel scrolls 5 rows vertically because of `b079239`).
  Optional: treat `Math.abs(deltaX) > Math.abs(deltaY)` as horizontal pan (trackpads).
- T8: `clampSpanToBounds` -> `end: Math.min(start + duration, totalMs)`.

### T9 Frame step

- Upstream `e5430eed`, `3bfcd857` (reads live `video.currentTime`), `baa30a9d` (tests),
  `b709d0d2`/`cd0f2ab3` (FIXED_SHORTCUTS entries + guard for select/contentEditable/slider).
  `FRAME_DURATION_SEC = 1/60` hard-coded.
- Capturia `3400172`: arrows seek by `seekStepSeconds` (settings slider) in effective time,
  Shift = 1 s. Users configured that; keep. Add `,`/`.` (Premiere/Resolve convention) or
  Alt+arrows for single-frame step using `computeFrameStepTime(current, duration, dir)` with
  a `frameDurationSec = 1 / resolvePreviewFrameRate(sourceFrameRate)` parameter (extend the
  signature; upstream's test still passes with the default). Seek through `handleSeekRef`
  so segment mapping applies. Port `cd0f2ab3`'s wider guard (`HTMLSelectElement`,
  `[role=slider]`) into Capturia's arrow handler: today pressing arrows on the seek-step
  `Slider` in `SettingsPanel` both moves the slider and seeks.

### T10 / T11 Speed input, stale selection

- Upstream `3895ca98` (presets to 5x, custom input, `PlaybackSpeed = number`),
  `0daf2295` (decimal/comma input, `customPlaybackSpeed.ts` + test), `27363e70` (100x cap
  with >16x frame-stepping preview + WSOLA audio stretch: touches `VideoPlayback`,
  `audioTimeStretch.ts`, exporter -> stream D).
- Capturia: `SettingsPanel.tsx` `SEGMENT_SPEED_PRESETS` 0.25-40 and a `<form>` with
  `parseFloat`; `handleSegmentSpeedChange` clamps 0.25-40; preview clamps
  `video.playbackRate` to 16 (`videoEventHandlers.ts:95`), so 20x/40x segments silently
  preview at 16x while export is correct. Port `parseCustomPlaybackSpeedInput` (+ 67-line
  test) and the `CustomSpeedInput` component into the segment section; keep Capturia's
  range constants. The >16x preview fix is D's call.
- T11: Capturia `handleSelectZoom` (VideoEditor.tsx ~line 1010) only clears
  `selectedSegmentId`; add `setSelectedAnnotationId(null)` for parity with
  `handleSelectSegment`/`handleSelectAnnotation`.

### T13 / T14 / T15 Item label, row hints, playhead rAF

- T13: only port `Item.tsx`'s `timeLabel` (start-end shown on hover/selected) and
  `MIN_ITEM_PX` wrapper; Capturia's `editable`, `subtitle`, `audio-edit` variants stay.
- T14: `Row.tsx` `hint`/`isEmpty` with keys `timeline.hints.*` (Capturia would add
  `timeline.pressZoom` etc.).
- T15: upstream `760eea72` makes the playhead read `video.currentTime` every frame. In
  Capturia the hover preview *seeks the real video element* while suppressing
  `onTimeUpdate` (`hoverPreviewActiveRef`), so a rAF playhead would jump to the hover
  position. Only port if `getPlaybackTimeMs` returns the saved time while hovering. Defer.

### A1 Duplicate annotation

- Upstream `5426b628` + selection fix `d856a523`. `handleAnnotationDuplicate(id)` clones with
  `+4 %` offset, new `zIndex`, strips `annotationSource`. Button in
  `AnnotationSettingsPanel` (2-col grid with Delete; label "Duplicate" is **not** localised
  upstream; use `annotation.duplicate`).
- Capturia: add handler next to `handleAnnotationDelete`, thread `onAnnotationDuplicate`
  through `SettingsPanel` -> `AnnotationSettingsPanel`.
- **Bug found while mapping:** `VideoEditor.tsx:719` restores the counter with
  `maxIdNum(s.annotationRegions, 'anno-')` but ids are created as `annotation-${n}`
  (`handleAnnotationAdded`), so after a project restore `nextAnnotationIdRef` stays at 1 and
  the next added/duplicated annotation collides with an existing id. Fix the prefix when
  touching this (commit `074aaac` intended to cover it).

### A2 Text animation presets

- Upstream `62000c6d`, `2aa6e90e` (labels via `settings.textAnimation.*` keys),
  `c0702b5e`/`0b06900a` (locales). `getTextAnimationState(annotation, currentTimeMs)` ->
  `{opacity, scale, translateX/Y, revealProgress}` over 700 ms from `startMs`; preview applies
  CSS transform + `clip-path: inset()` for typewriter; exporter applies `ctx.translate/scale/
  globalAlpha` and slices graphemes (`Intl.Segmenter`-free `Array.from`).
- Capturia: `AnnotationTextStyle` lacks `textAnimation` (optional field -> old saves fine);
  `AnnotationOverlay` gets a `currentTimeMs` prop (VideoPlayback has `currentTime`);
  `renderAnnotations(ctx, regions, w, h, effectTimeMs, scale)` already receives the time.
  Because Capturia stores annotations in source time and `frameRenderer` passes source
  `effectTimeMs`, animation timing is consistent with preview.
- Tests: `annotationTextAnimation.test.ts` (50 lines) ports verbatim.

### A3 Fonts

- Upstream `202c6700`: 16 Google families via `@import url(fonts.googleapis.com...)` in
  `src/index.css`; labels for the 8 legacy stacks via `settings.fontStyles.*`. Capturia's
  8 labels are hard-coded English (`"Classic"`, ...) even in zh-CN.
- Risk: runtime network dependency; export uses canvas `ctx.font` so unloaded fonts fall
  back silently. Prefer self-hosting the woff2 files under `public/fonts/` with
  `@font-face` (licences are OFL) and `await document.fonts.load()` before export.

### A4 Text wrapping / CJK in export

- Upstream: `4b3afcf5` (post-fork: wrap loop + clip to box), `f04c2b7c`, `dd622f83`
  (`\p{Script=Han|Hiragana|Katakana|Hangul}` per-char tokens). Final `renderText` in
  `/tmp/openscreen-v1.7.0/src/lib/exporter/annotationRenderer.ts` lines ~250-360.
- Capturia's `renderText` (`src/lib/exporter/annotationRenderer.ts:185-245`) only splits on
  `\n`; the preview `AnnotationOverlay` wraps with `word-break: break-word; white-space:
  pre-wrap`. Exports of long or Chinese text overflow the box. Port the whole upstream
  `renderText` (wrap loop, clip, background per line, underline) and keep Capturia's
  `getRenderableAnnotations` ordering from `src/lib/annotations/renderOrder.ts`.
- Tests: none upstream; add a `tokenizeForWrap` unit test (export it).

### A6 Empty new annotation

- `createTextAnnotationRegion` + `resolveTextAnnotationContent` in upstream `types.ts`;
  `AnnotationSettingsPanel` textarea gets a real `placeholder`. Capturia's
  `handleAnnotationAdded` writes `'Enter text...'` and `handleAnnotationTypeChange` restores
  it. Port with `types.test.ts` (29 lines).

### P1-P4 Project lifecycle (empty state, IPC, close dialog, unsaved tracking)

- Upstream design (`00191c47`, `34ef71b3`, `b3469c46`, `36076aaf`, `478fe316`, `7cf78fe5`):
  explicit `.openscreen` files, `currentProjectPath`, `lastSavedSnapshot` compared with
  `hasProjectUnsavedChanges`, main process blocks `close` and asks the renderer
  (`request-close-confirm` -> `close-confirm-response` -> `request-save-before-close` ->
  `save-before-close-done`), dashboard with drag-drop of project files (`webUtils.getPathForFile`),
  New Project resets `useEditorHistory` via `resetState()`. It also relies on v1.7.0's
  `nativeBridgeClient.project.*` (stream F) and `RecordingSession` (stream A).
- Capturia design (`6fd4424`, `566e481`, `f66479f`): sidecar auto-save keyed by video path,
  one-shot restore on open, "close editor" saves synchronously then `switchToLaunch`. There
  is no unsaved state to confirm. The HUD's "Open" button is the import entry point.
- Recommendation: keep Capturia's model. Concrete small ports:
  1. `handlers.ts` `open-video-file-picker` filters: add `m4v wmv flv ts` (upstream `34ef71b3`).
  2. Flush the debounced auto-save on window close: in `main.ts`
     `createEditorWindowWrapper` intercept `close`, send `request-save-before-close`, wait
     for `save-before-close-done` (reuse upstream channel names / preload
     `onRequestSaveBeforeClose`), then `forceCloseEditorWindow`. Renderer handler = the
     immediate-save body of `handleCloseEditor`. Also flush on `switch-to-launch` (already
     done) and on `before-quit`.
  3. Optional: replace the `editor.noVideo` error screen with a slim `EditorEmptyState`
     (Import Video only). Drag-drop of `.openscreen` files does not apply.
- Do not port `projectPersistence.ts`; but its normaliser pattern (clamp, validate enums,
  default missing fields) is a good model to harden Capturia's restore block
  (`VideoEditor.tsx:650-780`), which trusts the JSON shape.

### P5 / P7 User preferences and editor defaults

- Upstream `d5f59a7b` -> `4f48ecd4` (review) -> `c4072767` (exportFolder + handlers take a
  default folder) -> `b36a32d4` (`editorDefaults.ts`) -> `7cf78fe5` (projectFolder).
  `loadUserPreferences()` validates each field; `saveUserPreferences(partial)` merges;
  `parentDirectoryOf(path)` handles POSIX/Windows roots (tested).
- Capturia: nothing cross-session. The wallpaper default init (`getAssetPath`) and every
  `useState(initial)` in `VideoEditor.tsx` are the de-facto defaults.
- Port: `src/lib/userPreferences.ts` with fields `{padding, aspectRatio, exportQuality,
  exportFormat, exportFolder, seekStepSeconds, previewPlaybackRate}` (key
  `capturia_user_preferences`). Apply only when `loadProjectState` returns `notFound`
  (new project) so restored projects win. Extend `pick-save-file-path` /
  `pick-export-directory` handlers with a `defaultDirectory` argument (upstream
  `pick-export-save-path(fileName, exportFolder)`), and save `parentDirectoryOf(saveResult.path)`
  after a successful export in `handleExport`. `editorDefaults.ts`: port a slim version
  (appearance/layout/export/gif) and have `VideoEditor` initialisers read from it.
- Tests: `userPreferences.test.ts` (136 lines; uses `localStorage` -> needs
  `// @vitest-environment jsdom` in Capturia's node-default config; add `jsdom` devDep),
  `editorDefaults.test.ts` (55).

### P6 EditorMenuBar and application menu

- Upstream `148f181b`, `cb6ddca2`: pure `buildEditorMenuModel(props)` + Radix
  `DropdownMenu` rendering in the custom titlebar; `windows.ts` `setAutoHideMenuBar(true)`
  on win32/linux; native menu (`59ecedb0`, `main.ts` `setupApplicationMenu`) rebuilt on
  `set-locale`; `app-quit` IPC.
- Capturia: `main.ts` never calls `Menu.setApplicationMenu`, so Windows/Linux show
  Electron's default English menu above the custom titlebar; macOS shows the default
  Electron app menu. Port the component with Capturia's model: File (Import video...,
  Return to recorder, Export..., Quit), Edit (Undo, Redo with `canUndo/canRedo` -> see P9),
  View (Toggle timeline, Toggle settings, Fullscreen preview, Reload). Also add a minimal
  native menu (`main.ts`) so macOS gets Cmd+Q/Cmd+Z roles and Win/Linux hide the bar.
- Tests: `EditorMenuBar.test.tsx` needs `@testing-library/react`, `@testing-library/user-event`,
  `@testing-library/jest-dom`, `jsdom` (new devDeps) and `@vitest-environment jsdom`.
  The model test half (`buildEditorMenuModel`) runs in node.

### P9 Undo/redo comparison (keep Capturia's)

| | Capturia `566e481` | Upstream `useEditorHistory` |
|---|---|---|
| Mechanism | `useEffect` on `[segments, zoomRegionsByAspect, annotationRegions, audioEditRegions]` pushes previous snapshot; `isRestoringHistoryRef` guard | explicit `pushState` (checkpoint) / `updateState` (coalesces a drag) / `commitState` |
| Coverage | 4 collections | all `EditorState` incl. wallpaper, padding, crop, webcam, appearance |
| Capacity | 50 | 80 |
| UI state | refs only: no `canUndo/canRedo` -> cannot disable menu items | `canUndo/canRedo` booleans |
| Drag coalescing | none; annotation resize via react-rnd fires on stop only, sliders (fontSize) create one entry per tick | first `updateState` checkpoints, rest mutate present |
| Keys | Ctrl+Z, Ctrl+Shift+Z, Ctrl+Y (capture phase, not guarded for inputs) | same |

Swapping to `useEditorHistory` means routing every setter of a 2,648-line component through
one state object and rewriting the per-aspect zoom helpers: XL, high regression risk, no
user-visible gain. Instead: (a) mirror `undoStackRef.length` into state for `canUndo/canRedo`
(P6 needs it); (b) add `cropRegionsByAspect` and `subtitleCues` to the snapshot; (c) skip
Ctrl+Z when `isTextEditingTarget(e.target)` (currently undoes the timeline while typing in the
annotation textarea; upstream has the same gap).

### P10 Lazy-load editor

- `42c596da`: `const VideoEditor = lazy(() => import(...))` + `Suspense` in `src/App.tsx`
  (also `useScreenRecorder.ts` cleanup unrelated). Capturia `App.tsx` imports eagerly, so
  the HUD/source-selector windows pay for pixi + exporter. XS, no conflicts; add
  `editor.loadingEditor` string.

### S4 Global open-app shortcut vs Capturia stop-recording shortcut

- Upstream: `480890bc` + `d86c1740` (`KEY_TO_ACCELERATOR`), `902d4e4d` (failure surfaced),
  `59c9a192` (register new before unregistering old), `ff40a73a` (dialog stays open on
  failure), `ed5ef322`. `openApp` is a `ShortcutAction` stored in the same `shortcuts.json`;
  main reads it at startup (`loadAndRegisterGlobalShortcut`) and on `update-global-shortcut`.
- Capturia: `main.ts` `registerStopRecordingShortcut` (accelerator string, keep-old-on-failure,
  default `CommandOrControl+Shift+2`) configured from `LaunchWindow.tsx:228-424` with a raw
  accelerator string persisted in renderer `localStorage` (`STOP_SHORTCUT_STORAGE_KEY`), so
  the main process only learns it after the HUD renders; it is not in `shortcuts.json` and
  not validated by `findConflict`. No "open app" shortcut.
- Port: `electron/globalShortcut.ts` generalised to a map of `{openApp, stopRecording}`
  bindings -> accelerators; add `openApp` and `stopRecording` to `SHORTCUT_ACTIONS` (mark
  them `global: true` so `matchesShortcut` in the editor ignores them); `persistShortcuts`
  returns success; `ShortcutsConfigDialog` shows `shortcut.registrationFailed`. Migrate the
  HUD's stored accelerator once. Touches `main.ts`, `preload.ts`, `handlers.ts`
  (`SHORTCUTS_FILE` export), `LaunchWindow.tsx`.

## 3. i18n decision

### What each side has

Capturia `src/i18n/index.tsx` (941 lines): `Locale = "en" | "zh-CN"`, one flat map per locale,
419 keys each (fully in parity), prefixes `app common error launch source permission playback
editor settings export format gif shortcut tutorial annotation font timeline electron`.
`useI18n()` returns `{locale, setLocale, t(key, params)}`; `{{var}}` interpolation; fallback
to en then to the key. Consumed by 21 files (~259 distinct `t("...")` call sites). Locale
chooser is a `<select>` in the HUD (`LaunchWindow.tsx:1247`) hard-coded to two options;
`normalizeLocale` also maps `navigator.language`. Main process has its own tiny dictionaries
(`main.ts` `trayText`, `runtimeErrorText`; `handlers.ts` `tt(locale, key)`).

Upstream v1.7.0: `src/i18n/config.ts` (`SUPPORTED_LOCALES` 13, `I18N_NAMESPACES` 7),
`loader.ts` (`import.meta.glob` of `locales/**/*.json`, excludes incomplete locale folders,
`translate(locale, ns, key, vars)`), `contexts/I18nContext.tsx` (`useI18n().t("ns.key")`
**and** `useScopedT(ns)`, system-language suggestion prompt once, `electronAPI.setLocale`),
`electron/i18n.ts` (imports `common`+`dialogs` JSON of every locale, `mainT`), tray + app
menu rebuilt on locale change, `scripts/i18n-check.mjs` (key parity vs en; **fails on v1.7.0
with 247 missing / 12 extra keys across 12 locales** - mostly the late `timeline.buttons.auto*`
and `settings` additions; v1.10.0 passes), `tutorialHelpTranslations.test.ts`. en key count
~499 (common 42, dialogs 68, editor 71, launch 51, settings 180, shortcuts 36, timeline 51).
v1.10.0 (`9a95802c`) swapped the hand-rolled loader for `i18next` but kept the same file
layout, `I18nContext` API and namespaces; its en set is much larger (editor 347, settings
263) because of the new editor - not importable as a whole.

### Key overlap

The two key sets describe mostly the same UI but with different naming
(`settings.exportQuality.high` vs Capturia `settings.quality.high`, `timeline.buttons.addZoom`
vs `timeline.addZoom`, `shortcuts.actions.addZoom` vs `shortcut.addZoom`). Roughly 60 % of
Capturia's 419 keys have a semantic twin upstream; the rest are Capturia-only features
(permissions window 33 keys, subtitles/analysis, audio processing, aspect crop, capture
profiles, export batching). Upstream has ~150 keys for features Capturia lacks (webcam
layout, blur, cursor themes, 3D, captions, notes).

### Options

(a) **Adopt upstream's system wholesale** (files, namespaces, key names, `useScopedT`,
13 locales, `electron/i18n.ts`, check script):
- Rewrite ~259 call sites in 21 files + the 419-key table; every Capturia-only key must be
  invented in upstream's namespace style and translated to 12 new locales (or left English,
  which the check script then flags unless the file is padded with English).
- Touches every hot file (VideoEditor, TimelineEditor, SettingsPanel, LaunchWindow) at the
  same time as the feature batches -> merge conflicts with every other stream.
- Effort: L-XL (3-6 days plus a translation pass), high regression surface, no feature gain.

(b) **Keep Capturia's system, import upstream translations**:
- Keep the flat file; copy values for matching keys into zh-CN (Capturia's zh-CN is already
  complete, so the gain is zero) and add new locales as more 419-entry objects in a
  941-line TSX file -> unmaintainable (13 x 419 inline strings), no parity check, main
  process still has private dictionaries.
- Effort: S per locale but poor end state.

(c) **Recommended - adopt upstream's structure, keep Capturia's call-site contract**:
1. Move Capturia's strings into `src/i18n/locales/<locale>/<ns>.json` using the seven
   upstream namespaces (`common dialogs editor launch settings shortcuts timeline`), keeping
   Capturia's **existing key names** as the leaf keys where the prefix already matches an
   upstream namespace (`timeline.*`, `settings.*`, `shortcut.*` -> `shortcuts`, `launch.*`,
   `source.*`/`permission.*` -> `launch`, `export.*`/`tutorial.*`/`format.*`/`gif.*` ->
   `dialogs`, `annotation.*`/`font.*` -> `settings`, `electron.*` -> `common`).
   A one-off script does the split; call sites keep working if the loader resolves
   `t("timeline.addZoom")` by namespace prefix - exactly what upstream's `I18nContext.t`
   already does (`qualifiedKey.slice(0, dotIndex)` = namespace). Only keys whose Capturia
   prefix is not a namespace need a rename (`app.*`, `error.*`, `playback.*` -> `common.*`,
   `shortcut.*` -> `shortcuts.*`, `annotation.*`/`font.*` -> `settings.*`): ~90 call sites,
   mechanical.
2. Port `config.ts`, `loader.ts` (v1.7.0 hand-rolled version: zero deps, ~120 lines;
   apply `8e0a6268`'s fallback fix), `I18nContext.tsx` (keep exporting `useI18n` from
   `@/i18n` so imports do not move; add `useScopedT` for newly ported components),
   `scripts/i18n-check.mjs` + `npm run i18n:check`, `electron/i18n.ts` (replace `trayText`,
   `runtimeErrorText`, `tt()` with `mainT`), `set-locale` IPC, and the tutorial parity test.
3. Import translations: for every Capturia key with an upstream twin, take the upstream
   value per locale (prefer v1.10.0 files where the key still exists, since they pass parity;
   fall back to v1.7.0). Ship `en`, `zh-CN` (Capturia's own, complete), `vi` (Capturia's user
   base) first; add the other 10 locales only for keys that have upstream values and let
   missing keys fall back to en (the loader does this; run `i18n-check` in warn mode until
   the Capturia-only keys are translated).
4. Replace the HUD `<select>` with a list driven by `getAvailableLocales()` +
   `getLocaleName()`; add the system-locale suggestion prompt (optional).

Effort: M-L (2-3 days for the mechanical move + loader + main-process i18n; translation
import is scriptable). Do it as its own batch **before** the feature batches so ported
components can use upstream key names (`timeline.hints.pressZoom`, `editor.regionClipboard.*`,
`settings.textAnimation.*`) verbatim and the locale JSON diffs from upstream apply cleanly.
Risk: the batch touches every UI file; keep it purely mechanical (no behaviour change) and
land it while no other batch is open on `LaunchWindow.tsx`/`SettingsPanel.tsx`.

## 4. Recommended implementation order

Hot shared files are marked: **VE** `VideoEditor.tsx`, **TE** `TimelineEditor.tsx`,
**SP** `SettingsPanel.tsx`, **TY** `types.ts`, **HD** `electron/ipc/handlers.ts`,
**PL** `electron/preload.ts` (+`vite-env.d.ts`), **I18N** locale files.

| Batch | Contents | Hot files | Independent tests |
|---|---|---|---|
| B3-0 i18n restructure (I1) | namespaced JSON, loader, context, check script, `electron/i18n.ts`, HUD locale list; import vi + upstream values | I18N, every UI file (mechanical), `main.ts`, HD, PL | `i18n-check`, tutorial parity test, `loader.test.ts` (new: fallback, interpolation) |
| B3-1 pure libs | `frameStep.ts` (T9 lib), `customPlaybackSpeed.ts` (T10), `regionPlacement.ts` (T4), `annotationTextAnimation.ts` (A2 lib), `userPreferences.ts` + `editorDefaults.ts` (P5/P7 libs), `isTextEditingTarget` + `copySelected/paste` actions in `shortcuts.ts` (S5/T3) | TY (speed constants, `textAnimation` field), `shortcuts.ts` | all upstream tests ported: frameStep (42), customPlaybackSpeed (67), regionPlacement (54), annotationTextAnimation (50), userPreferences (136, jsdom), editorDefaults (55), shortcuts.test additions |
| B3-2 timeline interaction | T1 snap + tooltip, T8 clamp, T6 edge pan, T5 scrubbing, T11 selection fix, T13 item label, `hasOverlap` strict intersection | TE, `TimelineWrapper.tsx`, `Item.tsx`, VE (T11) | extracted `snapSpanToTargets`/`clampVisibleRange` unit tests; manual smoke |
| B3-3 waveform + row hints | T2 (in-memory path), T14, Timeline settings toggle, `showTrimWaveform` in `ProjectState` | TE, `Row.tsx`, SP, VE, TY | peak-bucketing test; manual smoke with/without audio |
| B3-4 annotations | A4 wrapping/CJK (renderer), A2 animation (overlay + renderer + panel), A1 duplicate, A6 empty content, A3 fonts (self-hosted) | `annotationRenderer.ts`, `AnnotationOverlay.tsx`, `AnnotationSettingsPanel.tsx`, SP, VE, `VideoPlayback.tsx`, `index.css` | `tokenizeForWrap` test, `types.test.ts`, animation test (from B3-1); export golden check manual |
| B3-5 copy/paste + frame step + speed input UI | T3 handlers/keydown, T9 keybinding + FIXED entries, T10 `CustomSpeedInput` in segment section, `cd0f2ab3` arrow guard | VE, SP, `shortcuts.ts`, `ShortcutsConfigDialog.tsx`, I18N | `regionClipboard.test.ts` (203) adapted; manual |
| B3-6 lifecycle & prefs | P5 wiring (defaults for new projects, remembered export folder), P2 picker filters, P3 flush-on-close, P10 lazy editor, P9(a-c) undo tweaks | VE, HD, PL, `main.ts`, `App.tsx` | `parentDirectoryOf` (in B3-1 tests); manual close/quit/export |
| B3-7 menus & global shortcuts | P6 `EditorMenuBar` + native menu + `setAutoHideMenuBar`, S4 `globalShortcut.ts` generalised (open app + stop recording in `ShortcutsConfig`) | VE, `main.ts`, `windows.ts`, PL, HD, `ShortcutsContext.tsx`, `ShortcutsConfigDialog.tsx`, `LaunchWindow.tsx`, I18N | `EditorMenuBar.test.tsx` (176, jsdom + testing-library), `bindingToAccelerator` unit test (extract) |

New devDependencies needed by ported tests: `jsdom`, `@testing-library/react`,
`@testing-library/user-event`, `@testing-library/jest-dom` (B3-1 for jsdom, B3-7 for the
rest). Keep Capturia's default `environment: 'node'` and opt in per file.

No npm runtime dependency is required for B3 except `web-demuxer` **if** the streaming
waveform path is wanted (defer to stream D). Fonts (A3) should be self-hosted assets.

## 5. Do NOT port / keep Capturia's version

| Item | Reason |
|---|---|
| Trim regions row, speed regions row, `SpeedRegion`/`TrimRegion` handlers (`112f02fe` bulk) | Capturia's segment model (`be7e959`, `129ee0a`) is the product's core; upstream's `timelineSegments.ts` derives segments from regions - the reverse of Capturia. Porting would fork the editing model. |
| `useEditorHistory.ts` | XL rewrite of `VideoEditor` state for no user-facing gain; Capturia's stack works with `zoomRegionsByAspect`. Take only `canUndo/canRedo` exposure and input guard. |
| `.openscreen` project files, `projectPersistence.ts`, `EditorEmptyState` drag-drop, New Project flow, `UnsavedChangesDialog` variants, `hasProjectUnsavedChanges` | Capturia auto-saves a sidecar per video; there is no unsaved state. Re-introducing explicit files would confuse the two persistence paths. Only the close-flush (P3) and picker filters (P2) apply. |
| Plain-wheel horizontal pan (T7) | Capturia's rows scroll vertically (`b079239`); Ctrl+wheel zoom is playhead-centred (`d8b6cd1`). |
| Arrow keys = 1/60 s frame step (T9 as-is) | Capturia users have a configurable seek step; frame step goes on separate keys. |
| Upstream `PlaybackControls`, fullscreen (P11/P12) | Capturia's are supersets. |
| `matchesShortcut` without secondary-modifier rejection | Capturia's rejects Meta on non-mac / Ctrl on mac; stricter and tested. |
| `SHORTCUT_LABELS` English map | Capturia's `SHORTCUT_LABEL_KEYS` is already i18n-driven. |
| Playhead rAF decoupling (T15) | Breaks hover-preview seeking unless gated; revisit only on measured jank. |
| `featureFlags.ts`, `addBlur` shortcut, blur row | Depends on B1 porting blur annotations; upstream itself disabled the row. |
| "clip tooltip" (`1d7b677f`) | Cursor setting tooltip; B2 scope. |
| Streaming waveform (`streamingAudioPeaks.ts`) and v1.10 native waveform | Needs `web-demuxer`, OPFS source materialisation (D) or the Rust/ffmpeg stack (out of scope). |
| Google Fonts `@import` in `index.css` | Runtime network dependency; self-host instead. |
| i18next (v1.10 `9a95802c`) | v1.7.0's dependency-free loader is enough for Capturia's key count; revisit if plural rules are needed. |

## 6. Capturia bugs found during mapping (fix opportunistically)

1. `VideoEditor.tsx:719` `maxIdNum(s.annotationRegions, 'anno-')` never matches ids
   `annotation-N` -> id collisions after restore (A1).
2. `handleSelectZoom` leaves `selectedAnnotationId` set (T11).
3. Arrow keys on the seek-step `Slider` both move the slider and seek (T9 guard).
4. Ctrl+Z inside the annotation textarea undoes timeline edits (P9c).
5. Window close within the 2 s auto-save debounce loses edits (P3).
6. Segment speeds > 16x preview at 16x silently (`videoEventHandlers.ts:95`); export is
   correct. Upstream `27363e70` is the fix pattern (stream D).
