# Upstream sync progress log

Chronological (oldest first). Each entry: date, cycle stage, what happened, verification result, open items.

## 2026-08-27 — plan (gap analysis)

- Baseline verified on `main@4cab381`: tsc clean, 204/204 tests, lint 59 pre-existing problems.
- Created branch `feat/upstream-sync-v1.7`, reference checkouts at `/tmp/openscreen-{base,v1.7.0,upstream}`.
- Scope decision: sync target is upstream **v1.7.0** (last release on the shared React/PixiJS
  architecture). v1.8+ Rust-compositor / ai-edition rewrite is documented but not ported.
- Spawned 6 read-only gap-analysis agents (A, B1, B2, B3, D, F). Reports land in `gap/`.
- Gap report A (recording) received and audited: 3 key claims verified in code
  (native discard leaves HUD stuck, native pause is a no-op, `cursorTelemetryBuffer` orphaned
  upstream). Accepted. Proposed batches A-0..A-5; Windows WGC helper and webcam sidecar deferred.
- Gap report B2 (zoom/cursor) received and audited: cursor size parity bug (C1) confirmed in
  `VideoPlayback.tsx:724` / `frameRenderer.ts:560` (contentScale = camera scale only, no output-width
  normalisation). Accepted. Batches B2-1..B2-5; Windows cursor sampler, bitmaps, themes deferred
  (themes blocked on licence check).
- Gap report B1 (composite/background/blur/3D) received and audited: gradient export bug
  confirmed (`frameRenderer.ts:239` splits on `,` -> every `rgba()` preset and the radial preset
  export wrong; angle ignored); permanent blur filter confirmed (`VideoPlayback.tsx:857`). Accepted.
  Lead decisions on B1's open questions:
  1. Webcam sidecar (A11/W1-W8): **deferred to a later phase**. Capturia's record-time overlay is a
     shipped feature (ground rule 1); the sidecar path is XL across A+B1+D. Revisit after this sync.
  2. Blur regions (X1): **not ported** — upstream shipped v1.7.0 with it flag-disabled.
  3. Gradient editor (B2): **backlog** — colour wheel + 24 presets first; port only if time remains.
  4. Sync `assetBaseUrl` via `additionalArguments`: decide with report F.
- Gap report D (export/audio/captions) received and audited: audio-dropped-at-speed!=1 confirmed
  (`videoExporter.ts:630`), no file-read IPC confirmed. Minor correction: `--disable-gpu` is set in
  `electron/main.ts:26` (Wayland-gated), not only in vite config — D4 readback port still applies to
  packaged non-Wayland Linux. Accepted. Lead decisions on D's open questions:
  1. Decoder: take upstream `web-demuxer` + `streamingDecoder.ts` verbatim (fidelity + 29 upstream
     tests) behind `decodePath` flag defaulting to `'seek'` until browser tests pass. Late wave.
  2. Whisper model: **first-use download to userData**, not bundled (no +85 MB per installer).
  3. `sharp`/electron-builder friction: verify in C-1 itself; not a planning blocker.
  4. D13 source-copy fast path: backlog (macOS-only value today).
- Gap report B3 (timeline/project/i18n) received and audited: annotation id-counter bug confirmed
  (`VideoEditor.tsx:719` uses prefix `anno-`, ids are `annotation-N` at :1296). Accepted.
  Lead decision on i18n: option (c) — adopt upstream's namespaced `locales/<lang>/<ns>.json`
  structure + dependency-free v1.7.0 loader + `i18n-check`, keep Capturia's `useI18n().t("ns.key")`
  contract, ship en/zh-CN/vi first with other locales falling back to en. Runs as batch B3-0
  **alone** on UI files (mechanical, no behaviour change) before feature batches.
  Keep: segment model, auto-save, Capturia undo/redo, PlaybackControls/fullscreen.
- Gap report F (electron/infra) received and audited: all security claims verified
  (`local-media://` unguarded at `main.ts:426`, `store-recorded-video` raw `path.join` at
  `handlers.ts:1590`, `open-external-url` unguarded at `handlers.ts:1748`, no application menu).
  Accepted. Lead decisions: switch to Biome (lint-only now, one-shot format at the end); do NOT port
  `singleInstanceLock.ts`; dependency upgrades late (electron-builder 26 -> vite 7 -> Electron 41);
  `update-checker` only, no `electron-updater` yet.
- All 6 gap reports in. Wrote `PLAN.md`; starting wave 0.

## 2026-08-27 — wave 0

- W0-a (tooling + test harness) reviewed and merged (ff). New baseline: lint 0 err / 118 warn,
  tsc + typecheck:test clean, 34 files / 208 tests. Review: `reviews/W0-a-tooling.md`.
- W0-b (IPC security + lifecycle) reviewed and merged. Merged tree: tsc/typecheck:test clean, lint 0 err,
  36 files / 260 tests. Manual Electron smoke pending (no display on lead machine).
  Review: `reviews/W0-b-security.md`. `.gitignore` += `.claude/worktrees/`.
- W0-c (pure libs) reviewed and merged. Wave 0 complete. Tree: lint 0 err / 117 warn, tsc +
  typecheck:test clean, 48 files / 392 tests. Review: `reviews/W0-c-purelibs.md`.

## 2026-08-27 — wave 1 (started)

- Spawned W1-a (i18n restructure), W1-b (recording pipeline: streaming to disk, discard fix,
  parallel capture), W1-c (exporter groundwork: Linux readback, file-read IPC/OPFS, Opus fallback,
  diagnostics, save-path memory). Merge order: W1-a first, then W1-b, W1-c (i18n key reconciliation).
- W1-a (i18n restructure) reviewed and merged; lead follow-up: OS-language auto-detect limited to
  complete locales (en/zh-CN/vi). Tree: 51 files / 416 tests, i18n:check PASS. Review: `reviews/W1-a-i18n.md`.
- W1-b (recording pipeline) merged; one conflict (`launch.cameraFallback`) resolved into JSON locales;
  lockfile synced for `@fix-webm-duration/parser`. Tree: 55 files / 448 tests. Review: `reviews/W1-b-recording.md`.
- W1-c (exporter groundwork) done on its branch; merge delegated to an integration agent because its 14
  new `export.*` keys/call sites must move to `dialogs.export.*` after the i18n restructure.
- W1-c (exporter groundwork) merged via integration branch. **Wave 1 complete.** Tree: lint 0 err / 116 warn,
  tsc + typecheck:test clean, i18n:check PASS (445 keys), 60 files / 507 tests. Review: `reviews/W1-c-exporter.md`.

## 2026-08-27 — wave 2 (started)

- Spawned W2-a zoom (B2-1 model/UI + B2-2 engine; auto-follow B2-3 deferred to wave 3), W2-b timeline
  (B3-2 + B3-3), W2-c annotations + background (B3-4 + B1-b), W2-d cursor polish (B2-4).
- Wave 2 agents were terminated by an API usage limit before committing anything (worktrees clean at
  `0dd7d04`). Resumed all four after the limit reset; agents instructed to commit per item.
- W2-b (timeline) reviewed and merged. Tree: 64 files / 562 tests, i18n 451 keys. Review: `reviews/W2-b-timeline.md`.
- W2-d (cursor polish) reviewed and merged; cursor size default kept (export-unchanged, preview matches).
  Review: `reviews/W2-d-cursor.md`.
- W2-a (zoom model + engine) reviewed and merged (ff). Tree: 71 files / 632 tests. Review: `reviews/W2-a-zoom.md`.
  Auto-zoom constants retuned; needs manual feel check.

## 2026-08-27 — wave 3 (started, overlapping W2-c)

- Spawned W3-a (HUD flow: chain record after selection, source selector polish, Spaces, restart) and
  W3-c (prefs wiring, close-flush, lazy editor, EditorMenuBar + app menu + edit-menu, global shortcuts
  module, diagnostics buffer + save-diagnostic, About/install-channel, NSIS, anti-flash).
  W3-b/W3-d wait for W2-c; W3-e waits for W3-a.
- W2-c (annotations + background) reviewed and merged (ff). **Wave 2 complete.** Tree: lint 0 err / 116 warn,
  tsc + typecheck:test clean, i18n 481 keys, 77 files / 751 tests. Review: `reviews/W2-c-annotations.md`.
- Spawned W3-b (copy/paste, frame step, custom speed input) and W3-f (auto-follow zoom, B2-3) after
  wave 2 closed. Running now: W3-a, W3-c, W3-b, W3-f. Queued: W3-d (motion blur + native aspect, after
  W3-f), W3-e (devices + notes, after W3-a).
- W3-a (HUD flow) reviewed and merged. Tree: 79 files / 764 tests, i18n 487 keys. Review: `reviews/W3-a-hud.md`.
  Spawned W3-e (devices + countdown overlay + Notes window).
- W3-b (copy/paste, frame step, speed input) reviewed and merged. Review: `reviews/W3-b-clipboard.md`.
- W3-c (lifecycle/menus/global shortcuts/diagnostics/About) reviewed and merged (ff). Tree: 86 files / 855 tests.
  Review: `reviews/W3-c-lifecycle.md`. Cmd+Z routing needs a macOS check.
- W3-f (auto-follow zoom) reviewed and merged. Tree: 87 files / 876 tests, i18n 563 keys.
  Review: `reviews/W3-f-autofollow.md`. Spawned W3-d (motion blur + native aspect).
- W3-e (devices/countdown overlay/Notes) reviewed and merged; deps installed. Review: `reviews/W3-e-devices-notes.md`.
  Swift camera-device change needs macOS verification.

## 2026-08-27 — W3-d merged (`2d288a4`) — Wave 3 complete

Motion blur slider (`motionBlurAmount`, velocity-driven `pixi-filters` `MotionBlurFilter`,
1080-px reference normalisation, legacy-boolean migration), M2 preview filter attached only
while active, `'native'` ("Original") aspect ratio through preview/crop/zoom maps/MP4 plan/GIF/
batch export. New dep `pixi-filters@^6.1.5`. Review: `reviews/W3-d-motionblur-aspect.md`.

Gate: lint 0 errors / 116 warnings; tsc + test types clean; i18n 588 en keys; vitest
**92 files / 927 tests**.

Wave 4 in flight: D-4 streaming decoder (`w4-decoder`), C-1 Whisper fallback (`w4-captions`).

## 2026-08-27 — wave 4: D-4 merged (`234a3dd`)

WebCodecs streaming decoder (`streamingDecoder.ts`, `timelineSegments.ts`, `segmentAdapter.ts`)
behind `decodePath` (default `'seek'`, override `localStorage['capturia.exportDecodePath']`),
seek fallback before the first frame, encoder preference retry / queue stall timeout / fatal
encoder error / flush timeout on both paths. New dep `web-demuxer@^4` + 3.0 MiB wasm asset.
Review: `reviews/W4-D4-streaming-decoder.md`.

Gate: lint 0 errors / 116 warnings; tsc + test types clean; i18n 590 en keys; vitest
**95 files / 1006 tests**.

In flight: C-1 Whisper fallback (`w4-captions`), B1-e 3D iso/tilt (`w4-threed`).

## 2026-08-27 — wave 4: C-1 merged (`a4710c7`)

In-browser Whisper caption fallback (`@xenova/transformers`, model downloaded on first use to
`userData`, ORT wasm bundled via Vite plugin) behind a `TranscriptionEngine` seam; native macOS
speech stays primary. New IPC `caption-model-*` + `analysis-save-sidecar` (path-gated).
Review: `reviews/W4-C1-whisper-captions.md`.

Gate: lint 0 errors / 116 warnings; tsc + test types clean; i18n 613 en keys; vitest
**100 files / 1054 tests**; `vite build` OK.

In flight: B1-e 3D iso/tilt (`w4-threed`), D-5 WSOLA audio (`w4-audio`).

## 2026-08-27 — wave 4: B1-e merged (`2b350ac`)

3D iso/left/right presets on zoom regions: shared camera step carries `rotation3D` (preview CSS
transform + export WebGL2 `threeDPass.ts`), cursor tilts with the video, subtitles/annotations
stay flat. Review: `reviews/W4-B1e-3d-tilt.md`.

Gate: lint 0 errors / 116 warnings; tsc + test types clean; i18n 618 en keys; vitest
**101 files / 1084 tests**.

In flight: D-5 WSOLA audio (`w4-audio`), F11+F10+F7 electron infra (`w4-infra`).

## 2026-08-27 — wave 4: D-5 merged (`f6ce317`)

Audio now exported at every speed: WSOLA stretcher per speed segment, output locked to the
rendered frame count on both decode paths, 1× path unchanged. Speed-audio warning removed.
Review: `reviews/W4-D5-wsola-audio.md`.

Gate: lint 0 errors / 116 warnings; tsc + test types clean; i18n 617 en keys; vitest
**104 files / 1113 tests**.

In flight: F11+F10+F7 electron infra (`w4-infra`). Queued: A-3 native pause/resume + B2-5 cursor
kinds (Swift, macOS build needed), F8 dependency upgrades, F9 signing, T-last format.

## 2026-09-03 — wave 4: F11 + F10 + F7 residue (branch `w4-electron-infra`, pending review)

`electron/ipc/handlers.ts` (2346 lines) split into `register*Handlers(ctx)` modules —
`context.ts` (shared `IpcContext` / `IpcSession`), `cursorTrack.ts` (pure sanitize + sidecar),
`cursorTracker.ts` (live tracker, moved verbatim), `permissions.ts`, `recordingFiles.ts`,
`exportFiles.ts`, `projectState.ts`, `analysis.ts`; `handlers.ts` is now a 76-line composition
root. `electron/paths.ts` exposes a lazy `getRecordingsDir()` so `main.ts` no longer exports
`RECORDINGS_DIR` and no IPC module touches `app` at import time (guarded by
`electron/ipc/__tests__/modules-import.test.ts`). `handlers.test.ts` pins the full 48-channel
set (+4 HUD) captured before the split; channel names, preload and `.d.ts` untouched.

F10: `electron/update-checker.ts` (upstream v1.9 port, strict semver, official-URL check,
pointed at `MinhOmega/Capturia`) behind a "Check for Updates…" menu item (mac app menu +
Help); result dialog with "Open Release Page" through `normalizeExternalUrl`. No download,
no `electron-updater`. New keys `common.electron.updates.*` (en/vi/zh-CN).
E2E skeleton: `@playwright/test` devDep, `playwright.config.ts`, `e2e/launch.spec.ts`
(HUD boots, source selector opens; self-skips without a display or without `dist-electron/`),
`npm run build:vite` / `npm run test:e2e`, nightly `.github/workflows/e2e.yml` (ubuntu xvfb +
macos-15). **Unverified here** (no display): the spec only ran as "1 skipped".

F7 residue: `HEADLESS=1|true` gates every window `show`/`showInactive`/`focus` and the Dock;
`console-message` listener on the Electron 39 details form. `--asset-base-url` is exposed by
the preload (`electronAPI.assetBaseUrl`) but `src/lib/assetPath.ts` still resolves wallpapers
through the `get-asset-base-path` IPC — consumer swap left to B1/F7 follow-up (renderer-only).

Gate: lint 0 errors / 116 warnings; tsc + test types clean; i18n 617 en keys; vitest
**111 files / 1136 tests**; `playwright test` 1 skipped (no display).

## 2026-08-27 — wave 4: F11+F10+F7 merged (`55da281`) — lead note

Review: `reviews/W4-F-infra.md`. Gate after merge: lint 0 errors / 116 warnings; tsc + test
types clean; i18n 621 en keys; vitest **115 files / 1195 tests**.

Spawned in parallel: Swift batch A-3 + B2-5 (`w4-swift`, macOS build needed), F8 + F9
(`w4-deps`). Then T-last format and the final report.

## 2026-09-03 — wave 4: F8 dependency upgrades + F9 release signing (branch `w4-deps`, pending review)

Five commits, one per step, gate green after each. Before → after: `@types/node` 22.20.1 (kept,
`.nvmrc` pinned 22.23.2 and `release.yml` now reads it), electron-builder 24.13.3 → 26.15.3
(`linux.desktop` → `desktop.entry`; `npmRebuild`/`buildDependenciesFromSource` false;
`asarUnpack **/*.node`; `mac.notarize:false`; `install-app-deps` CI step dropped), vite 5.4.21 →
7.3.6 with vitest 4.0.16 → 4.1.11, `@vitejs/plugin-react` 4.7.0 → 5.2.0, `vite-plugin-electron`
0.28.8 → 0.29.1, esbuild 0.27.7 explicit, TS declaration ^5.9.3 (lock now has one `vite`, one
`esbuild`), Electron 39.2.7 → 41.10.7. Dead devDeps removed: `@types/uuid`, `fix-webm-duration`.
No `src/**` or `electron/**` source change was needed; `vite.config.ts` only gained a note on the
Wayland `--disable-gpu` guard (kept until re-tested on 41).

F9: `release.yml` `validate` fails on tag pushes when `package.json` version differs from the tag;
mac legs sign through electron-builder (`CSC_LINK`/`CSC_KEY_PASSWORD`/`CSC_NAME`), then
`codesign --verify`, `notarytool submit --wait`, `stapler staple/validate`, `spctl` — all gated on
the six secrets, skipped on forks. `*.zsync`/publish block deferred (B8/M12).

Verified: lint 0 errors / 116 warnings; tsc + test types clean; i18n PASS; vitest **115 files /
1195 tests**; `vite build`; `electron-builder --dir --linux` (25 s); Electron 41 e2e launch smoke
under xvfb (1 passed). **Unverified**: signing/notarization on a macOS runner, Electron 41 on
X11/Wayland/macOS desktops, the four installer legs on CI. Review note:
`reviews/W4-F8-F9-deps-signing.md`.

## 2026-08-27 — wave 4: F8+F9 merged (`68bd174`) — lead note

Electron 41.10.7, Vite 7.3.6 (lockfile deduped), vitest 4.1.11, electron-builder 26.15.3,
TypeScript 5.9.3; gated macOS sign/notarize/staple + version==tag guard in `release.yml`.
Review: `reviews/W4-F8-F9-deps-signing.md`. Gate after merge on the new stack: lint 0 errors /
116 warnings; tsc + test types clean; i18n 621; vitest **115 files / 1195 tests**; `vite build` OK.

In flight: Swift batch A-3 + B2-5 (`w4-swift`). Then T-last Biome format and the final report.

## 2026-08-27 — wave 4: Swift batch merged — native pause/resume + cursor kinds

Swift uncompiled (Linux lead box); TS side degrades to "pause unsupported" with an old helper.
16 cursor kinds with original MIT glyphs (upstream SVGs skipped for licence). Review:
`reviews/W4-swift-pause-cursor-kinds.md`. Gate: lint 0 errors / 116 warnings; tsc + test types
clean; i18n 623; vitest **118 files / 1228 tests**.

Remaining: T-last Biome format, final report.

## 2026-09-03 — T-last: Biome formatter enabled + one-shot format

`biome.json` formatter on with the W0-a style untouched (2-space, lineWidth 100, single quotes,
JSX double quotes, semicolons as needed, trailing commas all); the unset options were pinned to
the value measured to give the smallest diff (`quoteProperties: preserve`, others at their
defaults). Ignored by the formatter: `.claude/worktrees`, `dist*`, `public/wasm`, `dist/ort`,
cursor SVGs, Swift sources, `package-lock.json`, `src/i18n/locales/**` (hand layout).
`npm run format` / `format:check` added; lint-staged now runs `biome check --write`.

Format commit: 328 files, +29960/-25598, listed in `.git-blame-ignore-revs`. One test read the
source text of `NotesWindow.tsx` and expected the CSS import in double quotes; the assertion is
now quote-agnostic. Gate unchanged: lint 0 errors / 116 warnings; tsc + test types clean;
i18n 623; vitest **118 files / 1228 tests**; `vite build`; `biome format .` reports nothing.

Remaining: final report.

## 2026-08-27 — T-last merged — sync complete

Biome formatter enabled (W0-a style, `quoteProperties: preserve`), one-shot format of 328 files
recorded in `.git-blame-ignore-revs`, lint-staged now formats. Final gate on
`feat/upstream-sync-v1.7`: lint 0 errors / 116 warnings; tsc + test types clean; i18n 623 en
keys (zh-CN, vi complete); vitest **118 files / 1228 tests** (main: 32 / 204); `vite build` OK;
`biome format .` clean.

Branch is local only (never pushed). Open before release: manual smoke checklists in every
`reviews/W*.md`, the macOS checklist in `docs/native-helper.md` (Swift uncompiled), a release
candidate tag to exercise the four installer legs and the gated signing, and the
`decodePath` default flip after the export smoke passes.

## 2026-08-27 — wave 5 round 1 started

Agents: `w5-audit` (deep re-audit), `w5-updater-fastpath` (M12 + D13), `w5-hud` (A24 + A25b),
`w5-editor` (B1-d gradient editor + X1 blur regions). PR preparation plan recorded in PLAN.md.

## 2026-09-03 — wave 5 round 1: A24 HUD click-through + drag + content-fit, A25b vertical tray

The HUD window no longer swallows desktop clicks in its transparent reserve: main ignores
mouse input while the pointer is over it (forwarded moves on macOS; a cursor poll against the
bar/popover boxes on X11 and Windows; never on Wayland) and the window shrinks to its content
around a bottom-centre anchor, so the reserve is small to begin with. The grip is a JS drag
handle (`hud-overlay-move-by`, clamped to the display under the cursor) and the placement
(anchor + size) is remembered in `userData/hud-overlay-placement.json`. `hudOrientation`
(`horizontal` | `vertical`, default horizontal) in user preferences switches the bar to a
stacked tray. New IPC: `hud-overlay-ignore-mouse-events`, `hud-overlay-move-by`,
`hud-overlay-set-size`, all guarded to the HUD's own `webContents`. Pure geometry in
`src/hooks/useHudLayout.ts` (shared with main). Note: `reviews/W5-A24-A25b-hud.md`.

Gate on the batch branch: lint 0 errors / 116 warnings; tsc + test types clean; i18n 626 en
keys (zh-CN, vi in parity); vitest **120 files / 1269 tests**. Nothing exercised in a live
Electron (no display on the lead box): the review note lists the manual smoke.

## 2026-09-03 — wave 5 round 1: M12 electron-updater + D13 source-copy fast path (agent branch, pending review)

Six commits on `29d0ff3`; note in `reviews/W5-M12-D13-updater-fastpath.md`.

- **M12/B8** `electron/auto-updater.ts` (pure controller, injected electron-updater; dmg/nsis/
  AppImage only, packaged only; `autoDownload` off, `autoInstallOnAppQuit` on, no prereleases;
  Download Now/Later → progress to renderer → Restart Now/On Next Quit; offline / no-release /
  unsigned classification with release-page fallback). `main.ts` launch check after 10 s gated on
  `userData/update-preferences.json` (`autoUpdateCheck`, default true) and the menu item; IPC +
  preload + `.d.ts` for the renderer (no UI consumer yet). `electron-builder.json5` `publish`
  block for `MinhOmega/Capturia` + mac `zip` target; `release.yml` uploads `latest*.yml`,
  `.blockmap`, `.zsync`, mac zips and merges the two `latest-mac.yml` feeds
  (`scripts/merge-update-feeds.mjs`). Dep `electron-updater@6.8.9`.
- **D13** `src/lib/exporter/sourceCopyFastPath.ts`: pure blockers + mediabunny file probe;
  `VideoExporter.export()` copies the source verbatim (phase `'copying'`, `sourceCopy: true`)
  when the export is native/source with no edit, an MP4 (H.264/HEVC/AV1 + ≤1 AAC/Opus track) at
  the planned size and ≤ 256 MiB; everything else renders as before. `VideoEditor` passes
  `aspectRatio`/`quality`; `ExportDialog` shows "Copying".
- Gate: lint 0 errors / 116 warnings; tsc + test types clean; i18n 632 en keys; vitest
  **121 files / 1306 tests** (was 118 / 1228); `vite build` OK; `biome format .` clean.
- Open: no live Electron run (dialogs, `quitAndInstall` vs `before-quit`); unsigned mac builds
  cannot auto-update (falls back to the release page); fast path unverified against a real SCK
  file; renderer toggle/progress UI for the updater belongs to the settings/HUD owners.


## 2026-09-03 — wave 5 round 1: B1-d gradient editor + X1 blur regions

Both backlog items from `gap/B1-composite.md`, implemented as Capturia features with our own
tests (upstream shipped blur regions disabled and untested). Feature note:
`docs/editor-gradient-blur.md`.

- Gradient editor: `src/lib/gradientBuilder.ts` (spec ↔ CSS, round-trips through the exporter's
  `gradientParser`), `GradientEditor.tsx` under a "Custom gradient" toggle in the background
  gradient tab. Persisted as the existing wallpaper string; stop cap 8 so every preset loads.
- Blur regions behind `featureFlags.ts` `BLUR_REGIONS_ENABLED` (default on): `AnnotationType`
  `'blur'`, optional `blurData` (mosaic only, rectangle/oval, light/dark shade, block size,
  intensity), `blurEffects.ts` shared by the preview overlay (Pixi stage extract) and the export
  pass (composite canvas, block size scaled with the output), own timeline row, `B` shortcut
  (`addBlur`, `b` was free), `blur-N` ids, clipboard/duplicate/paste aware, excluded from
  selection cycling via `getSelectionCycleAnnotations`. Undo covers them through the existing
  `annotationRegions` snapshot (by inspection; VideoEditor's inline history has no unit harness).

Gate: lint 0 errors / 116 warnings (unchanged); tsc + test types clean; i18n 652 en keys (zh-CN,
vi in parity); `biome format .` clean; vitest **122 files / 1277 tests** (+4 / +49). Manual smoke
list in the feature note — no display on the lead box.

## 2026-08-27 — wave 5: native batch merged

SCK helper: system audio (mixed single track, clock-driven, pause-aware), mic device selection,
word-boundary device matching, CoreGraphics init before window filters, prebuilt
`window-bounds-helper` replacing runtime `swiftc`. Swift uncompiled; checklist items 11–17 in
`docs/native-helper.md`. Gate after merge: lint 0 errors; tsc + test types clean; i18n PASS;
format clean; vitest **129 files / 1423 tests**; i18n 666 en keys.

## 2026-09-03 — wave 5 round 1: R5-NOTES (A-12) Notes teleprompter mode (agent branch, pending review)

Four commits on `832f5be`; note in `reviews/W5-A12-notes-teleprompter.md`.

- **A-12** `src/lib/notesTeleprompter.ts` (pure): bounds (speed 10–150 px/s, font 14–48 px),
  settings normalisation, capped frame delta, fractional position tracking, end detection,
  relative-position scaling, and the playback step with a 2 s hold after a manual scroll.
  `NotesToolbar`: teleprompter toggle; while on, formatting is disabled and a row with
  play/pause, restart, speed slider + readout, font −/+ + readout and mirror appears.
  `NotesWindow`: read-only editor while on, RAF loop, wheel/touch hold, drift-detected
  scrollbar hold, replay from the top after the end, reading position kept across font steps
  and the mode toggle, Space toggles playback outside the note and the controls.
  Preference `notesTeleprompter: { speed, fontSize }`; mirror is session-only. i18n: 15 keys
  (`launch.tooltips.notesToolbar.*`, `launch.notesTeleprompter.*`) in en / zh-CN / vi.
- Gate: lint 0 errors / 116 warnings; tsc + test types clean; i18n 647 en keys; vitest
  **125 files / 1388 tests** (was 123 / 1347); `biome format .` clean.
- Open: no live Electron run (RAF timing, tiptap `setEditable` interplay with autofocus, real
  wheel/scrollbar behaviour); see the smoke list in the note.


## 2026-09-03 — wave 5 round 1: R5-A1 browser-path system audio + HUD leftovers (agent branch, pending review)

Four commits on `ff05c01..deedc23`; note in `reviews/R5-A1-system-audio-hud.md`.

- **R5-A1** `src/lib/audioMix.ts` (new, 10 tests): pure mix-graph builder over a minimal
  `AudioContext` surface. Mic → gain (0 → user gain over a 20 ms ramp) and system → unity gain
  feed one soft limiter into a `MediaStream` destination; a lone system track passes through
  verbatim; no Web Audio records the raw tracks. `normalizeMicrophoneGain` moved here.
  `useScreenRecorder` gains `systemAudioEnabled`: the desktop capture asks for audio on both
  request shapes and retries video-only when refused, a missing track shows
  `editor.recordingSystemAudioUnavailable` and recording continues, and `hasMicrophoneAudio` is
  true when either input is present. Platforms: Windows loopback from the display-media handler
  (`request.audioRequested`), Linux the renderer's desktop-audio constraint, macOS the native
  helper only — so the HUD toggle (`capturia.systemAudioEnabled`, default off) is hidden on
  macOS until the helper reports `canCaptureSystemAudio`. macOS also gets
  `disable-features=MacCatapLoopbackAudioForScreenShare`, without which an audio request goes
  through the CoreAudio tap API and crashes the renderer in dev.
- **Camera** the overlay drops on the webcam track's `ended` event instead of freezing on the
  last frame (`editor.recordingCameraDisconnected`, recording continues), and the constraints no
  longer ask for an ideal 1280x720, so portrait cameras keep their native orientation and are
  centre-cropped into the overlay box.
- **A-5** every HUD popover closes on window `blur`. On a click-through window an outside click
  never reaches the renderer and Escape is undeliverable, so a stale picker blocked the bar.
  Capture-settings and camera-shape became controlled; the listener is on the window in bubble
  phase, and element blur does not bubble, so focus moving inside an open popover is ignored.
- **A-14** the HUD reads the registered stop shortcut from main on mount and adopts it instead
  of pushing its own `localStorage` copy over whatever main had; the push remains as the
  fallback when main reports nothing registered.
- Gate: lint 0 errors / 116 warnings (unchanged); tsc + test types clean; i18n 640 en keys
  (zh-CN, vi in parity); `biome format .` clean; vitest **124 files / 1370 tests** (was 121 /
  1306).
- Open: no live Electron run — loopback on Windows, the Linux monitor source and the macOS
  switch are argued from the API contract, not observed; the `blur` dismissal is jsdom-only; a
  real camera unplug was not tried; `hasSystemAudio` / `warnings` and the native batch's
  `launch.microphoneDeviceNotFound` / `launch.systemAudioUnavailable` keys have no consumer yet.


## 2026-09-03 — wave 5 round 2: project relink (R5-PROJ) + streaming waveform (R5-WAVE)

Two robustness items for long-lived projects and long recordings. Feature notes:
`docs/media-relink.md`, `docs/waveform-streaming.md`.

- Project state survives a move or rename: `<userData>/media-links.json` keyed by a content
  fingerprint (size + SHA-256 of the first and last 64 KiB, so the cost is flat in file size) AND
  by path, so two live copies stay distinguishable. `save-project-state` records the link;
  `load-project-state` falls back to it when the path has no state file, copies the state to the
  new key and the cursor sidecar next to the moved recording, and returns `relinked` for the
  `editor.projectRelinked` toast. No new IPC channel. `decideRelink` is pure and table-tested:
  keep / no-match / same-path / state-missing / **ambiguous** / relink, where ambiguity never
  relinks. Registry contents are data, not trust: bare `.json` names inside the projects dir,
  sidecar paths only as derived from their own entry, and `isReadablePathAllowed` before anything
  is fingerprinted or written.
- Waveform for huge sources: `src/hooks/streamingAudioPeaks.ts`. Above
  `MAX_IN_MEMORY_SOURCE_BYTES` the recording is materialized as an OPFS-backed File and its audio
  demuxed and decoded chunk by chunk (mediabunny `AudioBufferSink` over WebCodecs, the captioning
  stack) into `peakBlockCount(duration)` min/max columns, memory flat in the recording's length.
  Throttled progress hands out column snapshots so the timeline fills in progressively; abort
  stops at the next chunk. Small sources keep `decodeAudioData` and fall back to streaming on
  failure; when neither works the audio row shows `editor.waveformUnavailable`.

Gate: lint 0 errors / 116 warnings (unchanged); tsc + test types clean; i18n 666 en keys (zh-CN,
vi in parity); `biome format .` clean; vitest **130 files / 1448 tests** (+3 / +52). Not verified:
no Electron run, so the relink toast, a genuinely moved recording on disk and the streaming
waveform against a multi-GB file are all untested end to end.
