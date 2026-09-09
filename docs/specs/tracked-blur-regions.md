# Tracked blur regions

**Status:** the tracker, the keyframed model and the render path exist; the
authoring UI does not (see §3). The rectangles a track produces reach both the
live preview and the MP4 export through the one scene description, so there is
no second path that can disagree with the first.

## Why

A blur region is a rectangle over a time span. Users of screen recorders
routinely complain that a mask does not follow the content when the page
scrolls or a window moves: the email they blurred in a table is unblurred one
scroll later. An OCR-based automatic scan was measured and rejected; this
design does not read text. It follows the *pixels the user pointed at*, which
is a much easier problem and needs no model download.

### What the compositor already does, and the one thing that is ours

The native compositor draws blur regions itself, on all three GPU backends
(`crates/compositor/src/compositor_{windows,macos,linux}.rs`). It has both
styles (`blur`, `mosaic`), all three shapes (`rectangle`, `oval`, `freehand`)
and both shade colours, from `SceneAnnotationBlur` in
`crates/compositor/src/scene.rs`. None of that is ours to build and none of it
is duplicated here.

What is ours is **motion**: a `SceneAnnotation` carries one FIXED `x/y/w/h`
for its `[startSec, endSec)` span, and a tracked region needs a box that moves.
The whole of this document is about producing that box and getting it into a
schema that has no keyframe field — see §2.5, which is the design decision the
implementation rests on.

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
frame used at `t_k` is the decoded frame nearest to `t_k` (the handoff is the
midpoint between consecutive decoded frames).
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
  onto a *different* row of similar text is the worst failure mode (§4), and a
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
(theme switch, selection highlight that stays) shows up as LOST, and a user
correction pins a new template from that frame.

### 1.11 Frame sources

The tracker never touches playback. It reads its own decoded frames, and it
needs two things from whatever provides them — neither of which is built yet
(§3), so this section states the contract rather than an implementation:

- **A dense path**, able to deliver *every* frame in a range, because
  densification (§1.8) is what keeps a fast scroll from leaking. Frames arrive
  as gray buffers with their source timestamp; the tracker owns nothing else.
- **A sparse fallback**, able to deliver only the grid instants. No
  densification is possible there, and the union rule (§2.4) is what covers the
  intervals it cannot see.

**Backward span** (`startMs -> anchorMs`): decoding is forward-only, so the
span is processed in chunks of N grid intervals, each decoded forward, its
analysed frames kept, and the state machine run over them in reverse.
`planBackwardChunks` in `trackPlan.ts` is that split, and it is written so that
decisions depend only on the sample sequence and never on where a chunk
boundary fell — the results are identical to an idealised reverse pass.

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
benchmark that logs ms per sample. Decoding runs concurrently and is bounded by the codec:
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

The track lives on the annotation in `AxcutDocument`, defined once as zod in
`src/lib/ai-edition/schema/index.ts` and consumed everywhere as the inferred
`AxcutBlurTrack` / `AxcutBlurTrackKeyframe`:

```ts
blurTrackKeyframe = {
  timeMs: number            // the CLIP's source time, the same base as sourceStartSec
  x, y, w, h: number        // source-normalised: 0..1 of the FULL source frame
  lost?: true               // not visible from here to the next non-lost keyframe
  gap?: true                // the interval from here on was never seen at frame rate
  origin?: "user"           // a pin; the tracker never moves it
}

blurTrack = {
  version: 1
  space: "source"           // present so a future stage-space track cannot be confused with this
  keyframes: [...]          // sorted by timeMs, unique timeMs, at least one
  sourceSize: { width, height }
  sampleIntervalMs: number  // the grid the tracker used — and the emission grid, see §2.5
  anchorMs: number
  quality?: { meanScore, lostMs, trackedMs }   // settings panel only
}
```

`blurData` (shape, colour, block size, intensity) is unchanged: it describes
the look, `blurTrack` describes where.

Rectangles are **source-normalised** — fractions of the full source frame,
before any crop, zoom camera or output aspect — because that is what the
tracker measures against the decoded pixels. This is a DIFFERENT box from the
region's own `position`/`size`, which are percentages of the screen rect;
`sceneSteps.ts` converts (§2.6).

### 2.2 Source of truth and cache

- **Keyframes are the truth.** They are what the document persists and what the
  scene is built from; nothing re-tracks on load. The anchor template pixels are
  *not* persisted; re-tracking re-samples them from the anchor keyframe's frame.
- **Nothing else is cached on disk.** Reading the rect at `t` is a binary search
  over the keyframe array plus a lerp.
- `position`/`size` of a tracked region stay as the authored box. They are what
  a build that does not understand `blurTrack` renders — a static box, degraded
  but not broken — and what this build falls back to when the track cannot be
  read at all (§2.3).

### 2.3 Schema versioning and migration

No version bump, no migration. `blurTrack` is an optional field on
`annotationRegionSchema`, which is the project's stated convention for an
additive one (see `assetVideoSchema.width/height` and
`asset.transcriptionFailure`, both carrying the same note): an older build
simply drops the key on save, and the region falls back to the static box it
already has. A document written before tracking existed is untouched.

Validation happens twice on purpose. `documentSchema.parse` rejects a
structurally wrong track at load; `normalizeBlurTrack`
(`annotations/blurTracking/keyframes.ts`) is a second, softer gate at read
time — wrong `space`, empty keyframes, non-finite numbers, zero-area rects all
yield `undefined`, which every caller reads as "untracked". A hand-edited
document therefore degrades to a static blur instead of failing to open.

### 2.4 Rect at time `t`

```ts
// src/lib/ai-edition/annotations/blurTracking/keyframes.ts
resolveTrackedBlurRect(track, timeMs): { rect: NormRect; opacity: number } | null
```

- `t` before the first keyframe → the first keyframe's rect; after the last →
  the last.
- Find `k_i <= t < k_{i+1}`.
  - `k_i.lost` → last known rect, `opacity = max(0, 1 - (t - k_i.timeMs) / 100)`.
  - `k_{i+1}.lost` → hold `k_i`'s rect at full opacity until the lost instant.
  - else lerp between the two.
  - **union safety:** across an interval the tracker never saw at frame rate
    (`k_i.gap`) that is longer than 40 ms and moves more than 6 source px, the
    answer is the union of the two rects rather than the lerp. A long gap alone
    is not enough: simplification leaves those behind precisely because it
    verified a straight line reproduces every sample it dropped.
- opacity 0 → `null`, nothing is drawn.

### 2.5 Motion in a fixed-rect schema: a run of short annotations

`SceneAnnotation` has one rect and no keyframe array, but it carries **its own
time span**. So a region that moves is expressible with no schema change, no
Rust and no shader work: emit a SEQUENCE of short static blur annotations, one
per step of the track, into the scene JSON.
`annotations/blurTracking/sceneSteps.ts` does exactly that, upstream of
`projectRegionsToSource`, so the fragments inherit trim clipping, clip
splitting and `clipIndex` from the existing projection like any other
annotation.

Three properties make this correct rather than merely cheap, each verified
against the compositor source rather than assumed:

- **No seam, no gap, no double blur.** All three backends select an annotation
  with the half-open test `t >= start_sec && t < end_sec` (`compositor_windows.rs`,
  `compositor_macos.rs`, `compositor_linux.rs`, identical in each). Consecutive
  steps share an exact boundary, so at every instant exactly one of them is
  live. The boundary is exact because the steps are built in whole
  milliseconds and `projectRegionsToSource` quantises with
  `Math.round(sourceStartSec * 1000)` — the same integer for both sides.
- **The count is affordable.** The per-frame cost is one linear scan with a
  float compare, skipping everything invisible before any GPU work; the
  single blur render-target copy is taken once per frame for all blur
  annotations, and only one of a run is ever visible, so it costs exactly what
  one static blur costs. `Scene::for_clip_window` clones the annotation vector,
  but on a scene or clip change, not per frame. Measured: a 60-second tracked
  region at the tracker's 10 Hz grid is 600 annotations and about 138 KiB of
  scene JSON.
- **Paint order is stable.** Every fragment carries the region's `zIndex` and
  the scene sorts ascending with a stable sort, so the run stays contiguous and
  in emission order however long it is. Order within the run is moot anyway,
  since only one fragment is live at a time.

**The ceiling, stated plainly:** the region STEPS between fragments instead of
interpolating inside one. Two things keep that from mattering:

1. density is a parameter rather than a constant — the grid is the track's own
   `sampleIntervalMs`, and every keyframe instant is also a step boundary, so a
   stretch the tracker densified to frame rate emits at frame rate while a
   still stretch stays at 10 Hz;
2. each step covers the UNION of the rect at its two ends, so the content is
   inside the blur for the whole step at any density. The step is visible as a
   box that grows and shrinks, never as content escaping it — which is the
   failure that would matter for a redaction.

The upgrade path, if the stepping ever reads as stepping, is a native `path` /
keyframe field on `SceneAnnotation` that the three backends interpolate
per-frame. `sceneSteps.ts` becomes the thing that writes the path instead of
the run; nothing else moves.

Two smaller compromises come with it:

- `SceneAnnotation` has no alpha, so §2.4's 100 ms fade-out after a lost
  keyframe is a **hard cut**. It errs towards more blur, not less.
- A region that is tracked but never visible anywhere in its span keeps its
  authored static box, so it cannot silently vanish from a render.

### 2.6 Interaction with crop, zoom and aspect

- **Crop.** The screen rect shows the CROPPED source, so
  `sourceRectToAnnotationBox` re-normalises against `clip.cropRegion` and clips
  to the rect — a blur that has scrolled out of the crop draws nothing rather
  than painting the wallpaper beside the footage.
- **Zoom.** Annotations are deliberately NOT subject to the zoom crop: the
  overlay is a sibling of the element carrying the transform, so they hold
  still while the content zooms underneath (`SceneAnnotation.anchor_rect`).
  A tracked blur inherits that, which means it holds its screen-rect position
  under a zoom exactly like every other annotation does. Following the zoom
  camera would need the native keyframe field named above.
- **Aspect.** Source space is aspect-independent: one track serves every export
  aspect.
- **Trims and speed.** Keyframes are the clip's source time, like the region's
  own `sourceStartSec`/`sourceEndSec`. The projection clips the fragments to
  the kept segments; a fully trimmed one takes the same `underTrim` path any
  other annotation does.

### 2.7 Preview / export parity

There is nothing to keep in step. `buildSceneDescription` is the single scene
contract and it drives both the live compositor view and the MP4 export, so the
expansion runs once and both consume its output. Building a separate preview
path is the drift openscreen deleted its browser exporter to eliminate.

---

## 3. What exists and what does not

**In the tree:**

- `annotations/blurTracking/trackerCore.ts` — the tracker of §1, pure functions
  over grayscale buffers, with `trackerCore.test.ts` and the `syntheticScreen.ts`
  fixture that gives those tests ground truth.
- `annotations/blurTracking/keyframes.ts` — normalisation, the rect at `t`
  (§2.4), simplification, pin merge. The only code allowed to interpret a track.
- `annotations/blurTracking/trackPlan.ts` — the sample grid, the densification
  rule and turning analysed samples into the persisted keyframe list.
- `annotations/blurTracking/sceneSteps.ts` — §2.5, wired into
  `buildSceneDescription`.
- `blurTrack` on `annotationRegionSchema`.

**Not in the tree**, and what a tracked region therefore still needs before a
user can make one: the frame source (decode a clip's frames for the tracker to
analyse), the worker that drives `BlurTracker` over them off the main thread,
the session that owns the forward/backward passes and densification, and the
UI — drawing the anchor box, running a track with progress and cancel, showing
keyframe marks and hidden spans on the timeline, and dragging a correction pin.
`mergeUserPin` and `origin: "user"` exist so that last one needs no model
change when it lands.

---

## 4. Reverse thinking

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
3. **Complexity in the render path.** A second geometry space, and motion
   expressed as a run of annotations rather than one. Contained by keeping it
   entirely in TypeScript (§2.5): no schema change, no Rust, no shader work,
   and untracked regions take the existing path byte-for-byte.
4. **Wall time.** A five-minute span may take longer than the target on a
   software-decoding laptop. Progress with cancel and the typical short span
   make this tolerable, but it is a real cost.
5. **It is not redaction.** A tracker follows what the user pointed at; it
   does not find what they missed. The redaction spike settled that a finder
   is out of reach for now; this feature must not be marketed as one.

### What would still cancel the feature

- The similar-rows kill criterion in `trackerCore.test.ts` cannot be held: the
  right row must beat the best wrong row by a score margin of at least 0.1 on
  realistic text without dropping recall on the scroll tests below 95 %. Below
  that the core failure mode is unbounded and the feature ships wrong blurs.
- The benchmark median exceeds 15 ms/sample on the dev box after profiling
  (three times the estimate), which puts a five-minute span past a minute of
  tracker time on a laptop before decode.
- No frame source (§1.11) can deliver a dense range reliably across the codecs
  Capturia records, and the sparse fallback alone leaves fast scrolls leaking
  under the union rule on a recorded fixture.
- Determinism cannot be held: identical runs on the same machine diverge.

---
