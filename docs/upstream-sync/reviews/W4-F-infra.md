# Review — F11 + F10 + F7 residue: handlers decomposition, update checker, e2e skeleton, HEADLESS

Merged as `55da281` (agent branch `worktree-agent-ae8077b11cc8351e3`, 14 commits; only
`PROGRESS.md` conflicted — both entries kept).

## Scope delivered

- **F11** `electron/paths.ts` (lazy `getRecordingsDir/getProjectsDir`) breaks the
  `main ↔ handlers` import cycle. `electron/ipc/handlers.ts` 2346 → 76 lines: builds one
  `IpcContext` (`context.ts`) and calls `register*Handlers(ctx)` for `cursorTracker` (moved
  verbatim), `cursorTrack` (pure sanitize + sidecar, tested), `permissions`, `recordingFiles`
  (store + native recorder + stream registry + source selection), `exportFiles` (W0-b guards and
  dialog parents unchanged), `projectState`, `analysis`, plus the pre-existing `fileRead`,
  `caption`, `hudWindows`, `recordingStream` modules. One commit per module.
- `handlers.test.ts` pins the 48 pre-split channels (+4 HUD) as a hardcoded list and asserts the
  registered set is identical and duplicate-free. `__tests__/modules-import.test.ts` asserts each
  module imports without calling `app.getPath`. Per-module tests added (44 total).
- **F10** `electron/update-checker.ts` (upstream v1.9 port): GitHub latest-release API for
  `MinhOmega/Capturia`, strict semver compare (leading zeros rejected), official-URL check
  (`github.com/<repo>/releases/tag/<tag>` only), `net.fetch` with 10 s timeout, no download.
  "Check for Updates…" in the mac app menu + Help; release page opened through the existing
  external-URL allowlist. i18n `common.electron.updates.*` en/zh-CN/vi.
- E2E skeleton: `@playwright/test`, `playwright.config.ts`, `e2e/launch.spec.ts` (boots with
  `HEADLESS=1`, self-skips without a display), `npm run test:e2e`, nightly
  `.github/workflows/e2e.yml` (ubuntu xvfb + macos-15).
- **F7 residue** `HEADLESS=1|true` gates every window `show`, `hud-overlay-restore`,
  `showMainWindow` and `app.dock.show()`; `console-message` listener moved to the Electron 39
  `details` form. `--asset-base-url` is exposed as `electronAPI.assetBaseUrl` but
  `src/lib/assetPath.ts` still uses the async IPC (kept by gap-B1 decision; `src/**` untouched).

## Lead verification (merged tree)

- `npm run lint` 0 errors / 116 warnings; `tsc` + test types clean
- `npm run i18n:check` PASS — 621 en keys
- `npx vitest --run` **115 files / 1195 tests** (was 104 / 1113)
- `npx playwright test` → 1 skipped (no display) — spec itself unverified

## Review notes

- Composition root reads cleanly; module boundaries match gap F §3.8. `recordingStream.ts` only
  narrowed its `ipcMain` type.
- Update checker has no auto-download path and cannot be pointed elsewhere from the renderer.
- Nothing here was exercised in a live Electron; the moved IPC domains are covered only by the
  channel-set pin and per-module fake-ipcMain tests.

## Manual smoke (macOS/Linux)

1. Record → stop → editor opens (stream + buffer paths; cursor sidecar written).
2. Native SCK record/stop/discard (mac). Export MP4/GIF via dialog and remembered folder;
   reveal in folder; import picker.
3. Permissions checker + Privacy deep links (mac); project state + shortcuts persist;
   Generate Subtitles.
4. Help → Check for Updates: up-to-date / available / offline; Open Release Page.
5. `HEADLESS=1 npm run dev`: no window, no Dock bounce.
6. `npm run build:vite && xvfb-run --auto-servernum npm run test:e2e` on Linux.
