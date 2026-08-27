# Review: W1-c exporter groundwork

Branch `worktree-agent-ac5face61a018b0d7` (5 commits) merged via integration branch
`worktree-agent-af4688723189eedcb` (i18n reconciliation: 14 keys → `dialogs.export.*`, incl. nested `diag`).

## Verified independently (merged tree)
- lint 0 errors / 116 warnings; tsc + typecheck:test clean; i18n:check PASS (445 en keys, 467 literals);
  vitest 60 files / 507 tests.
- `electron/ipc/fileReadHandlers.ts`: reads double-gated (video extension + `isReadablePathAllowed`),
  64 MiB chunk cap; registered via one-line `registerFileReadHandlers` call (module-per-domain pattern).
- Linux readback: `willReadFrequently` and `getImageData`-backed `VideoFrame` only when `platform === 'linux'`;
  other platforms byte-identical.
- Opus fallback: `selectExportAudioCodec()` (injectable probe) → `VideoMuxer(config, hasAudio, codec)`;
  mediabunny 1.25.1 supports Opus-in-MP4.
- Save flow: `exportFolder` remembered via `userPreferences`, validated in main with `fs.stat`;
  `unsavedExport` + "Save again"; diagnostics helper is label-injectable (no i18n literals in lib).
- D17: probed WebM duration flows `VideoPlayback` → `VideoEditor` → exporters; `resolveSourceDurationMs` only tightens.

## Notes
- Exporter decode path still `<video>` seek (wave 4 D-4). `localSourceFile` is exposed but unused by export.
- Manual Electron smoke pending (Linux export not green; Opus track on AAC-less Linux; save-failure retry).
