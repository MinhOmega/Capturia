# Review: W3-f auto-follow zoom focus

Branch `worktree-agent-afa658bb291d3723c`, 3 commits, merged `--no-ff` (one import-line conflict in
`SettingsPanel.tsx`, union of both sides).

## Verified (merged tree)
- lint 0 errors; tsc + typecheck:test clean; i18n:check PASS (563 keys); vitest 87 files / 876 tests.
- `focusMode: 'auto'` resolves focus from Capturia's `CursorTrack` via `cursorFollowUtils.ts`
  (`buildCursorTelemetry` drops invisible samples, memoised; `interpolateCursorAt`; frame-rate-independent
  `advanceFollowFocus`, 30 vs 60 fps convergence test). Follow state lives in the shared
  `ZoomCameraState`, so preview and export step identically (`stepZoomCamera`); parity tests extended.
- Preview snaps to raw focus when paused; export always steps. Indicator hidden and drag disabled for
  auto regions; X/Y inputs hidden; timeline cursor marker.
- Deviation kept as briefed: auto-zoom drafts stay manual; only `movement` drafts get `auto` when the
  global toggle is on. `autoFocusAll` not in the undo snapshot (same as `autoZoomEnabled`).
- Old projects: `focusMode` missing → manual; `autoFocusAll` missing → false; unknown values stripped.
