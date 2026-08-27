# Upstream sync progress log

Newest entries first. Each entry: date, cycle stage, what happened, verification result, open items.

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
