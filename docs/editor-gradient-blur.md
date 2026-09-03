# Gradient editor and blur regions

Two editor features added in wave 5, batch B1-d: a custom gradient builder for the background,
and blur (mosaic) regions on the timeline. Both are pure-library first, with the UI a thin layer.

## Gradient editor

- Model: `src/lib/gradientBuilder.ts` — `GradientSpec { kind: linear|radial, angle, stops[2..8] }`.
  `buildCssGradient` produces the string persisted as the wallpaper (`linear-gradient(<angle>deg,
  <colour> <pos>%, …)` or `radial-gradient(circle at 50% 50%, …)`); `parseGradientSpec` is the
  inverse, built on the exporter's `gradientParser.ts`, so a preset or a saved wallpaper loads into
  the editor. No schema change: the wallpaper stays a string.
- Stop cap is 8 rather than the 6 first planned because one bundled preset has 7 stops and must
  load without truncation. Stops keep their row order while a position is typed; the output sorts.
- Component: `src/components/video-editor/GradientEditor.tsx`, under the "Custom gradient" toggle
  in the Background → Gradient tab of the settings panel. Live preview swatch, linear/radial
  toggle, angle slider + number field, per-stop colour popover (`ColorPicker`) and position field,
  add/remove stops, preset row.
- Tests: `gradientBuilder.test.ts` (18; round trip builder → parser → same stops for linear,
  radial, six stops, every preset) and `GradientEditor.test.tsx` (7, jsdom).

## Blur regions

Blur regions are annotations of type `blur`. They live in `annotationRegions`, so span editing,
selection, deletion, duplicate, copy/paste and the undo snapshot all reuse the annotation paths.

- Flag: `src/components/video-editor/featureFlags.ts` → `BLUR_REGIONS_ENABLED` (default `true`).
  Off hides the timeline row and toolbar button, the `addBlur` shortcut (keydown, help and config
  dialogs), the settings panel, the preview overlay and the export pass. Regions already in a
  project are kept in the list, not rendered.
- Schema: `AnnotationType` gains `'blur'`; `AnnotationRegion.blurData?: { type: 'mosaic', shape:
  'rectangle' | 'oval', color: 'white' | 'black', intensity: 2..40, blockSize: 4..48 }`.
  Optional, so older projects load unchanged. `normalizeAnnotationBlurData` (called on restore)
  forces `type: 'mosaic'`, clamps ranges, fills defaults for blur regions and drops a stray
  `blurData` on other kinds.
- Ids: `blur-N` via `BLUR_ID_PREFIX`, own counter synced with `maxIdNum` on restore.
- Shortcut: `B` (`addBlur`). `b` was unbound; the default-binding conflict test covers it.
- Pixels: `src/lib/blurEffects.ts` → `renderMosaicRegion(imageData, blurData, blockSizePx)`:
  block averaging aligned to the region's top-left, shade tint (white 6 % / black 72 % at the
  default intensity 12, scaled linearly, capped at 95 %), and for `oval` the pixels outside the
  inscribed ellipse restored to the source. Both preview and export call this one routine.
  - Preview: `AnnotationOverlay` draws the pixels under the box from a snapshot of the composited
    Pixi stage (`VideoPlayback.capturePreviewFrame`, `renderer.extract.canvas` over the screen
    rect, one extract per render while a blur region is on screen) into its own canvas; the box is
    resampled live while dragged or resized. Areas outside the video (wallpaper) are transparent in
    the snapshot, so the preview shows the wallpaper through with the shade on top there.
  - Export: `annotationRenderer.renderBlurRegion` snaps the region to output pixels, scales the
    block size by `scaleFactor` (output px per preview px) and mosaics the composite canvas in
    place — this includes the wallpaper under the region, the one intended preview/export
    difference.
- Selection cycling: `getSelectionCycleAnnotations` / `isSelectionCyclable`
  (`src/lib/annotations/renderOrder.ts`) exclude blur regions from the preview click-through
  cycle and the timeline Tab cycle; they are picked from their own row. `getRenderableAnnotations`
  is unchanged and still includes them.
- Tests: `blurEffects.test.ts` (13), `annotationBlurParity.test.ts` (5, node, buffer-backed fake
  context: byte parity with the preview routine, 2× block alignment, oval mask, edge clipping,
  `renderAnnotations` dispatch), plus blur cases in clipboard, duplicate, renderOrder, idCounters
  and shortcuts suites.

## Not verified here (no display on the lead box)

Manual smoke before release:

Gradient
1. Background → Gradient → "Custom gradient": build a 3-stop linear gradient, change the angle,
   switch to radial, add/remove stops up to the cap; the preview swatch and the video background
   follow every change.
2. Click a preset swatch inside the editor and in the grid above: the editor reloads it.
3. Export MP4 with a custom gradient: the exported background matches the preview.

Blur
4. Press `B` and click the toolbar eye-off button: a purple item appears in the Blur row and a
   mosaic box on the preview; the settings panel shows the blur panel.
5. Move and resize the box; the mosaic follows during the drag. Switch to Oval, Dark shade, change
   block size and intensity.
6. Two overlapping text annotations plus a blur region at the playhead: Tab and click-through
   cycle only between the two text boxes; clicking the selected blur keeps it selected.
7. Ctrl+Z / Ctrl+Shift+Z after adding, moving and editing a blur region.
8. Export at 1080p and at 4K: block layout and shade match the preview at the output scale.
9. Open a project saved before this batch: loads unchanged, no blur row items.
10. Set `BLUR_REGIONS_ENABLED = false`: row, button, shortcut, panel and overlay disappear;
    exports ignore blur regions; the project still loads.

## Verification note

Merged into the integration branch with the full gate green (lint 0 errors, tsc, test types,
i18n, format, vitest). Nothing here was exercised in a live window; the smoke list above is
the acceptance test.
