# Batch note — W5 R5-NOTES (A-12): Notes teleprompter mode

Four commits on the batch branch, in order: pure timing library, preference block, window +
toolbar + i18n, docs. Scope stayed inside `src/components/launch/Notes*`,
`src/lib/notesTeleprompter.ts`, the `notesTeleprompter` block of `src/lib/userPreferences.ts`,
`launch.json` (en / zh-CN / vi) and this note. No new dependencies.

## What changed

- **`src/lib/notesTeleprompter.ts`** (new, side-effect free): bounds and defaults (speed 10–150
  px/s in steps of 5, default 40; font 14–48 px in steps of 2, default 16),
  `normalizeNotesTeleprompterSettings` (clamps, drops unknown fields), frame math
  (`getTeleprompterFrame` caps a frame at 100 ms so a throttled window does not jump,
  `getNextTeleprompterScrollTop`, `resolveTeleprompterPosition` keeps a fractional position so
  the slowest speed still moves when the engine rounds `scrollTop`), `isAtTeleprompterEnd`
  (never "at the end" when the note fits the window, so playback stays armed),
  `scaleScrollTop` (relative reading position across a re-flow), and the playback step:
  `createTeleprompterRunState` / `stepTeleprompter` / `holdTeleprompter`. A drift of more than
  1 px between the tracked and the actual offset is treated as a manual scroll: the tracked
  position adopts the DOM offset and auto-scroll waits 2 s (`TELEPROMPTER_MANUAL_SCROLL_HOLD_MS`)
  before resuming from there; further scrolling extends the wait. `shouldSpaceTogglePlayback`
  decides when Space may toggle playback (not inside the editor, not on a button / input /
  link, not on key repeat). 23 tests.
- **`src/lib/userPreferences.ts`**: `notesTeleprompter: { speed, fontSize }` (validated through
  the library on load; unknown or malformed values fall back per field). 1 test.
- **`NotesToolbar.tsx`**: a "Teleprompter mode" toggle after the formatting groups. While on,
  formatting buttons are disabled and a second row appears: play/pause (label changes with the
  state, no `aria-pressed`, described by the Space hint), restart from top, a native range
  slider for the speed with a live readout (`<output>`, also the slider's accessible
  description), font size −/+ with readout, and a mirror toggle. Readouts go through
  `Intl.NumberFormat(locale)` and `launch.notesTeleprompter.speedReadout` /
  `fontSizeReadout`. 5 tests through the real `I18nProvider` (en + vi).
- **`NotesWindow.tsx`**: mode / playing / mirrored are session state; speed and font size come
  from user preferences and are written back only after the user changes them (identity check
  against the loaded object, StrictMode-safe). The editor is created with
  `editable: !teleprompterEnabled` and `setEditable(…, false)` follows the toggle. Playback is
  a `requestAnimationFrame` loop driving `stepTeleprompter` on `editor.view.dom`; the speed is
  read through a ref so dragging the slider does not restart the loop. Wheel and touch input
  on the note call `holdTeleprompter`; scrollbar drags and keyboard scrolling are caught by
  the drift check. Reaching the bottom stops playback; pressing play at the bottom replays
  from the top. The font size is applied only while the mode is on; toggling the mode or
  stepping the size captures the relative scroll position first and restores it after the
  re-flow, so switching off lands on the same passage. Space toggles playback while the mode
  is on and the focus is outside the note and the controls. Mirror flips the scroll container
  (`data-mirrored`) and only applies in teleprompter mode. 12 window tests (stubbed RAF, fake
  editor with a scroll element).
- **`NotesWindow.css`**: `.notes-content[data-teleprompter='true'] .tiptap` hides the caret;
  `.notes-content[data-mirrored='true']` is `scaleX(-1)`.
- i18n (en / zh-CN / vi): `launch.tooltips.notesToolbar.{teleprompter, play, pause, restart,
  speed, fontSize, decreaseFontSize, increaseFontSize, mirror}` and
  `launch.notesTeleprompter.{speedReadout, fontSizeReadout, spaceHint}` (15 keys).

## Decisions

- Speed is in px/s, not lines/s: the note mixes headings, lists and code blocks, so a "line" has
  no stable height; the readout is localised and the range is wide enough (10–150) for reading
  paces from slow rehearsal to fast recap.
- Mirror is session-only (the preference block is exactly `{ speed, fontSize }` as specified).
- The note's default 16 px is untouched while the mode is off, so the editing view never
  changes size behind the user's back.

## Gate (batch branch)

lint 0 errors / 116 warnings (unchanged); `tsc` + `typecheck:test` clean; i18n 647 en keys,
zh-CN and vi in parity; `biome format .` clean; vitest counts in PROGRESS.md.

## Not verified here

No display on the lead box, so nothing ran in a live Electron. The unit tests stub
`requestAnimationFrame`, `performance.now` and the editor's DOM (no layout).

## Manual smoke (any platform where the Notes window opens)

1. Open Notes, paste a long note (several screens). Click the teleprompter toggle: the
   formatting buttons grey out, the second row appears, the caret disappears, typing does
   nothing. Toggle off: editing works again and the note is still at the same passage.
2. Play: text scrolls smoothly at 40 px/s; drag the slider to 10 and to 150 — no stutter, no
   restart; the readout follows the locale (vi shows `px/giây`).
3. Scroll with the wheel while playing: the scroll stops fighting you, waits about two seconds
   after the last wheel tick, then continues from where you left it. Same with a scrollbar
   drag.
4. Let it reach the bottom: the play button returns to "Start auto-scroll". Press play again:
   it restarts from the top. Restart from top works while playing and while paused.
5. Font size −/+: the text re-flows and the passage in view stays in view; the readout shows
   the size; the buttons disable at 14 and 48. Quit and reopen Notes: speed and font size are
   remembered, the mode starts off and paused.
6. Space: with the focus on the window body (click the white margin) Space toggles play/pause;
   with the focus in the note or on a toolbar button it does not.
7. Mirror: the note flips horizontally; the toolbar does not; toggling the mode off restores
   the normal view.
