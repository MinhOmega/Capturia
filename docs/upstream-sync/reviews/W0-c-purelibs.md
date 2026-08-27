# Review: W0-c pure libraries + upstream tests

Branch `worktree-agent-a2fccd646fb81da77`, 12 commits, merged `--no-ff`.

## Verified independently (merged wave-0 tree)
- lint 0 errors / 117 warnings; tsc clean; typecheck:test clean; vitest 48 files / 392 tests.
- Diffs read: `frameRenderer.setupBackground` now uses upstream `gradientParser` (fixes every
  `rgba()`/angled/radial preset in export) and throws `BackgroundLoadError` instead of painting black;
  exporters return `{ success: false }` for it without retry. `getZoomScale` call-site switch is a
  no-op when `customScale` is unset (`ZOOM_DEPTH_SCALES[depth]`). `findFreeGapAt` is semantically
  identical to the inline code it replaced. Downmix engages only for >2 channels.
- Annotation id-counter bug fixed via shared `idCounters.ts` (`ANNOTATION_ID_PREFIX`).
- Undo snapshot key now includes `customScale` (good catch by the agent).

## Deviations (accepted)
- `userPreferences` field set trimmed to Capturia's (no Windows-encoder flags); `exportQuality` default
  `'source'`. `textAnimation` lives on `AnnotationTextStyle` (upstream placement).
- `createTextAnnotationRegion` added but not wired (W2-c will add the panel placeholder first).
- `GRADIENTS` moved to `backgroundPresets.ts` so the parser regression test covers every preset.

## Follow-ups for later batches
- W2-c: toast for `BackgroundLoadError` (`errors.exportBackgroundLoadFailed`), wire empty-text default.
- W2-a: UI for `customScale` (slider) — model is ready.
- W3-b: wire `copySelected`/`paste` actions + `isTextEditingTarget` into the key handler.
