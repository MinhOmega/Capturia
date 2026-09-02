# Gap report F - Electron main/preload, security, permissions, build, packaging, tooling

Status: analysis complete (2026-08-27). Read-only; no source changed.

Refs: base `/tmp/openscreen-base` (87735c27), target `/tmp/openscreen-v1.7.0`, main
`/tmp/openscreen-upstream` (v1.10.0). Capturia = `feat/upstream-sync-v1.7` @ 4cab381.

Legend: **MISSING** / **PARTIAL** / **PRESENT-DIFFERENT** (ours differs; says which wins) /
**PRESENT-SAME** / **N/A**. Effort: S (< 0.5 day), M (0.5-2 days), L (2-5 days), XL.

Hot files (touched by many batches; serialize edits): `electron/main.ts`,
`electron/ipc/handlers.ts`, `electron/preload.ts`, `electron/electron-env.d.ts`,
`src/vite-env.d.ts` (Capturia duplicates the whole `Window.electronAPI` typing in both d.ts
files - every preload change is a 3-file edit), `package.json`, `electron-builder.json5`.

---

## 1. Summary table

| # | Item | Upstream files / commits | Capturia status | Effort | Recommendation |
|---|------|--------------------------|-----------------|--------|----------------|
| S1 | `local-media://` protocol serves any path | (Capturia-only; upstream has `approveReadableVideoPath`) | **MISSING guard** - `electron/main.ts:426-481` reads any absolute path the renderer names | M | **Port first.** Introduce `electron/ipc/paths.ts` (approved-path policy, from `handlers.ts:66-100,214-252` upstream) and gate the protocol on it |
| S2 | Path traversal in recording file name | `resolveRecordingOutputPath` `handlers.ts:254-272` (e4672811) | **MISSING** - `handlers.ts:1590` `path.join(RECORDINGS_DIR, fileName)` unguarded | S | Port function verbatim; use in `store-recorded-video` |
| S3 | `open-external-url` scheme allowlist | cf6dce55 (lost in a merge; absent in v1.7.0!), re-added on main `handlers.ts:3472-3488` (5936e5f6) | **MISSING** - `handlers.ts:1748` | S | Port the **main** version (`EXTERNAL_URL_PROTOCOLS = http/https/mailto`) |
| S4 | Guard exported file paths | `write-export-to-path` `handlers.ts:2488-2517` | **PARTIAL** - `save-exported-video` (`handlers.ts:1790-1846`) accepts renderer-supplied `targetFilePath`/`directoryPath`, `mkdir -p` + writes anywhere | S | Require absolute + `.mp4/.gif` ext; additionally only accept paths previously returned by `pick-save-file-path`/`pick-export-directory` (approved set) |
| S5 | `set-current-video-path` / `analysis-start` / `reveal-in-folder` accept any path | `resolveApprovedVideoPath`, `approveReadableVideoPath` | **MISSING** - `handlers.ts:1936,2016,1771` | S | Same policy module as S1; `analysis-start` hands the path to the Swift transcriber helper, so it matters |
| S6 | `read-binary-file` crash fix, `read-file-chunk` cap | 6441e960; `handlers.ts:2588-2690` | **N/A today** (Capturia streams via `local-media://` instead) | - | Only if stream D ports the >2 GiB OPFS path (`dfdcbc62`); then port these handlers with the `MAX_IPC_CHUNK_BYTES` cap |
| S7 | Scope IPC replies to originating window | e2bdfee6 (`event.sender.id` check in `close-confirm-response`, `main.ts:422-431`) | **N/A** (no close-confirm flow yet) | S | Apply the pattern if B3 ports the unsaved-changes dialog |
| S8 | Wallpaper resolver hardening (IPC side) | 8458cbb4 / 702b7330 `--asset-base-url=` via `additionalArguments` (`windows.ts:12-17`, `preload.ts:8-16`) | **PRESENT-DIFFERENT** - Capturia keeps async `get-asset-base-path` IPC + `assets/wallpapers` layout | S | Port the `additionalArguments` mechanism (sync, no IPC), keep Capturia's `assets/` layout. Coordinate with B1 (resolver) |
| S9 | Runtime-compiled Swift helper | (Capturia-only) `electron/ipc/windowBounds.ts:69-116` writes Swift source into `userData/native-tools` and runs `swiftc` | **Capturia hardening gap** | M | Prebuild `window-bounds-helper` in `scripts/build-native-macos-helper.mjs` + `extraResources`, drop runtime compile (fails silently on Macs without Xcode CLT anyway) |
| P1 | `setPermissionCheckHandler` / `setPermissionRequestHandler` allowlist | 7833dee0, c9b60746; `main.ts:521-545` | **MISSING** (Electron default = grant everything) | S | Port both handlers verbatim |
| P2 | Proactive mic ask + screen TCC probe at startup | 7833dee0, be4e2d0c; `main.ts:563-570`, `requestScreenAccess` `handlers.ts:1310-1343` | **PRESENT-DIFFERENT** - Capturia has a richer model: `getCapturePermissionSnapshot`, per-key request, deep links, `PermissionCheckerWindow` | S | **Keep Capturia.** Fold in one detail: focus HUD + `app.focus({steal:true})` before triggering the TCC prompt (`handlers.ts:1324-1331`) so the dialog is not hidden |
| P3 | `NSScreenCaptureUsageDescription` + entitlements | f47fa6bd, 3dd7b85e; `macos.entitlements`, `electron-builder.json5` mac block | **PARTIAL** - usage strings present; `build/entitlements.mac.plist` lacks `com.apple.security.device.screen-capture`; no `NSCameraUseContinuityCameraDeviceType`; no explicit `notarize` | S | Add the three keys |
| P4 | Record permissions prompt / gate source selector on screen access | 43b01cfb; `open-source-selector` `handlers.ts:1463-1500` | **PRESENT-DIFFERENT** (Capturia gates via checker + `getSourcesWithFallback`) | - | Keep Capturia |
| P5 | Camera permission (`src/lib/requestCameraAccess.ts`, `request-camera-access`) | `handlers.ts:1394-1424` | **PRESENT-DIFFERENT** (`request-capture-permission-access('camera')`) | - | Keep Capturia; optional: renderer `getUserMedia` probe fallback on non-mac |
| P6 | `disable-features=MacCatapLoopbackAudioForScreenShare` | `main.ts:34-39` | **MISSING** | S | Port only if A enables system-audio capture via `getDisplayMedia` on macOS (dev-run crash avoidance) |
| L1 | Single instance lock + duplicate HUD guard | 77904538, 59cfe26f; **final state = 83ea5edb (v1.8) drops `singleInstanceLock.ts`** | **MISSING** | S | Port `app.requestSingleInstanceLock()` + `second-instance -> showMainWindow` + `createWindow` guard. **Do NOT port `electron/singleInstanceLock.ts`/test** (PID-file lock bricked startup on Windows, reverted upstream) |
| L2 | macOS dock lifecycle | 6fc19314; `main.ts:485-499,515-519` | **PARTIAL** | S | Port `app.dock?.show()` and the `activate` visible-window check; keep Capturia's `window-all-closed` (stay alive with tray) |
| L3 | HUD/editor anti-flash | 34ef71b3 (+9f6ef0f5 `HEADLESS`); `windows.ts:118,137-139,186,207-217` | **MISSING** | S | `show:false` + `ready-to-show` for editor (safe) and HUD (verify on Linux X11 `type:'dock'` path); editor `dom-ready` insertCSS; `HEADLESS` env for e2e |
| L4 | Tray click opens/focuses HUD; small-window refactor | 4655e71c; `main.ts:104-123,313-321` | **PARTIAL** (Capturia tray = context menu only; `createWindow` unguarded) | S | Port `showMainWindow()` + tray `click`/`double-click` |
| L5 | Custom install location (NSIS) | 56988e86; `electron-builder.json5` `nsis` block | **MISSING** | S | Add `nsis: { oneClick:false, allowToChangeInstallationDirectory:true }` |
| L6 | Normalise paths on all OS (main side) | 5f657676; `normalizeVideoSourcePath` `handlers.ts:371-390`, `path.normalize` on dialog results | **PARTIAL** (renderer side is B1/B3) | S | Port `normalizeVideoSourcePath` (file:// -> path) into `paths.ts`; normalise every path returned by dialogs |
| L7 | Wayland/Hyprland dialog parent | 31f0483c; `buildDialogOptions` `handlers.ts:103-112` | **MISSING** - 4 dialogs (`handlers.ts:1814,1856,1877,1908`, `save-diagnostic`) have no parent | S | Port helper; keep Capturia's own Wayland GPU switches (`main.ts:22-28`). Flag `WebRTCPipeWireCapturer` to A |
| M1 | Main-process i18n + dynamic application menu | bb30e20d, 59ecedb0, a1a75bad; `electron/i18n.ts`, `main.ts:162-311,575-579` | **PRESENT-DIFFERENT** - ad-hoc en/zh-CN dictionaries in `main.ts:113-135,228-245` and `tt()` in `handlers.ts`; **no application menu** | M | Port `electron/i18n.ts` shape once B3 fixes locale file layout (Capturia is a single `src/i18n/index.tsx`); `set-locale` IPC so main follows renderer language. Menu: see M10-edit-menu (macOS Cmd+Z bug) |
| M2 | Diagnostics ring buffer + `save-diagnostic` | 09f6348d `electron/diagnostics/main-log-buffer.ts` (+test), a0c423de `handlers.ts:3004-3050` | **MISSING**; Capturia has its own error dialog -> GitHub issue (`main.ts:161-226`, `src/lib/userErrorFeedback.ts`) | S/M | Port buffer + test verbatim (env `CAPTURIA_DIAGNOSTIC`); add `save-diagnostic`; append buffer tail to the issue body |
| M2b | `scripts/diagnostic-tool/*`, `diagnostic-artifact.yml` | 09f6348d | **N/A** (drives upstream's WGC/SCK helper CLI; Capturia's `sck-recorder` has a different protocol) | - | Note only |
| M3 | `electron/globalShortcut.ts` (configurable open-app shortcut, accelerator conversion, register-before-unregister) | 480890bc, d86c1740, 59c9a192, 902d4e4d | **PARTIAL** - Capturia has `registerStopRecordingShortcut` (`main.ts:290-328`, raw accelerator string) | M | Generalise upstream module to N actions (`openApp`, `stopRecording`); reuse `bindingToAccelerator`. `ShortcutBinding` type is identical in both repos. Adding `openApp` to `SHORTCUT_ACTIONS` is B3/UI |
| M4 | Tray vertical layout (HUD resize/move/click-through IPC) | c35a899a; `windows.ts:27-81`, `preload.ts:26-34` | **PRESENT-DIFFERENT** (Capturia HUD: fixed window, CSS compact bar, Linux `focusable:false`/`type:'dock'`) | - | Defer to A. Only port `hud-overlay-set-size`/`move-by`/`ignore-mouse-events` if A adopts upstream's HUD |
| M5 | Streaming recordings to disk (main side) | f3c5b8a6 (+36d7d2bd, 5c5cab69 are renderer); `electron/ipc/recordingStream.ts` + test; `resolveRecordingOutputPath`, `finalizeRecordingFile` (`handlers.ts:254-296`); `electron/recording/webm-duration.ts` + test (727e395f, 4613c283, 411171ce) | **MISSING** (Capturia buffers whole blob, `fixWebmDuration` in renderer `useScreenRecorder.ts:1157`) | M | Port both modules + tests verbatim (self-contained). Needs `@fix-webm-duration/parser` as a direct dep (already present transitively). Renderer `recorderHandle.ts` is A |
| M6 | Project import / new project IPC | 34ef71b3; `load-project-file-from-path`, `webUtils.getPathForFile`, menu channels | **N/A** (B3 owns; Capturia persists state per video, not project files) | - | Note: touches preload + both d.ts files |
| M7 | Last export location handlers | 9af31856 (#512); `pick-export-save-path(fileName, exportFolder)` `handlers.ts:2437-2486` | **PRESENT-DIFFERENT** - Capturia has `pick-export-directory`, `pick-save-file-path`, `targetFilePath` flow (e22e141) | S | Keep Capturia; add upstream's `fs.stat` validation of the remembered folder before using it as `defaultPath` |
| M8 | `electron/native-bridge/*` + `ipc/nativeBridge.ts` (44f59bfa) | see section 3.8 | **MISSING** | L (incremental) | **Do not adopt the bridge envelope.** Adopt the *structure*: split `handlers.ts` by domain into `register*Handlers(ctx)` modules (upstream's `registerRecordingStreamHandlers` pattern) |
| M9 | v1.8+: `main-process-errors.ts` (+test) | d68ab84a | **MISSING** - Capturia's `reportRuntimeError` (`main.ts:372-377`) shows a dialog for EPIPE/ECONNRESET too | S | Port `shouldSwallowMainProcessError` as a filter in front of `reportRuntimeError`; keep Capturia's dialog (do not re-throw) |
| M10 | v1.8+: `edit-menu.ts` (+test) | 90459e24, efc7544f | **MISSING - likely live bug on macOS**: Capturia has no app menu, so Electron's default Edit menu `role:"undo"` swallows Cmd+Z before the renderer's undo/redo (`566e481`) sees it (upstream #433) | S/M | Port with an application menu (M1) - verify on a Mac first |
| M11 | v1.8+: `about.ts`, `install-channel.ts` (+tests) | f210c833, 56241090, 01cb74a0 | **MISSING** (Capturia shows version in settings footer only) | S | Pure modules; port `install-channel` (feeds issue-report body + gates any updater) and About box |
| M12 | v1.8+: `auto-updater.ts`, `update-checker.ts` (+tests) | 01cb74a0, c2163cfe, 140859cf, dee0452f | **MISSING** | M / L | Port `update-checker.ts` (manual "check for updates" against GitHub releases/latest, pure + tested) first. `electron-updater` needs `publish` config + `latest*.yml`/blockmaps uploaded by `release.yml` - product decision, defer |
| M13 | v1.8+: `media/audioPeaks.ts`, `recording/deviceNameMatching.ts` | 33e9641b, de3fef6a | **N/A** (needs bundled ffmpeg / Windows WGC helper) | - | Note only (D may care about peaks) |
| M14 | v1.8+: `src/hooks/rendererConsoleForwarder.ts` | 1320121d | **PRESENT-DIFFERENT** - `attachDevWindowLogging` in `windows.ts:16-30` (uses the deprecated positional `console-message` signature) | S | Keep Capturia; **fix the signature before Electron 41** (see B4) |
| M15 | v1.8+: `scripts/check-docs.mjs` | 066a2f7d | N/A / optional | S | Could lint `docs/upstream-sync` links; low value |
| M16 | v1.8+: `scripts/set-release-version.mjs` | - | **Does not exist** in upstream main; RC bump is `sed` in `prerelease.yml:109` | - | Nothing to port |
| B1 | Node/npm pinning | c84c2447; `.nvmrc`, `engines`, `packageManager` | **MISSING** | S | Pin `node 22.x` / `npm 10.x`, `.nvmrc`, `node-version-file: .nvmrc` in workflows |
| B2 | ESLint -> Biome | b472c768; `biome.json` (fork base already had Biome; Capturia's initial commit re-added ESLint) | **PRESENT-DIFFERENT** | M | **Switch** (section 4) - lint rules first, formatter in a single end-of-sync commit |
| B3 | husky + lint-staged | `.husky/pre-commit`, `lint-staged` in package.json | **MISSING** | S | Port with Biome |
| B4 | vite 7 / vitest 4.1 / electron 41 / plugin-react 5 / TS 5.9 | 41a26f3e, 659affa8 | **DONE (F8, 2026-09-03)** - vite 7.3.6 / vitest 4.1.11 / plugin-react 5.2.0 / vite-plugin-electron 0.29.1 / esbuild 0.27.7 explicit / TS ^5.9.3 / Electron 41.10.7; one `vite` and one `esbuild` in the lock | M (3 PRs) | Section 4.2. Electron 41.10 embeds Node 24.18, `@types/node` stays 22 (conservative) |
| B5 | Remove `electron-icon-builder`, `electron-rebuild` | 018ba08e | **MISSING** - both present, unreferenced (grep verified) | S | Remove (kills the 22-vuln audit chain) |
| B6 | sharp prebuilt / `buildDependenciesFromSource:false` | c6331bad | **DONE (F8)** - `sharp` *is* in the lock (optional dep of `@xenova/transformers`) and gets packaged; `npmRebuild:false`, `buildDependenciesFromSource:false`, `asarUnpack: **/*.node`, `install-app-deps` step dropped from both workflows | S | electron-builder 26.15.3; `--dir --linux` verified locally (rebuild skipped) |
| B7 | Hardened runtime / entitlements / notarization | 78901a80, build.yml `build-macos` job | **DONE (F9, unverified on a runner)** - `release.yml` mac legs: secrets-gated `CSC_LINK`/`CSC_KEY_PASSWORD` signing through electron-builder, `codesign --verify`, `notarytool submit --wait`, `stapler staple/validate`, `spctl`; skipped entirely when any secret is absent; `mac.notarize:false` explicit | M | `scripts/build_macos.sh` not ported (workflow is the single path) |
| B8 | AppImage update info / `publish` block | 7e298d3b; main `electron-builder.json5:19-39` | **MISSING (deferred by F9)** - needs a `publish` block, not a one-liner | S | Only with M12; upload `*.zsync` in `release.yml` |
| B9 | Arch/Hyprland: `pacman` target | 31f0483c | **MISSING** | S | Optional; needs `libarchive-tools` on the Linux runner |
| B10 | Nix flake | 64cdc0dd | N/A | - | Note only |
| B11 | `scripts/before-pack.cjs` | 3e3a8168 | N/A (caption model fetch; D's call) | - | Note only |
| B12 | `.github/workflows/ci.yml` (lint+typecheck+test+build+semantic-pr), `actions/setup` composite | 17aa4a2a, da4e1cab | **PARTIAL** - Capturia `build.yml` `validate` job = tsc + vitest (no lint, because lint is red) | S | Add composite setup action + lint job once Biome baseline is fixed; semantic-pr optional |
| B13 | `tsconfig.test.json` + "Typecheck (tests)" job | 35462ee8 (v1.8) | **MISSING** - test files never typechecked | S | Port; expect an initial error backlog, use the ratchet pattern then zero |
| B14 | Playwright e2e (`tests/e2e/gif-export.spec.ts`, xvfb, swiftshader, `HEADLESS`) | 9f6ef0f5, 61d89831, **d4c50c9a removed the CI job as flaky**; still runnable locally | **MISSING** | M | Port spec adapted to Capturia's `save-exported-video` IPC as a local/nightly check, **not** a PR gate |
| B15 | Release-candidate pipeline (prerelease/promote, `release/vX.Y.Z` branches) | da4e1cab | N/A - guard **DONE (F9)** | - | Capturia's tag-driven `release.yml` kept; the `package.json version == tag` guard now runs in its `validate` job on tag pushes |
| B16 | CODEOWNERS, `.editorconfig` | - | **MISSING** | S | Add `* @MinhOmega`, `.editorconfig` |

---

## 2. Security items (priority)

### S1. `local-media://` protocol - arbitrary file read (Capturia-specific)

`electron/main.ts:426-481` (`protocol.handle('local-media', ...)`): `filePath = decodeURIComponent(url.pathname)`,
then `statSync`/`readFileSync` with no allowlist. The editor renderer runs with
`webSecurity: false` (`windows.ts:185`), and the scheme is registered `standard, secure,
supportFetchAPI` (`main.ts:81-91`), so any renderer code (or an XSS-class bug in it) can
`fetch('local-media://host/etc/passwd')`. Upstream never had this protocol; it reads video
through `read-binary-file`/`read-file-chunk` gated by `approveReadableVideoPath`
(`/tmp/openscreen-v1.7.0/electron/ipc/handlers.ts:214-252`): allowed = inside
`RECORDINGS_DIR` **or** in `approvedPaths` (paths the user picked via a dialog or a loaded
project), and extension in `ALLOWED_IMPORT_VIDEO_EXTENSIONS`.

Port plan:
- New `electron/ipc/paths.ts` (testable, no `app.getPath` at import): `approveFilePath`,
  `isPathWithinDir`, `isPathAllowed(filePath, allowedDirs)`, `normalizeVideoSourcePath`,
  `hasAllowedImportVideoExtension`, `resolveRecordingOutputPath`. Copy from upstream
  `handlers.ts:66-116, 254-272, 371-390` (all pure). Extend the extension set with
  `.json` (Capturia sidecars `*.cursor.json`, analysis sidecar) and `.png/.jpg` if the
  protocol is used for images (check `VideoEditor.tsx:607-622`; today only video).
- Gate `protocol.handle('local-media')` on `isPathAllowed`, return 403 otherwise.
- Call `approveFilePath` from `open-video-file-picker` (`handlers.ts:1905`) and
  `set-current-video-path` after validation.
- Tests: new `electron/ipc/paths.test.ts` (traversal, `file://` input, ext allowlist,
  approved set). Upstream has no unit test for these helpers - write ours.

### S2. Recording file name traversal
`handlers.ts:1590` `path.join(RECORDINGS_DIR, fileName)` with renderer `fileName`
(`recording-${timestamp}.webm` in practice). Port `resolveRecordingOutputPath`
(rejects `..`, separators, absolute). Same guard for the webcam file if A ports dual-track.

### S3. `open-external-url`
Port the **main** version (`EXTERNAL_URL_PROTOCOLS`), not v1.7.0's (the cf6dce55 fix was
lost in a merge and v1.7.0 `handlers.ts:2422-2431` is unguarded again). Capturia calls it
from `userErrorFeedback.ts:58` and `PERMISSION_SETTINGS_URLS` (x-apple.systempreferences: -
those go through `shell.openExternal` directly in `handlers.ts:350`, not this handler, so the
allowlist does not need `x-apple.systempreferences:`).

### S4. Export writes
`save-exported-video` `handlers.ts:1796-1831`: `targetFilePath`/`directoryPath` come from
the renderer. Upstream `write-export-to-path` (`handlers.ts:2488-2517`) checks absolute +
`.mp4/.gif`. Capturia should additionally remember the paths returned by
`pick-save-file-path`/`pick-export-directory` and refuse others (the renderer only ever
echoes them back). `reveal-in-folder` (`handlers.ts:1771`): restrict to that same set plus
`RECORDINGS_DIR`.

### S5. Video path inputs
`set-current-video-path` (`handlers.ts:1936`) then `readCursorTrackSidecar` reads
`<dir>/<name>.cursor.json`; `analysis-start` (`handlers.ts:2016`) passes `videoPath` to the
Swift `speech-transcriber` helper. Both must go through `normalizeVideoSourcePath` +
`isPathAllowed`.

### S9. `windowBounds.ts` runtime `swiftc`
Not an upstream item, but flagged: writes `window-bounds-helper.swift` into `userData` and
executes the compiled binary. Any process able to write `~/Library/Application Support/Capturia/native-tools/window-bounds-helper` gets code execution inside Capturia's TCC scope.
Prebuild it like the other four helpers in `scripts/build-native-macos-helper.mjs` and add
an `extraResources` entry; `getWindowBoundsById` then resolves like `sckRecorder.ts:167-169`.
(A owns cursor mapping semantics; build/packaging is F.)

---

## 3. Per-item detail

### 3.1 Permissions (P1-P6)
- **P1** `main.ts:521-545` upstream. Capturia has none; Electron grants every permission
  request by default (notifications, geolocation, clipboard...). Port both handlers with the
  7-entry allowlist. No test upstream (main.ts is untestable); none needed.
- **P2** Capturia wins. Capturia: `getCapturePermissionSnapshot` (`handlers.ts:240-330`),
  `requestScreenPermissionAccess` (`handlers.ts:347-373`, probes `desktopCapturer` then opens
  settings), `requestMediaPermissionAccess`, accessibility + input-monitoring, plus
  `src/lib/permissions/*` with 3 test files and `PermissionCheckerWindow.tsx`. Upstream v1.7.0
  only has camera/screen/mac-cursor accessibility. One thing to borrow: before probing
  `desktopCapturer` in `requestScreenPermissionAccess`, `mainWin.show(); mainWin.focus();
  app.focus({steal:true})` (upstream `handlers.ts:1324-1331`) so the TCC sheet is not behind
  the source selector/checker window.
- **P3** `build/entitlements.mac.plist`: add `com.apple.security.device.screen-capture`
  (upstream reports #548 fixed with it; harmless if Apple ignores it). `electron-builder.json5`
  mac: `"notarize": false` explicit (electron-builder 26 otherwise tries when `APPLE_ID` env
  is set), `NSCameraUseContinuityCameraDeviceType: true` in `extendInfo`. Keep Capturia's
  `NSSpeechRecognitionUsageDescription`.
- **P6** Only relevant with `getDisplayMedia({audio:true})` on macOS in dev; A decides.

### 3.2 Lifecycle (L1-L7)
- **L1** Final upstream state (83ea5edb, 2026-08-04): *only* `app.requestSingleInstanceLock()`;
  the PID-file lock (`electron/singleInstanceLock.ts` + test in v1.7.0) was deleted because a
  recycled PID made the app exit 0 with no window. Port into `main.ts` top-level:
  ```ts
  const hasLock = app.requestSingleInstanceLock()
  if (!hasLock) app.quit()
  else app.on('second-instance', () => showMainWindow())
  ```
  plus `createWindow()` early-return when `mainWindow` alive (59cfe26f). Wrap `app.whenReady()`
  in `hasLock ?` like upstream `main.ts:506`. Dev and packaged builds have different
  `userData`, so they still run side by side.
- **L2** `app.dock?.show()` at ready (HUD is frameless+skipTaskbar, AppKit otherwise treats
  the app as accessory). `activate` handler: use `showMainWindow()` when no *visible* window.
  Keep Capturia's `window-all-closed` no-op (tray keeps app alive) - upstream changed to
  `app.quit()`, that is a product choice; Capturia's tray has Quit.
- **L3** Editor: `show:false`, `ready-to-show -> show`, `backgroundColor '#09090b'`
  (Capturia uses `#000000`), `dom-ready` insertCSS. HUD: `show:false` + `ready-to-show`; on
  Linux X11 Capturia sets `focusable:false, type:'dock'` - `show()` from `ready-to-show`
  works the same but re-test the always-on-top re-apply in `windows.ts:108-138`
  (`win.once('show')` still fires). Add `HEADLESS` env gate for e2e (B14).
- **L4** `showMainWindow()` = restore-if-minimized + show + focus, else create. Wire to tray
  `click`/`double-click` and the tray `Open` item (replaces `main.ts:264-269`).
- **L6** Capturia `normalizeLocale`/`tt` already localise dialogs; add `path.normalize()` on
  every dialog `filePath` returned (`handlers.ts:1826,1867,1888,1922`).
- **L7** `buildDialogOptions(base, getMainWindow())` for all 4 dialogs + `save-diagnostic`.

### 3.3 Main-process i18n + menu (M1, M10)
Upstream `electron/i18n.ts` imports `src/i18n/locales/<locale>/{common,dialogs}.json` and
exposes `mainT(ns, key, vars)` + `setMainLocale`; renderer calls `set-locale` on language
change (`main.ts:575-579`) which rebuilds menu + tray. Capturia's i18n is one TSX module with
inline dictionaries (`src/i18n/index.tsx`, en + zh-CN), so a direct port is blocked on B3's
locale layout. Interim: keep `trayText`/`runtimeErrorText`, but add the `set-locale` IPC now so
main stops guessing from `app.getLocale()` (a user who switches to English on a zh-CN OS gets
a zh-CN tray today).

Application menu: Capturia has **no** `Menu.setApplicationMenu`, so the Electron default menu
is active. On macOS the default Edit menu's `role:"undo"` key equivalent (Cmd+Z) is matched by
AppKit before the renderer keydown (upstream #433, fixed by `electron/edit-menu.ts`
90459e24/efc7544f which forwards `menu-undo`/`menu-redo` to the editor renderer and falls
back to `webContents.undo()` for non-editor windows). Capturia's `useUndoRedo` shortcut
(`566e481`) is probably dead on macOS for the same reason - verify on hardware, then port
`edit-menu.ts` + `edit-menu.test.ts` and a minimal `setupApplicationMenu` (App/File/Edit/View/
Window with roles; File items for project ops wait for B3). Renderer side: listen for
`menu-undo`/`menu-redo` in the editor (preload + both d.ts files).

### 3.4 Diagnostics (M2)
`MainLogBuffer` (`electron/diagnostics/main-log-buffer.ts`, 102 lines, 6 tests) is pure; port
verbatim, env `CAPTURIA_DIAGNOSTIC`. Install it *always at low capacity* (not env-gated) so
`showRuntimeErrorDialog` (`main.ts:161`) can include the last ~50 main-process lines in the
issue body (`buildIssueReportUrl` already truncates to 7.5 KB). Add `save-diagnostic`
(`handlers.ts:3004-3050`, drop the WGC/SCK helper-output fields, add Capturia's
`sck-recorder` last stderr lines from `sckRecorder.ts:354` if captured). Renderer button is in
upstream `SettingsPanel.tsx` (a0c423de) - trivial. Tests: `main-log-buffer.test.ts`.

### 3.5 Global shortcuts (M3)
Upstream `globalShortcut.ts` (77 lines): `bindingToAccelerator` with `KEY_TO_ACCELERATOR`
map (d86c1740), register-new-before-unregister-old (59c9a192), failure feedback (902d4e4d),
persistence via `shortcuts.json.openApp`. Capturia: `registerStopRecordingShortcut`
(`main.ts:290-328`) takes a raw accelerator from `LaunchWindow.tsx:418` and keeps it in memory
only (not persisted; default `CommandOrControl+Shift+2`). Merge: one module with a
`Map<action, accelerator>`; `stopRecording` and `openApp` actions; persist both in
`shortcuts.json`; convert Capturia's stop shortcut UI to a `ShortcutBinding` (UI is B3). Add a
unit test for `bindingToAccelerator` (upstream has none).

### 3.6 Streaming recordings, main side (M5)
Port verbatim: `electron/ipc/recordingStream.ts` (+7 tests, real tmp fs) and
`electron/recording/webm-duration.ts` (+test, fixtures `tests/fixtures/sample*.webm`). Wire
`registerRecordingStreamHandlers(ipcMain, registry, resolveRecordingOutputPath)` and make
`store-recorded-video` call `finalizeRecordingFile` (`handlers.ts:283-294`) then
`patchWebmDurationOnDisk` when streamed. `recordingsCleanup` `excludePaths` must include the
in-flight stream file. Vitest `include` must gain `electron/**` (Capturia's
`vitest.config.ts` only collects `src/**`; upstream 7216a7e8/f3c5b8a6). Dependency:
`@fix-webm-duration/parser` as a direct dep. Renderer (`recorderHandle.ts`, 36d7d2bd,
5c5cab69) is A - but note 5c5cab69: renderer must require *both* `openRecordingStream` and
`appendRecordingChunk` on `electronAPI` before streaming.

### 3.7 Export location (M7)
Keep Capturia. Borrow: `fs.stat(exportFolder).isDirectory()` before using a remembered folder
as `defaultPath` (`handlers.ts:2447-2459`) - Capturia's `pick-save-file-path` uses
`downloads` unconditionally and `save-exported-video` `mkdir -p`s the remembered dir (S4).

### 3.8 Native bridge (M8) - should `handlers.ts` adopt it?
What it is (44f59bfa): one `native-bridge:invoke` channel with a versioned
`{domain, action, payload}` request and `{ok, data|error, meta}` envelope
(`src/native/contracts.ts`), a `NativeBridgeStateStore`, three services (system, project,
cursor) and a renderer client (`src/native/client.ts`). Reality in v1.7.0: the bridge covers
13 actions; the legacy `electronAPI` still has ~60 channels and is what the app uses;
only 3 renderer files touch the bridge; upstream itself moved on in v1.10 (5936e5f6 "one
document service"). Verdict: **do not port the envelope/store/services** - it adds a second
IPC style without removing the first.

What *is* worth taking is the decomposition pattern already present in v1.7.0:
`registerRecordingStreamHandlers(ipcMain, registry, resolvePath)` and
`registerNativeBridgeHandlers(context)` - modules that take a small context object and
register their own channels. Proposed split of Capturia's `handlers.ts` (2167 lines; only
`registerIpcHandlers` at `:1122` and `RECORDINGS_DIR` import at `:6` are entry points):

| New module | Lines today | Notes |
|---|---|---|
| `electron/ipc/paths.ts` | new | S1/S2/L6 policy; pure; tested |
| `electron/ipc/permissions.ts` | `handlers.ts:~120-440` + handlers `1470-1555` | pure functions already; `PERMISSION_SETTINGS_URLS` |
| `electron/ipc/cursorTracker.ts` | `~440-1180` + handlers `1174,1430` | biggest chunk; A/B2 touch the algorithm, F only moves it |
| `electron/ipc/recordingFiles.ts` | `1588-1640,1646-1746` + M5 | store/native start-stop |
| `electron/ipc/exportFiles.ts` | `1748-1935` | dialogs (L7), S3/S4 |
| `electron/ipc/projectState.ts` | `1936-2012,2128-2145` | shortcuts file too |
| `electron/ipc/analysis.ts` | `2016-2125` | S5 |

Also break the `main.ts <-> handlers.ts` import cycle (`RECORDINGS_DIR`): put
`getRecordingsDir()` in `electron/paths.ts` (lazy `app.getPath`), which is what makes the
new modules loadable in vitest (upstream's own note in `deviceNameMatching.ts:275-276`:
handlers.ts "calls app.getPath() while being imported and cannot be loaded from a test").
Do this one module per batch, never as a big-bang refactor.

**Status (2026-09-03, F11):** done as listed, one commit per module. Actual layout:
`electron/paths.ts` (lazy `getRecordingsDir`/`getProjectsDir`), `electron/ipc/context.ts`
(`IpcContext`, `IpcSession`), `cursorTrack.ts` (pure) + `cursorTracker.ts` (runtime),
`permissions.ts`, `recordingFiles.ts` (also owns the recording-stream registry and source
selection), `exportFiles.ts`, `projectState.ts`, `analysis.ts`. `handlers.test.ts` pins the
channel set; `__tests__/modules-import.test.ts` fails if any module touches `app` on import.

### 3.9 v1.8+ modules (M9-M16)
- `main-process-errors.ts`: port `shouldSwallowMainProcessError` + test; in Capturia call it
  first in the `uncaughtException`/`unhandledRejection` handlers (`main.ts:372-377`) and
  `console.warn` instead of dialog. Do not port `installMainProcessErrorGuards`' re-throw.
- `install-channel.ts` + `about.ts`: pure, tested; `classifyInstall` needs `process.windowsStore`,
  `APPIMAGE`, `package-type` marker (only written when a `publish` config resolves - B8).
  Use channel in `showRuntimeErrorDialog` issue body. About box: `Menu` role `about` on mac
  (`app.setAboutPanelOptions`), `dialog.showMessageBox` elsewhere.
- `update-checker.ts` (v1.9, 140859cf + dee0452f hardening): pure fetch + strict semver
  compare + official-URL check, tested; point at `MinhOmega/Capturia`. Good first step before
  `electron-updater` (M12/B8: needs `publish` block, `latest*.yml` + `.blockmap` uploaded by
  `release.yml`, and macOS signing - B7 - or Squirrel refuses to install).
- `rendererConsoleForwarder.ts`: skip; but `windows.ts:19` uses the **deprecated** positional
  `console-message` listener (Electron 39 `electron.d.ts:15337-15368` marks `level, message,
  line, sourceId` `@deprecated`; new form is `(event, details)` with `details.level`
  (`'info'|'warning'|'error'|'debug'`), `details.message`, `details.lineNumber`,
  `details.sourceId`). Fix before B4 (Electron 41) regardless of whether the old form still
  fires there - I did not verify removal in 41's changelog.
  **Status (2026-09-03):** `update-checker.ts` + test ported (menu item, dialog, release page
  via the URL allowlist); `console-message` moved to the details form in `windows.ts`.

### 3.10 Packaging / `electron-builder.json5` three-way diff
| Key | base 87735c27 | Capturia | v1.7.0 | Action |
|---|---|---|---|---|
| `appId`/`productName` | openscreen | `com.capturia.app`/Capturia | openscreen | keep |
| `asarUnpack` | - | - | `**/*.node` | add only if a native npm module appears |
| `beforePack` | - | - | `scripts/before-pack.cjs` (caption model) | D decides |
| `npmRebuild`/`buildDependenciesFromSource` | true/true | true/true | true/false | set both false (no native deps; faster CI) |
| `extraResources` wallpapers | `assets/wallpapers` | `assets/wallpapers` | `wallpapers` + `cursors` + `caption-assets` | keep `assets/` (B1 resolver contract); add `cursors` only with B2's cursor assets |
| mac `hardenedRuntime`/entitlements | - | `build/entitlements.mac*.plist`, `gatekeeperAssess:false` | `macos.entitlements` x2, `notarize:false` | add `notarize:false`, screen-capture key |
| mac `extendInfo` | - | 4 usage strings incl. speech | 4 strings + Continuity flag | add Continuity flag |
| mac `extraResources` | - | 4 individual helpers -> `native/<name>` | `electron/native/bin` filtered `darwin-*/*` | keep Capturia (add window-bounds helper, S9) |
| linux targets | AppImage | AppImage, deb, `executableArgs --disable-gpu`, `StartupWMClass` | AppImage, deb, pacman | optional pacman; re-evaluate `--disable-gpu` after Electron 41 |
| win | nsis | nsis, `${productName}-Setup-${version}` | nsis + `nsis` block | add `nsis` block (L5) |
| `publish` | - | - (scripts pass `--publish never`) | - (main: github provider, still `--publish never`) | B8/M12 only |

### 3.11 CI / workflows
Capturia (`e59de4d`, 2026-03-19): `build.yml` on push/PR = `validate` (tsc + vitest) then a
4-leg matrix (windows-latest, ubuntu-latest, macos-15-intel, macos-15) building installers on
**every push and PR** (~4 runners x ~10 min per change); `release.yml` on `v*` tags = same +
`softprops/action-gh-release`. Upstream v1.7.0: `ci.yml` (lint, typecheck, test, vite build,
semantic-pr) on PR/push; `build.yml` only on tags/dispatch with a secrets-gated macOS
sign+notarize path (`build.yml:88-230`) and `caption-assets` cache.

Recommendations:
1. Split Capturia `build.yml`: cheap `ci.yml` on PR/push (lint once green, `tsc --noEmit`,
   `tsc -p tsconfig.test.json --noEmit`, `vitest --run`, `vite build`); installer matrix on
   `workflow_dispatch` + tags only (or keep on `main` push if the artifacts are used).
2. Composite `.github/actions/setup/action.yml` (node from `.nvmrc`, `cache: npm`, `npm ci`).
3. Port the macOS signing block into `release.yml` mac legs, gated on the same six secrets;
   keep Capturia's two-runner matrix (`macos-15-intel`/`macos-15`) instead of upstream's
   `macos-latest --arch`. Keep `publish never`.
4. Version guard: fail the release if `package.json.version != tag` (`build.yml:294-301`).
5. e2e: port `tests/e2e/gif-export.spec.ts` + `playwright.config.ts` + fixture, adapted:
   Capturia's export IPC is `save-exported-video(videoData, fileName, locale, options)` not
   `pick-export-save-path`/`write-export-to-path`; needs `data-testid` hooks (`src/utils/getTestId.ts`)
   in Capturia's export UI (D) and the `HEADLESS` gate in `windows.ts`. Run under
   `xvfb-run --auto-servernum` with `--no-sandbox --enable-unsafe-swiftshader`
   (61d89831 job as the template). Upstream removed it from PR CI as flaky 3 weeks later
   (d4c50c9a); run it nightly/dispatch, not as a gate.

---

## 4. Tooling decisions

### 4.1 ESLint vs Biome - recommendation: switch to Biome 2.4
Facts: the fork base already shipped `biome.json` (Biome 2.3.13); Capturia's initial commit
(5752f38) added `.eslintrc.cjs` (ESLint 8.57, `@typescript-eslint` 7, `react-hooks`,
`react-refresh`) - ESLint 8 is EOL and the flat-config migration would be its own chore
anyway. Upstream v1.7.0 `biome.json` is essentially the ESLint-recommended rule set
transcribed (`recommended:false` + explicit rules), plus `useHookAtTopLevel: error`,
`useExhaustiveDependencies: warn`, `noExplicitAny: warn`, `useComponentExportOnlyModules: off`
(= `react-refresh/only-export-components` dropped), organize-imports assist. Every file ported
from upstream is Biome-formatted (tabs, double quotes, 100 cols); Capturia is 2-space, mostly
single quotes, mixed semicolons.

Plan:
1. Batch T1 (early): add `@biomejs/biome ^2.4.12`, upstream `biome.json` with the **formatter
   set to Capturia's style** (`indentStyle: "space"`, `indentWidth: 2`, `quoteStyle: "single"`,
   `semicolons: "asNeeded"`, `lineWidth: 100`) but `formatter.enabled: false` and
   `assist.organizeImports` off for now; `npm run lint = biome lint .`; record the new
   baseline in `README.md` (it replaces "59 problems"); remove ESLint + 4 plugins. Keep
   `--max-warnings 0` semantics by treating Biome warnings as informational and errors as
   the gate.
2. Add husky + lint-staged (`biome check --no-errors-on-unmatched`) in the same batch.
3. Batch T-last (end of sync): enable the formatter, run `biome format --write .` once as a
   dedicated commit (`.git-blame-ignore-revs`). Doing it earlier makes every port PR a
   whole-file diff.

### 4.2 Dependency upgrades (Capturia lock -> v1.7.0)
| Package | Capturia (lock) | v1.7.0 | Risk / notes |
|---|---|---|---|
| electron | 39.2.7 | 41.2.1 | `console-message` signature (3.9); Capturia's Wayland `disableHardwareAcceleration` (`main.ts:22-28`, "Electron 39 can hard-crash") may become unnecessary - re-test Ubuntu Wayland; macOS 26 content-protection note in upstream AGENTS.md is v1.10-only |
| electron-builder | **24.13.3** (base was ^26.7.0; Capturia downgraded in 5752f38) | 26.8.1 (main 26.15.3) | 26 needed for `pacman`, `notarize` option, current NSIS; migration notes: `mac.notarize` semantics changed in 25/26 (explicit `false` recommended) |
| vite | 5.4.21 (+ nested 7.3.0 under vitest) | 7.3.2 | vitest 4.0.16 peer `vite ^6||^7||^8` is satisfied only by the nested copy = duplicate bundler, the situation 659affa8 fixed. Vite 7 needs Node 20.19+/22.12+ (ok). `manualChunks` object form still works (upstream switched to function form for rolldown/vite 8 compat, not required for 7). Add `esbuild ^0.27` explicitly (peer of `vite-plugin-electron-renderer`) |
| vitest | 4.0.16 | 4.1.4 | low |
| @vitejs/plugin-react | 4.7.0 | 5.2.0 | required for vite 7 |
| vite-plugin-electron | 0.28.8 | 0.29.1 | required for vite 7 |
| typescript | 5.9.3 (declared ^5.2.2) | 5.9.3 | bump the declaration only |
| @types/node | 25.0.3 | 22.19.17 | Capturia types Node 25 APIs that Electron 39/41 (Node 22.x) do not have - downgrade to ^22 |
| jsdom / testing-library | - | 29 / RTL 16 | only if B-streams port component tests; upstream vitest default env is `node` (v1.10) with per-file `@vitest-environment jsdom` |
| electron-icon-builder, electron-rebuild | present | removed | remove (B5) |
| @electron/rebuild | - | ^4.0.4 | not needed (no native npm modules) |
| husky, lint-staged, @biomejs/biome, @playwright/test | - | yes | T1 / B14 |

**Status 2026-09-03 (F8 batch)**: all four steps landed, one commit each, local gate green after
each (lint 0 errors, tsc, test types, i18n, vitest 115/1195, `vite build`). Installed:
electron-builder 26.15.3, vite 7.3.6, vitest 4.1.11, plugin-react 5.2.0, vite-plugin-electron 0.29.1,
esbuild 0.27.7, Electron 41.10.7 (Node 24.18 / Chromium 146). electron-builder 26 change that bit:
`linux.desktop` keys must sit under `desktop.entry`. `@rolldown/pluginutils` (pure JS) is the only
rolldown artefact. Electron 41 e2e launch smoke passed under xvfb; X11/Wayland/macOS runtime smoke is
still manual (`reviews/W4-F8-F9-deps-signing.md`).

Order (each its own PR, CI matrix green before the next): (1) B5 removals + Node pin +
`@types/node` 22; (2) electron-builder 26 (verify all 4 installer legs, NSIS block, mac
entitlements); (3) vite 7 + vitest 4.1 + plugin-react 5 + vite-plugin-electron 0.29 +
esbuild (check `vite.config.ts` `renderer: process.env.NODE_ENV === 'test' ? undefined : {}`
still valid with 0.29); (4) Electron 41 last, with manual smoke on Linux X11, Linux Wayland,
macOS (native helpers unaffected: they are separate binaries).

### 4.3 `tsconfig.test.json`
Port verbatim (`extends ./tsconfig.json`, `types: ["vitest/globals","node"]`,
`noUnusedParameters:false`, `include: ["src","electron","tests","scripts"]`, `exclude: []`).
Capturia's 32 test files have never been typechecked; expect errors. Upstream shipped the CI
job as a ratchet ("fail only if the count grows") and walked it to zero - copy that.

### 4.4 e2e
See 3.11 point 5. Prerequisite: `HEADLESS` gate (L3), `data-testid` hooks, and the spec's
IPC stubs re-targeted to `save-exported-video`. Do not gate PRs on it.
**Status (2026-09-03):** skeleton landed — `playwright.config.ts`, `e2e/launch.spec.ts`
(HUD + source selector; self-skips without a display / build), `npm run test:e2e`, nightly
`e2e.yml` (ubuntu xvfb + macos-15). Not executed locally (no display). The export spec still
needs the editor `data-testid` hooks (D) before it can be ported.

---

## 5. Recommended batches (independently testable)

| Batch | Contents | Hot files | Tests |
|---|---|---|---|
| **F0 Tooling base** | B5 remove dead devDeps, B1 Node pin + `.nvmrc`, `@types/node` 22, B16 CODEOWNERS/.editorconfig, B13 `tsconfig.test.json` (ratchet), composite setup action, split `ci.yml` | `package.json`, workflows | tsc, tsc -p test, vitest |
| **F1 Path policy + IPC security** (S1-S5, L6, L7) | `electron/ipc/paths.ts`, gate `local-media`, `resolveRecordingOutputPath`, URL allowlist, export path guard, dialog parents, `path.normalize` | `main.ts`, `handlers.ts` | new `paths.test.ts`; vitest `include` += `electron/**` |
| **F2 Permission + lifecycle hardening** (P1, P3, L1, L2, L4, M9) | permission handlers, entitlements/plist keys, single-instance (Electron API only), dock/show helpers, tray click, EPIPE filter | `main.ts`, `electron-builder.json5`, `build/entitlements.mac.plist` | `main-process-errors.test.ts`; manual mac/linux smoke |
| **F3 Tooling switch** (B2, B3) | Biome (lint only), husky, lint-staged, new baseline | `package.json`, `biome.json`, `.husky` | lint |
| **F4 Streaming main side** (M5, S2) | `recordingStream.ts`, `webm-duration.ts`, `finalizeRecordingFile`, stream handlers, `@fix-webm-duration/parser` | `handlers.ts`, `preload.ts`, both d.ts, `package.json` | 2 upstream test files + fixtures; pairs with A's `recorderHandle` batch |
| **F5 Diagnostics + shortcuts** (M2, M3) | `main-log-buffer.ts`, `save-diagnostic`, issue-body log tail, generalised `globalShortcut.ts` | `main.ts`, `handlers.ts`, `preload.ts`, both d.ts | `main-log-buffer.test.ts`, new accelerator test |
| **F6 Menu + i18n + About** (M1, M10, M11) | `set-locale` IPC, application menu, `edit-menu.ts`, `about.ts`, `install-channel.ts`; `electron/i18n.ts` after B3's locale layout | `main.ts`, `preload.ts`, both d.ts | 4 upstream test files; **verify Cmd+Z on macOS before/after** |
| **F7 Window polish** (L3, S8, L5) | anti-flash, `HEADLESS`, `--asset-base-url` additionalArguments (with B1), NSIS block | `windows.ts`, `preload.ts`, `electron-builder.json5` | manual; enables B14 |
| **F8 Dependency upgrades** (B4, B6) | electron-builder 26 -> vite 7 stack -> Electron 41 (3 PRs), `console-message` signature fix, `npmRebuild:false` | `package.json`, `vite.config.ts`, `windows.ts` | full CI matrix + manual smoke per platform |
| **F9 Release pipeline** (B7, B15 guard, optional B8/B9) | mac sign/notarize steps, version guard, pacman, zsync | workflows, `electron-builder.json5` | dispatch run |
| **F10 e2e + update check** (B14, M12 checker) | Playwright spec adapted, nightly job, `update-checker.ts` | `windows.ts`, `package.json` | playwright local; `update-checker.test.ts` |
| **F11 handlers.ts decomposition** (M8) | move domains into `register*Handlers(ctx)` modules, break `main<->handlers` cycle | `handlers.ts`, `main.ts` | existing + per-module tests; do one module per PR, ideally fold into F1/F4/F5 as those touch each domain |
| **T-last Format** | enable Biome formatter, one-shot format commit | everything | lint |

Order: F0 -> F1 -> F2 -> F3 -> F4 (with A) -> F5 -> F7 -> F6 (after B3 locale decision) ->
F8 -> F9 -> F10 -> F11 (continuous) -> T-last.

---

## 6. Do NOT port / keep Capturia's version

| Item | Reason |
|---|---|
| `electron/singleInstanceLock.ts` + test (77904538) | Deleted upstream in 83ea5edb: recycled PID made the app exit silently on Windows. Use only `app.requestSingleInstanceLock()` |
| v1.7.0 `open-external-url` | Unguarded (the cf6dce55 fix was lost in a merge); port main's allowlist instead |
| Native-bridge envelope (`electron/native-bridge/*`, `ipc/nativeBridge.ts`, `src/native/*`) | Second IPC style covering 13 actions; upstream kept the legacy surface and re-architected again in v1.10. Take the module-per-domain pattern only |
| Upstream permission model (`request-camera-access`, `request-screen-access`, `requestCameraAccess.ts`) | Capturia's snapshot/request/settings-deep-link model + `PermissionCheckerWindow` is a superset with tests |
| Upstream `window-all-closed -> app.quit()` | Capturia keeps a tray-resident app by design |
| Upstream Wayland switches (`ozone-platform wayland`, `disable-features Vulkan`) as-is | Capturia's Linux work (b74542f, b7ff968) uses software rendering + X11 dock hints; re-evaluate after Electron 41, do not blindly overwrite. `WebRTCPipeWireCapturer` is A's call |
| HUD window model (`hud-overlay-set-size`, `move-by`, click-through `setIgnoreMouseEvents(forward:true)`) | Conflicts with Capturia's fixed-size HUD + Linux `focusable:false`/`type:'dock'`; defer to A |
| `scripts/diagnostic-tool/*`, `diagnostic-artifact.yml`, `test:wgc-*` scripts | Drive upstream's WGC/SCK helper CLI; Capturia's `sck-recorder` protocol differs |
| `scripts/before-pack.cjs`, `caption-assets` extraResources, `asarUnpack **/*.node`, sharp settings | Caption model / native npm modules Capturia does not have (D decides captions) |
| Release-candidate pipeline (`prerelease.yml`, `promote.yml`, `release/vX.Y.Z` branches), Discord/AUR/winget/homebrew/nix workflows, `flake.nix` | Process for a multi-maintainer org; Capturia's tag-driven `release.yml` is adequate. Borrow only the version==tag guard |
| `scripts/build_macos.sh` | Superseded by the CI signing block; optional local convenience |
| `electron-updater` (auto-updater.ts) now | Needs publish config, metadata upload, signed mac builds; start with `update-checker.ts` |
| `rendererConsoleForwarder.ts` | `attachDevWindowLogging` already covers dev; just fix its event signature |
| `mainLogBuffer` env-gating `OPENSCREEN_DIAGNOSTIC` | Install at low capacity always so the runtime error dialog can attach logs |
| Upstream `extraResources` layout (`wallpapers/`, `electron/native/bin/darwin-*/`) | Capturia's `assets/wallpapers` + `native/<helper>` contract is referenced by `sckRecorder.ts`, `transcriber.ts`, `cursorKindMonitor.ts`, `mouseButtonMonitor.ts` and the B1 resolver |
| `get-recorded-video-path` mtime sort (cf6dce55) | Capturia names files `recording-<Date.now()>.webm`; lexicographic sort is correct for fixed-width timestamps until 2286 |
| `scripts/set-release-version.mjs` | Does not exist upstream |

## 7. Open questions / uncertainty
- Electron 41: whether the positional `console-message` form still fires - not verified
  against the changelog; fixing the signature is required either way.
- `com.apple.security.device.screen-capture` is not an Apple-documented hardened-runtime
  entitlement; upstream credits it (with the usage string) for #548. Cheap to add, unproven.
- macOS Cmd+Z interception (M10) is inferred from upstream #433 + Capturia's missing app
  menu; needs a hardware check.
- B14 e2e IPC stubs depend on D's final export IPC shape.
