# Review — D-5: export audio at speed ≠ 1 (WSOLA) + downmix

Merged as `f6ce317` (agent branch `worktree-agent-a83e2c3102875292b`, 3 commits, clean merge).

## Scope delivered

- `src/lib/audio/audioTimeStretch.ts` (`WsolaTimeStretcher`: streaming, grain shrink for short
  high-speed regions, window-sum normalisation, 100× local cap) and `planarChunkQueue.ts` (O(1)),
  ported with tests (10 + 6).
- Exporter: Capturia's slice pipeline stays the source (`AudioBufferSink` → kept ranges →
  audio-edit gain → two-pass loudness → `createAudioSlice` gain/limiter/downmix). When every
  segment is passthrough (`|speed-1| < 1e-3`) the old path runs unchanged (parity test verified
  against the pre-change file). Otherwise `exportTimeStretchedAudio` walks the same
  `SpeedTimelineSegment[]` the decoder uses (D-4 adapter on the seek path, `decodePlan.segments`
  on webcodecs), one stretcher per segment, output clamped to a per-segment sample budget derived
  from the rendered frame count (`buildVideoFrameCountsForTimeline` + `buildAudioSegmentSampleBudget`,
  last segment absorbs the rounding), silence pad on underrun, head-silence fill per segment.
- `editor.exportWarningSpeedAudioUnavailable` removed from code and en/zh-CN/vi (no remaining
  unsupported case).
- Downmix >2 ch → stereo was already applied in `createAudioSlice` (W1-c/D-4); verified, not redone.
- `docs/technical-debt/export-silent-pipeline.md` audio paragraph.

## Lead verification (merged tree)

- `npm run lint` 0 errors / 116 warnings; `tsc` + test types clean
- `npm run i18n:check` PASS — 617 en keys; no dangling reference to the removed key
- `npx vitest --run` **104 files / 1113 tests** (was 101 / 1084)

## Review notes

- A/V lock test covers 1×/2×/0.5× + trim on both decode paths (144000 samples == 180 frames @
  60 fps). This is the property that matters; drift-free by construction.
- Limiter runs before the stretch (documented); acceptable since WSOLA preserves peaks
  approximately. Revisit only if clipping is heard on the manual smoke.
- Stretcher's 100× cap exceeds Capturia's `MAX_PLAYBACK_SPEED` (40); harmless.

## Manual smoke (needs Electron)

1. Global 2×: audio present, pitch preserved, in sync at start and end.
2. Per-segment 0.5× / 3× with mute + duck regions and loudness normalisation on.
3. 1× export byte-identical to before; 5.1 source → stereo; Linux Opus fallback at 2×.
4. Both `capturia.exportDecodePath` values.
