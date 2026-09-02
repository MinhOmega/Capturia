# W4 F8 + F9: dependency upgrades and release signing — batch note

Branch `w4-deps` (worktree agent), 5 code commits + 1 docs commit, based on
`feat/upstream-sync-v1.7` @ `626c69d`. Lead review to be appended below.

## Version table

| Package | Before | After |
|---|---|---|
| Node (`.nvmrc`) | `22` (bare major) | `22.23.2` (release.yml now reads `.nvmrc`) |
| `@types/node` | 22.20.1 | 22.20.1 (kept on 22; Electron 41 nests its own 24.x) |
| electron-builder | 24.13.3 | 26.15.3 |
| vite | 5.4.21 (+ nested 7.3.0 under vitest) | 7.3.6 (single copy) |
| vitest | 4.0.16 | 4.1.11 |
| @vitejs/plugin-react | 4.7.0 | 5.2.0 |
| vite-plugin-electron | 0.28.8 | 0.29.1 |
| vite-plugin-electron-renderer | 0.14.6 | 0.14.6 |
| esbuild | transitive | 0.27.7 explicit devDep (single copy) |
| typescript | 5.9.3 (declared ^5.2.2) | 5.9.3 (declared ^5.9.3) |
| electron | 39.2.7 (Node 22 / Chromium 142) | 41.10.7 (Node 24.18 / Chromium 146) |
| removed | `@types/uuid`, `fix-webm-duration` | — |

## Config changes

- `electron-builder.json5`: `linux.desktop` → `desktop.entry` (26.x schema validation rejects the
  flat form at load time); `npmRebuild:false`, `buildDependenciesFromSource:false`,
  `asarUnpack: ["**/*.node"]`, `mac.notarize:false`. `sharp` and `onnxruntime-node` are packaged
  (they are production transitive deps) but never loaded by Capturia's main process.
- `build.yml` / `release.yml`: `electron-builder install-app-deps` step removed.
- `release.yml`: version-equals-tag guard in `validate`; secrets-gated mac signing (electron-builder
  `CSC_*`), `codesign --verify`, `notarytool --wait`, `stapler`, `spctl`. Skipped when any of the
  six secrets is absent. `.zsync`/`publish` deferred (gap F B8/M12).
- `vite.config.ts`: comment only (Wayland `--disable-gpu` guard kept until re-tested on 41).

## Verified locally (Linux, no display)

After every step: `npm run lint` 0 errors / 116 warnings, `npx tsc --noEmit`,
`npm run typecheck:test`, `npm run i18n:check`, `npx vitest --run` 115 files / 1195 tests,
`npx vite build` (dist/ort/*.wasm emitted, es-format workers, `preload.mjs`).
Also: `npx electron-builder --dir --linux` on 26.15.3 (25 s, rebuild skipped, `.node` unpacked);
`xvfb-run npx playwright test` on Electron 41 + vite 7 build: 1 passed (HUD boots, source
selector opens).

## Not verified here (manual smoke)

macOS (x64 + arm64 runners and a desktop):
1. `npm run build:mac:arm64` unsigned (no secrets) still produces the DMG; app launches from it.
2. With the six secrets set: release run shows "signing: enabled", `codesign --verify --deep --strict`
   passes, `codesign --display --entitlements -` lists `build/entitlements.mac.plist` keys,
   notarytool returns `Accepted`, `stapler validate` + `spctl -t install` pass.
3. Signed app: SCK native record / stop / discard, cursor-kind + mouse-button monitors, speech
   transcriber — the Swift helpers are re-signed by osx-sign with `entitlementsInherit`; confirm
   the audio-input / camera prompts still appear and the helpers are not killed on launch.
4. Electron 41: HUD, source selector, editor window, `console-message` dev logging, permissions
   checker deep links, Cmd+Z routing (`edit-menu.ts`).

Linux X11 (`npm run dev` and the AppImage/deb from CI):
5. HUD boots, screen/window capture via `setDisplayMediaRequestHandler`, cursor tracker.
6. `StartupWMClass` in the generated `.desktop` (moved to `desktop.entry`).

Linux Wayland:
7. Launch with the kept `--disable-gpu` guard; then try `XDG_SESSION_TYPE=x11` style launch without
   it — if Electron 41 no longer crashes, drop the guard in `main.ts` + `vite.config.ts` together.

Windows:
8. NSIS assisted installer (install dir prompt) from `build:win` on electron-builder 26; app launches.

CI:
9. First tag push after merge: `validate` version guard, four installer legs, GitHub release assets.
