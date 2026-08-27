# Sync plan — waves and batches

Derived from the six gap reports in `gap/`. Each batch is implemented by one teammate on its own
branch/worktree, reviewed by the lead, then merged into `feat/upstream-sync-v1.7` in the order
listed. Waves are ordered by dependency and by hot-file contention (`VideoEditor.tsx`,
`SettingsPanel.tsx`, `VideoPlayback.tsx`, `TimelineEditor.tsx`, `frameRenderer.ts`, `types.ts`,
`electron/ipc/handlers.ts`, `electron/main.ts`, `electron/preload.ts`, i18n).

Environment constraint: the lead machine is Linux. Swift/macOS helper changes can be written but
not compiled or smoke-tested here; they are scheduled last and marked "needs macOS verification".

## Standing decisions (from the gap audits)

| Topic | Decision |
|---|---|
| Sync target | upstream v1.7.0 (same architecture). v1.8+ Rust compositor / ai-edition: not ported. |
| Webcam sidecar (A11, B1 W1–W8) | Deferred to a later phase; Capturia's record-time overlay stays. |
| Blur regions (B1 X1) | Not ported (upstream shipped it flag-disabled). |
| i18n | Upstream namespaced JSON structure + v1.7.0 dependency-free loader + `i18n-check`; keep `useI18n().t("ns.key")` call sites; en/zh-CN/vi first, others fall back to en. |
| Captions | Native macOS transcriber primary; upstream in-browser Whisper as win/linux fallback behind a `TranscriptionEngine` seam; model downloaded on first use to `userData`. |
| Exporter decoder | Port `streamingDecoder.ts` + `web-demuxer` verbatim behind `decodePath` (default `seek` until browser tests pass). |
| Undo/redo, segment model, auto-save, PlaybackControls, permission model, SCK helper, cursor tracker | Keep Capturia's. |
| Lint | Biome (lint rules now, formatter one-shot at the very end). |
| Deps | Upgrades late: electron-builder 26 → vite 7 stack → Electron 41. `singleInstanceLock.ts` not ported. |
| Windows WGC helper, cursor themes, 3D, auto-updater | Backlog / separate projects. |

## Wave 0 — foundations (parallel, no UI hot files)

| Batch | Contents | Source reports |
|---|---|---|
| **W0-a tooling + test harness** | jsdom + @testing-library devDeps, `vitest.config.ts` include `{src,electron}/**` (node default, per-file jsdom), `tsconfig.test.json` + `npm run typecheck:test`, remove `electron-icon-builder`/`electron-rebuild`, Node/npm pin + `.nvmrc`, `@types/node` ^22, `.editorconfig`, CODEOWNERS, Biome lint-only replacing ESLint (formatter disabled), husky + lint-staged, CI job updates | A-0, F0, F3 |
| **W0-b IPC security + lifecycle** | `electron/ipc/paths.ts` (+tests): approved-path policy, `local-media://` gate, `resolveRecordingOutputPath`, external-URL allowlist, export-path guard, `set-current-video-path`/`analysis-start`/`reveal-in-folder` validation, dialog parents (Wayland), permission check/request handlers, entitlement keys, `requestSingleInstanceLock` + duplicate-HUD guard + `showMainWindow` + tray click, dock lifecycle, `main-process-errors` filter | F1, F2, A21, A22, A25 |
| **W0-c pure libraries + tests** | `gradientParser.ts` + frameRenderer gradient fix + `BackgroundLoadError` path + max rounding 64, `backgroundImageUpload.ts` (PNG), GIF worker count, audio downmix fns, `frameStep.ts`, `customPlaybackSpeed.ts`, `regionPlacement.ts`, `annotationTextAnimation.ts`, `userPreferences.ts`, `editorDefaults.ts`, `shortcuts.ts` additions (`isTextEditingTarget`, copy/paste actions), `types.ts` `getZoomScale`/`customScale` + `createTextAnnotationRegion`, annotation id-counter bug fix | B1-a, B1-b(part), D-0(part), D3b, B3-1, B2-1(lib) |

## Wave 1 — cross-cutting (after wave 0)

| Batch | Contents | Source |
|---|---|---|
| **W1-a i18n restructure** | namespaced locale JSON, loader, `I18nContext`, `i18n-check`, `electron/i18n.ts` + `set-locale`, HUD locale list, import en/zh-CN/vi (+ upstream values for other locales) — mechanical, no behaviour change | B3-0, M1 |
| **W1-b recording pipeline** | streaming recordings to disk (main + renderer), WebM duration patch, parallel screen+mic capture, native discard fix, hide Pause on native, camera-fallback toast | A-1, F4 |
| **W1-c exporter groundwork** | Linux `readPixels` readback, file-read IPC + path approval + `localSourceFile`/OPFS + `'preparing'` phase, AAC→Opus fallback, export diagnostics, save-path guard + remembered folder + `unsavedExport`, interim duration override | D-0, D-1, D-3 |

## Wave 2 — editor features (parallel worktrees; merged one at a time)

| Batch | Contents | Source |
|---|---|---|
| **W2-a zoom** | custom scale slider, precision X/Y, hold-to-preview, auto-zoom `source` tagging + wand toggle; then Screen-Studio easing + connected transitions + zoom spring + scrub state + rafCoalescer + overlaySize; then auto-follow focus + UI + marker | B2-1, B2-2, B2-3 |
| **W2-b timeline** | snap guides + tooltip, handle clamp, edge pan, empty-lane scrubbing, selection fix, item label, waveform + row hints + Timeline settings toggle | B3-2, B3-3 |
| **W2-c annotations + background** | export text wrapping + CJK, text animation presets, duplicate annotation, empty-content default, self-hosted fonts, colour wheel, `wallpaper.ts` classify + canonical persistence + legacy normaliser | B3-4, B1-b |
| **W2-d cursor polish** | size parity fix, clip-to-bounds, hide outside crop, cursor motion blur, optional click-bounce/spring smoothing | B2-4 |

## Wave 3 — UX and lifecycle

| Batch | Contents | Source |
|---|---|---|
| **W3-a HUD flow** | chain record after source selection, source selector empty state/tab default/counts, Spaces visibility, restart recording (browser path) | A-2, A-4(part) |
| **W3-b copy/paste + speed + frame step** | region copy/paste, `CustomSpeedInput`, frame-step keys, arrow-key guard | B3-5 |
| **W3-c lifecycle + prefs + menus** | prefs wiring, picker filters, flush-on-close, lazy editor, EditorMenuBar + app menu + `edit-menu` (Cmd+Z), generalised `globalShortcut.ts` (open app + stop recording), diagnostics ring buffer + `save-diagnostic`, About/install-channel | B3-6, B3-7, F5, F6 |
| **W3-d motion blur + native aspect** | filter attach/detach fix, intensity slider + `pixi-filters` + schema migration; `'native'` aspect ratio | B1-c, D-2 |
| **W3-e devices + notes** | camera device picker, mic toggle/picker/meter, countdown overlay window, Notes window (tiptap) + tooltip | A-4, A-5, A-6 |

## Wave 4 — heavy / risky (each its own project-sized PR)

D-4 streaming decoder, D-5 WSOLA audio at speed≠1, C-1 Whisper fallback, B1-e 3D iso/tilt,
F7 window polish + `assetBaseUrl`, F8 dependency upgrades, B2-5 cursor kinds (Swift, needs macOS),
A-3 native pause/resume (Swift, needs macOS), F9 release signing, F10 e2e + update checker,
F11 `handlers.ts` decomposition, T-last Biome format.

## Backlog (not scheduled)

Webcam sidecar + editor composite (A11/B1-f), Windows WGC helper (A27/C9), cursor themes (C10,
licence), blur regions (X1), gradient editor (B1 B2), source-copy fast path (D13),
`electron-updater`, click-through HUD (A24), vertical tray (A25b).
