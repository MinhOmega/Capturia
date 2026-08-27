# Review — W3-d: motion blur slider + Original ("native") aspect ratio

Merged as `2d288a4` (agent branch `worktree-agent-a9a0d30121c83b99d`, 4 commits).

## Scope delivered

- **M2** Preview `videoContainer.filters` is only assigned on activity transitions
  (`lastMotionBlurActive` cache); idle/paused/scrubbing frames render with no filter
  attached, so the idle preview is no longer softened by a permanent filter pass.
- **M1** `motionBlurEnabled` toggle replaced by `motionBlurAmount` (0..1 slider) driving
  `pixi-filters` `MotionBlurFilter` from camera velocity (`stepMotionBlur` in
  `zoomTransform.ts`). Velocity and blur length are normalised to a 1080-px reference
  stage so preview and export blur the same fraction of the frame (parity test
  960×540 vs 3840×2160). Export creates the filter only when amount > 0.
- **Migration** `resolveProjectMotionBlurAmount`: number → clamp 0..1, else legacy
  boolean → `DEFAULT_ZOOM_MOTION_BLUR = 0.35` / 0. Save still writes
  `motionBlurEnabled = amount > 0` for one release (downgrade-safe).
- **D8** `'native'` aspect ("Original"): `ASPECT_RATIOS` extended, `isAspectRatio`
  validation on load, `getNativeAspectRatioValue` / `resolveAspectRatioValue` (16:9
  fallback before metadata), `formatAspectRatioForCSS(aspect, nativeRatio)`. Padding is
  not mutated — derived `effectivePadding = 0` with the slider locked and a hint; MP4 plan
  uses `calculateEffectiveSourceDimensions` (cropped source, even-rounded) only for
  native; GIF dimensions now follow aspect + crop for all ratios. Batch export suffix
  `-native`, dialog label "Original".

## Lead verification (merged tree)

- `npm run lint` 0 errors / 116 warnings (unchanged)
- `npx tsc --noEmit`, `npm run typecheck:test` clean
- `npm run i18n:check` PASS — 588 en keys, zh-CN/vi parity
- `npx vitest --run` **92 files / 927 tests** (was 91 / 897)

## Review notes

- Checked the M2 attach/detach path: filter is created once in setup, destroyed in
  cleanup, `filters = null` while inactive; no per-frame reassignment.
- `stepMotionBlur` clamps `dt` to [1, 80] ms and keys on content time (`frameTimeMs`),
  so export (fixed frame step) and preview (RAF) produce the same velocity for the same
  camera path. State resets whenever blur is inactive, so resume never blurs from a stale
  sample.
- Deviation accepted: isotropic `BlurFilter` removed entirely (upstream keeps it at 0).
- Deviation accepted: fixed ratios keep Capturia's full-source MP4 bound; only native
  uses the cropped-source dimensions.

## Known gaps / follow-ups

- Free-form crop for Original: `PreviewAspectCropOverlay` stays aspect-locked; native
  keeps the crop's own shape (full source by default).
- `VideoPlayback` reads `videoRef.current.videoWidth` during render for the native CSS
  ratio; relies on the existing metadata re-render. Fine today, fragile if that state
  changes.

## Manual smoke (needs a display)

1. Idle preview sharper than before (no filter attached); blur only during pans/zooms.
2. No blur while paused or scrubbing.
3. Preview vs export look at 0.35 on the same pan.
4. Legacy project with `motionBlurEnabled: true` loads at 0.35.
5. "Original": preview fills the frame, padding slider locked; MP4 dims = cropped source.
6. Batch export incl. Original (`-native` suffix); GIF at Original.
