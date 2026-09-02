# macOS native helpers

Capturia ships four small Swift command-line helpers next to the Electron main
process. They are compiled with `swiftc` (no Xcode project, no SwiftPM), signed
ad-hoc with the entitlements in `build/`, and copied into `Contents/Resources/native/`
by electron-builder. Sources live in `electron/native/macos/`, the TypeScript side
in `electron/native/*.ts`.

| Helper | Source | TS driver | Purpose |
|---|---|---|---|
| `sck-recorder` | `sck-recorder.swift` | `sckRecorder.ts` | ScreenCaptureKit display/window capture -> H.264 MP4 with optional mic track and camera overlay |
| `cursor-kind-monitor` | `cursor-kind-monitor.swift` | `cursorKindMonitor.ts` | Polls the system cursor and prints its kind (arrow, text, pointer, resize ...) |
| `mouse-button-monitor` | `mouse-button-monitor.swift` | `mouseButtonMonitor.ts` | Prints left-button transitions for click / selection detection |
| `speech-transcriber` | `speech-transcriber.swift` | `transcriber.ts` | On-device `SFSpeechRecognizer` transcription |

## Building

```
npm run build:native        # scripts/build-native-macos-helper.mjs, macOS only
```

Every `build:*` script runs it first. In development `ensureHelperBinary()` in each
TS driver also compiles the helper on demand into `electron/native/bin/` when the
binary is missing, so a fresh clone works after `npm run dev` on a Mac with Xcode
command-line tools. **The binaries are not rebuilt automatically after a Swift
source change**: delete `electron/native/bin/<helper>` or run `npm run build:native`.

Deployment target is macOS 13.0 (`-target <arch>-apple-macos13.0`); the build
script verifies `minos 13.0` with `vtool`/`otool`.

## `sck-recorder` protocol

Arguments are plain CLI flags (see `RecorderArguments.parse`). Everything else is
line-oriented text over the three standard streams.

### stdout (helper -> Electron)

| Line | When |
|---|---|
| `SCK_RECORDER_READY width=<w> height=<h> fps=<n> source=display\|window mic=0\|1` | capture started |
| `SCK_RECORDER_CAPS pause` | immediately after READY; space-separated capability names |
| `SCK_RECORDER_PAUSED` | ack of a `pause` command (also when already paused) |
| `SCK_RECORDER_RESUMED` | ack of a `resume` command (also when already recording) |
| `SCK_RECORDER_DONE frames=<n> observed_fps=<n>` | file finalised, process exits 0 |

Anything else on stdout is logged as `[sck-recorder] ...`.

### stderr

`SCK_RECORDER_ERROR code=<snake_case> message=<text>` followed by exit 1. Codes
are mapped to user messages in `src/lib/permissions/nativeRecorderErrors.ts`.

### stdin (Electron -> helper)

One command per line, read on a dedicated thread: `pause`, `resume`, `stop`.
`stop` is equivalent to SIGINT / SIGTERM, which `sckRecorder.ts` still uses for
stopping (proven path); the stdin form exists for parity with upstream.

### Pause semantics

Port of upstream OpenScreen `73870c65`. `ScreenStreamWriter` keeps
`pauseStartedAt` / `totalPausedDuration` on the host clock (`CMClockGetHostTimeClock`),
guarded by a serial queue. While paused every video frame and microphone buffer is
dropped. After a resume, every sample is retimed: video PTS becomes
`pts - firstPTS - totalPausedDuration`, mic buffers are shifted by
`firstPTS + totalPausedDuration` before the gain/limiter stage. The output MP4
therefore has no gap and no timestamp jump. The camera overlay needs no retiming
(the compositor only reads the latest camera frame).

### Capability detection and old binaries

`sckRecorder.ts` records the `SCK_RECORDER_CAPS` line. A helper built before this
protocol never prints it, so:

- `native-screen-recorder-start` returns `canPause: false`;
- the HUD hides the Pause button on the native path (`canPauseRecording` in
  `src/hooks/recordingPhase.ts` needs `nativePauseSupported: true`);
- `pause-native-recording` / `resume-native-recording` answer
  `{ success: false, supported: false }` without touching the helper;
- the pipe on stdin is harmless: the old helper never reads it and stops on SIGINT
  as before.

If the helper does support pause but does not ack within
`NATIVE_RECORDER_ACK_TIMEOUT_MS` (3 s), the IPC answers
`{ success: false, supported: true }`, the hook keeps the phase unchanged and
shows `launch.pauseFailed` / `launch.resumeFailed`.

### Cursor track and pauses

The cursor tracker (`electron/ipc/cursorTracker.ts`) samples on the wall clock and
keeps sampling while paused. The renderer calls `cursor-tracker-pause` /
`cursor-tracker-resume` around every pause (native and MediaRecorder paths), and on
stop the recorded ranges are removed with `compactCursorTrackPauseRanges`
(`electron/ipc/cursorTrack.ts`, port of upstream
`compactPendingCursorTelemetryPauseRanges`): samples inside a pause are dropped,
later samples and click/selection events shift back by the paused duration.

## `cursor-kind-monitor` protocol

Prints `CURSOR_KIND <kind>` whenever the kind changes (~60 Hz poll). Kinds are the
`CURSOR_KINDS` list in `src/lib/cursor/cursorKinds.ts` (upstream OpenScreen's
`NativeCursorType` set): `arrow`, `text`, `pointer`, `crosshair`, `open-hand`,
`closed-hand`, `resize-ew`, `resize-ns`, `resize-nesw`, `resize-nwse`, `move`,
`not-allowed`, `wait`, `app-starting`, `help`, `up-arrow`.

Detection order: (1) SHA-256 of the cursor bitmap against a few known I-beam
bitmaps observed on real machines, (2) a table of the standard `NSCursor.*`
bitmaps hashed at launch (arrow, I-beam, pointing hand, crosshair, open/closed
hand, resize left/right/up/down, operation-not-allowed, drag link), (3) the AppKit
image name. Custom bitmaps (Chromium's diagonal resize cursors, app-specific
cursors) report `arrow`. No Accessibility trust is needed. An old helper binary
prints `CURSOR_KIND ibeam`, which `parseCursorKindLine` maps to `text`.

Rendering: `src/lib/cursor/cursorGlyphs.ts` draws every non-arrow kind from a
bundled SVG in `src/assets/cursors/` (Capturia originals, MIT like the repo; the
upstream `Cursor=*.svg` set was not copied because it is a Figma export with no
licence of its own). The arrow keeps the tuned Path2D in `cursorComposer.ts`.
Old sidecars with `cursorKind: "ibeam"` load as `text`; unknown kinds load as
`arrow`.

## macOS verification checklist (required before a release)

Run on a Mac with Xcode command-line tools after `npm run build:native`. The
Swift changes for A5 and B2-5 were written on Linux and are **uncompiled** until
this is done.

1. `npm run build:native` compiles all four helpers with no errors or new
   warnings; `vtool -show electron/native/bin/sck-recorder` reports `minos 13.0`.
2. `npm run dev`, record a display natively for ~10 s: helper log shows
   `SCK_RECORDER_READY ...` followed by `SCK_RECORDER_CAPS pause`; stop opens the
   editor; the MP4 plays with audio when the mic was on.
3. Pause/resume: record, pause ~5 s (HUD timer stops), resume, record ~5 s, stop.
   The MP4 duration is ~10 s (not ~15), audio stays in sync after the resume,
   the log shows `SCK_RECORDER_PAUSED` and `SCK_RECORDER_RESUMED`, and the editor
   cursor overlay follows the real cursor after the resume (no drift equal to the
   pause length).
4. Pause twice in one recording, and stop while paused: no hang, the file is
   finalised, the trailing paused stretch is absent from the video.
5. Window capture + camera overlay + pause: overlay keeps updating after resume.
6. Discard while paused: file and `.cursor.json` removed, HUD returns to idle.
7. Old-helper regression: temporarily rebuild `sck-recorder` from the previous
   commit's Swift (or comment out the `SCK_RECORDER_CAPS` print), start a native
   recording: the Pause button is hidden and stop/discard still work.
8. Cursor kinds: hover a text field, a link, a window edge (resize), and drag a
   window (closed hand) during a native recording; the sidecar samples carry
   `text`, `pointer`, `resize-ew`/`resize-ns`, `closed-hand`, and the editor
   preview and an MP4 export show the matching glyphs at the same position.
9. Open a project recorded before this change (sidecar with `ibeam`): it loads,
   the I-beam renders as the `text` glyph.
10. MediaRecorder path (turn native capture off) with a pause: the cursor overlay
    stays aligned after the resume.
