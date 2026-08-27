# Gap report A: Recording / launch HUD / native capture

Status: analysis complete (2026-08-27). Read-only; no source changed.

Reference trees: Capturia working tree (`feat/upstream-sync-v1.7`), fork base
`/tmp/openscreen-base` (87735c27), sync target `/tmp/openscreen-v1.7.0`, upstream main
`/tmp/openscreen-upstream` (v1.10.0, used only for follow-up commits).

## 0. Architectural context (read first)

The two recorders diverged a lot more than the editor did. Before classifying features:

| Concern | Capturia today | Upstream v1.7.0 |
|---|---|---|
| Hook shape | `src/hooks/useScreenRecorder.ts` (1346 lines) takes options (`includeCamera`, `cameraShape`, `cameraSizePercent`, `captureProfile`, `captureFrameRate`, `captureResolutionPreset`, `recordSystemCursor`, `microphoneGain`), returns `recording / recordingState / toggle / pause / resume / discard` + timing refs. | `src/hooks/useScreenRecorder.ts` (1754 lines) owns all HUD state (mic/webcam/system-audio/cursor-mode/devices), returns `recording / paused / saving / elapsedSeconds / toggleRecording / togglePaused / restartRecording / cancelRecording / ...`. |
| macOS native path | `electron/native/sckRecorder.ts` + `electron/native/macos/sck-recorder.swift` (1217 lines). CLI flags, `SCK_RECORDER_READY/DONE/ERROR` stdout lines, stop via `SIGINT`. Mic via `AVCaptureDevice` audio, **camera overlay composited inside the helper**, `--hide-cursor`, `--width/--height`, `--bitrate-scale`. No system audio (`capturesAudio = false`), no pause, no stdin commands. | `electron/native/screencapturekit/Sources/OpenScreenScreenCaptureKitHelper/main.swift` (693 lines). One JSON request arg, newline-JSON events (`ready`, `recording-started`, `recording-stopped`, `warning`, `error`), stdin commands `pause`/`resume`/`stop`. SCK system audio + native SCK mic (when the OS exposes it), no webcam (webcam is an Electron sidecar). |
| Windows native path | none (getDisplayMedia / legacy `chromeMediaSource`) | `electron/native/wgc-capture/*` C++ helper (4.5k lines) + `electron/ipc/handlers.ts` `start-native-windows-recording` etc. |
| Output model | one file (`recording-<ts>.webm` or `.mp4`) + `CurrentVideoMetadata` (frameRate, size, mimeType, `systemCursorMode`, `hasMicrophoneAudio`, `cursorTrack` sidecar `*.cursor.json` written by `writeCursorTrackSidecar`). Camera is **baked into the pixels**. | `RecordingSession { screenVideoPath, webcamVideoPath?, cursorCaptureMode, createdAt }` + `recording-<id>.session.json` manifest + `<video>.cursor.json`. Webcam is a **separate sidecar file** (`recording-<id>-webcam.webm`) composited in the editor. |
| Cursor telemetry | `electron/ipc/handlers.ts` `cursor-tracker-start/stop` (16 ms `screen.getCursorScreenPoint` poll, `cursorKindMonitor.ts` arrow/ibeam, `mouseButtonMonitor.ts` clicks + selection gestures, `windowBounds.ts` for window sources). | `electron/native-bridge/cursor/recording/*` sessions: mac `openscreen-macos-cursor-helper` (NSCursor bitmaps + CGEvent tap + AX pointer/text), Windows `cursor-sampler.cpp`, Linux position-only. Editor renders native cursor bitmaps (stream B2). |
| HUD window | `electron/windows.ts` fixed-size transparent window (760–2200 x 300–420), always-on-top `screen-saver`, Linux X11 `type: 'dock'`, **not click-through** (transparent area swallows desktop clicks), Radix `Popover`s, `-webkit-app-region` drag, minimize-to-hide, `hud-overlay-resize/restore`. | 600x160 window resized to content via `hud-overlay-set-size` (bottom-centre anchored), click-through via `setIgnoreMouseEvents` + `data-hud-interactive` hit-testing, JS drag via `hud-overlay-move-by`, `Tooltip`, portal language menu, vertical/horizontal tray layout. |
| HUD features Capturia has that upstream lacks | Configurable countdown seconds (0/3/5/8), auto-hide HUD on record, configurable global **stop** shortcut with key capture, capture profile / Pro (fps + resolution) settings, system-cursor show/hide toggle, camera shape + size, Permissions button -> `PermissionCheckerWindow`, permission preflight before opening the picker and before recording, `reportUserActionError` plumbing. | — |
| Tests | Capturia: 32 files / 204 tests, vitest `environment: node`, `include: src/**` only, no jsdom / testing-library. | jsdom + `@testing-library/react`, `include: {src,electron,.github}/**`. |

Consequences for this stream:

1. Anything upstream wrote against `RecordingSession` / webcam sidecar needs a joint decision with
   stream B1 (editor composite). This report proposes the recording-side shape but does not assume B1
   lands.
2. Anything against the upstream SCK helper JSON protocol is **not** portable as-is; port the
   *behaviour* into `sck-recorder.swift` + `sckRecorder.ts`.
3. Porting any upstream `LaunchWindow.test.tsx` requires adding `jsdom`, `@testing-library/react`,
   `@testing-library/jest-dom` as devDependencies and a `// @vitest-environment jsdom` opt-in (keep the
   node default, as upstream did later in f172110f). Porting `electron/**` tests requires widening
   `vitest.config.ts` `include`.

## 1. Summary table

Effort: S < 0.5 day, M 0.5–2 days, L 2–5 days, XL > 1 week. "Hot files" = `LaunchWindow.tsx`,
`useScreenRecorder.ts`, `electron/ipc/handlers.ts`, `electron/main.ts`, `electron/preload.ts`,
`electron/electron-env.d.ts`, `src/vite-env.d.ts`.

| # | Feature | Upstream files (v1.7.0) | Capturia status | Effort | Recommendation |
|---|---|---|---|---|---|
| A1 | Stream long recordings to disk + WebM duration patch on save | `src/hooks/recorderHandle.ts`, `electron/ipc/recordingStream.ts`, `electron/recording/webm-duration.ts`, `handlers.ts` `storeRecordedSessionFiles`/`finalizeRecordingFile` | MISSING (chunks buffered in memory, `fixWebmDuration` in renderer) | M | **Port** (batch 1). Highest value: prevents renderer OOM on long recordings. |
| A2 | Parallel screen+mic capture (mic lag fix) | `useScreenRecorder.ts` `startRecording` (e736ff4a, f698bba6) | MISSING (sequential `captureDesktopStream` then `captureRequiredMicrophoneStream`) | S | **Port** the parallelisation; mic fade-in gain belongs to stream D (`audioMix.ts`). |
| A3 | Cancel recording (discard) | `cancelRecording`, `discardRecordingId`, `stop-native-*-recording(discard)` deletes file + `.cursor.json` | PRESENT-DIFFERENT, **buggy on native path** (see 3.3) | S | **Fix** Capturia's `discardRecording` native branch using upstream's `discard` flag on the stop IPC. |
| A4 | Restart recording (async, `restarting` guard) | `restartRecording` in `useScreenRecorder.ts` (0727b61d, 119c3acb, e2147bec) | MISSING | S–M | **Port** after A3 (restart = discard + start). Add HUD button. |
| A5 | Pause/resume while recording + duration fix | `togglePaused`, `accumulatedDurationMs`/`segmentStartedAt` (b002f2a4, c868469b); native mac pause via stdin `pause`/`resume` + sample-buffer retiming (73870c65); cursor pause-range compaction (`compactPendingCursorTelemetryPauseRanges`) | PARTIAL: MediaRecorder path present and correct (`cumulativePauseMs`/`pauseStartTime`, Capturia commit 5749ea7f). **Native SCK path: pause is a no-op** (`pauseRecording` returns when `nativeRecordingActive`). | L | Port pause into `sck-recorder.swift` (stdin command loop + CMTime offset) + `sckRecorder.ts` + cursor tracker pause ranges. Batch 3. |
| A6 | Countdown before record start (overlay window, IPC run token) | `src/components/launch/CountdownOverlay.tsx`, `windows.ts` `createCountdownOverlayWindow`, `handlers.ts` `countdown-overlay-show/set-value/hide`, `useScreenRecorder.ts` `startRecordCountdown` + `countdownRunId` (1670db41 .. 4a65ab81) | PRESENT-DIFFERENT: Capturia has configurable 0/3/5/8 s countdown rendered *in the HUD button* (`beginRecordCountdown` in `LaunchWindow.tsx`), cancel on click, no screen overlay. | M | Keep Capturia's seconds setting; **add the overlay window** driven by Capturia's timer. Optional / batch 4. |
| A7 | Chain recording after source selection | `LaunchWindow.tsx` `recordAfterSourceSelectionRef`, `onSelectedSourceChanged`, `onSourceSelectorClosed`, `handlers.ts` `select-source` emits `selected-source-changed`, `main.ts` selector `closed` -> `source-selector-closed` (48dfe748) | MISSING (record button with no source only opens the picker) | S | **Port** (batch 2). Brings 5 upstream tests. |
| A8 | Screen source selection recovery flow | `openSourceSelectorFlow.ts` (+3 tests), `SourceSelector.tsx` empty state + reload, `request-screen-access` (6ba9f1e9) | PRESENT-DIFFERENT: Capturia has `getScreenCaptureAccessStatus`, `PermissionCheckerWindow`, retry / open-settings / check-permissions buttons (richer). Missing only the "0 sources, no error" empty state. | S | Keep Capturia flow; add empty-state + reload and source counts. Do not port `openSourceSelectorFlow.ts`. |
| A9 | Default to Windows tab when no screens + source counts | `SourceSelector.tsx` (dcf35a6e) | MISSING | S | Port with A8. |
| A10 | SourceSelector squircle / spinner polish | `SourceSelector.module.css`, `SourceSelector.tsx` (1cdb8ed1) | MISSING (cosmetic) | S | Optional, with A8. |
| A11 | Webcam recording as separate sidecar track (+ webcam toggle, `acquireId` guard, camera-disconnected toast, webcam start after native start) | `useScreenRecorder.ts` webcam effect, `createRecorderHandle` for webcam, `store-recorded-session`, `attach-native-mac-webcam-recording`, `src/lib/recordingSession.ts` (2fb5b3b5, 942a7e59, c3e4c86b, 210baee0, d11eea04, 5b67fd78) | PRESENT-DIFFERENT: Capturia bakes the camera into pixels (canvas composite in `buildCompositedStream`; `CameraCaptureProvider` inside `sck-recorder.swift`) with shape/size. Toggle while recording: upstream final state also disables it while recording (`disabled={recording \|\| saving}`). | XL (A-side M–L) | **Joint decision with B1.** Keep baked overlay as default (ground rule 1). If B1 adopts editor PiP, add sidecar as a second camera mode. Not in the first batches. |
| A12 | Webcam source selector + camera permission handling + camera light fix | `src/hooks/useCameraDevices.ts` (+5 tests), `src/lib/requestCameraAccess.ts`, `handlers.ts` `request-camera-access`, HUD device popups (0a5e57ce, 579887e2, 20b0899c) | PARTIAL: Capturia auto-picks a non-virtual camera (`pickPreferredCameraId`; Swift `selectCaptureDevice`), no user choice; camera permission handled by `PermissionCheckerWindow` + `request-capture-permission-access('camera')`. | M | Port `useCameraDevices` + a device `<select>` in the camera popover; pass chosen device to the Swift helper (`--camera-device-id`, AVCaptureDevice `uniqueID`) and to `getUserMedia` `deviceId.exact`. Batch 4. Camera-light fix is N/A (Capturia opens the camera only at record time). |
| A13 | Mic toggle, mic device selector, level meter, system-audio toggle | `useMicrophoneDevices.ts`, `useAudioLevelMeter.ts`, `ui/audio-level-meter`, `src/lib/audioMix.ts` (64bc261c, 371f79a3, e736ff4a) | MISSING: mic is **mandatory** (`captureRequiredMicrophoneStream` throws -> recording fails when denied); no system audio anywhere; Swift helper `capturesAudio = false`. | M (browser path) / L (SCK system audio) | Port toggle + device picker + meter for the MediaRecorder path in batch 4 (mixing from stream D). SCK system audio = Swift work (`SCStreamConfiguration.capturesAudio`, second `AVAssetWriterInput`); see upstream helper + v1.9 audio-timeline fixes (71428067, 7faa2909, df042715, efe5accc). |
| A14 | Notes / teleprompter window | `src/components/launch/NotesWindow.tsx`, `NotesToolbar.tsx`, `NotesWindow.module.css`, `windows.ts` `createNotesWindow` (content-protected), `handlers.ts` `open-notes`, `main.ts` wrapper, `App.tsx` `showNotes` (9711a6c5 .. 34d687c9, f695b4c7) | MISSING | M | Port (batch 5). Deps: `@tiptap/react`, `@tiptap/starter-kit`, `@tiptap/extension-text-style`, a `Tooltip` component (`@radix-ui/react-tooltip`, Capturia lacks `ui/tooltip.tsx`). Take v1.8 fixes adaba8ef (plain `.css`, not module) and ad8fef3a (macOS 26 content-protection gate). Teleprompter mode 44e16483 optional. |
| A15 | Start a new recording from the editor | `VideoEditor.tsx` "New Recording" dialog, `switch-to-hud`/`start-new-recording` IPC, `main.ts` `switchToHudWrapper` (14cd045e) | PRESENT-DIFFERENT: Capturia `VideoEditor.tsx:2295` saves project state then `switchToLaunch()` (`main.ts` `switch-to-launch`). Upstream clears current video + confirm dialog. | — | Keep Capturia's (auto-save is better). NOT-PORT. |
| A16 | Record permissions prompt (mac Accessibility dialog for editable cursor) | `handlers.ts` `request-native-mac-cursor-access` (43b01cfb) | PRESENT-DIFFERENT: Capturia preflights via `getCapturePermissionSnapshot` + `resolveRecordingPermissionReadiness` and opens `PermissionCheckerWindow`. | — | Keep Capturia's. NOT-PORT. |
| A17 | HUD follows macOS Spaces (HUD + source selector) | `windows.ts` `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })` (e7d82e14) | PARTIAL: HUD calls `setVisibleOnAllWorkspaces(!isLinuxWayland)` without `visibleOnFullScreen`; source selector and permission checker have nothing. | S | Port (batch 2). |
| A18 | Avoid horizontal scrollbar on Windows | `App.tsx` overflow hidden, root `w-full` not `w-screen` (1b980d62) | PRESENT-SAME (`App.tsx` sets `overflow: hidden` for hud/source windows; root uses `w-full h-full`). | — | Nothing. |
| A19 | Keep HUD interactive on Linux | `LaunchWindow.tsx` `isLinuxHud` (8246d071) | NOT-APPLICABLE (Capturia HUD is never click-through). | — | Only relevant if A24 is adopted. |
| A20 | Language switching menu in HUD + HUD sizing for system-language prompt | `LaunchWindow.tsx` portal menu, `getAvailableLocales`, `systemLocaleSuggestion` (0c627da2, c9c2634d, 97fbb018, d1c95554, 3a81f554) | PRESENT-DIFFERENT: Capturia has a `<select>` with en / zh-CN over a single-file dictionary (`src/i18n/index.tsx`). | — | Defer to stream B3 (i18n architecture). Not worth porting the menu on top of a 2-locale select. |
| A21 | Guard duplicate HUD creation | `main.ts` `createWindow()` early return (59cfe26f) | MISSING (`createWindow()` unconditionally creates; `activate` and tray "Open" can double-create in edge cases) | S | Port (batch 2). |
| A22 | Single instance lock | `main.ts` `app.requestSingleInstanceLock()` + `second-instance` -> `showMainWindow()` (eb04f4e0). `singleInstanceLock.ts` PID lock (77904538) was **removed** upstream in 83ea5edb (bricked startup after PID reuse). | MISSING | S | Port the Electron lock only. Do **not** port `electron/singleInstanceLock.ts`. Mind Capturia's `before-quit` async shutdown (`ipcRuntime.shutdown()`): `app.quit()` on lock failure happens before `whenReady`, so `ipcRuntime` is null and the path is safe. |
| A23 | Global shortcut to open the app | `electron/globalShortcut.ts`, `main.ts` `loadAndRegisterGlobalShortcut`/`update-global-shortcut`, `src/lib/shortcuts.ts` `openApp` binding, `ShortcutsContext.tsx` (480890bc, d86c1740, 902d4e4d, 59c9a192) | MISSING (Capturia has a configurable global **stop-recording** shortcut in `main.ts` `registerStopRecordingShortcut`, unrelated) | S–M | Port (batch 5). Reuse Capturia's shortcuts persistence (`get-shortcuts`/`save-shortcuts`, `ShortcutsConfigDialog`). Risk: accelerator collisions with the stop shortcut; validate on register (upstream's "register new before unregister old" pattern). |
| A24 | HUD click-through + JS drag + content-fit resize (`hud-overlay-ignore-mouse-events`, `hud-overlay-move-by`, `hud-overlay-set-size`) | `windows.ts`, `LaunchWindow.tsx` `setHudMouseEventsEnabled`, `measureHudSize` | MISSING (Capturia uses a large fixed window; transparent reserve swallows clicks) | L | Optional UX upgrade; if taken, port from **v1.10** state (3bee346a cursor poll, 6eb5bbb7 not-born-click-through, 428a277b `\| 0`), not v1.7.0's `{ forward: true }`. Not in initial batches. |
| A25 | Vertical tray layout toggle + tray icon sizes | `LaunchWindow.tsx` `trayLayout`, `userPreferences.ts` (c293786e, 993f693b); `main.ts` `trayIconSize = isMac ? 16 : 24` (33a60fed, d526ab4c); tray click/double-click opens HUD (4655e71c) | MISSING. Capturia tray: 24 px everywhere, no click handler (context menu only). | S (icon + click) / L (vertical layout, needs A24) | Port icon size + tray click (batch 2). Vertical layout only with A24. |
| A26 | macOS ScreenCaptureKit helper (upstream) | `electron/native/screencapturekit/*`, `src/lib/nativeMacRecording.ts` (+4 tests), `handlers.ts` `start/pause/resume/stop-native-mac-recording`, `is-native-mac-capture-available` (fbdc7d56 .. 179047b8, 3ef2001f) | PRESENT-DIFFERENT: Capturia's `sck-recorder.swift` is more capable in some areas (camera overlay, size/bitrate control, OS-version fallback `os_version_unsupported` -> WebRTC) and less in others (no pause, no system audio, no JSON event protocol, no `captureBounds` event). | — | **Keep Capturia's helper.** Cherry-pick behaviours: pause (A5), system audio (A13), `_ = CGMainDisplayID()` init before window filter (c9cd061d, v1.10), mic device selection. Do not port `nativeMacRecording.ts` types. |
| A27 | Windows WGC helper | `electron/native/wgc-capture/*` (4.5k lines C++), `scripts/build-windows-wgc-helper.mjs`, `src/lib/nativeWindowsRecording.ts`, ~700 lines in `handlers.ts`, hook branch `startNativeWindowsRecordingIfAvailable`, software-encoder fallback notice (d3a749b7) | MISSING (Capturia uses getDisplayMedia on Windows) | XL | **Defer** to its own project. If done, take the helper from v1.10 (`/tmp/openscreen-upstream/electron/native/wgc-capture`, still standalone, 6.2k lines: DPI awareness, fragmented MP4, GPU readback, hang fixes) and the v1.10 `nativeWindowsCaptureStop.ts`. Needs a Windows toolchain and CI. |
| A28 | Native cursor recording sessions (`electron/native-bridge/*`) + mac cursor helper bitmaps | `electron/native-bridge/cursor/recording/{factory,macNativeCursorRecordingSession,windowsNativeRecordingSession,telemetryRecordingSession}.ts`, `OpenScreenMacOSCursorHelper/main.swift` (44f59bfa, 248ebabc, e82fc0d8) | PRESENT-DIFFERENT: Capturia's `cursor-tracker-*` + `cursorKindMonitor.ts` (arrow/ibeam) + `mouseButtonMonitor.ts` (clicks, selection gestures) + `windowBounds.ts`. Upstream adds `pointer` (hand) cursor kind and real cursor bitmaps. | — | Keep Capturia's tracker. Bitmap capture is a stream B2 decision. NOT-PORT from A. |
| A29 | Cursor telemetry buffer keyed by recordingId | `src/lib/cursorTelemetryBuffer.ts` (+16 tests) (3b9b4192) | NOT-APPLICABLE: in v1.7.0 the file is orphaned (only its own test imports it; superseded by native-bridge sessions). | — | Do not port. |
| A30 | Camera permission on webcam enable (`request-camera-access`) | `handlers.ts`, `src/lib/requestCameraAccess.ts` | PARTIAL: Capturia has `request-capture-permission-access('camera')` but the hook falls back to screen-only silently on camera failure. | S | Add a toast on camera fallback (`t("launch.cameraFallback")`). With A12. |
| A31 | Software-encoder fallback notice | `LaunchWindow.tsx`, `userPreferences.ts` (d3a749b7) | NOT-APPLICABLE (Windows helper only). | — | With A27 only. |
| A32 | Electron permission allowlists (`screen`, `display-capture`) + proactive screen-permission check on startup | `main.ts` `setPermissionCheckHandler/RequestHandler` (c9b60746), `be4e2d0c` | Capturia has neither handler (default allow) and checks screen permission lazily via the permission checker. | S | Belongs to stream F (security); noting here because it gates `getDisplayMedia`. |

## 2. Per-feature detail

### 2.1 A1 Streaming recordings to disk + on-disk WebM duration patch

What it does: `createRecorderHandle(stream, options, fileName)` wraps `MediaRecorder`, opens a
write stream in main (`open-recording-stream`), appends each 1 s chunk (`append-recording-chunk`) in
arrival order with a serialised write chain, and falls back to in-memory buffering if the open fails
or the IPC is missing (version skew). On stop, `store-recorded-session` calls
`RecordingStreamRegistry.finalize()`; streamed files get `patchWebmDurationOnDisk(path, durationMs)`
(2 MB header read + stream copy; whole-file fallback under 2 MB). `discard()` closes and unlinks the
partial file.

Upstream commits (final state): 727e395f -> f3c5b8a6 (registry extracted, tests) -> 36d7d2bd,
5c5cab69 (skew guard) -> 4613c283 (optimised patcher + "Saving..." state) -> 411171ce.

Capturia mapping:
- `src/hooks/useScreenRecorder.ts:1087-1202` (`ondataavailable` -> `chunks.current`, `onstop` ->
  `fixWebmDuration` -> `storeRecordedVideo(arrayBuffer, name, metadata)`).
- `electron/ipc/handlers.ts:1588` `store-recorded-video` writes the buffer, sets
  `currentVideoMetadata`, writes cursor sidecar, schedules cleanup.

Port notes:
- Copy `src/hooks/recorderHandle.ts` (+ `recorderHandle.test.ts`, 10 tests, node env with a
  fake `window.electronAPI`), `electron/ipc/recordingStream.ts` (+7 tests, needs `include`
  `electron/**` in `vitest.config.ts`), `electron/recording/webm-duration.ts` (+3 tests; add
  `@fix-webm-duration/parser` to `dependencies` explicitly, it is already in `node_modules` as a
  transitive dep of `@fix-webm-duration/fix`).
- Add `resolveRecordingOutputPath(fileName)` (path-traversal guard) and `finalizeRecordingFile()` to
  `handlers.ts`; extend `store-recorded-video` to accept `durationMs` in `metadata`, call
  `registry.finalize` first and only write `videoData` when not streamed, then
  `patchWebmDurationOnDisk` when streamed. Keep Capturia's metadata + `writeCursorTrackSidecar` +
  `scheduleRecordingsCleanup({ excludePaths: [videoPath] })` exactly as is.
- Hook: replace `mediaRecorder`/`chunks` with a `RecorderHandle`; on discard call `handle.discard()`.
  Keep `recorder.start(1000)` timeslice (upstream uses the same 1000 ms).
- `electron/recordingsCleanup.ts`: the streamed file is created at record start; cleanup only runs at
  startup and post-recording (with the new path excluded), so no change is needed, but add a unit
  test that `.duration-patch.tmp` files are treated as orphans by `recordingsCleanupPolicy.ts`
  (they are `.tmp`, verify `recordingGroupKeyFromFileName`).
- Preload/env: `openRecordingStream`, `appendRecordingChunk`, `closeRecordingStream` in
  `electron/preload.ts`, `src/vite-env.d.ts`.
- Risk: Capturia's camera-composited `canvas.captureStream()` recorder is the same `MediaRecorder`, so
  streaming applies unchanged. Native SCK output is already on disk (mp4); unaffected.

Tests to bring: all of `recorderHandle.test.ts`, `recordingStream.test.ts`, `webm-duration.test.ts`.

### 2.2 A2 Parallel screen + mic capture

Upstream e736ff4a/f698bba6: `screenCapture` and `micCapture` promises are created together; if screen
capture rejects, the mic stream that resolved in parallel is stopped before rethrow. Capturia awaits
`captureDesktopStream` then `captureRequiredMicrophoneStream` (`useScreenRecorder.ts:959-1010`), so
the mic starts ~hundreds of ms after video (upstream issue #57). Port is a 30-line change in
`startRecording`; keep Capturia's gain/limiter chain (`buildAdjustedMicrophoneStream`). The mic
fade-in (`MIC_FADE_IN_S`) lives in `audioMix.ts` (stream D); adopt it when D lands.

### 2.3 A3 Cancel / discard recording (bug found)

Upstream final: `cancelRecording()` sets `discardRecordingId`, `allowAutoFinalize=false`, stops the
recorder; `finalizeRecording` sees the discard id, calls `discardCursorTelemetry`, `handle.discard()`.
Native: `stop-native-mac-recording(discard=true)` deletes the mp4 and `.cursor.json` and returns
`{ discarded: true }`.

Capturia `useScreenRecorder.ts:1291-1316` `discardRecording()`:
- MediaRecorder path: correct (`discardFlag` -> `onstop` cleans up, phase back to `idle`).
- **Native path is broken**: it calls `window.electronAPI.stopNativeScreenRecording()` directly and
  returns, leaving `transitionInFlight=true`, `recordingPhase="stopping"`,
  `nativeRecordingActive=true`, `cursorTrackingActive=true`, the mp4 on disk, and the cursor tracker
  running. Every later `toggleRecording()` returns early; the HUD stays on "Processing..." until the
  window reloads. (Comment in code says "discard not supported".)

Fix (port shape): add a `discard?: boolean` argument to `native-screen-recorder-stop`
(`handlers.ts:1726`) that, after `stopNativeMacRecorder()`, `fs.rm`s the output and skips
`onRecordingStateChange`'s editor switch; in the hook route the native discard through
`stopNativeRecording({ discard: true })` so `finally` resets state and `stopCursorTracking` runs.
Add a regression test for the state machine (extract the phase transitions into a pure helper or
test the hook with `@testing-library/react` `renderHook` once jsdom is available).

### 2.4 A4 Restart recording

Upstream final (`restartRecording`, e2147bec): guard with `restarting` ref, set
`discardRecordingId`, await the recorder `stop` event(s) (screen + webcam), then `startRecording()`
without a countdown. Native paths: `finalizeNative*Recording(true)` then `startRecording()`.
Capturia: none. Port after A3 as `restartRecording = discard + await idle + startRecording`.
Because Capturia's `startRecording` reads `getSelectedSource` again, restart naturally reuses the
source. HUD: add a `RotateCcw` button in the compact bar (`LaunchWindow.tsx:824-844`). i18n keys
`launch.restartRecording` en/zh-CN.

### 2.5 A5 Pause / resume on the native macOS path

Upstream 73870c65: helper reads stdin lines (`pause`/`resume`/`stop`), `ScreenCaptureRecorder.pause()`
records `pauseStartedAt = CMClockGetTime(hostClock)`, `resume()` accumulates the offset, and every
sample buffer is retimed by `retimedSampleBuffer(_, subtracting:)` and dropped while paused
(`currentPauseState()`), for video, system audio and mic inputs. Main tracks
`nativeMacPauseRanges` and `compactPendingCursorTelemetryPauseRanges` removes cursor samples inside
pauses and shifts later ones. `canPauseRecording` gates the HUD button.

Capturia: `sck-recorder.swift` stops via `SIGINT` (`StopSignal`, line ~227/1200) and has no stdin
loop; `sckRecorder.ts` spawns with `stdio: ['ignore', ...]`; `pauseRecording()` is a no-op for native.
The HUD still shows the Pause button during native recording (misleading).

Port plan:
1. Swift: add a stdin reader thread (`readLine()` loop as upstream `main.swift:667-676`), keep
   `SIGINT` for stop; add pause offset + retiming in the `SCStreamOutput` callback and in
   `CameraCaptureProvider`/mic `AVCaptureAudioDataOutput` delegates (Capturia has three sample
   sources, upstream two). Emit `SCK_RECORDER_PAUSED`/`RESUMED` lines.
2. `sckRecorder.ts`: `stdio: ['pipe', 'pipe', 'pipe']`, `pauseNativeMacRecorder()` /
   `resumeNativeMacRecorder()` writing `pause\n`/`resume\n`; preload
   `pauseNativeScreenRecording` / `resumeNativeScreenRecording`.
3. `handlers.ts`: record pause ranges and apply them to the cursor track in `cursor-tracker-stop`
   (Capturia samples are `timeMs` relative to `startedAt`; port
   `compactPendingCursorTelemetryPauseRanges` to operate on `CursorTrackPayload.samples` and
   `events`).
4. Hook: `pauseRecording/resumeRecording` call the IPC when `nativeRecordingActive`, reusing
   `cumulativePauseMs`/`pauseStartTime`.
Until 1–4 land, hide the Pause button when the native recorder is active (S, do in batch 1).

Tests: port the pause-range compaction as a pure function with unit tests (upstream has none for it;
write 3–4 cases: sample inside range dropped, sample after range shifted, overlapping ranges).

### 2.6 A6 Countdown overlay window

Upstream final state (after 1670db41 -> 6b08a0a7 -> ea68e4cf -> d04bab73 -> 331e126d -> 3ba9e901 ->
65b9d189 -> 7e028568 -> 4a65ab81): a transparent 420x260 `focusable:false` window
(`createCountdownOverlayWindow`), `CountdownOverlay.tsx` subscribes to `countdown-overlay-value`
and ignores stale `runId`s; the hook's `startRecordCountdown` claims `countdownRunId` before the
first await, shows 3-2-1, hides, then `startRecording(runId)` checks `isCountdownRunActive` at every
await so a cancel mid-`getUserMedia` tears down streams. Stop has priority over countdown cancel in
`toggleRecording`.

Capturia: `LaunchWindow.tsx:626-656` runs a `setInterval` countdown (`recordCountdownSeconds`
0/3/5/8) and shows the number in the record button; cancel by clicking; countdown cancelled when the
source disappears. No overlay. Recommendation: keep Capturia's timer and preference, add the overlay
window + 3 IPC handlers + `CountdownOverlay.tsx` + `App.tsx` route `countdown-overlay`, driven from
`beginRecordCountdown` with the run-token pattern (token = `countdownTimerRef` identity). Skip the
hook-level `isCountdownRunActive` checks: Capturia only calls `toggleRecording()` after the timer
completes, so there is no cancel-mid-getUserMedia window. Also keep upstream's `app.on("activate")`
exclusion of the countdown window when deciding whether to re-create the HUD (`main.ts`).

### 2.7 A7 Chain recording after source selection

Upstream 48dfe748 (+ f38c881e, 4a90d6c5): `handleRecordButtonClick` sets
`recordAfterSourceSelectionRef=true` when no source, opens the selector; `select-source` handler
sends `selected-source-changed` to the HUD, the selector `closed` event sends
`source-selector-closed` (clears the intent). `onSelectedSourceChanged` triggers `toggleRecording()`
once.

Capturia: `handleRecordButtonClick` (`LaunchWindow.tsx:658-708`) opens the selector and stops; the
HUD polls `getSelectedSource` every 500 ms. Port: add the two IPC events (`handlers.ts:1555`
`select-source`, `main.ts:337` `createSourceSelectorWindowWrapper`), preload
`onSelectedSourceChanged`/`onSourceSelectorClosed`, and the ref in `LaunchWindow.tsx`. Keep the
permission preflight before recording. The chained start must go through `beginRecordCountdown`
(so the user's countdown applies), not `toggleRecording` directly.

Tests to bring (adapted, jsdom): the 5 "record button" cases in `LaunchWindow.test.tsx:255-336`.
Capturia's `LaunchWindow` has many more controls; mock `useScreenRecorder` like upstream and stub
`window.electronAPI` with `getCapturePermissionSnapshot` returning an all-granted snapshot.

### 2.8 A8–A10 Source selector

Keep Capturia's `SourceSelector.tsx` permission flow (`getScreenCaptureAccessStatus`,
`openScreenCaptureSettings`, `openPermissionChecker`). Bring from upstream `SourceSelector.tsx`:
`hasNoSources` empty state with reload (l.85-107), `defaultValue={screenSources.length === 0 ?
"windows" : "screens"}` and `Screens ({{count}})` labels (l.147-163), `data-testid` hooks, and
optionally the `.sourceCard` squircle CSS. Tests: `SourceSelector.test.tsx` (2 tests) adapted to
Capturia's `getScreenCaptureAccessStatus` mock. Do not port `openSourceSelectorFlow.ts`: it exists
to retry after the macOS "not-determined" prompt, which Capturia handles earlier via the permission
checker.

### 2.9 A11–A13 Webcam and audio HUD

Upstream HUD state lives in the hook (`microphoneEnabled`, `microphoneDeviceId/Name`,
`webcamEnabled`, `webcamDeviceId/Name`, `systemAudioEnabled`, `cursorCaptureMode`). Webcam preview
stream is acquired as soon as the toggle is on (effect at `useScreenRecorder.ts:234-307`, `acquireId`
guard against stale `getUserMedia`, `track.onended` -> "camera disconnected" toast unless restarting)
and recorded through a second `RecorderHandle` (`-webcam.webm`, in-memory). On the native mac path
the webcam recorder is created only after `recording-started` (d11eea04) and the native recording is
stopped if that creation throws (5b67fd78); finalize calls `attach-native-mac-webcam-recording`.

Capturia: the camera is composited into the video (`buildCompositedStream`, and natively by
`CameraCaptureProvider` + overlay drawing in `sck-recorder.swift`), with user-facing shape/size
controls that upstream does not have at capture time. The editor has no webcam track concept.

Recommendation: this is a product decision shared with B1. From the recording side the cheapest
compatible path is a "camera mode" preference: `overlay` (today, default) vs `separate` (records a
sidecar; requires B1's editor PiP and `RecordingSession` plumbing). Do **not** start this in the
first batches. What *is* worth porting now, independent of the mode: `useCameraDevices` + a device
picker (A12), mic enable/disable + device picker + level meter (A13; Capturia currently fails the
whole recording when the mic is denied, which is a real UX bug), and a system-audio toggle for the
MediaRecorder path (`getDisplayMedia({ audio: true })` on Windows via `setDisplayMediaRequestHandler`
`audio: 'loopback'`, `chromeMediaSource` audio on Linux; upstream `startRecording` l.1196-1247).
System audio inside the SCK helper is Swift work: `configuration.capturesAudio = true` +
`SCStreamOutputType.audio` + an AAC `AVAssetWriterInput`, plus the v1.9 clock-driven audio timeline
fixes (71428067, 4adbec5d, 0d4637d4) if pause is also ported.

Dependencies: `audioMix.ts` (stream D), locale keys `launch.audio.*`, `launch.webcam.*`.

### 2.10 A14 Notes window

Final upstream state in v1.7.0: `NotesWindow.tsx` (tiptap `StarterKit`, localStorage `notes`,
legacy plain-text migration), `NotesToolbar.tsx` (bold/italic/strike/lists/quote/code with
`Tooltip`), `NotesWindow.module.css`, `createNotesWindow()` 400x540 always-on-top
`setContentProtection(true)`, `open-notes` IPC focusing an existing window, `notes-window-closed`
event, `App.tsx` renders `<NotesWindow />` when `?showNotes=true`. HUD button hidden on Linux
(`!isLinuxHud`, content protection is unsupported there).

Capturia: none. Port notes:
- New files: `src/components/launch/NotesWindow.tsx`, `NotesToolbar.tsx`, `NotesWindow.css`
  (use v1.8 adaba8ef: a plain stylesheet, because `.tiptap` classes set via `editorProps.attributes`
  are not hashed by CSS modules and the production bundle dropped the styles), `src/components/ui/
  tooltip.tsx` (port from upstream, needs `@radix-ui/react-tooltip`).
- `electron/windows.ts` `createNotesWindow` + `applyContentProtection` gate from ad8fef3a
  (macOS 26 never paints content-protected windows; env `CAPTURIA_DISABLE_CONTENT_PROTECTION` /
  `CAPTURIA_FORCE_CONTENT_PROTECTION`), `main.ts` wrapper, `handlers.ts` `open-notes`, preload
  `openNotes`, `App.tsx` route.
- Deps: `@tiptap/react`, `@tiptap/starter-kit`, `@tiptap/extension-text-style` (^3.27), tailwind
  `typography` not required.
- Follow-ups worth taking with it: 44e16483 teleprompter mode (`notesTeleprompter.ts` + 3 test files,
  optional), 84672161/3ccb88ba read-only mirror is v1.8-HUD specific (skip).
- Tests: upstream v1.7.0 has none for Notes; v1.8 adds `NotesWindow.test.tsx` (jsdom) and
  `NotesToolbar.test.tsx`; bring `NotesWindow.test.tsx`'s "stylesheet in bundle" and migration cases.

### 2.11 A21–A23, A25 Electron main infrastructure

- Duplicate HUD guard (59cfe26f): 4 lines in `main.ts` `createWindow()`. Also make `switch-to-launch`
  and the tray "Open" go through a shared `showMainWindow()` (restore + show + focus) as upstream
  `main.ts:112-124`.
- Single instance (eb04f4e0): `app.requestSingleInstanceLock()` before `whenReady`,
  `second-instance` -> `showMainWindow()`, else `app.quit()`. Skip 77904538's PID lock (reverted by
  83ea5edb on 1.8.0 because a recycled PID bricked startup forever).
- Open-app global shortcut (480890bc + d86c1740 key mapping + 902d4e4d error feedback + 59c9a192
  register-before-unregister): new `electron/globalShortcut.ts` (77 lines), `ShortcutBinding`
  `openApp` in `src/lib/shortcuts.ts` `DEFAULT_SHORTCUTS`, `update-global-shortcut` IPC, and an entry
  in `ShortcutsConfigDialog`. Capturia's `registerStopRecordingShortcut` already implements the
  same "keep the old binding if the new one fails" rule; unify both behind one helper so
  `will-quit` `globalShortcut.unregisterAll()` stays the single teardown.
- Tray: `trayIconSize = isMac ? 16 : 24` (d526ab4c), `tray.on('click'|'double-click', showMainWindow)`
  (4655e71c). Capturia's tray strings are hard-coded per locale in `main.ts` `trayText`; upstream
  uses `electron/i18n.ts` (stream B3/F).

### 2.12 A26 macOS helper: what to cherry-pick into `sck-recorder.swift`

Keep Capturia's helper and CLI protocol. Bring, in order of value:
1. `_ = CGMainDisplayID()` before building `SCContentFilter(desktopIndependentWindow:)` (v1.10
   c9cd061d: SkyLight `CGS_REQUIRE_INIT` abort on window capture in a CLI helper). Capturia's
   helper builds that filter at `sck-recorder.swift:1035` and makes **no** CoreGraphics display call
   anywhere before it (grep: no `CGMainDisplayID`/`CGDisplayPixelsWide`), so the fix applies as-is.
   Upstream hit the abort on macOS 26 / Electron 41; reproduce there before and after. 1 line, S.
2. stdin command loop + pause/resume retiming (A5).
3. `capturesAudio` system audio (A13) and native SCK microphone probe
   (`supportsNativeMicrophoneCapture`, macOS 15+), keeping Capturia's AVCapture mic as fallback.
4. Explicit camera device by `uniqueID` (A12).
5. `captureBounds` in the ready line for window sources (3ef2001f), so the cursor tracker can use the
   helper's frame instead of `windowBounds.ts`'s separate `swiftc` helper. Optional; Capturia's
   `getWindowBoundsById` refresh loop already handles moving windows.

## 3. v1.8–v1.10 follow-ups in this area (architecture-independent)

| Commit | Take? | Why |
|---|---|---|
| 83ea5edb drop PID-file instance lock | Yes (by omission) | Port only `requestSingleInstanceLock`. |
| ad8fef3a no content protection on macOS 26 | Yes, with A14 | Otherwise the Notes window is invisible on macOS 26. |
| c9cd061d CoreGraphics init before window filter | Yes (A26.1) | Applies to any CLI SCK helper doing window capture. |
| 0c2ce827 do not await mic prompt at startup | N/A | Capturia does not request mic at startup. |
| 3bee346a / 6eb5bbb7 / 51f3c6d2 click-through cursor poll | Only with A24 | If Capturia adopts click-through, port this final form, never `{ forward: true }`. |
| 428a277b `Math.round(...) \| 0` for `setPosition` | Only with A24 | Capturia uses `-webkit-app-region: drag`, no JS drag today. |
| 54e12706 close HUD popovers on window blur | Probably N/A | Capturia uses Radix `Popover` (handles focus-outside); verify on macOS that clicking the desktop closes the capture-settings popover; if not, add a `window.addEventListener("blur")` close. S. |
| 44e16483 + adaba8ef Notes teleprompter + stylesheet | Yes (stylesheet), optional (teleprompter) | See A14. |
| 70c5b6f8 / bdfeec7f / de3fef6a camera/mic name matching (`deviceNameMatching.ts`, `webcamDeviceIdentity.ts`) | Partial | `webcamDeviceIdentity.ts` (+test) is useful when porting A12 to keep the label of the camera the browser actually opened. The rest is WGC-only. |
| 41126c44 / 8c8155df / 4d3f0f65 native webcam sidecar & failed-stop recovery | No | Windows helper + sidecar model. |
| 71428067, 7e6cde3f, 7faa2909, df042715, 4adbec5d, 0d4637d4, efe5accc macOS helper audio timeline | Reference only | Read before adding system audio + pause to the Swift helper (clock-driven audio PTS, ring buffer bounds, single audio track). |
| 135c360d handle detached promises in `useScreenRecorder` | Review | Small hardening of `void` promises; Capturia's hook already uses `.catch` on most, check `startCursorTracking` calls. |
| 2bc9d706 drag region on the grab handle, 7f166c0f HUD geometry reserve, 93cbc6c7 drop-shadow halo | No | v1.8 HUD rewrite (`HudControls.tsx`, `hudGeometry.ts`); different HUD. |

## 4. Recommended implementation order

Each batch is independently testable and leaves `tsc`/`vitest`/lint green.

**Batch A-0: test harness (prerequisite, touches no hot file)**
- Add `jsdom`, `@testing-library/react`, `@testing-library/jest-dom`, `@testing-library/user-event`
  devDeps; `vitest.config.ts` include `{src,electron}/**`; keep `environment: 'node'` with per-file
  `// @vitest-environment jsdom`.
- Verify baseline still 32 files / 204 tests.

**Batch A-1: recording pipeline hardening** (hot: `useScreenRecorder.ts`, `handlers.ts`,
`preload.ts`, `electron-env.d.ts`, `vite-env.d.ts`)
- A1 streaming + duration patch (+20 tests), A2 parallel capture, A3 native discard fix, hide Pause
  on native (A5 stopgap), A30 camera-fallback toast.
- Manual smoke: 2 min recording on macOS native and on Linux MediaRecorder; discard on both; check
  `recordings/` has no orphan `.tmp`.

**Batch A-2: HUD flow + main-process fixes** (hot: `LaunchWindow.tsx`, `handlers.ts`, `main.ts`,
`preload.ts`, `windows.ts`)
- A7 chain record after selection (+5 tests), A8/A9/A10 source selector empty state, tab default,
  counts (+2 tests), A17 Spaces, A21 duplicate HUD guard, A22 single instance, A25 tray size + click.
- These are all small; keep them in one PR to avoid five preload/env churns.

**Batch A-3: native pause/resume + restart** (hot: `useScreenRecorder.ts`, `handlers.ts`,
`preload.ts`, `sckRecorder.ts`, `sck-recorder.swift`)
- A5 full port, A4 restart. Requires a macOS machine with Xcode for the helper rebuild
  (`npm run build:native`). Add pause-range compaction unit tests.

**Batch A-4: capture devices** (hot: `LaunchWindow.tsx`, `useScreenRecorder.ts`, `handlers.ts`,
`sck-recorder.swift`)
- A12 camera picker (+5 `useCameraDevices` tests), A13 mic toggle/picker/meter and browser-path
  system audio (depends on stream D `audioMix.ts`), A6 countdown overlay window.

**Batch A-5: new windows and shortcuts** (hot: `main.ts`, `windows.ts`, `preload.ts`, `handlers.ts`)
- A14 Notes window (+ tooltip component + tiptap), A23 open-app global shortcut, ad8fef3a content
  protection gate.

**Deferred / separate projects**: A11 webcam sidecar mode (with B1), A24 click-through HUD, A25
vertical tray, A27 Windows WGC helper, A13 SCK system audio (Swift), A28 native cursor bitmaps (B2).

## 5. Do NOT port / keep Capturia's version

| Item | Reason |
|---|---|
| Upstream `useScreenRecorder.ts` wholesale | Different state ownership; Capturia's options (`captureProfile`, Pro fps/resolution, `recordSystemCursor`, camera shape/size, `microphoneGain`) and `reportUserActionError` plumbing would be lost. Port behaviours piecemeal (A1–A5). |
| Upstream `LaunchWindow.tsx` wholesale | Capturia's HUD has countdown seconds, auto-hide, stop shortcut UI, capture settings, permissions button; upstream's is built around click-through geometry and a resizable window. |
| `electron/native/screencapturekit/*`, `src/lib/nativeMacRecording.ts`, `is-native-mac-capture-available`, `start/stop-native-mac-recording` handlers | Capturia's `sck-recorder.swift` + `sckRecorder.ts` already cover display/window capture with camera overlay, size/bitrate control and an OS-version fallback. Cherry-pick pause, system audio, CG init (section 2.12). |
| `electron/singleInstanceLock.ts` (+test) | Removed upstream in 83ea5edb: stale PID file + PID reuse = app quits silently forever. |
| `src/lib/cursorTelemetryBuffer.ts` (+16 tests) | Orphaned in v1.7.0; nothing imports it. |
| `electron/native-bridge/*`, `electron/ipc/nativeBridge.ts`, `src/native/*` | Different cursor pipeline; Capturia's tracker has selection gestures and window-bounds refresh that upstream lacks. B2 decides on cursor bitmaps. |
| `openSourceSelectorFlow.ts`, `request-screen-access` retry dialog | Capturia's permission checker + `get-screen-capture-access-status` already gate the picker; two flows would fight. |
| `request-native-mac-cursor-access` Accessibility dialog (43b01cfb) | `PermissionCheckerWindow` covers accessibility + input monitoring with deep links. |
| "New Recording" editor dialog (14cd045e) | Capturia's `switchToLaunch` auto-saves project state first; upstream discards. |
| Language menu + system-language prompt + HUD resize for prompt (A20) | Wait for B3's i18n decision; a portal menu over 2 locales is not worth the click-through dependency. |
| `{ forward: true }` click-through from v1.7.0 `windows.ts` | Known to brick the HUD on Windows (#266/#385); if click-through is ever adopted use the v1.10 poll. |
| Windows WGC helper and everything keyed on `nativeWindowsRecording` (A27, A31) | XL, needs a Windows toolchain; separate project. |
| Webcam sidecar recording (A11) as a default | Would regress Capturia's baked overlay + shape/size feature (ground rule 1). Add only as an opt-in mode alongside B1. |

## 6. Findings that need a decision or a fix regardless of the sync

1. **Bug**: native-path discard leaves the HUD stuck in "Processing..." and leaks the mp4 and the
   cursor tracker (`useScreenRecorder.ts:1300-1304`). Fix in batch A-1.
2. **UX bug**: microphone denial aborts the whole recording (`captureRequiredMicrophoneStream`
   throws). A mic toggle (A13) or a "continue without mic" fallback fixes it.
3. Pause button is shown during native macOS recording but does nothing (`pauseRecording` early
   return). Hide it until A5 lands.
4. HUD transparent area is not click-through; on a 2200 px wide window the reserve swallows desktop
   clicks in the bottom ~300 px. Not a regression, but the main reason upstream built A24.
5. `vitest.config.ts` only includes `src/**`; any `electron/*.test.ts` port will be silently skipped
   until `include` is widened (batch A-0).
