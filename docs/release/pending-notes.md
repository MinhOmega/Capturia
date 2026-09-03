# Pending release notes

Draft entries for the next release. Bug entries state what a user would have seen.

## Fixed

### Every export failed with a cross-origin error

Recordings are served to the editor over the `local-media://` scheme, which is a different origin
from the page that loads it. The scheme did not enable CORS and the handler sent no
`Access-Control-Allow-Origin`, so the media was cross-origin data that the renderer refused to
touch. **Both decode paths failed, on default settings**, measured on Linux with Electron
41.10.7:

- The default path failed when the tainted video was uploaded into the preview's WebGL texture:
  `Failed to execute 'texImage2D' on 'WebGL2RenderingContext': The video element contains
  cross-origin data, and may not be loaded.` It never reached the frame or canvas read.
- The optional single-pass path did not rescue it. Its fetch was blocked outright with
  `Cross origin requests are only supported for protocol schemes: chrome, chrome-extension,
  chrome-untrusted, data, http, https`, after which it fell back to the default path and hit the
  same failure.

The same export now succeeds. Development runs were affected too, because the localhost page is
still a different origin from the media.

### The editor preview was blank, with an error toast

Same cause, separate element. Opening a recording showed an empty preview canvas and a toast
reading "Something went wrong. Please try again." The preview now requests the media in CORS
mode. Fixed alongside the export path; the two are separate elements and needed separate fixes.

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
