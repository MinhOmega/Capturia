# Review: W2-b timeline interaction + waveform

Branch `worktree-agent-abe45c516e6284cbc`, 6 commits, merged `--no-ff`.

## Verified (merged tree)
- lint 0 errors; tsc + typecheck:test clean; i18n:check PASS (451 en keys); vitest 64 files / 562 tests.
- Snap/clamp logic is pure (`timeline/snapping.ts`, tests); `hasOverlap` now strict intersection so
  snapped-adjacent items are accepted (intended).
- Empty-lane scrub gated off for scissors mode, items/handles/playhead and `data-timeline-scrub="off"`
  (`timelineScrub.ts`, tests). Class-name based like upstream — acceptable, noted as brittle.
- Waveform columns map effective → source time via `effectiveToSourceMsWithSegments`, so splits and
  per-segment speed stay aligned. Peaks decoded in a Web Worker; file loaded via `readBinaryFile` IPC.
- `ProjectState.showTimelineWaveform` (default false), persisted, not in undo snapshot.

## Skipped (agreed)
- Streaming peaks (needs web-demuxer), T15 rAF playhead, T7 plain-wheel pan.
