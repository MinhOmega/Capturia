# Waveform for huge recordings

`useAudioPeaks` read the whole media file through the `read-binary-file` IPC and handed it to
`decodeAudioData`, with no size check. For a long recording that needs the file, its structured-clone
copy in the main process and the decoded PCM (about 12 MB per minute of 48 kHz mono float) resident
at the same time. Past a few hundred megabytes the timeline did not draw a slow waveform, it took
the renderer down. The same file exports fine, because export has streamed since the OPFS source
copy landed.

## Two paths, one threshold

`shouldStreamAudioPeaks(sizeBytes)` decides, against `MAX_IN_MEMORY_SOURCE_BYTES` from
`src/lib/exporter/sourceFileLimits.ts` (256 MiB). Deliberately the exporter's constant and not a new
one: "too large to hold in memory" should mean one thing across the app. The size comes from
`getReadableFileInfo`; when the desktop bridge cannot answer, the source is treated as small.

- **At or below the threshold** — unchanged. Read whole, `decodeAudioData`, peaks computed in the
  existing Web Worker.
- **Above it** — `streamAudioPeaks` in `src/hooks/streamingAudioPeaks.ts`. The recording is
  materialized through `materializeLocalSourceFile`, which for a large file is an OPFS-backed
  `File` streamed in chunks rather than an in-memory blob. Its audio track is then demuxed and
  decoded a chunk at a time through mediabunny's `AudioBufferSink`, which drives a WebCodecs
  `AudioDecoder`. Each decoded chunk is folded into the peak columns and dropped, so memory is flat
  in the recording's length and only the column array survives.

mediabunny rather than the `web-demuxer` WASM the video decode path uses: the audio side of that
stack is already proven here by the captioning extractor, and reusing it avoids a second copy of
codec-configuration and extradata handling for no gain. Both are demux + WebCodecs.

A small source whose in-memory decode fails falls back to the streaming path, which opens containers
`decodeAudioData` refuses. A large source does not fall back the other way, since reading it whole
is the thing being avoided. When neither path works the hook reports `unavailable` and the audio row
shows `editor.waveformUnavailable` centred in place of the waveform, so an unreadable track does not
look like a silent one.

## Columns

`createPeakColumns(durationSec)` allocates `peakBlockCount(duration)` columns, exactly what the
in-memory path produces (200 per second, capped at 24000), in the same
`[min0, max0, min1, max1, …]` layout. `BackgroundWaveform` cannot tell which path drew it.

`addSamplesToPeakColumns` places each chunk by its own start time rather than by arrival order, and
walks column by column so the inner min/max loop has no division. Min and max are seeded at 0, as
the in-memory reducer does, so a silent column reads flat rather than as an artefact. Samples beyond
the reported duration are dropped, not clamped: a container whose timestamps overrun its own
duration would otherwise pile its whole tail into the last column and spike it.

## Progress and cancellation

`reduceAudioChunksToPeaks` is the reduction, the progress throttle and the cancellation check,
separated from the demuxer so all three are testable against a plain async generator.

- **Progress** — at most one callback every 250 ms, each carrying a *copy* of the columns filled so
  far plus a 0..1 fraction. The hook pushes those into state as `status: 'streaming'`, so the
  waveform draws progressively instead of after a long blank wait. Partial results are never cached.
- **Cancellation** — the abort signal is checked before the first chunk and once per chunk, so
  changing recording or toggling the waveform off stops the decode at the next chunk boundary rather
  than after the whole track. The hook aborts on cleanup, as before.

## Hook shape

`useAudioPeaks` now returns `{ data, status, progress }` instead of a bare result;
`status` is `idle | decoding | streaming | ready | unavailable`. `TimelineEditor` reads `data` for
the waveform and `status === 'unavailable'` for the hint, and passes both down to
`BackgroundWaveform` (`peaks` may be null, `hint` renders only when there are no peaks).

## Tests

`src/hooks/streamingAudioPeaks.test.ts` (17): threshold decision including a missing or nonsense
size and an explicit override; column allocation; the reduction (single chunk, multi-column chunk,
placement by start time, zero seeding, overrun dropping, empty input); the full stream reduction;
throttled progress with an injected clock; each update getting its own snapshot; abort before the
first chunk; and abort mid-stream asserting the remaining chunks are never pulled.
