# Tracked blur regions

**Status:** design, build-ready. Nothing in this document is implemented yet.
**Branch:** `feat/1.9`. **Flag:** `BLUR_TRACKING_ENABLED` in
`src/components/video-editor/featureFlags.ts` (off until phase 2 ships).

## Why

A blur region today is a rectangle over a time span. Users of screen recorders
commonly complain that a mask does not follow the content when the page scrolls
or a window moves: the email they blurred in a table is unblurred one scroll
later. An OCR-based automatic scan was measured and rejected
(`docs/technical-debt/redaction-spike.md`); this design does not read text. It
follows the *pixels the user pointed at*, which is a much easier problem and
needs no model download.

### What the code does today, and one premise to correct

- A blur region is an `AnnotationRegion` of `type: 'blur'`
  (`src/components/video-editor/types.ts`). Its `position` and `size` are
  **percentages of the output stage**, not source coordinates:
  `annotationRenderer.ts` multiplies them by `canvasWidth`/`canvasHeight` of
  the composite canvas, and `AnnotationOverlay.tsx` by the overlay container.
- Blurs are painted **after** the zoom camera (`frameRenderer.renderFrame`:
  `applyZoomTransform` → render stage → `renderAnnotations` on the composite).
  So a blur does **not** follow zoom or crop today, and because
  `annotationRegions` is shared across aspects while the stage differs per
  aspect, the same blur lands on different content in a 9:16 export than in
  16:9.
- The mosaic itself is shared (`renderMosaicRegion` in `src/lib/blurEffects.ts`)
  and parity-tested (`annotationBlurParity.test.ts`).
- The cursor already solves the geometry problem this design needs: cursor
  samples are source-normalised (0..1 of the full frame) and
  `projectCursorToViewport` (`src/lib/cursor/cursorComposer.ts`) maps them
  through crop → mask → camera to stage pixels, identically in preview and
  export.

Consequence: a tracked blur must store geometry in **source-normalised space**
and be projected like the cursor. That makes tracked blurs follow zoom, crop and
every export aspect for free. Untracked (legacy) blurs keep their stage-percent
geometry and render exactly as before, so existing projects load unchanged.

---

## 1. Tracking algorithm

### 1.1 Problem statement

Input: the source video, a blur region with span `[startMs, endMs]`, and the
anchor rectangle the user drew at time `t0` (source ms), converted to
source-normalised coordinates. Output: a keyframe list giving, for each
analysed instant, the rectangle's position or the fact that the content is not
visible.

Motion model: **translation only.** Scrolling (the dominant case) and window
dragging are translations of a rigid patch; a resize of the window or a browser
zoom changes scale and is out of scope (the track goes lost, the user corrects).
The patch keeps its size unless the user changes it.

### 1.2 Approaches evaluated

| Approach | Verdict | Why |
|---|---|---|
| Full-frame phase correlation (2D FFT), then local refinement | rejected as the primary estimator | A 512×256 complex FFT pair in JS is 5–10 ms per sample before any refinement, and it measures the *dominant* motion of the whole frame. Screen content is mixed: static chrome plus one scrolling pane. The static part wins the peak and the pane's shift is a secondary peak that has to be disambiguated anyway. |
| Sparse features (corners + descriptors) | rejected | Text patches have thousands of near-identical corners; matching is brittle at small sizes and much more code (detector, descriptor, matcher, RANSAC) for no gain over correlation on rigid translation. |
| Exhaustive NCC template matching in a search window | too slow alone | A 64×16 template over a ±64 px window at analysis scale is ~16 M multiply-adds per sample (15–30 ms in JS). 3000 samples would take a minute. |
| **Projection-profile shift candidates + NCC verification (chosen)** | chosen | Scroll is a 1-D problem most of the time. Correlating gradient profiles of a band around the patch gives shift candidates in well under a millisecond; NCC then verifies at a handful of candidate offsets with a ±3 px refinement. Coarse-to-fine, deterministic, robust to noise, cheap. |

### 1.3 Pipeline

Frames are analysed on a **fixed sample grid** `t_k = t0 + k·Δ`, `Δ = 100 ms`,
clamped to `[startMs, endMs]`, forward (`k > 0`) and backward (`k < 0`). The
frame used at `t_k` is the decoded frame nearest to `t_k` (same handoff rule as
the exporter's `decodeAll`: the midpoint between consecutive decoded frames).
When motion is detected between two grid samples the interval is **densified**
to every decoded frame (§1.8). Everything below runs in a Web Worker on
grayscale `Uint8Array`s.

Per analysed frame:

1. **Coarse frame** `C`: the full frame drawn at width `W_c = 480` (1080p →
   1/4, 4K → 1/8, 720p → 3/8; always `W_c = 480`, height by aspect), converted
   to gray `Y = (77R + 150G + 29B) >> 8`.
2. **Fine window** `F`: the region around the predicted patch position, drawn
   at the *patch scale* `s_p` (§1.4), sized `(w_p + 2·R) × (h_p + 2·R)` at that
   scale with `R = 8`.
3. **Shift candidates** from `C` (§1.5).
4. **NCC verification** of the anchor template at each candidate in `F` (§1.6).
5. **State update** (§1.7) → emit `{timeMs, x, y, w, h, score, state}`.

Both draws are `OffscreenCanvas` `drawImage` calls with a source rectangle, so
crop and downscale happen in one GPU-backed step and only two small
`getImageData` reads hit the CPU per frame.

### 1.4 Scales

- Coarse scale `s_c = W_c / sourceWidth`.
- Patch scale `s_p = 2^-k` with the largest `k ∈ {0,1,2,3}` such that the patch
  at that scale still has `min(w,h) ≥ 16 px` and `max(w,h) ≥ 48 px`. A 200×16 px
  email cell at 1080p is tracked at `s_p = 1` (full res); a 900×600 px window
  at `s_p = 1/8`. Additionally the fine template is capped at 160×96 px by
  lowering `s_p` one more step if needed, which bounds the NCC cost for large
  boxes.
- All thresholds in px below are at the scale they are evaluated at unless
  stated as *source px*.

### 1.5 Shift candidates from projection profiles

Screen content has strong horizontal gradients at text and UI edges, and a
vertical scroll shifts the *row profile* of those gradients rigidly. Restricting
the profile to the patch's own columns makes it belong to the patch's scroll
container rather than to the whole screen.

- Gradient image `G = |Y(x+1,y) − Y(x,y)|` on `C`.
- **Column band** for vertical shift: columns `[x_p − w_p/2, x_p + 3·w_p/2]`
  (patch width doubled, centred), all rows. Row profile
  `P_v(y) = mean_x G(x,y)` over the band. Length `H_c`.
- **Row band** for horizontal shift: rows `[y_p − h_p, y_p + 2·h_p]`, all
  columns. Column profile `P_h(x) = mean_y G(x,y)`. Length `W_c`.
- Zero-mean each profile, then normalised cross-correlation between the profile
  of the previous analysed frame and the current one:

  ```
  r(d) = Σ_i p₁(i)·p₂(i+d) / sqrt(Σ p₁² · Σ p₂²)     over the overlap
  ```

  for `d ∈ [−H_c/2, H_c/2]` (vertical) and `d ∈ [−W_c/4, W_c/4]` (horizontal).
  Overlap shorter than 25 % of the profile is not scored.
- Candidates: the top-3 local maxima of `r_v` with `r ≥ 0.5`, the top-2 of
  `r_h`, plus `d = 0`, plus the constant-velocity prediction
  `p̂ = p_{prev} + 0.5·v_{prev}·Δt`. Vertical and horizontal candidates are
  combined pairwise (≤ 4 × 3 = 12 offsets, deduplicated). Coarse offsets are
  scaled to the fine scale by `s_p / s_c`.

Cost: `G` and both profiles ~130 k operations; both correlations ~190 k. Under
one millisecond.

### 1.6 NCC verification

The **template** `T` is the patch at `t0`, at scale `s_p`, kept for the whole
track (no drift-updating; §1.10 explains why). Zero-mean normalised
cross-correlation at offset `(u, v)` in the fine window `F`:

```
ncc(u,v) = Σ (T(i,j) − T̄)(F(i+u, j+v) − F̄ₙ) / ( σ_T · σ_F(u,v) · N )
```

`F̄ₙ` and `σ_F(u,v)` are the mean and standard deviation of the window under
the template at that offset (computed from integral images of `F` and `F²`, so
each offset costs `O(N)` for the cross term only). Both images are smoothed with
a 3×3 box filter first, which suppresses compression ringing at essentially no
cost.

For each candidate offset the 7×7 neighbourhood (±3 px) is evaluated and the
best `(u,v)` and its score kept. The overall best candidate wins; ties within
0.05 go to the offset nearest the constant-velocity prediction.

Cost at the cap (160×96 template, 12 candidates × 49 offsets): ~9 M
multiply-adds ≈ 4–6 ms. Typical (text cell, 3 candidates): < 1 ms.

**Quadrant scores.** The same pass also produces `ncc` for the four quadrants
of `T` at the winning offset (they are partial sums of the same terms). These
drive the partial-occlusion rule below.

**Template validity.** At `t0`, `σ_T` is computed at scale `s_p`. If
`σ_T < 6` (of 255) the patch has too little detail to track (a blank area, a
flat colour) and tracking is refused with a clear message rather than producing
a random walk.

### 1.7 State machine and thresholds

```
FOUND      whole ≥ 0.70,  or  (maxQuadrant ≥ 0.80 and whole ≥ 0.30)   → emit rect
TENTATIVE  0.45 ≤ whole < 0.70 and streak ≤ 3                          → hold last rect, no new keyframe
LOST       whole < 0.45,  or TENTATIVE streak > 3,  or predicted rect
           outside the frame                                             → emit lost keyframe
```

- `FOUND → TENTATIVE`: a cursor crossing the patch, a hover highlight, a
  selection tint. The rect is held where it was; the next FOUND sample resumes
  normal keyframes. Three consecutive tentative samples (300 ms) become LOST.
- The **quadrant rule** keeps the blur on when a dropdown or tooltip covers up
  to three quarters of the patch but the remaining quarter is clearly the same
  content. If the whole patch is covered the state is LOST and the blur hides,
  which is correct: the content is not visible.
- `LOST` keyframes carry the last known rect (for the fade-out and the "hidden
  here" outline in the editor).
- Thresholds live in one exported `BLUR_TRACKER_TUNING` object so tests and
  the benchmark can reference them; they are not user-facing.

### 1.8 Densification during motion

At 10 samples per second a flick scroll moves the content 100+ source px
between samples. Linear interpolation between two such keyframes would put the
blur tens of pixels off for a few frames, which for a redaction is a leak.
Two rules, both deterministic:

1. **Densify (WebCodecs path).** The worker receives every decoded frame but
   analyses only grid samples. Frames between two grid samples are held in a
   small ring (≤ 8 `VideoFrame`s; at 60 fps a 100 ms interval holds 6). When
   the displacement between the two grid samples exceeds `6 source px`, or the
   state changed (FOUND↔LOST), the held frames are analysed too, in order, and
   each emits a keyframe. Otherwise they are closed unread. Motion therefore
   costs analysis at source frame rate only while it happens.
2. **Union safety (render time, both paths).** When two consecutive keyframes
   are more than 40 ms apart *and* more than `6 source px` apart, the rendered
   rect for the interval is the union of both rects instead of the lerp (§2.4).
   A blur that is too large during a fast scroll is harmless; one that is too
   small is the bug this feature exists to fix. With rule 1 in effect this is a
   no-op; it is the safety net for the seek fallback (§1.11), which cannot
   densify.

### 1.9 Re-acquisition

While LOST:

- **Every lost sample**, a 1-D search along the scroll axis: the coarse-scale
  template (patch at `s_c`; if that is smaller than 8×3 px the fine template
  over a vertical strip of `F` covering the whole height is used instead) is
  slid over the full frame height at the last known `x ± 4 px`. Accept when
  `ncc ≥ 0.80` **and** a fine-scale verification at that position scores
  `≥ 0.75`. This is the "scrolled off, scrolled back" case and costs ~1 ms.
- **Every 5th lost sample** (500 ms), a full 2-D coarse search with the
  integral-image NCC over the whole coarse frame (window drag, tab switch and
  back). Same double threshold. ~40 ms, so ≤ 8 ms amortised while lost.
- The re-acquisition thresholds are stricter than FOUND on purpose: latching
  onto a *different* row of similar text is the worst failure mode (§5), and a
  lost blur is honest while a wrong one is not.
- A found keyframe after a lost span is stamped at `t_found − Δ` (one grid
  interval early) so the blur is already on when the content can first have
  appeared. Redaction is asymmetric: early is free, late is a leak.

### 1.10 Why the template is not updated

Drift-updating the template (replacing it with the latest match) is the classic
way to survive appearance change and the classic way to drift onto the
background one pixel at a time. Screen content does not deform; it is either
the same pixels or not there. Keeping the `t0` template means a track can never
walk away from its content, and re-acquisition is comparing against the thing
the user actually drew around. Appearance change beyond what NCC tolerates
(theme switch, selection highlight that stays) shows up as LOST, and the user
correction in §3.4 pins a new template from that frame.

### 1.11 Frame sources

The tracker never touches `<video>` playback in the editor. It opens its own
decoder on the source file, exactly as the exporter does:

- **WebCodecs path (default).** `StreamingVideoDecoder` gains a
  `decodeRange({ startSec, endSec }, onFrame)` sibling of `decodeAll` that
  reads `demuxer.read('video', startSec, endSec)` (web-demuxer starts at the
  keyframe at or before `startSec`; earlier frames are decoded and dropped) and
  emits **every** decoded frame in the range with its source timestamp. The
  decoder object needs `window` (`withTimeout`, `electronAPI` for local files)
  so it stays on the main thread; each `VideoFrame` is **transferred** to the
  worker (`postMessage(frame, [frame])`, zero-copy), which owns and closes it.
  Backpressure: the worker acknowledges each frame and the main thread keeps
  at most 4 in flight.
- **Seek path (fallback).** `VideoFileDecoder` + the exporter's `seekVideoTo`
  logic at the grid instants only, `createImageBitmap(video)` transferred to
  the worker. No densification; the union rule covers it. Selected by the same
  `resolveExportDecodePath` rule as export (`decoderFallback.ts`), so a
  machine that exports by seeking tracks by seeking.
- **Backward span** (`startMs → t0`): decoding is forward-only, so the span is
  processed in chunks of `N` grid intervals (`N` chosen so the held fine-scale
  frames stay under 64 MB; 16–32 intervals at 1080p). Each chunk is decoded
  forward, its analysed frames kept as gray arrays, and the state machine runs
  over them in reverse. Decisions depend only on the sample sequence, never on
  chunk boundaries, so results are identical to an idealised reverse pass.

### 1.12 Budget

Target: a 5-minute 1080p span in about 10 s of tracker time on a mid laptop.

| Step (per analysed frame) | Estimate |
|---|---|
| coarse draw + `getImageData` (480×270) + gray | ~0.8 ms |
| gradient + profiles + two correlations | < 0.5 ms |
| fine window draw + read | ~0.4 ms |
| NCC, typical text cell (3 candidates) | < 1 ms |
| NCC at the 160×96 cap, 12 candidates | 4–6 ms |
| **typical total** | **~3 ms** → 3000 grid samples ≈ 9 s |
| lost sample (1-D search) | ~1 ms; +40 ms every 5th |

These are operation-count estimates, not measurements. Phase 1 ships a
benchmark browser test that logs ms per sample; the acceptance criterion is on
that number (§4.1). Decoding runs concurrently and is bounded by the codec:
hardware H.264 at 1080p decodes several hundred frames per second; software
VP9 may be the slower half of the wall time on a laptop, and the progress UI
must reflect frames decoded, not only frames analysed. Typical blur spans are
seconds to a minute; five minutes is the worst case, not the median.

### 1.13 Determinism

Fixed grid, fixed thresholds, integer image maths, no randomness, no
wall-clock dependence, no adaptive sample rate. Given the same decoded pixels
the output is byte-identical. Decoded pixels *can* differ between a hardware
and a software decoder by a few levels, which can move a match by a pixel. That
is why keyframes are persisted (§2): export never re-tracks, so an export is a
pure function of the project file.

---

## 2. Data model

### 2.1 Types

```ts
// src/components/video-editor/types.ts

/** One tracked or pinned position of a blur region, in source-normalised coordinates (0..1 of the full source frame). */
export interface BlurTrackKeyframe {
  timeMs: number            // source time
  x: number; y: number      // top-left, 0..1
  w: number; h: number      // size, 0..1
  /** Content not visible from this keyframe until the next non-lost one. Rect = last known. */
  lost?: true
  /** 'user' = placed or dragged by the user; a pin. Missing = 'tracked'. */
  origin?: 'user'
}

export interface BlurTrack {
  version: 1
  /** Always 'source'. Present so a future stage-space track cannot be confused with this one. */
  space: 'source'
  /** Sorted by timeMs, unique timeMs, at least one keyframe. */
  keyframes: BlurTrackKeyframe[]
  /** Source dimensions the track was computed against; px-based render rules use them. */
  sourceSize: { width: number; height: number }
  /** Grid interval used, ms. */
  sampleIntervalMs: number
  /** Anchor time the user drew the box at. */
  anchorMs: number
  /** For the panel only; never read by the renderer. */
  quality?: { meanScore: number; lostMs: number; trackedMs: number }
}

export interface AnnotationRegion {
  // ...existing fields...
  /** Present on tracked blur regions only. Missing = untracked, stage-percent geometry as before. */
  blurTrack?: BlurTrack
}
```

`BlurData` (shape, colour, block size, intensity) is unchanged: it describes
the look, `blurTrack` describes where.

### 2.2 Source of truth and cache

- **Keyframes are the truth.** They are what the project persists and what the
  preview and the export read. The anchor template pixels are *not* persisted;
  re-tracking re-samples them from the anchor keyframe's frame.
- **Nothing else is cached on disk.** At render time the interpolation is a
  binary search over the keyframe array plus a lerp; a region's array only
  changes on user action, so the renderer keeps the last index as a hint and
  that is the whole cache.
- `position`/`size` of a tracked region are kept **in sync with the stage
  projection of the anchor keyframe** whenever the track changes. They are not
  read by a build that understands `blurTrack`. A build that does not (an
  older release opening the project) renders the blur as a static box at the
  anchor position, which is degraded but not broken, and it does not drop the
  field because unknown fields survive its `normalizeAnnotationBlurData`.

### 2.3 Schema versioning and migration

`ProjectState.version` stays `1`. Every field added since `version: 1`
(`motionBlurAmount`, `autoZoomEnabled`, `cursorStyle.*`, `rotationPreset`, …)
has been an optional field with a normaliser that fills defaults, and this
follows the same rule:

- `normalizeAnnotationBlurData` (`src/lib/blurEffects.ts`) grows a
  `normalizeBlurTrack(value: unknown): BlurTrack | undefined`: non-object,
  wrong `space`, empty or non-array `keyframes`, non-finite numbers, keyframes
  out of `[0,1]` after clamping to a degenerate size, missing `sourceSize` →
  `undefined` (the region falls back to untracked, static, exactly what it was
  before tracking). Keyframes are sorted, duplicates by `timeMs` collapsed
  (last wins), and non-blur regions drop a stray `blurTrack`.
- A project saved before this feature has no `blurTrack` and is untouched.
- No conversion of existing untracked blurs to source space is performed on
  load. Converting would need the stage layout (aspect, crop, padding) the box
  was authored under, and a wrong guess would move a user's blur. Untracked
  regions keep rendering as stage-percent boxes.

### 2.4 Rect at time `t` (shared by preview and export)

```ts
// src/lib/blurTracking/keyframes.ts
export function resolveTrackedBlurRect(track: BlurTrack, timeMs: number): { rect: NormRect; opacity: number } | null
```

- `t` before the first keyframe → first keyframe's rect (a track always starts
  at `startMs` because the backward pass reaches it, but be tolerant).
  `t` after the last → last keyframe.
- Find `k_i ≤ t < k_{i+1}`.
  - `k_i.lost` → `{ rect: k_i.rect, opacity: max(0, 1 − (t − k_i.timeMs) / 100) }` (fade out over 100 ms).
  - `k_{i+1}.lost` → `{ rect: k_i.rect, opacity: 1 }` (hold until the lost time).
  - else `u = (t − k_i.timeMs) / (k_{i+1}.timeMs − k_i.timeMs)`, `rect = lerp(k_i, k_{i+1}, u)`.
  - **union safety:** if `k_{i+1}.timeMs − k_i.timeMs > 40` and the displacement
    between the two rects exceeds `6 / sourceSize.height` (6 source px,
    normalised), `rect = union(k_i.rect, k_{i+1}.rect)` instead.
- `opacity 0` → return `null` (nothing drawn).

Opacity is applied inside `renderMosaicRegion` as a blend of the mosaic result
with the original pixels (`out = orig·(1−a) + mosaic·a`), so the fade is
identical in preview and export. Re-acquisition does not fade in: the blur
appears at full strength at the (pre-rolled) found keyframe.

### 2.5 Projection: source ↔ stage

```ts
// src/lib/blurTracking/projection.ts
export interface StageGeometry {
  stageSize: { width: number; height: number }
  baseOffset: { x: number; y: number }     // mask origin in camera-local px (preview: maskRect.x/y; export: 0,0 — see cursor code)
  maskRect: { width: number; height: number }
  cropRegion: CropRegion
  camera: { scale: number; x: number; y: number }   // cameraContainer scale/position after applyZoomTransform
}
export function projectSourceRectToStage(rect: NormRect, g: StageGeometry): { x: number; y: number; width: number; height: number; clipped: boolean } | null
export function stageRectToSourceRect(rect: StagePxRect, g: StageGeometry): NormRect
```

`projectSourceRectToStage` maps the top-left and bottom-right corners with the
same arithmetic as `projectCursorToViewport` (re-normalise against the crop,
place on the mask, apply camera scale and position), then intersects with the
projected mask rect so the mosaic never spills onto the wallpaper padding. The
camera is a uniform scale plus translation, so a rect stays a rect. The cursor
helper is refactored to call a shared `projectSourcePointToStage` so the two
cannot drift. `stageRectToSourceRect` is the exact inverse and is what turns
the user's drag into a keyframe (§3.4) and the anchor box into the first
keyframe.

### 2.6 Interaction with zoom, crop, aspects

- **Zoom.** Both the preview ticker and `frameRenderer.updateAnimationState`
  run `stepZoomCamera`; each path projects with *its own* camera for the frame
  it is drawing. The blur is attached to content, not to the stage, so it is
  correct in each path by construction even where the two cameras differ
  slightly (the paused preview snaps, the export always springs).
- **Crop / aspect** (`aspectZoomState.ts`, `cropRegionsByAspect`). Source
  space is aspect-independent: one track serves every export aspect, and a
  rect outside the active crop projects to nothing. This fixes the multi-aspect
  mismatch that stage-percent blurs have today, for tracked regions.
- **3D tilt presets.** Annotations are drawn flat above a tilted video today;
  a tracked blur inherits that and will sit off its content while a tilt is
  active. Documented limitation, same as every annotation; not addressed here.
- **Segments and trims** (`timeMapping.ts`). Keyframes and the region span are
  source time, like everything else on a region. The tracker runs over source
  time and ignores segments (a deleted segment is simply never shown). The
  timeline draws keyframe marks at
  `sourceToEffectiveMsWithSegments(k.timeMs, segments)` and hides marks that
  fall in deleted segments. Speed changes need nothing: the renderer asks for
  the rect at the source time it is drawing.

### 2.7 Export parity

`renderAnnotations` gains an optional `blurGeometry?: StageGeometry`
parameter. For a region with `blurTrack`, both `annotationRenderer.renderBlurRegion`
(export) and `AnnotationOverlay` (preview) call
`resolveTrackedBlurRect` → `projectSourceRectToStage` → the existing pixel path
(`getImageData` on the composite, `renderMosaicRegion`, `putImageData`).
`frameRenderer` supplies geometry from `layoutCache` and `cameraContainer`
after `applyZoomTransform`; `VideoPlayback` supplies it from `baseMaskRef`,
`cropRegionRef` and `cameraContainerRef`, the same values the cursor canvas
uses. Untracked regions take the old branch untouched.
`annotationBlurParity.test.ts` grows a case with a tracked region under a
zoomed camera and asserts identical pixels between the two call paths.

---

## 3. UX

### 3.1 Vocabulary

- Action: **Track content**. Not "auto", not "smart".
- Result states on the timeline: **tracked** (keyframe ticks), **hidden**
  (hatched span), **pinned** (user keyframe, brighter tick).
- Copy is honest by default. The panel hint under the button reads:
  *"Follows this area as the page scrolls or the window moves. Tracking may
  lose the content after large changes; hidden spans are shown on the
  timeline."*

### 3.2 Track content (phase 2)

In `BlurSettingsPanel`, below the intensity slider:

- **Button "Track content"** (icon: crosshair). Enabled when the playhead is
  inside the region's span; the frame under the playhead is `t0` and the box as
  drawn is the anchor.
- Press → the panel shows a progress row: *"Tracking… 0:42 of 3:10"* with a
  thin bar and a **Cancel** button. Progress is
  `(decodedMs) / (spanMs)`, counted over the forward and backward passes, so it
  moves even when the decoder is the slow part. Cancel aborts the decoder,
  terminates the worker and leaves the region exactly as it was.
- Refusals are immediate and specific: *"This area has too little detail to
  track. Make the box larger or include some text or edges."* (template
  variance check, §1.6); *"The playhead is outside this blur's time span."*
- On completion the result is applied in **one** `setAnnotationRegions`
  update: `blurTrack` set, `position`/`size` synced to the anchor projection.
  The history effect records one undo entry. A toast summarises: *"Tracked
  3:10. Hidden for 0:14."* If the content was lost for more than half the span
  the toast is a warning with the same numbers, not a success.
- Re-running "Track content" on a tracked region replaces the tracked
  keyframes but **keeps user pins** (§3.4) as boundaries.
- The button reads **"Remove tracking"** when the region is tracked; that
  deletes `blurTrack` and leaves the region as a static box at its current
  `position`/`size` (one undo entry).

### 3.3 Timeline

The blur row item (`Item.tsx`, `variant="blur"`) gets two optional props:

- `keyframeTicks: number[]` (effective ms) → 1 px ticks along the bottom edge
  of the item, in the same yellow as `KeyframeMarkers`. Ticks are not
  draggable in phase 2 (the correction gesture is on the preview, where the
  user can see the content).
- `hiddenSpans: { startMs, endMs }[]` (effective ms) → a diagonal-hatch
  overlay with reduced opacity and a `title` of *"Hidden: content not found"*.

Ticks are decimated for display when denser than one per 3 px so a densified
scroll does not become a solid bar.

### 3.4 Corrections (phase 3)

- Dragging or resizing the box in the preview at time `t` on a tracked region:
  the stage rect is inverted with `stageRectToSourceRect` at the preview's
  current geometry and written as a keyframe `{ timeMs: t, origin: 'user' }`.
  Tracked keyframes within `±Δ` of `t` are removed. If `t` falls in a hidden
  span, the user keyframe also ends that span at `t`.
- After a correction the panel shows a row: *"Position changed at 0:12.4 ·
  Re-track from here"* with a button. Re-tracking from a pin uses the pin's
  rect as the new template, runs forward to the next pin (or `endMs`) and
  backward to the previous pin (or `startMs`), and replaces only the tracked
  keyframes in that window. Pins are never moved by the tracker.
- When the playhead is inside a hidden span and the region is selected, the
  overlay draws a dashed outline at the last known rect with a small label
  *"Hidden here"* instead of a mosaic, so the region remains selectable and
  draggable. Unselected, nothing is drawn.
- Undo: each of these is one `annotationRegions` update → one entry.

### 3.5 Find this elsewhere (phase 3, optional)

Panel action **"Search recording for this content"**. Runs the coarse 2-D
search (§1.9, every 500 ms) over the recording *outside* the region's span
using the region's template, groups consecutive hits into spans, tracks each
span with the normal tracker, and shows the results as a list in the panel:
*"Found at 1:04–1:19, 4:32–4:40 …"* with *Add* buttons and *Add all*. Each
added region is a new blur region with the same `blurData` and its own
`blurTrack`, created in one update. Nothing is added without the user's click.
Copy: *"Searches for the same pixels, not the same text. It finds this content
where it looks the same and may miss it where the page has changed."*

### 3.6 Render-side polish

- When a tracked region becomes lost it **fades out over 100 ms** (§2.4)
  instead of popping.
- A tracked region inside a hidden span is skipped entirely by both renderers
  (no `getImageData`), so a hidden blur costs nothing.

---

## 4. Verification plan

Run lanes under the machine's memory rules (`flock /tmp/heavy.lock
systemd-run --user --scope -q -p MemoryMax=8G <cmd>`; browser lane and the
harness dev server as in `docs/testing/browser-harness.md`).

### 4.1 Unit tests (node lane, `vitest --run`)

Fixture generator `src/lib/blurTracking/syntheticScreen.ts` (test-only): a
seeded PRNG draws a "page" into a gray `Uint8Array` — static chrome bars,
a scrollable pane with text-like rows (runs of small rectangles with row
periodicity and per-row variation), and a marked cell whose ground-truth rect
is known. Parameters: scroll offset per frame, noise σ, optional cursor blob,
optional occluder rect, optional row re-render (change the row's glyph
pattern).

`trackerCore.test.ts`:

1. **Known scroll.** Offsets `{1, 3, 8, 25, 60, 130}` px vertical and `{−40, 12}`
   horizontal recovered within 1 px at `s_p = 1`, within `1/s_p` px otherwise.
2. **Off-screen and back.** Pane scrolls the cell above the top edge → LOST at
   the first sample where the predicted rect leaves the frame; scrolls back →
   FOUND on the first sample it is fully visible, keyframe stamped `Δ` early.
3. **Noise.** σ = 8 gaussian on both frames → still FOUND with score ≥ 0.8.
4. **Cursor.** 20×20 blob crossing the cell → never LOST; ≤ 2 tentative samples.
5. **Partial occlusion.** Occluder over 60 % of the cell → FOUND by the quadrant
   rule; over 100 % → LOST after 3 tentative samples; occluder removed → FOUND.
6. **Similar rows.** Ten rows of similar text; cell scrolled 1.5 rows between
   samples → tracker follows the correct row (score margin ≥ 0.1 over the best
   wrong row). This is the kill-criterion test (§5).
7. **Template validity.** Flat patch → refusal; textured patch → accepted.
8. **Re-acquisition thresholds.** A wrong row scoring 0.72 while lost does not
   re-acquire (needs 0.80 + 0.75 fine).
9. **Backward chunking.** A reverse pass over one chunk of 32 equals the pass
   over two chunks of 16, keyframe for keyframe.

`keyframes.test.ts`: interpolation (hold, lerp, fade-out curve, union safety
on/off by gap and displacement), simplification keeps transitions and pins and
stays within 0.5 source px, `normalizeBlurTrack` on garbage, sort/dedupe.

`projection.test.ts`: round trip `stageRectToSourceRect ∘ projectSourceRectToStage`
under identity, crop, padding and a zoomed camera; equality with
`projectCursorToViewport` for a point; clipping to the mask.

`annotationBlurParity.test.ts` (extended): tracked region under a zoom → same
pixels via `renderAnnotations` with `blurGeometry` and via the preview's
sampling; opacity 0.5 blends identically; hidden span draws nothing.

`timeMapping` interplay: keyframe marks inside a deleted segment are hidden;
marks around a 2× segment land at the right effective time.

### 4.2 Browser test (`*.browser.test.ts`, headless Chromium)

`trackBlurRegion.browser.test.ts`: records a 4 s 480×270 WebM in-test from a
canvas with `captureStream` + `MediaRecorder` (the pattern in
`gifExporter.browser.test.ts`) drawing a table that scrolls 40 px/s for 2 s,
holds, then jumps 200 px. Runs `trackBlurRegion` with the WebCodecs path and
with `decodePath: 'seek'`:

- recovered `y(t)` within 3 source px of the drawn scroll at every grid sample
  in the smooth part (WebCodecs), within 6 px (seek);
- the jump produces either a dense keyframe run (WebCodecs) or a union-safe
  interval (seek), and in both cases the rendered rect covers the ground-truth
  rect at every frame of the interval;
- cancel via `AbortSignal` after 300 ms rejects with `AbortError` and leaves no
  live worker or decoder (`performance.memory` not required; check the
  promise and that a second run works);
- **benchmark:** logs median and p90 ms per analysed sample through the
  `writeSpikeArtifact` command. Acceptance: median ≤ 5 ms on the dev box
  (software rendering), which extrapolates to ≤ 15 s for 3000 samples.

### 4.3 Manual DevTools check (browser harness)

The bundled `sample.webm` is 2 s of 320×240 without scrolling, so phase 1 adds
`src/__fixtures__/scrolling-table.webm`: 6 s, 480×270, VP9, a table that
scrolls, pauses, and scrolls back, under 300 KB. The harness middleware serves
it at `/dev-fixtures/scrolling-table.webm`; the editor is pointed at it with
`electronAPI.setCurrentVideoPath(url)` from DevTools.

Phase 1 (no UI): `window.__capturiaBlurTracking.track(regionId)` debug handle
(installed only when `import.meta.env.DEV`), returns the `BlurTrack`; inspect
keyframes, check `lost` spans against what the fixture shows.

Phase 2: add a blur over a table cell at 1 s, press **Track content**, watch
the progress row, then scrub: the mosaic follows the cell, hides while it is
off-screen, and reappears. Toggle a zoom region over the span and confirm the
mosaic stays on the content. Export a GIF from the harness, open it, and
confirm the same at two times.

### 4.4 Playwright e2e (nightly lane)

`e2e/blur-tracking.spec.ts`, structure of `editor-shortcuts.spec.ts`, fixture
`scrolling-table.webm` via `CAPTURIA_E2E_VIDEO`: add a blur with the `addBlur`
shortcut, click **Track content** (`data-testid="blur-track-button"`), wait for
`data-testid="blur-track-progress"` to disappear, then seek to two times and
assert that the `blur-region` overlay's bounding box moved in the scroll
direction by roughly the fixture's scroll, and that at the off-screen time the
overlay is absent. Then run the GIF export as `export.spec.ts` does and assert
a non-empty file. Budget timeouts as the existing specs do (software
rendering).

### 4.5 Acceptance criteria per phase

**Phase 1**

- All §4.1 unit tests pass in the node lane; §4.2 passes in the browser lane
  with the benchmark median ≤ 5 ms/sample.
- Tracking is deterministic: two runs over the same file produce identical
  keyframes (browser test asserts deep equality).
- Cancel is clean; no `VideoFrame` leaks (worker closes every frame; test
  counts sends vs closes).
- Old projects load unchanged (`normalizeBlurTrack` tests); a project with a
  `blurTrack` round-trips through save/load.
- Nothing user-visible changes with the flag off.

**Phase 2**

- Parity test with a tracked region under zoom passes.
- Harness check §4.3 passes by hand on the scrolling fixture, including a
  zoomed export.
- e2e §4.4 passes in the nightly lane.
- `npm run i18n:check` passes with the new keys in `en`, `zh-CN`, `vi`.
- No regression in `annotationBlurParity.test.ts` for untracked regions
  (byte-identical to before).

**Phase 3**

- Correction round trip: drag at `t` → pin → re-track → the pin is unchanged
  and tracked keyframes on both sides are replaced (unit test on the
  orchestrator with a fake frame source).
- Find elsewhere on the fixture finds the second scroll-in and nothing during
  the off-screen span.

### 4.6 Failure modes that must not ship

- **A wrong blur.** The tracker following a different row of similar text
  (test 6) or re-acquiring on a lookalike (test 8). A lost blur is acceptable;
  a confidently wrong one is not, because it tells the user their content is
  covered when it is not.
- **A late blur.** Any interval where the ground-truth rect is not covered by
  the rendered rect during motion (browser test, both paths).
- **Preview/export disagreement** on the sampled rect for the same camera.
- **Blur outside the video** (on the wallpaper padding) after projection.
- **A silent decoder fallback** that changes results without the seek path
  being reported in the completion toast.
- **UI lock-up** during tracking: the worker owns all pixel work; the main
  thread only feeds frames.
- **Undo needing several presses** after a track (the result must be one
  state update).

---

## 5. Reverse thinking

### Strongest arguments against

1. **Users can re-record.** True for a demo; not for a customer call, a bug
   reproduction, a live incident. The complaint exists because re-recording
   is often not possible, and today's alternative is scrubbing the timeline
   and placing a dozen static boxes by hand.
2. **Scroll tracking fails on virtualised lists and re-rendered rows.** If the
   list re-renders rows with different data at the same pixel positions, a
   pixel tracker can either lose the row (fine) or latch onto a lookalike (not
   fine). The design mitigates with full-resolution verification for small
   patches, strict re-acquisition thresholds and the similar-rows test, but it
   cannot be immune: two identical strings in two rows are identical pixels.
   The honest framing in the copy and the hidden-span display exist for this.
3. **Complexity in export.** A second geometry space in the renderer, a
   camera-dependent projection, an opacity blend in the mosaic. Contained by
   sharing one `resolveTrackedBlurRect` + one projection with the cursor, and
   by leaving untracked regions on the old path byte-for-byte.
4. **Wall time.** A five-minute span may take longer than the target on a
   software-decoding laptop. Progress with cancel and the typical short span
   make this tolerable, but it is a real cost.
5. **It is not redaction.** A tracker follows what the user pointed at; it
   does not find what they missed. The redaction spike settled that a finder
   is out of reach for now; this feature must not be marketed as one.

### What would cancel the feature after phase 1

- The similar-rows test (§4.1 item 6) cannot be made to pass with a score
  margin ≥ 0.1 on realistic text without dropping recall on the scroll tests
  below 95 %. That means the core failure mode cannot be bounded and the
  feature would ship wrong blurs.
- The benchmark median exceeds 15 ms/sample on the dev box after profiling
  (three times the estimate), which puts a five-minute span past a minute of
  tracker time on a laptop before decode.
- The browser test shows the WebCodecs `VideoFrame` transfer or
  `decodeRange` is unreliable across the codecs Capturia records (VP8, VP9,
  AV1, H.264 from the native helper) and the seek path alone cannot densify,
  so fast scrolls leak under the union rule in the recorded fixture.
- Determinism cannot be held: identical runs on the same machine diverge.

---

## 6. Phased build plan

One coding lane per phase, each ≤ 1 week. Every phase ends with the lanes that
fit this machine (`check`, typecheck, unit, browser) green locally and the
Electron e2e left to the nightly lane.

### Phase 1 — core tracker, keyframed model, tests; no UI

**Files**

- `src/lib/blurTracking/trackerCore.ts` — gray conversion, gradient profiles,
  profile correlation, integral-image NCC with quadrants, state machine,
  `BLUR_TRACKER_TUNING`. Pure functions over `Uint8Array`; no DOM.
- `src/lib/blurTracking/keyframes.ts` — `resolveTrackedBlurRect`,
  `simplifyKeyframes`, `normalizeBlurTrack`, `mergeUserPin` (phase 3 uses it;
  the data shape is fixed now).
- `src/lib/blurTracking/projection.ts` — `StageGeometry`,
  `projectSourceRectToStage`, `stageRectToSourceRect`,
  `projectSourcePointToStage` (and `cursorComposer.ts` switched to call it).
- `src/lib/blurTracking/blurTracker.worker.ts` — message protocol
  (`init`, `frame`, `flush`, `cancel` in; `sample`, `progress`, `done`,
  `error` out), `OffscreenCanvas` draws, densification ring, frame closing.
- `src/lib/blurTracking/trackBlurRegion.ts` — orchestrator: decode path
  resolution, `StreamingVideoDecoder.decodeRange` or seek fallback, backward
  chunking, backpressure, `AbortSignal`, progress callback, returns
  `BlurTrack`.
- `src/lib/blurTracking/syntheticScreen.ts` — test fixture generator.
- `src/lib/exporter/streamingDecoder.ts` — `decodeRange`.
- `src/components/video-editor/types.ts` — `BlurTrackKeyframe`, `BlurTrack`,
  `AnnotationRegion.blurTrack`.
- `src/lib/blurEffects.ts` — `normalizeAnnotationBlurData` calls
  `normalizeBlurTrack`; `renderMosaicRegion` gains `opacity` (default 1, so
  existing callers and parity are unchanged).
- `src/components/video-editor/featureFlags.ts` — `BLUR_TRACKING_ENABLED = false`.
- `src/components/video-editor/VideoEditor.tsx` — dev-only
  `window.__capturiaBlurTracking.track(regionId)` handle behind
  `import.meta.env.DEV`; applies the result in one update.
- `src/__fixtures__/scrolling-table.webm` + the harness middleware entry in
  `vite.config.ts`; a `scripts/make-scrolling-fixture.mjs` that regenerates it
  from Playwright Chromium so it is reproducible.

**Tests:** §4.1 all, §4.2 all. **Harness:** §4.3 phase-1 check. **e2e:** none.
**i18n:** none (no UI).

**Risks:** `demuxer.read` with a non-zero start not landing on the preceding
keyframe for some containers (verify on VP8/VP9/AV1/H.264 fixtures in the
browser test; fall back to `startSec = 0` with early drop if it does not);
`VideoFrame` transfer to a worker in the Electron version in use (fallback:
`createImageBitmap` on the main thread, still transferable); benchmark
estimates being optimistic (the lane profiles NCC first; the 160×96 cap and
candidate count are the knobs).

### Phase 2 — UI, preview, export parity; flag on

**Files**

- `src/components/video-editor/BlurSettingsPanel.tsx` — Track content /
  Remove tracking button, progress row with cancel, refusal messages.
- `src/components/video-editor/VideoEditor.tsx` — `handleTrackBlurContent`,
  `handleRemoveBlurTracking`, progress state, toast on completion.
- `src/components/video-editor/VideoPlayback.tsx` — expose
  `getStageGeometry()` on the imperative handle; pass `blurGeometry` to
  `AnnotationOverlay`.
- `src/components/video-editor/AnnotationOverlay.tsx` — tracked branch:
  resolve rect, project, sample, opacity; hidden → render nothing (selected →
  dashed outline, phase 3).
- `src/lib/exporter/annotationRenderer.ts` — `blurGeometry` parameter,
  tracked branch in `renderBlurRegion`.
- `src/lib/exporter/frameRenderer.ts` — build `StageGeometry` after
  `applyZoomTransform` and pass it.
- `src/components/video-editor/timeline/Item.tsx`, `TimelineEditor.tsx` —
  `keyframeTicks`, `hiddenSpans`, source→effective mapping, decimation.
- `src/components/video-editor/featureFlags.ts` — flag `true`.
- `docs/editor-gradient-blur.md` — blur section updated; this spec linked.

**Tests:** extended `annotationBlurParity.test.ts`; `BlurSettingsPanel`
jsdom test for button states, progress and cancel; `Item` test for ticks and
hidden spans; time-mapping test for marks. **Harness:** §4.3 phase-2 check
including a zoomed export. **e2e:** `e2e/blur-tracking.spec.ts` (§4.4).

**i18n keys** (`settings.json` → `annotation.*`; `timeline.json`; `editor.json`),
in `en`, `zh-CN`, `vi`:

- `settings.annotation.trackContent`, `trackContentHint`, `removeTracking`,
  `trackingProgress` (`{{done}}`, `{{total}}`), `trackingCancel`,
  `trackingRefusedLowDetail`, `trackingRefusedOutsideSpan`,
  `trackingDecodeFallback` (seek path was used).
- `timeline.blurHiddenSpan`, `timeline.blurKeyframes` (`{{count}}`).
- `editor.blurTracked` (`{{tracked}}`, `{{hidden}}`),
  `editor.blurTrackedMostlyHidden`, `editor.blurTrackingFailed`.

**Risks:** per-frame React re-render of the overlay during playback (already
happens for `previewFrameVersion`; verify no extra `getImageData` per render);
the paused-preview camera vs. export camera confusing the manual check (the
blur is on the content in both; document it in the harness steps); ticks
cluttering the item on dense tracks (decimation).

### Phase 3 — corrections, find elsewhere, polish

**Files**

- `AnnotationOverlay.tsx`, `VideoEditor.tsx` — drag/resize on a tracked
  region → `stageRectToSourceRect` → `mergeUserPin`; "Re-track from here" row;
  dashed "Hidden here" outline when selected in a hidden span.
- `src/lib/blurTracking/trackBlurRegion.ts` — `retrackBetweenPins`.
- `src/lib/blurTracking/findElsewhere.ts` — coarse sweep, span grouping,
  per-span tracking; `BlurSettingsPanel.tsx` results list with Add / Add all.
- `KeyframeMarkers`-style tick selection on the blur item (optional; only if
  the preview gesture proves insufficient in the harness check).
- `docs/specs/tracked-blur-regions.md` — status updated to shipped; known
  limitations section.

**Tests:** orchestrator tests with a fake frame source for pin boundaries and
re-track windows; `findElsewhere` on the synthetic page (two appearances, one
lookalike that must not be proposed); jsdom tests for the results list.
**Harness:** correct a drift by dragging at 3 s, re-track, confirm the pin
holds; run find elsewhere on the fixture. **e2e:** extend
`blur-tracking.spec.ts` with one drag correction and a re-track.

**i18n keys:** `settings.annotation.retrackFromHere`, `positionChangedAt`
(`{{time}}`), `hiddenHere`, `findElsewhere`, `findElsewhereHint`,
`findElsewhereResults` (`{{count}}`), `findElsewhereAdd`, `findElsewhereAddAll`,
`findElsewhereNone`.

**Risks:** find-elsewhere false positives on repeated UI (the same button on
every page) — proposals are shown, never auto-added, and the copy says
"looks the same"; the drag gesture at a frame where the camera is mid-spring
in a playing preview (only allow the gesture when paused, as the selection
already effectively requires).
