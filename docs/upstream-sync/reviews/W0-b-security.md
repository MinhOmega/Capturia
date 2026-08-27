# Review: W0-b IPC security + lifecycle

Branch `worktree-agent-a7dbf9a26da26dfc3`, 4 commits, merged with `--no-ff`.

## Verified independently (merged tree)
- tsc clean, typecheck:test clean, lint 0 errors, vitest 36 files / 260 tests (46 `paths` + 6 error-filter tests).
- Traced every renderer caller of `set-current-video-path`: file picker (approved by handler) and native
  recorder stop (`handlers.ts:1718` writes into `RECORDINGS_DIR`) — both pass the new read policy.
- `local-media://` now serves only allowed video/sidecar extensions inside recordings dir or approved
  files; images removed from the MIME map (renderer never fetched them via the scheme).

## Deviations from upstream (accepted)
- `fullscreen` added to the web-permission allowlist: `VideoEditor.tsx` uses `requestFullscreen()`.
- `activate` handler ignores dock clicks while `recordingActive` so the intentionally hidden HUD stays hidden.
- GTK save dialogs: extension `.mp4`/`.gif` appended when omitted (previously written verbatim).

## Not verifiable here (Linux, no display)
Manual smoke checklist from the agent is kept in the batch report; the lead cannot run the Electron app
headless. Highest-value checks: open a recording in the editor (sidecar + scrubbing), open an external
video via picker, export MP4/GIF + reveal, second-instance raise, dock click during/after recording.

## Follow-ups
- `.gitignore` now excludes `.claude/worktrees/` (Biome otherwise finds nested `biome.json` roots).
- `x-apple.systempreferences:` deep links still go through the separate permission-settings handler (unchanged).
