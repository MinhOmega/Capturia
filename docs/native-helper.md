# macOS native helpers

Capturia ships five small Swift command-line helpers next to the Electron main
process. They are compiled with `swiftc` (no Xcode project, no SwiftPM), signed
ad-hoc with the entitlements in `build/`, and copied into `Contents/Resources/native/`
by electron-builder. Sources live in `electron/native/macos/`, the TypeScript side
in `electron/native/*.ts`.

| Helper | Source | TS driver | Purpose |
|---|---|---|---|
| `sck-recorder` | `sck-recorder.swift` | `sckRecorder.ts` | ScreenCaptureKit display/window capture -> H.264 MP4 with optional mic / system audio track and camera overlay |
| `cursor-kind-monitor` | `cursor-kind-monitor.swift` | `cursorKindMonitor.ts` | Polls the system cursor and prints its kind (arrow, text, pointer, resize ...) |
| `mouse-button-monitor` | `mouse-button-monitor.swift` | `mouseButtonMonitor.ts` | Prints left-button transitions for click / selection detection |
| `speech-transcriber` | `speech-transcriber.swift` | `transcriber.ts` | On-device `SFSpeechRecognizer` transcription |
| `window-bounds-helper` | `window-bounds-helper.swift` | `ipc/windowBounds.ts` | Prints a window's global bounds as JSON for the cursor tracker's window mapping |

## Building

```
npm run build:native        # scripts/build-native-macos-helper.mjs, macOS only
```

Every `build:*` script runs it first. In development `ensureHelperBinary()` in each
TS driver also compiles the helper on demand into `electron/native/bin/` when the
binary is missing, so a fresh clone works after `npm run dev` on a Mac with Xcode
command-line tools. **The binaries are not rebuilt automatically after a Swift
source change**: delete `electron/native/bin/<helper>` or run `npm run build:native`.

`window-bounds-helper` is the exception: `windowBounds.ts` never compiles anything
(it used to write Swift source into `userData` and run `swiftc` at runtime, which
was a code-execution surface inside Capturia's TCC scope and failed silently
without the command-line tools). When the binary is missing it logs one warning
and `getWindowBoundsById` returns `null`, so window recordings fall back to the
heuristic cursor mapping until `npm run build:native` has run.

Deployment target is macOS 13.0 (`-target <arch>-apple-macos13.0`); the build
script verifies `minos 13.0` with `vtool`/`otool`.

## `sck-recorder` protocol

Arguments are plain CLI flags (see `RecorderArguments.parse`). Everything else is
line-oriented text over the three standard streams. Unknown flags are skipped
together with their value, which is what lets a newer `sckRecorder.ts` drive an
older binary.

The first thing `main()` does is `_ = CGMainDisplayID()`: the helper is a plain
command-line process and `SCContentFilter(desktopIndependentWindow:)` aborts on
recent macOS releases when CoreGraphics was never initialised in the process.
Display capture never hit it; window capture crashed before the first frame.

### Audio flags

| Flag | Meaning |
|---|---|
| `--microphone-enabled 0\|1`, `--microphone-gain <0.5-2>` | as before |
| `--mic-device-id <uniqueID>` / `--mic-device-name <label>` | preferred microphone: exact `AVCaptureDevice.uniqueID` first, then the label under the word-boundary rules (`DeviceNameMatching`, twin of `electron/recording/deviceNameMatching.ts`: exact, exact without the `(vid:pid)` suffix, one name containing the other as whole words, never plain substring). Nothing matched -> system default + `SCK_RECORDER_WARN mic_device_not_found` |
| `--camera-device-id` / `--camera-device-name` | same rules for the camera overlay |
| `--system-audio 0\|1` | capture what the system plays (`SCStreamConfiguration.capturesAudio`, 48 kHz stereo, `excludesCurrentProcessAudio`) |

Audio track layout:

- mic only: one AAC track, 44.1 kHz mono, the direct path (gain + limiter in
  `applyMicrophoneGainAndLimiter`), unchanged;
- system audio (with or without mic): **one** mixed AAC track, 48 kHz stereo,
  192 kbps, produced by `MixedAudioTrack`. One track on purpose: the editor
  preview is an HTML5 `<video>`, which only plays audio track 0. The mic is
  captured at 48 kHz on this path so nothing is resampled. Both sources are placed
  on a shared timeline by presentation timestamp; a 10 ms timer on the audio queue
  advances the cursor on the clock, emitting silence where no source covers a
  chunk, so leading/mid-take silence stays in place and a source that stops
  delivering (unplugged mic) releases the track after 250 ms. Mic gain is applied
  per source; a soft limiter (knee 0.9, tanh above it) bounds the sum.

### stdout (helper -> Electron)

| Line | When |
|---|---|
| `SCK_RECORDER_READY width=<w> height=<h> fps=<n> source=display\|window mic=0\|1 system_audio=0\|1` | capture started (`system_audio` absent on old helpers -> parsed as 0) |
| `SCK_RECORDER_CAPS pause mic-device system-audio` | immediately after READY; space-separated capability names |
| `SCK_RECORDER_WARN <snake_case_code> [details]` | non-fatal condition, may precede READY. Codes: `mic_device_not_found requested=<name> opened=<name>`, `audio_source_undecodable source=system\|microphone format=...`, `audio_mixer_backlog`, `audio_mixer_tail_dropped chunks=<n>` |
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

System audio samples get exactly the same treatment: dropped while paused, shifted
by `firstPTS + totalPausedDuration` before they reach the mixer. The mixer's clock
(`ScreenStreamWriter.timelineNow`) is the host clock minus `firstPTS` minus the
pause offset and is frozen while paused (`pauseStartedAt` stops moving), so a pause
interrupts the audio timeline without shifting anything recorded after it.

### Capability detection and old binaries

`sckRecorder.ts` records the `SCK_RECORDER_CAPS` line. A helper built before this
protocol never prints it, so:

- `native-screen-recorder-start` returns `canPause: false`, `canCaptureSystemAudio:
  false` and `hasSystemAudio: false`; `--system-audio 1` and the `--mic-device-*`
  flags are skipped by the old binary (default mic, no system audio), and
  `useScreenRecorder` shows `launch.systemAudioUnavailable` when system audio was
  requested but the helper cannot honour it. The HUD should hide the system-audio
  toggle when `canCaptureSystemAudio` is false;
- `warnings` in the start result is the list of `SCK_RECORDER_WARN` codes seen
  before READY (empty for an old helper); `mic_device_not_found` becomes
  `launch.microphoneDeviceNotFound`;
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
Swift changes for A5, B2-5 and the R5-SW batch (CoreGraphics init, device
matching, mic device selection, system audio, window-bounds helper) were written
on Linux and are **uncompiled** until this is done.

1. `npm run build:native` compiles all five helpers with no errors or new
   warnings; `vtool -show electron/native/bin/sck-recorder` reports `minos 13.0`.
2. `npm run dev`, record a display natively for ~10 s: helper log shows
   `SCK_RECORDER_READY ... mic=1 system_audio=0` followed by
   `SCK_RECORDER_CAPS pause mic-device system-audio`; stop opens the editor; the
   MP4 plays with audio when the mic was on.
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
11. CoreGraphics init (macOS 26 / Electron 41): record a **window** natively; the
    helper reaches `SCK_RECORDER_READY` instead of aborting with `CGS_REQUIRE_INIT`
    (check Console.app for a crash report of `sck-recorder` if it exits early).
12. Mic device pick: with two microphones plugged in, pick the non-default one in
    the HUD, record natively; the helper log has no `mic_device_not_found` line and
    the track is from the chosen mic. Then unplug it before starting: the log
    shows `SCK_RECORDER_WARN mic_device_not_found ...`, the toast
    "Selected microphone not found" appears and the recording carries the default
    mic. Also check a Chromium label with a `(vid:pid)` suffix resolves.
13. System audio A/V sync: `--system-audio 1` (temporarily set `systemAudioEnabled`
    in `useScreenRecorder` options or use the HUD toggle once it exists), play a
    video with a visible beat, record ~20 s with the mic on. `ffprobe` shows one
    audio stream (48 kHz stereo AAC) and one video stream; in the editor the beat
    and the picture line up at the start and at the end; the mic voice is audible in
    the same track; no clipping when both are loud (soft limiter).
14. System audio + pause: pause ~5 s mid-take, resume, stop. Duration is the
    unpaused length, system audio and video stay in sync after the resume, no
    audio from the paused stretch is present. Also stop while paused.
15. System audio with nothing playing for the first 5 s: the track starts with
    5 s of silence (the first sound is not pulled to t=0), and the file length
    matches the video.
16. Window bounds helper: `ls "Capturia.app/Contents/Resources/native"` in a
    packaged build lists `window-bounds-helper`; record a window natively and move
    it mid-recording, the editor cursor overlay follows the window. Delete the
    binary and record again: one `[window-bounds] helper missing` warning, no
    `swiftc` process, recording still works with the heuristic mapping.
17. Old-helper regression for the new flags: rebuild `sck-recorder` from the
    previous Swift, start a native recording with a picked mic and system audio
    requested: no crash, default mic, `canCaptureSystemAudio: false`, the
    "System audio is not available" toast shows once.
