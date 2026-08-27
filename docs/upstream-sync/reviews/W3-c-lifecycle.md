# Review: W3-c lifecycle, menus, global shortcuts, diagnostics, About

Branch `worktree-agent-a098d37cc0e3d4ce7`, 4 commits (rebased on tip), fast-forwarded.

## Verified (merged tree)
- lint 0 errors; tsc + typecheck:test clean; i18n:check PASS; vitest 86 files / 855 tests.
- Global shortcuts: one `GlobalShortcutManager` for `openApp` (Ctrl/⌘+Shift+O) and `stopRecording`
  (Ctrl/⌘+Shift+2 — same default as before), persisted in `shortcuts.json`; HUD's legacy
  `set-stop-recording-shortcut` writes through, so customised stop shortcuts survive. Register-new-
  before-unregister-old with conflict feedback; dialog stays open on failure. Fixed-shortcut clash test covers it.
- Close-flush: `request-save-before-close` (≤2 s) on window close and inside the existing `before-quit`
  shutdown sequence — fixes the "edits lost within the 2 s debounce" bug (gap B3 §6.5).
- App menu built with `mainT`, rebuilt on `set-locale`; `edit-menu.ts` routes Cmd+Z to the renderer
  (`menu-undo`) — **needs macOS check** (upstream #433); `EditorMenuBar` with jsdom test.
- Diagnostics: main log ring buffer (200 lines, 500 with `CAPTURIA_DIAGNOSTIC=1`), `save-diagnostic`
  report, log tail appended to the GitHub-issue body; About box + install channel; NSIS install-dir;
  editor window anti-flash (`show:false` + `ready-to-show`, `HEADLESS`).
- New projects seeded from `userPreferences` via `editorDefaults`; lazy-loaded editor bundle.

## Skipped (agreed) / follow-ups
- P9(b) widening the undo snapshot (crop auto-init would create entries). "Check for updates" (no updater).
- `LaunchWindow` could read `getStopRecordingShortcut()` on mount instead of localStorage — backlog.
