# Preview at High Speed: Technical Debt Note

## Context

Capturia lets a timeline segment run up to `MAX_PLAYBACK_SPEED` (40x), but a
browser will not let a media element play that fast. Chromium throws on
`playbackRate` above 16, other engines clamp silently and some clamp lower. The
preview used to write the segment speed straight onto the element, so a 20x or
40x segment played at 16x while the timeline and the exported file ran at the
speed the user asked for. Nothing reported the mismatch: the playhead simply
lagged for the length of the segment.

## Changes Applied

1. **The cap is probed, not assumed.** `probeNativePlaybackRateCap` tries
   candidate rates from the top and reads back what the element accepted, so an
   engine that throws and an engine that clamps silently both yield the real
   ceiling. It runs once per source, next to the Pixi texture setup.
2. **Two preview modes.** At or below the probed cap the element plays natively
   and nothing about the previous behaviour changes. Above it the preview
   frame-steps: the element is muted and held at 1x while a virtual clock driven
   by the animation-frame loop owns the playhead and seeks the element toward it.
3. **The clock uses the shared segment mapping.** `planFrameStep` advances in
   effective (collapsed) time through `src/lib/trim/timeMapping.ts`, the same
   mapping the timeline and the exporter use. A tick that crosses a boundary
   spends its remaining wall time in the next segment at that segment's own
   speed, and deleted stretches are skipped rather than stepped through.
4. **The planner is DOM-free and tested.** Mode selection, the next timestamp,
   boundary and deleted-stretch crossings, the hand-back to native playback and
   the end of the kept timeline are unit-tested with no media element involved.
   `videoPlayback/frameStepPreview.ts` holds the policy; the handler set only
   does the element work.
5. **The element work is defensive.** One seek is in flight at a time and is
   released on `seeked` or after a timeout, so a decoder that stalls past its
   buffered end cannot freeze the playhead. A tick is capped so a tab that was
   hidden does not leap across the timeline on return. Seeks the module issues
   are told apart from a user scrub, so stepping does not flip the preview into
   scrub mode on every frame. The pause that ends a stepped run at the end of the
   media is not mistaken for the spurious native pause the retry path exists for.
6. **The state is exposed, not yet surfaced.** `VideoPlaybackRef` carries
   `isFrameStepping`, `frameSteppingHintKey` and `nativePlaybackRateCap`, and
   `settings.speedPreviewFrameSteppingHint` exists in en / zh-CN / vi.

Export is unaffected throughout: it renders frames by seeking or decoding and
never sets `playbackRate`.

## Remaining Debt

1. **No UI consumes the hint yet.** The speed control still shows nothing when a
   segment previews stepped and muted. The ref field and the string are in place;
   wiring them into the settings panel is owned elsewhere.
2. **The stepped preview is silent by design.** Audio at 20x-40x is not
   meaningful, and the element is muted because it is being seeked rather than
   played. The export path time-stretches audio properly, so this is a preview
   limitation only, but a user who does not read the hint may read it as a bug.
3. **Smoothness is decoder-bound.** Each animation frame asks for a seek roughly
   0.3-0.7 s further into the source, which on a long-GOP source means a keyframe
   seek and a decode. When that cannot keep up, the throttle skips a frame rather
   than queueing, so the preview goes choppy instead of falling behind. It is
   honest about position but not smooth. A `requestVideoFrameCallback`-driven
   variant, or decoding through WebCodecs the way the exporter now can, would
   present more frames per second at these speeds.
4. **The element is left in the playing state while stepping.** It is muted and
   pinned to 1x rather than paused, so `video.paused` stays a truthful signal for
   the play/pause state machine and the spurious-pause retry path. The cost is
   that between two stepping seeks the element advances a few milliseconds on its
   own. At these speeds that is well under one stepped frame, but it does mean
   the element is not perfectly quiescent.
5. **The probe writes to the element.** It sets and restores `playbackRate`
   during texture setup, while the video is paused. It is ordered before the
   handler set is wired so nothing observes the intermediate values, but it is a
   side effect on a shared element and a future reorder could expose it.

## Follow-up Plan

1. Show the hint next to the speed control when the ref reports stepping, with
   the probed cap interpolated into `{{native}}`.
2. Measure how many frames the stepped preview actually presents on a long-GOP
   source, and decide whether a WebCodecs-backed preview decoder is worth the
   complexity for the 20x-40x range.
3. Confirm the probe's candidate ladder against non-Chromium engines once
   Capturia runs anywhere other than Electron; the current ladder assumes a cap
   at or below 16.
