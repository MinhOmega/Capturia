# Review: W1-b recording pipeline

Branch `worktree-agent-aa3e067404559ba87`, 5 commits. Reviewed before merge (merge follows W1-a).

## Read
- `handlers.ts`: `store-recorded-video` finalises the stream first, writes the buffer only when not
  streamed, then `patchWebmDurationOnDisk` when `metadata.durationMs` is valid; sanitising, cursor
  sidecar and cleanup exclusion untouched. `native-screen-recorder-stop` takes `{ discard }`, removes
  mp4 + `.cursor.json`, still runs tray/HUD restore, skips editor switch. Good.
- `src/hooks/recordingPhase.ts`: pure transition rules (`canRequestStop/Discard`, `beginStopTransition`,
  `resolveStopRoute`, `planNativeStopSideEffects`, `canPauseRecording`) with tests — this is the fix
  for the stuck-HUD bug found in gap A3, and it is now regression-tested.
- Hook: `createRecorderHandle(recorder, fileName)` wraps Capturia's own recorder (codec/bitrate chain
  kept); in-memory fallback keeps renderer-side `fixWebmDuration`. Screen + mic captures created in
  parallel, mic stopped if screen rejects.
- `.duration-patch.tmp` handled by the cleanup policy as an orphan after `orphanSidecarAgeMs`.

## Accepted deviations
- File name timestamp taken at record start (needed to open the stream), `capturedAt` still at stop.
- `@fix-webm-duration/parser` added to `package.json` without lockfile update — lead regenerates.

## Lead actions at merge
- Move `launch.cameraFallback` (new key) into `locales/{en,zh-CN,vi}/launch.json`.
- `npm install` to sync the lockfile.
- Manual smoke (needs a display / macOS): agent checklist kept in the batch report.
