# Pending release notes

Draft entries for the next release. Bug entries state what a user would have seen.

## Regressions caught before release

The Electron 39 to 41 upgrade on this branch changed how the renderer treats media served over
the `local-media://` scheme: what used to load as ordinary media became cross-origin data the
renderer refuses to touch. **Users of the released version were never affected.** This was found
and repaired here, and is recorded because it must not silently return.

Isolated by a controlled comparison on Linux: unmodified `main` at `4cab381` with Electron
39.2.7 renders the preview and reads frames from it successfully; installing Electron 41.10.7
into that same untouched tree flips every symptom below, with no source change.

Three separate failures, three separate elements, all repaired by requesting the media in CORS
mode and serving the scheme with the matching headers:

- **Every export failed.** The default path threw when the video was uploaded into the WebGL
  texture: `Failed to execute 'texImage2D' on 'WebGL2RenderingContext': The video element
  contains cross-origin data, and may not be loaded.` The optional single-pass path did not
  rescue it; its fetch was blocked outright (`Cross origin requests are only supported for
  protocol schemes: chrome, chrome-extension, ...`) and it fell back into the same failure.
- **The editor preview was blank**, with a toast reading "Something went wrong. Please try
  again." No export needed; opening a recording was enough.
- **Analyze Video Cursor failed to load its source** with `MEDIA_ELEMENT_ERROR: Format error`.
  That element already requested CORS mode, so it failed outright rather than tainting.

Verified after the fix: preview renders with no errors, MP4 export 152457 bytes, GIF export
433033 bytes.

## Fixed

### GIF export could hang forever on the first frame

This one is a genuine long-standing bug, independent of the Electron upgrade.

The first-frame wait asked for the next presented video frame only after the seek had already
completed. That callback fires only on a *new* presentation, so when the frame was already on
screen the wait never resolved. Progress sat in the preparing phase, no error appeared, and only
Cancel responded, so the app looked hung rather than failed. GIF only; MP4 already bounded the
same wait. Reproduced on every run under software rendering; on a GPU it is a race and would
appear intermittently. In practice the tainted-media failure above masked it, because that one
failed first on a real recording.

### The crop overlay never appeared

The overlay measured its own size to decide what to draw, but returned nothing until it had a
size, so it never mounted and never got one. It could not render at all.

## Notes for the release manager

- The macOS helper is uncompiled on this branch. Build it and run the checklist in
  `docs/native-helper.md` before shipping.
- Auto-update cannot work on unsigned macOS builds; the updater detects that and falls back to
  the release page.
- Caption model downloads on first use, about 45 MB, pinned to a fixed model revision.
