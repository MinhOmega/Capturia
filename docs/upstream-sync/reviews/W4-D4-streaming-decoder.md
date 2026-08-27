# Review — D-4: WebCodecs streaming decoder + encoder robustness

Merged as `234a3dd` (agent branch `worktree-agent-aab79327616ea5c6e`, 6 commits). One
conflict in `src/lib/exporter/index.ts` (export union with W3-d's
`calculateEffectiveSourceDimensions`) resolved by the lead.

## Scope delivered

- `streamingDecoder.ts` ported verbatim (re-styled; `getExportMetrics` delegates to a pure
  `computeExportMetrics`), `timelineSegments.ts`, tests (16).
- `segmentAdapter.ts`: `segmentsToSpeedTimeline` + `buildDecodeTimelinePlan` map Capturia's
  `VideoSegment[]` / `TrimRegion[]` / global `playbackSpeed` onto the decoder's trim + speed
  regions. 23 tests incl. parity with `getEffectiveDurationMsWithSegments` and a round trip via
  `buildSpeedSegments`.
- `VideoExporterConfig.decodePath?: 'webcodecs' | 'seek'`, default **`'seek'`**
  (`DEFAULT_EXPORT_DECODE_PATH`). Override: `localStorage['capturia.exportDecodePath']`
  (`readExportDecodePathOverride`, only the two literal values accepted). `resolveDecodePath`
  forces `'seek'` when `VideoDecoder` is missing or a fallback is already active.
- `exportFramesByDecoding`: metadata via `localSourceFile` (OPFS copy reported as `'preparing'`),
  `decodeAll` → existing `renderAndEncodeFrame` (now `HTMLVideoElement | VideoFrame`). ETA,
  heartbeat and throughput unchanged.
- Fallback boundary: decoder failure **before the first rendered frame** or zero frames →
  `DecoderFallbackError` → same encoder preference re-run on the seek path +
  `editor.exportWarningDecoderFallback`. Render/encode errors inside the frame callback never fall
  back. Short decode → `editor.exportWarningDecodeEndedEarly` (soft).
- D5 encoder robustness (both decode paths): `getEncoderPreferences(platform)` retry loop
  (software-first on `win32`), retry only on `ExportEncoderError` (unsupported config, encoder
  `error` callback, queue stall, flush timeout) — narrower than upstream which retries
  everything; `waitForEncoderQueueSpace` 15 s stall timeout replaces the microtask spin;
  encoder `error` sets `fatalEncoderError` and cancels the decoder instead of flagging
  `cancelled`; `flushEncoder` 20 s timeout; software queue cap 32. `latencyMode: 'realtime'` +
  4 s GOP kept.
- New dep `web-demuxer@^4`; `public/wasm/web-demuxer.wasm` 3.0 MiB (byte-identical to upstream).
- `docs/technical-debt/export-silent-pipeline.md` updated.

## Lead verification (merged tree)

- `npm run lint` 0 errors / 116 warnings; `tsc` + test types clean
- `npm run i18n:check` PASS — 590 en keys
- `npx vitest --run` **95 files / 1006 tests** (was 92 / 927)

## Review notes

- Checked attempt isolation: `runExportAttempt` calls `cleanup()` on entry and in `finally`;
  `cancel()` stops the streaming decoder and cleans up, so a retried attempt never sees a
  half-open encoder/muxer.
- `fatalEncoderError` is checked before render, after the queue wait, and at flush — no path
  can keep encoding into a dead encoder.
- Default stays `'seek'` on purpose: the webcodecs path has not been run in a browser here.
  Flip `DEFAULT_EXPORT_DECODE_PATH` only after the manual smoke below passes on Linux + macOS.

## Not done / follow-ups

- GIF export still uses `VideoFileDecoder` (seek); wire `decodePath` there once the MP4 path is
  proven.
- Encoder stall / flush-timeout messages are raw English inside `ExportResult.error` (same as
  other export errors) — localise when the error surface is reworked.
- No `SpeedRegion` type added to `video-editor/types.ts`; the adapter owns the mapping.

## Manual smoke (needs a browser/Electron)

1. DevTools: `localStorage.setItem('capturia.exportDecodePath','webcodecs')`, reload.
2. Linux: export a browser-recorded WebM (VP9/Opus); console shows `Decode path: webcodecs`;
   compare frame count / duration / audio sync with `'seek'`.
3. macOS: export an SCK MP4 (avc1) with trims + per-segment speed.
4. Source > 256 MB: dialog shows the `preparing` phase.
5. Unsupported codec (HEVC / truncated file): fallback toast, export completes on seek path.
6. Encoder stall: expect "hardware video encoder stopped responding" then a software retry.
7. Cancel mid-export on both paths: no OPFS copy keeps running, no leaked `VideoFrame`.
