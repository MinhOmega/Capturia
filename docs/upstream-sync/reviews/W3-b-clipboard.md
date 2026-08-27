# Review: W3-b copy/paste, frame step, speed input

Branch `worktree-agent-ae4b4724e63fed6fd`, 4 commits, merged `--no-ff`.

## Verified (merged tree)
- lint 0 errors; tsc + typecheck:test clean; i18n:check PASS (493 keys); vitest green (see PROGRESS).
- `regionClipboard.ts` (17 tests): kinds `zoom` / `annotation` / Capturia-specific `segmentSpeed`; pasted
  zoom always `source: 'manual'`; paste-as-new via `findFreeGapAt`; one undo entry per paste.
- Keydown: all inline `instanceof` guards replaced by `isTextEditingTarget`; Ctrl+C/V only intercepted
  when a region is selected / clipboard non-empty (textarea copy still works).
- Frame step `,` / `.` at the real source fps, reading live `video.currentTime`; arrows keep Capturia's
  configurable seek step and no longer fire on sliders/ARIA widgets (fixes the seek-step slider bug).
- Test asserts every default binding is clear of fixed shortcuts (also covers W3-c's `openApp`).
- `SegmentSpeedInput` keyed by segment id (fixes stale selection display), decimal + `1,75` accepted.

## Backlog
- Speed typing records one undo entry per keystroke (as upstream); batching needs an `onSegmentSpeedCommit`
  prop — deferred to avoid W3-f conflicts.
