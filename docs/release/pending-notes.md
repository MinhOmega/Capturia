# Pending release notes

Draft entries for the next release. Bug entries state what a user would have seen.

## Fixed

### Exports failed with a security error (GIF always; MP4 pending confirmation)

Recordings are served to the editor over the `local-media://` scheme, which is a different
origin from the page that loads it. The scheme did not enable CORS and the handler sent no
`Access-Control-Allow-Origin`, so the media element was CORS-tainted and pixel reads off it
failed.

- **GIF export: measured.** Export failed within a second or two. The dialog read "Export
  failed" with the reason `Failed to construct 'VideoFrame': VideoFrames can't be created from
  tainted sources`. GIF has only the seek decode path, so it failed every time. Measured on
  Linux with Electron 41.10.7.
- **MP4 export: awaiting measurement.** The seek path (the default) does not read the element
  directly; it renders the element into the compositing canvas and builds the frame from that
  canvas, so it is expected to fail one step later at the canvas read, with a different error
  string. The optional WebCodecs path is unaffected because it reads container bytes instead.
  **Do not publish the MP4 half of this entry until the error string and throw site are
  captured on a pre-fix build.**

Not platform-specific in principle, since the cause is the scheme pairing rather than the OS,
but only Linux was exercised. Development runs were affected too: the localhost page is still a
different origin from the media.

### GIF export could hang forever on the first frame

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
