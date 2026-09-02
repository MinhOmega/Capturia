# Review — B1-e: 3D iso/tilt presets on zoom regions

Merged as `2b350ac` (agent branch `worktree-agent-a1a8a205cb6fddaaa`, 5 commits, clean merge).

## Scope delivered

- `ZoomRegion.rotationPreset?: 'iso' | 'left' | 'right'`; `Rotation3D`, `ROTATION_3D_PRESETS`,
  `lerpRotation3D`, `isRotation3DIdentity`, `computeRotation3DContainScale`,
  `rotation3DPerspective`, `normalizeRotationPreset` (drops unknown values on load; tested).
  Region clipboard copies the preset.
- Zoom engine: `findDominantRegion` carries `rotation3D`; `zoomCamera.resolveZoomCameraTarget`
  sets `target.rotation3D = lerp(identity, preset, progress)` using Capturia's Screen-Studio
  eased progress. Preview ticker and `frameRenderer.updateAnimationState` both read the same
  target, so preview/export parity holds by construction.
- Preview: Pixi canvas + Capturia's composited cursor canvas inside `composite3D`
  (`perspective` on `outerWrapper`); annotations, subtitles and the focus indicator stay in the
  flat overlay (lead decision). `'native'` aspect and motion-blur attach/detach untouched.
- Export: `threeDPass.ts` (WebGL2 quad, `buildMvpMatrix`, premultiplied upload, anisotropic, no
  mipmaps) + unit tests for the matrix/fov math. `compositeWithShadows` split into
  `drawBackground` / `drawVideoLayer`; non-identity rotation routes video + cursor through a
  foreground canvas → 3D pass → shadow on the rotated silhouette → composite. Linux keeps the
  `readPixels` readback. WebGL2 unavailable → warning, flat export (never fails).
- Settings: None / Iso / Left / Right buttons; i18n `settings.zoom3d{Title,None,Iso,Left,Right}`.

## Lead verification (merged tree)

- `npm run lint` 0 errors / 116 warnings; `tsc` + test types clean
- `npm run i18n:check` PASS — 618 en keys
- `npx vitest --run` **101 files / 1084 tests** (was 100 / 1054)

## Review notes

- The rotation ramp is in the shared camera step, not in `zoomRegionUtils` transitions only,
  which is the right seam given Capturia's connected-pan model.
- Contain scale is upstream's (slightly conservative, ~0.97 extent); identical in both paths.
- Skipped T2 (native cursor clip sync): Capturia has no `nativeCursorClipRef`.

## Manual smoke (needs a display)

1. Iso on a region: tilt only inside the region with a smooth ramp; cursor tilts, subtitles flat.
2. Exported frame matches preview on macOS (`drawImage`) and Linux (`readPixels`).
3. None resets; old project loads flat; copy/paste carries the preset; undo/redo works.
4. `'native'` aspect + 3D; motion blur + 3D together.
