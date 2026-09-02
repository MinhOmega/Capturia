# Batch note — W5 M12 electron-updater + D13 source-copy export fast path

Agent branch (worktree `agent-a42c2f51b99868545`), 6 commits on top of `29d0ff3`. Not pushed.

## Scope delivered

### M12 / B8 — opt-in in-place updates

- `electron/auto-updater.ts` (+26 tests): pure decision module around an injected
  electron-updater instance. Eligibility = packaged **and** channel ∈ {`dmg`, `nsis`, `appimage`}
  (deb/rpm/pacman stay on the release-page dialog; Store/Flatpak/Snap/Nix were already filtered
  by `install-channel.ts`). Settings reapplied before every check: `autoDownload: false`,
  `autoInstallOnAppQuit: true`, `allowPrerelease: false`, `logger: null`. Flow: check →
  "Download Now / Later" → download (progress broadcast to every renderer window as
  `update-progress`) → "Restart Now / On Next Quit". A restart requested mid-recording is
  downgraded to on-quit. Error classification `offline` / `no-release` / `unsigned` / `unknown`;
  `unsigned` and `no-release` fall back to the existing release-page flow
  (`checkLatestRelease`), `offline`/`unknown` show a dialog from the menu and stay silent on the
  launch check.
- `electron/main.ts`: `getAutoUpdater()` lazily imports `electron-updater` only on eligible
  channels; "Check for Updates…" (mac app menu + Help) drives the updater when active, the
  release-page dialog otherwise. Launch check 10 s after the first window, gated on
  `userData/update-preferences.json` (`autoUpdateCheck`, default `true`; skipped under
  `HEADLESS`). New IPC: `get-auto-update-check`, `set-auto-update-check`, `check-for-updates`;
  preload exposes `getAutoUpdateCheck`, `setAutoUpdateCheck`, `checkForUpdates`,
  `onUpdateProgress` (typed in both `.d.ts`). **No renderer UI consumes these yet** — the
  Settings toggle and a progress indicator belong to the panels other batches own.
- i18n `common.electron.updates.{downloadPrompt,downloadNow,later,downloaded,restartNow,
  onNextQuit,offline}` en/zh-CN/vi.
- `electron-builder.json5`: `publish: [{ provider: github, owner: MinhOmega, repo: Capturia,
  releaseType: release }]` (makes electron-builder write `latest*.yml` + `.blockmap` and the
  `package-type` marker); mac target adds `zip` (what Squirrel.Mac installs from). Every build
  script still passes `--publish never`; `build:mac:x64/arm64` now build `dmg zip`.
- `release.yml`: each leg uploads its feed and sidecars (`latest.yml` + `.exe.blockmap`;
  `latest-linux*.yml` + `.zsync` if any; `latest-mac.yml` + `.zip` + `.zip.blockmap`).
  `publish-release` merges the two per-architecture `latest-mac.yml` files with
  `scripts/merge-update-feeds.mjs` (+6 tests, no YAML dependency) and attaches everything.
- Dependency: `electron-updater@6.8.9` (lockfile hoists `fs-extra` and dedups 21 nested copies).

### D13 — source-copy fast path

- `src/lib/exporter/sourceCopyFastPath.ts` (+35 tests): `getSourceCopyFastPathBlockers(config)`
  is pure and lists every reason to render; `getSourceCopyProbeBlockers` / `probeSourceCopyCandidate`
  check the actual file through mediabunny (`Input.getFormat/getVideoTracks/getAudioTracks`).
- `videoExporter.ts`: `export()` calls `trySourceCopyFastPath()` before the encoder loop. Config
  gains `aspectRatio` and `quality` (passed by `VideoEditor.tsx`; without them the fast path is
  off). Progress phase `'copying'` (0 % then 100 %), result `{ success, blob, sourceCopy: true }`
  with no warnings, `console.info('[VideoExporter] source-copy fast path used …')` as the
  diagnostics line; when disabled the blockers are logged the same way.
- `localSourceFile.ts`: `loadLocalSourceBlob()` (in-memory read ≤ `MAX_IN_MEMORY_SOURCE_BYTES`
  = 256 MiB, `null` above it or on any read failure) (+4 tests).
- `ExportDialog.tsx` labels the phase (`dialogs.export.phaseCopying/statusCopying` en/zh-CN/vi).
- mediabunny `Conversion` was evaluated for a remux: it stream-copies encoded samples by default,
  but the output of a WebM→MP4 remux is unverified in players, so only verbatim MP4 copies ship.
  WebM/Matroska, QuickTime and GIF sources never take the fast path.

**The fast path triggers only when all of these hold**: aspect `'native'`, quality `'source'`,
full crop, padding 0, video padding 0, radius 0, no shadow, no background blur, no motion blur,
no trim regions, no deleted or re-timed segments, playback speed 1, no zoom regions (this also
excludes the 3D tilt preset), no annotations, no subtitles, no cursor samples, no webcam, audio
enabled, no audio edit regions, gain 1, loudness normalisation **off** (it defaults on in the
editor, so the user has to switch it off for the fast path to apply — measuring the gain instead
would cost a full audio decode); then the file must be an MP4-brand ISO BMFF with exactly one
H.264/HEVC/AV1 video track, at most one AAC/Opus audio track, a display size equal to the planned
output (odd source dimensions are rounded to even by `mp4ExportPlan`, which blocks), and be at
most 256 MiB. In practice that is a macOS SCK recording exported untouched; browser/Linux
recordings are WebM and always render.

## Verification (agent worktree)

- `npm run lint` 0 errors / 116 warnings (unchanged); `npx tsc --noEmit` and
  `npm run typecheck:test` clean; `npm run i18n:check` PASS — 632 en keys; `npx biome format .`
  nothing to fix.
- `npx vitest --run` **121 files / 1306 tests** (was 118 / 1228).
- `npx vite build` OK.

## Unverified (needs CI / real desktops)

- No live Electron run: the updater dialogs, the launch timer, `quitAndInstall` interplay with
  Capturia's `before-quit` shutdown (it `preventDefault`s, drains the recorder, then calls
  `app.quit()` again — expected to be fine for NSIS/AppImage; Squirrel.Mac needs a check), and
  whether electron-builder 26 keeps writing `latest-mac.yml` per leg with the names the merge
  step expects. First tag run will tell.
- **macOS**: an unsigned build cannot auto-update — Squirrel refuses with "Could not get code
  signature for running application"; the updater classifies that as `unsigned` and opens the
  release page instead. Real updates need the six signing secrets from
  `W4-F8-F9-deps-signing.md`. Also unverified: App Translocation (a quarantined .app run from
  `~/Downloads`) — the updater will fail the same way and fall back.
- Windows: NSIS assisted installer relaunch with `isForceRunAfter=true`; per-machine installs
  prompt UAC because `isSilent=false`.
- The fast path against a real SCK recording (brand `mp42`/`isom` from `AVAssetWriter(.mp4)`),
  byte-identity of the exported file, and player compatibility of the copied file.
- Renderer-side `update-progress` consumers do not exist yet; the event shape is pinned in both
  `.d.ts` files.

## Manual smoke — auto-update (packaged build, eligible channel)

1. Fresh install of version N with a published N+1 that has `latest*.yml`: launch, wait 10 s →
   "Capturia N+1 is available … Download Now / Later". Later → nothing else happens this session.
2. Help → Check for Updates → Download Now → renderer receives `downloading` events
   (`window.electronAPI.onUpdateProgress`), then "Restart Now / On Next Quit". Restart Now →
   app relaunches on N+1.
3. On Next Quit → keep working, Cmd/Ctrl+Q → installer runs, app comes back on N+1.
4. Start a recording, then Restart Now → no restart; install waits for quit.
5. `update-preferences.json` with `{"autoUpdateCheck": false}` → no launch dialog; menu still works.
6. Offline → launch check silent (console warning only); menu → "Could not reach the update
   server". Release without feeds (older tag) → release-page dialog from the menu.
7. Unsigned mac build → after download the release-page dialog appears, nothing is installed.
8. deb / dev run → menu shows the old release-page dialog; `electron-updater` never loads.

## Manual smoke — source-copy fast path (macOS, SCK recording)

1. Record with SCK (MP4), open the editor, set aspect **Native**, quality **Source**, padding 0,
   radius 0, shadow 0, blur off, motion blur 0, loudness normalisation **off**, no cursor
   overlay (or a recording without a cursor sidecar). Export → dialog shows "Copying", finishes
   in seconds, console: `source-copy fast path used`. `cmp` source vs export → identical.
2. Toggle any single blocker (add a zoom, a trim, a subtitle, set 16:9, set Good, gain 1.2,
   normalisation on) → console lists that blocker and the export renders as before.
3. Recording > 256 MiB → "source is too large to read in memory" blocker, render path.
4. WebM (browser recorder / Linux) with the same settings → "source container is not MP4",
   render path.
5. Cancel during "Copying" → "Export cancelled".

## Lead verification (merged as `832f5be`)

- Checked: updater eligible only for packaged dmg/nsis/AppImage, `autoDownload` off, no
  prereleases, unsigned-mac → release page; fast path requires an MP4-brand file with a single
  H.264/HEVC/AV1 track and no blocker; no reference to the source project in code or commits.
- Gate on merged tree after `npm install`: lint 0 errors / 116 warnings; tsc + test types clean;
  i18n 635 en keys; `biome format .` clean; vitest **123 files / 1347 tests**; `vite build` OK.
- Unverified here: live updater dialogs, `quitAndInstall` vs `before-quit` flush, feeds on
  electron-builder 26, fast path against a real SCK recording.
