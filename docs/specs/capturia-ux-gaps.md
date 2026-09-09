# Capturia UX gaps against the openscreen v1.10.0 shell

Status: audit complete, W7 ("Tier 2").
Baseline: `4596a7b5` — the tree is exactly openscreen v1.10.0 (`upstream/main`, 70e30c1f).
Reference for behaviour only: `git show feat/1.9:<path>`. No file was ported.

The governing decision for this workstream is that Capturia's Tier 2 surfaces are
**dropped as code and kept as requirements**. This document is that requirement set.
Every claim below was checked against upstream sources; `technical-documentation/` was
not consulted, and neither was any summary of it.

The headline result is that **four of the six surfaces already exist upstream**, three of
them in a strictly better form than Capturia's. Only two gaps are real, and one of those
is a single boolean.

---

## Summary

| Surface | Verdict | Action |
|---|---|---|
| `SubtitleStylePanel` | Superseded — upstream's model and pane are richer | **Drop** |
| `PreviewAspectCropOverlay` | Superseded — upstream's crop has 7 ratio presets with lock | **Drop** |
| `SubtitleCueEditor` | Mostly superseded; per-cue split/merge is not representable | **Drop the panel**, defer the residual |
| `GifOptionsPanel` | 3 of 4 native parameters already exposed; `dither` is not | **Close the one gap** |
| `TutorialHelp` | Genuinely absent — but its 20 strings ship in all 13 locales | **Build** |
| Multi-track audio | Real, and not where the brief assumed | **Specify only** |

---

## 1. `SubtitleStylePanel` — DROP, fully superseded

**What it did in Capturia.** `src/components/video-editor/SubtitleStylePanel.tsx` (209 lines)
wrote the eight fields of `SubtitleStyle` (`src/lib/rendering/subtitleStyle.ts`): `fontScale`,
`anchor` (top/center/bottom), `marginRatio`, `textColor`, `backgroundEnabled`,
`backgroundOpacity`, `highlightCurrentWord`, `highlightColor`.

**What upstream has.** `src/lib/ai-edition/captions/settings.ts` defines `CaptionSettings`
with 18 fields, and `src/components/ai-edition/CaptionsPane.tsx` (678 lines) renders a
control for essentially all of them: font family, bold, `fontSize`, `color`, background
enable + `backgroundColor` + `backgroundOpacity`, `anchorV` + `insetY`, `anchorH` +
`insetX`, `minWordsPerLine` / `maxWordsPerLine`, display language with a translation
layer, and caption lane selection.

**Is the gap real? No.** The mapping is total in one direction:

| Capturia field | Upstream equivalent |
|---|---|
| `fontScale` | `fontSize` (px at a 1080-high frame, resolution-free via `annotationScale.ts`) |
| `anchor` + `marginRatio` | `anchorV` + `insetY` — and upstream *deliberately removed* `center`, documenting it in `settings.ts` as "the old pathology given a name" |
| `textColor` | `color` |
| `backgroundEnabled` / `backgroundOpacity` | same names |
| — | `anchorH` / `insetX`, `fontFamily`, `fontWeight`, `backgroundColor`, word-count bounds, `language`, `captionLane` — all new |

The only Capturia field with no upstream counterpart is the karaoke-style
`highlightCurrentWord` / `highlightColor`. Grepping `highlight|karaoke` across
`src/lib/ai-edition/`, `src/components/ai-edition/` and `crates/compositor/src/` returns
only transcript-pane cursor highlighting and `RecStage`'s cursor-highlight capture mode —
nothing caption-related, in the renderer or the compositor.

**Cheapest way to close it.** Do not. Per-word caption tinting is a *compositor* feature,
not a panel feature: it needs per-word spans to survive into `text_plate.rs` and the three
platform rasterizers, which is far outside a UX-gap workstream. Adding a toggle with no
renderer behind it would be a lie in the UI. If it is ever wanted, it is a compositor
ticket, not this one.

Upstream also solved a problem Capturia's panel had: `settings.ts` documents why a `width`
slider was removed (it only changed wrap behaviour, invisibly) and why insets are unsigned
distances from a named edge rather than signed offsets. Porting our panel would have
reintroduced both.

---

## 2. `PreviewAspectCropOverlay` — DROP, fully superseded

**What it did in Capturia.** `src/components/video-editor/PreviewAspectCropOverlay.tsx`
(317 lines) over `src/lib/crop/aspectCrop.ts` (259 lines): a drag/resize rectangle on the
preview with eight handles, an aspect lock (`CropAspectPreset = 'free' | AspectRatio`), and
a document-wide crop region.

**What upstream has.** `EditClipModal` in `src/components/ai-edition/Modals.tsx`
(from line 683) plus `src/components/ai-edition/cropDraft.ts`. It renders a paused still of
the clip in an aspect-correct preview box (`previewBoxStyle`), a draggable/resizable crop
rectangle with edge handles, four numeric percent fields stepping one *source pixel* at a
time (`stepPct`), and a ratio segmented control:

```
CROP_RATIOS = free, 16:9, 9:16, 1:1, 4:3, 3:4, 21:9   (Modals.tsx:556)
```

Picking a preset snaps to `centeredFitPct` and then *locks* the ratio through
`lockedFractionRatio` for every subsequent drag and numeric edit; `detectRatio` reads the
active preset back out of a stored region within 2%. Crucially it converts between the
preset's *visual* ratio and the region's *fraction* space through the source's real pixel
aspect ratio, which Capturia's version did not do.

**Is the gap real? No — upstream's is better on three axes.** More presets (7 vs ours),
pixel-precision numeric entry, and per-clip rather than document-wide crop
(`clipSchema.cropRegion`, composed with trim in `useTimeline`'s `applyClipEdit`).

**Cheapest way to close it.** Nothing to close. If anyone later wants crop handles on the
*live* preview rather than in the modal, note that this touches the preview overlay stack
that `w4-tracked-blur` owns; it must be coordinated with that workstream, not built here.

---

## 3. `SubtitleCueEditor` — DROP the panel, defer the residual

**What it did in Capturia.** `src/components/video-editor/SubtitleCueEditor.tsx`
(173 lines): pick a cue from a `<select>`, edit its text in a textarea committed on
blur/Enter, and split / merge-next / merge-previous / delete it. Timings were displayed,
not editable.

**What upstream has.** Two things, and the split between them is the whole answer.

*Text.* `src/lib/ai-edition/document/transcript.ts` exposes `setWordText`,
`setDocumentWordText`, `insertDocumentWord`, `removeDocumentWords`, and `carryOverWordEdits`.
`TranscriptPane` (`src/components/ai-edition/RightPanes.tsx:839`, mounted by
`FloatingInspector.tsx:1072`) drives all of them — there are colocated tests for word edit,
word insert, keyboard cut, lanes, and captions. So caption text **is** editable today, at a
finer grain than a cue.

*Cue boundaries.* `src/lib/ai-edition/captions/cues.ts` opens with "Caption cues, derived
from the transcript." `deriveCaptionCues` groups the transcript's word stream into cues
bounded by `minWordsPerLine` / `maxWordsPerLine`, both of which `CaptionsPane` exposes as
controls.

**Is the gap real? Partly, and not in the way our panel assumed.** Per-cue *timing* editing
is not merely missing — it is **not representable**. A cue has no independent existence in
the document; it is a pure function of the transcript's word timings and two integer
settings. Our panel showed timings read-only for exactly this reason, so nothing is lost.
Per-cue *text* editing is present and better. What is genuinely absent is a per-cue
**split/merge override**: upstream offers only the global word-count knobs.

**Cheapest way to close it — and why we are not.** It would need a new per-document list of
cue-boundary overrides in the `legacyEditor` passthrough blob, a change to
`deriveCaptionCues` to honour it, boundary re-anchoring when the transcript is edited (the
same problem `carryOverWordEdits` solves for words), and a decision about how overrides
survive a re-transcription. That is a document-model change, not a UI one, and its output
feeds the SRT/VTT sidecar writer that `w6-subs-fonts` owns. **Deferred as a follow-up with
`w6-subs-fonts` as a prerequisite.** The global word-count controls cover the common case
(cues too long / too short); manual per-cue splitting is an editorial nicety.

---

## 4. `GifOptionsPanel` — one real parameter missing

**What it did in Capturia.** `src/components/video-editor/GifOptionsPanel.tsx` (115 lines):
frame rate select, size-preset select with a computed output dimension readout, and a loop
switch. It drove a renderer-side `gifExporter.ts` that no longer exists.

**What the native encoder actually accepts.** `crates/compositor/src/gif_export.rs`:

```rust
pub struct GifExportParams {
    pub width: Option<u32>,       // default DEFAULT_GIF_WIDTH  = 854
    pub height: Option<u32>,      // default DEFAULT_GIF_HEIGHT = 480
    pub fps: Option<u32>,         // default DEFAULT_GIF_FPS    = 12
    pub loop_count: Option<u16>,  // None or 0 -> infinite
    pub dither: bool,             // Floyd-Steinberg, default off
}
```

That is the complete list. Everything else is fixed by the encoder and must **not** be
offered as a control: `PALETTE_COLORS = 256`, `PALETTE_REQUANTIZE_EVERY = 30` frames,
median-cut quantization, and GIF's LZW variant. There is no quality/compression scalar to
expose.

The parameter survives the whole boundary: `crates/compositor-view-napi/src/lib.rs:530`
(`pub dither: Option<bool>`) → `:668` (`dither: p.dither.unwrap_or(false)`) →
`src/native/contracts.ts:208` (`dither?: boolean`) → `exportGifNative`
(`src/native/compositorViewClient.ts:171`).

**What upstream's UI already does.** `src/components/ai-edition/ExportDialog.tsx` renders,
in its GIF branch (lines ~544-618): a 4-way frame-rate segmented control
(`GIF_FRAME_RATES` = 15/20/25/30), a 3-way size preset (`GIF_SIZE_PRESETS` capping the long
edge at 720 / 1080 / original), a loop toggle, and a summary line. It calls
`exportGifNative` at line 326 with `{...gifOutputDims(gifSize, outDims), fps, loopCount}`.

**Is the gap real? Only for `dither`.** Three of the four user-facing native parameters are
already wired. `dither` is honoured by the encoder, typed all the way to TypeScript, and
reachable from no control in the product.

**Cheapest way to close it.** One toggle in the existing GIF options block, mirroring the
adjacent loop toggle, plus `dither` in the `exportGifNative` call. **Done — see
"Implemented" below.**

*Noted, not fixed:* `GIF_SIZE_PRESETS[...].label` and `GIF_FRAME_RATES[...].label` in
`src/lib/exporter/types.ts` are hardcoded English ("Medium (720p)", "15 FPS - Balanced")
while the rest of the dialog is translated. The dialog dodges half of it by rendering
`{r.value} FPS` instead of the label, but `gifSizeLabel` reaches the summary line
untranslated. Small, real, and a separate change — it touches `ExportDialog.tsx`, which is
already a merge-contention point this cycle.

---

## 5. `TutorialHelp` — the only genuinely missing component

**What it did in Capturia.** `src/components/video-editor/TutorialHelp.tsx` (129 lines): a
help button opening a dialog that explains the trim tool's inverted semantics — a trim
region marks what gets **removed**, not what gets kept — with a diagram of a timeline
showing red REMOVED spans and the kept parts they leave behind, then two numbered steps.

**What upstream has.** The strings. All twenty of them, in all thirteen locales, plus a
test asserting they are present:

- `src/i18n/locales/<locale>/dialogs.json` → `tutorial.*` (20 keys, 13 locales)
- `src/i18n/__tests__/tutorialHelpTranslations.test.ts` — asserts every key in every locale

and **no consumer**. `grep -rn "tutorial\." src/ --include=*.tsx --include=*.ts` outside
`src/i18n/` returns nothing. The test currently passes vacuously: it guards translations for
a component that does not exist. Upstream shipped the strings and the test but not the UI.

**Is the gap real? Yes — and, unusually, the brief's scepticism was misplaced.** The task
flagged this one as possibly speculative and asked for the user problem to be named. It can
be named precisely, and upstream's own model still has it:

> In every mainstream NLE the selection is what you **keep**. In this editor a trim range
> is what you **lose**. The timeline communicates that with colour and lane position only —
> `V4Timeline.tsx:719` labels a trim pill with its duration (`formatSec`), nothing more.

The semantics are unchanged since Capturia: `tl.trimRanges`, `coalescedTrimGroups`,
`ventilateTimelineSpanToTrims`, `removeRegion`, `addTrim` bound to `t`
(`src/lib/shortcuts.ts:114`). So the explanation upstream already translated is still
*correct* — it describes the shipping product.

That leaves a binary choice, because the current state is a defect either way: build the
component, or delete twenty keys across thirteen files and the test that guards them.
Building is cheaper than it looks (the expensive part of a 13-locale feature is the
translation, and that is done) and it closes a real inversion trap.

**Cheapest way to close it.** A self-contained component using the shell's own `ModalShell`,
opened from one row in the existing app menu — which is where "Keyboard shortcuts" and
"About" already live. **Done — see "Implemented" below.**

One deviation from Capturia's version: the step-1 key must be read from the live shortcut
binding via `useShortcuts()` + `formatBinding`, not hardcoded to `T`, because
`ShortcutsConfigDialog` lets the user rebind `addTrim`. Capturia had no rebinding, so its
hardcoded key was correct then and would be wrong now.

---

## 6. Multi-track audio — requirement only, and the brief's premise is wrong

**What Capturia did.** Kept the microphone and system audio as separate tracks through the
whole pipeline, so they stayed independently adjustable after the recording.

**What upstream actually does — the correction.** The brief states that "upstream sidesteps
this by mixing at capture time." That is **not** what the sources say, and getting it wrong
would send the fix to the wrong file.

Capture already keeps them separate. `src/hooks/useScreenRecorder.ts` passes
`systemAudio: { enabled }` and `microphone: { ... }` to the native recorder as independent
config (around line 1174), and `crates/compositor/src/audio.rs` documents the result:

> *TOUTES les pistes audio sont décodées puis mixées. L'enregistreur natif macOS écrit
> l'audio système et le micro en deux pistes AAC distinctes, toutes deux marquées
> `default`* — `audio.rs:229-234`

The mix happens later, at **decode time for playback and export**:

- `decode_clip_audio` (`crates/compositor/src/audio.rs:235`) enumerates *every* audio stream
  in the container and builds one `AudioTrackDecoder` per stream. This is deliberate: it
  fixed issue #108, where `av_find_best_stream` returned only the first (often silent)
  track and the microphone vanished from exports.
- `mix_aligned_tracks` (`crates/compositor/src/audio.rs:423`) crops every track to the same
  window and **sums them, sample for sample**, with no gain, no mute, and no per-track
  identity. Its only per-track parameter is `origin_sec`, used to absorb start offsets.
  It clips to ±1.0 when more than one track is present.

**Where the gap actually is.** Not at capture, and *emphatically* not in a renderer-side
mixer — a JS mixer would have to demux the container itself and would diverge from the
compositor, which is the only thing that renders the export. The gap is that
`mix_aligned_tracks` has no per-source-stream gain and nothing upstream of it can name a
stream to address.

**The requirement, stated for whoever picks it up.**

1. `mix_aligned_tracks` (`crates/compositor/src/audio.rs:423`) takes a per-track gain
   alongside `origin_sec`, defaulting to 1.0 so single-track and untouched multi-track
   recordings are bit-identical to today. It is already separated from decoding "pour être
   testable sans ffmpeg", so this is directly unit-testable in Rust with no ffmpeg fixture.
2. `decode_clip_audio` (`:235`) accepts that gain vector and keeps a stable identity for
   each stream — the container's stream index is the only stable handle, since both tracks
   are marked `default` and neither carries a distinguishing title.
3. The scene description carries per-stream gain/mute for a clip's source, so
   `buildSceneDescription` emits it and the headless CLI exporter honours it identically to
   the app.
4. Only then a UI: per-source-track gain and mute, alongside the existing per-audio-track
   gain the document model already has for *added* audio layers
   (`src/lib/ai-edition/document/audioTracks.ts`, `AddAudioLayerDialog.tsx`).

**Not attempted here**, per the brief. Steps 1-3 are Rust and scene-schema work; step 4 is
the only part that is a UX surface, and it is worthless without them.

---

## Implemented in this workstream

- **GIF dithering** — `ExportDialog.tsx` gains one toggle in the existing GIF options block
  and passes `dither` to `exportGifNative`; `exportDialog.ditherGif` / `ditherGifHint` added
  to all 13 locales (`localeParity.test.ts` enforces this).
- **TutorialHelp** — `src/components/ai-edition/v4/TutorialHelp.tsx`, a `ModalShell` dialog
  reading the existing `dialogs.tutorial.*` keys and the live `addTrim` binding, opened from
  one row in `EditorTopBar`'s app menu. No new strings.

## Deferred

- **Per-cue split/merge** for captions — needs a document-model override list and
  `w6-subs-fonts`'s sidecar writer to land first (section 3).
- **Multi-track audio** — Rust-side, specified in section 6, not started.
- **Karaoke word highlight** — compositor feature, not a panel (section 1).
- **i18n of the GIF preset labels** in `src/lib/exporter/types.ts` (section 4).

## Recommended cut outright

- `SubtitleStylePanel`, `PreviewAspectCropOverlay`, `SubtitleCueEditor` as components.
  Upstream's equivalents are present and, in the first two cases, better. Nothing to port.
