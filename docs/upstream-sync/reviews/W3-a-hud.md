# Review: W3-a HUD flow

Branch `worktree-agent-a4385c261d13fdd22`, 4 commits, merged `--no-ff`.

## Verified (merged tree)
- lint 0 errors; tsc + typecheck:test clean; i18n:check PASS (487 keys); vitest 79 files / 764 tests.
- A7 chained start: `selected-source-changed` / `source-selector-closed` IPC; HUD consumes the intent
  once via an effect keyed on `hasSelectedSource` and goes through `requestRecordStart` (permission
  preflight + Capturia's countdown). Closing the picker clears the intent. 7 jsdom tests.
- A8/A9/A10: empty state + reload, `windows` tab default when no screens, counts, testids; Capturia's
  permission UI kept as a separate `loadFailed` state; `openSourceSelectorFlow.ts` not ported (decision).
- A17: `setVisibleOnAllWorkspaces(..., { visibleOnFullScreen: true })` for HUD (Wayland gate kept),
  source selector and permission checker.
- A4 restart: discard + effect on `recordingState` → `startRecording()` without countdown, both paths;
  `recordingPhase.ts` extended with tests. One `biome-ignore` on that effect's deps (warning count unchanged).

## Manual (macOS/Linux display needed)
- Agent checklist items 1–7 in the batch report; macOS Spaces and native restart cannot be checked here.
