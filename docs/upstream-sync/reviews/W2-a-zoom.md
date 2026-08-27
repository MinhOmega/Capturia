# Review: W2-a zoom model + engine

Branch `worktree-agent-abeb46a6ea79a164e`, 8 commits (incl. its own merge of the tip), fast-forwarded.

## Verified (merged tree)
- lint 0 errors; tsc + typecheck:test clean; i18n:check PASS; vitest 71 files / 632 tests.
- Preview/export parity enforced through a shared pure step (`videoPlayback/zoomCamera.ts`) with a
  "preview / export parity" suite; spring (`zoomSpring.ts`) and `motionSmoothing.ts` use `motion`'s
  `spring()` (12.23.24 verified, no dep bump).
- Screen-Studio easing (`TRANSITION_WINDOW_MS = 1015.05`, final upstream value after the #373 revert),
  connected regions ≤ 1.5 s → 1 s pan in transform space, single-slot cache. Agent's deliberate
  improvement: incoming region of a connected pair holds strength 1 after the pan (upstream dips to 0.99).
- Auto-zoom lifecycle: `ZoomRegion.source` (missing → manual, never removed by the wand),
  `autoZoomEnabled` (missing → true). On-load silent auto-apply keeps Capturia's pre-existing rule
  (only when an aspect has zero regions and a cursor track exists) — checked, not a behaviour change.
- Undo: `beginHistoryBatch/endHistoryBatch` so slider drags / typed coordinates are one entry.
- Auto-zoom constants retuned for the longer transition (`CLICK_HOLD_MS` 1600, `MOVEMENT_HOLD_MS` 1200,
  `MERGE_GAP_MS` 300, `MIN_REGION_DURATION_MS` 1200) with a test that every draft reaches strength 1.
  **Needs a manual feel check** on a real recording; constants live in one place.

## Deferred
- Z7–Z9 auto-follow focus + marker (wave 3). Motion-blur slider (B1-c) hooks on `frameTimeMs`.
