# Review: W2-c annotations + background

Branch `worktree-agent-aec7c89a7401013d6`, 7 commits (rebased on tip), fast-forwarded.

## Verified (merged tree)
- lint 0 errors; tsc + typecheck:test clean; i18n:check PASS (481 en keys); vitest 77 files / 751 tests.
- Export text wrapping (`textWrap.ts`) with Unicode-script CJK boundaries; wrap width mirrors the preview
  span padding; typewriter export mirrors the preview `clip-path`. Parity tests for animations.
- Duplicate annotation via `src/lib/annotations/duplicate.ts`; new text annotations start empty with a
  placeholder (upstream #127).
- 16 self-hosted font families (`public/fonts`, 4 MB, OFL, `LICENSES.txt`, latin/latin-ext/vietnamese
  subsets only); export awaits `document.fonts.load` with a 5 s timeout and falls back on failure.
- Colour wheel (`ui/color-picker.tsx`, `@uiw/react-color-colorful`) replaces the four `Block` usages.
- Wallpaper: canonical `/wallpapers/wallpaperN.jpg` persisted; `normalizeWallpaperValue` on restore
  migrates legacy `file://…/(assets/)wallpapers/N.jpg` (incl. Windows drive letters), out-of-set → default,
  colours/gradients/data URIs untouched (41 tests). `BackgroundLoadError` now surfaces as
  `editor.exportBackgroundLoadFailed` toast for MP4 and GIF.
- Async `getAssetPath` kept; asset layout unchanged (per B1 decision).

## Follow-ups
- Manual: packaged-app wallpaper round-trip and legacy sidecar open (agent checklist items 7–8).
- Installer size +4 MB (fonts) — acceptable; noted for release notes.
