# Review — Swift batch: native macOS pause/resume (A5) + cursor kinds (B2-5)

Merged as the merge commit after `db4b446` (agent branch `worktree-agent-a02d5878fcc10845a`,
5 commits, clean merge). **Both Swift files are uncompiled** — no toolchain on the Linux lead box.
Do not ship a release until the macOS checklist in `docs/native-helper.md` has been run.

## Scope delivered

- `sck-recorder.swift`: stdin command thread (`pause` / `resume` / `stop`), pause state on a
  serial `stateQueue`, `pauseStartedAt` / `totalPausedDuration` from the host clock, video and
  mic samples dropped while paused and retimed by the accumulated offset afterwards, monotonic
  guard on relative PTS, `SCK_RECORDER_CAPS pause` capability line, `SCK_RECORDER_PAUSED` /
  `SCK_RECORDER_RESUMED` acks. SIGINT stop path unchanged.
- `sckRecorder.ts`: caps parsing, `pauseNativeRecording` / `resumeNativeRecording` with 3 s ack
  timeout, `{success:false, supported:false}` when the helper never announced pause.
  `native-screen-recorder-start` returns `canPause`. IPC `pause-native-recording`,
  `resume-native-recording`, `cursor-tracker-pause`, `cursor-tracker-resume` (pinned in
  `handlers.test.ts`).
- `recordingPhase.canPauseRecording` allows native only when the helper reports support (pure,
  tests); `useScreenRecorder.togglePaused` routes native pause through IPC; elapsed time keeps
  Capturia's `cumulativePauseMs`. Cursor tracker records pause ranges and
  `compactPendingCursorTelemetryPauseRanges` (pure, tests) drops in-pause samples and shifts later
  ones — on both paths. Side fix: the MediaRecorder path never compensated cursor samples for
  pauses before.
- Cursor kinds: `CURSOR_KINDS` (16: arrow, text, pointer, crosshair, open/closed-hand, resize
  ew/ns/nesw/nwse, move, not-allowed, wait, app-starting, help, up-arrow). Legacy `ibeam` → `text`,
  unknown → `arrow` in sanitizer, editor loader, parser and composer. Glyphs parsed to Path2D at
  draw time so preview and export share one path (parity test). Hotspot table in `cursorGlyphs.ts`.
- **Licence decision**: upstream's `Cursor=*.svg` (Figma export, no licence) was NOT copied;
  15 original SVGs authored under the repo's MIT licence.
- `docs/native-helper.md`: stdin protocol, caps line, rebuild instructions, 10-item macOS checklist.

## Lead verification (merged tree)

- `npm run lint` 0 errors / 116 warnings; `tsc` + test types clean; `npm run i18n:check` PASS (623)
- `npx vitest --run` **118 files / 1228 tests** (was 115 / 1195)
- Swift read-through by the lead: pause state only touched under `stateQueue.sync`; `lastRelativePTS`
  declared and updated; `guard let self` / multi-statement `sync` closures need Swift ≥ 5.7 (fine on
  any current Xcode). Not compiled.

## Behaviour with an old helper binary

The old binary never reads stdin and never prints the caps line: `canPause` is false, the Pause
button stays hidden on the native path, stop via SIGINT still works. Nothing changes for recording
until `npm run build:native` runs on a Mac.

## macOS checklist (blocking for release)

See `docs/native-helper.md`: build, caps line, pause/resume duration + A/V sync, stop while
paused, discard while paused, old-helper regression, cursor kind detection per app, legacy
sidecar load, MediaRecorder pause alignment.
