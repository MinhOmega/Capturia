# Review: W2-d cursor polish + parity

Branch `worktree-agent-a5bc8331daee57d9f`, 5 commits, merged `--no-ff` (no overlap with W2-b).

## Verified (merged tree)
- lint 0 errors; tsc + typecheck:test clean; i18n:check PASS; vitest green (see PROGRESS).
- C1 size parity: `contentScale = cameraScale × (maskRect.width / cropRegion.width) / 1920`
  (`CURSOR_REFERENCE_WIDTH`), applied identically in `renderCursorOverlay` and `renderCursorLayer`.
  Lead decision: keep `size` default 2.2 → 1080p export unchanged, preview shrinks to match export
  (old preview glyph ≈ 6.8 % of frame width was oversized vs a real OS cursor; export was the more
  natural reference). Users who liked the big preview cursor can raise `size`.
- C2 `clipToBounds` (default off), C3 hide when crop-renormalised position leaves [0,1],
  C4 `motionBlur` 0..1 (default 0), speed in 1080p-reference px/s × `sizeNorm` → same fraction of the
  frame in preview and export; snaps on pause/backwards time.
- Old projects: both fields optional, merged over `DEFAULT_CURSOR_STYLE`. Undo snapshot not widened.

## Skipped (agreed)
- C5 click bounce, C6 spring smoothing — Capturia's click pulse / Gaussian smoothing cover them.
