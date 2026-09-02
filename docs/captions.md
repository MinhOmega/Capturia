# Captions (automatic subtitles + rough cuts)

"Generate Subtitles" produces `SubtitleCue[]` and `RoughCutSuggestion[]` from a
transcript of the recording. Two engines can produce that transcript; the
analysis itself (`src/lib/analysis/videoAnalysisPipeline.ts`) is shared.

| Engine | Runs on | Where | Timing | Model |
|--------|---------|-------|--------|-------|
| `macos-speech` (primary) | macOS | main process, `electron/native/transcriber.ts` (`SFSpeechRecognizer` helper) | real word timestamps + confidence | system |
| `whisper-web` (fallback) | Windows, Linux, macOS when speech recognition is denied/unavailable | renderer Web Worker, `src/lib/captioning/` (Transformers.js + ONNX Runtime wasm) | phrase-level, split into pseudo-words | `Xenova/whisper-tiny` (quantized), downloaded on first use |

## Engine selection

`src/lib/analysis/transcriptionEngine.ts` (`runCaptionGeneration`) is the seam.
The user setting `captions.engine` (Settings > Auto Edit > "Captions engine",
stored in `localStorage["capturia.captionsEngine"]`) is one of:

- `auto` (default): native first; if it fails with `unsupported_platform`,
  `speech_permission_denied` or `recognizer_unavailable` and the Whisper engine
  is available, run Whisper and tell the user which engine produced the result.
- `native`: native only.
- `whisper`: Whisper only.

The native failure code reaches the renderer through the job status
(`analysis-status` -> `status.code`, set by `TranscriptionFailureError` in
`electron/analysis/videoAnalysisService.ts`).

## Whisper pipeline (renderer)

1. `extractMono16k.ts`: load the recording as a `File` (`readBinaryFile` /
   OPFS streaming via `localSourceFile.ts`), decode with `decodeAudioData`;
   if that fails (WebM/Matroska with video, fragmented MP4) fall back to
   mediabunny `Input` + `AudioBufferSink` (`extractMono16kMediabunny.ts`).
   Output: mono 16 kHz float PCM, capped at 4 h (30 min for sources above the
   in-memory limit).
2. `leadingSilence.ts`: drop the silent prefix (re-added to all timestamps).
3. `transcribe.ts` -> `transcribe.worker.ts`: `pipeline('automatic-speech-recognition',
   'Xenova/whisper-tiny')`, `numThreads = 1`, language pinned from the app
   locale (`whisperLanguageForLocale`), `transcribeCore.runTranscription`
   (12 min slices, 30 s chunks, word -> phrase timestamp fallback).
4. `src/lib/analysis/whisperWords.ts`: `CaptionSegment[]` -> `TranscriptWord[]`.
   Phrase segments are split by character weight into pseudo-words flagged
   `synthetic: true` + `phraseIndex`; `roughCutEngine` ignores gaps between
   synthetic words of the same phrase.
5. `buildVideoAnalysisResult` in the renderer, then `analysis-save-sidecar`
   writes `<video>.analysis.json` (same format as the native path, so
   `analysis-get-current` keeps working).

## What is bundled vs downloaded

**Bundled with the app (Vite, `vite.config.ts` plugin `capturia-ort-wasm`)**

- `dist/ort/ort-wasm-simd.wasm` (10.0 MB) from `onnxruntime-web@1.14.0` (the
  version `@xenova/transformers@2.17.2` pins). Nothing else: the threaded
  variants need `SharedArrayBuffer` (unavailable under `file://`) and the
  non-SIMD build is never selected because Electron's Chromium always has
  WebAssembly SIMD. The worker sets `env.backends.onnx.wasm.simd = true` and a
  per-file `wasmPaths` map that names only this binary
  (`src/lib/captioning/ortWasm.ts`), and probes SIMD support first so a runtime
  without it fails with a readable error instead of a 404. In dev the file is
  served from `/ort/`.
- The Transformers.js worker bundle (`worker.format = 'es'`, code-split for the
  dynamic import). Node builtins `fs`/`path`/`url` are aliased to
  `src/lib/vite-stubs/empty-node-module.ts`; `onnxruntime-node` to
  `onnxruntime-node-stub.ts` (re-exports `onnxruntime-web`).

**Downloaded on first use (`electron/ipc/captionHandlers.ts`)**

`userData/caption-models/Xenova/whisper-tiny/`, fetched from
`https://huggingface.co/Xenova/whisper-tiny/resolve/<CAPTION_MODEL_REVISION>/<file>`.

| File | Size |
|------|------|
| `onnx/decoder_model_merged_quantized.onnx` | 30.7 MB |
| `onnx/encoder_model_quantized.onnx` | 10.1 MB |
| `tokenizer.json`, `vocab.json`, `merges.txt`, `normalizer.json`, `config.json`, `generation_config.json`, `preprocessor_config.json`, `tokenizer_config.json`, `added_tokens.json`, `special_tokens_map.json`, `quantize_config.json` | ~4 MB total |

Total ~45 MB. Downloads are sequential, written to `<file>.partial` and
renamed when complete, resumed with `Range` requests, retried with backoff on
408/425/429/5xx (honouring `Retry-After`), and cancellable
(`caption-model-download-cancel`). The renderer asks before the first download
(toast "Download caption model?") and shows progress.

**Pinned revision and integrity.** `CAPTION_MODEL_REVISION`
(`src/lib/captioning/captionConstants.ts`) is the full commit SHA of the Hub
repo the file list was captured against; `modelFileUrl` refuses anything that
is not a 40-hex SHA, so a push to the repo's `main` cannot change the
tokenizer or config under the app. **Every** file (ONNX graphs and the JSON /
text metadata) carries a SHA-256 in `WHISPER_TINY_MODEL`; a mismatch deletes the
`.partial` and fails the download with `Checksum mismatch for <file>`.

To move to a newer revision:

```
curl -s 'https://huggingface.co/api/models/Xenova/whisper-tiny?blobs=true' \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["sha"]);[print(s["rfilename"],s["size"],(s.get("lfs") or {}).get("sha256")) for s in d["siblings"]]'
# then, for each file in WHISPER_TINY_MODEL:
curl -sL -o f "https://huggingface.co/Xenova/whisper-tiny/resolve/<sha>/<file>" && sha256sum f
```

Update `CAPTION_MODEL_REVISION` and every `approximateBytes` /
`expectedSha256`, then run `npx vitest --run electron/ipc/captionHandlers.test.ts`.
The LFS `sha256` the API reports for the ONNX files must equal what you
compute from the downloaded bytes; the JSON/text files are not LFS objects, so
their digests can only be computed locally.

## IPC and preload

| Channel | Purpose |
|---------|---------|
| `caption-model-status` | `{ present, dir, downloadedBytes, totalBytes, missingFiles }` |
| `caption-model-download` | stream the files, `caption-model-progress` events to the sender |
| `caption-model-download-cancel` | abort |
| `caption-model-dir` | absolute model root |
| `analysis-save-sidecar` | write a renderer-built analysis (path validated by the file-read policy: recordings dir or explicitly approved video) |

The worker cannot call IPC, so the editor window receives two
`webPreferences.additionalArguments` (`electron/windows.ts`), exposed by the
preload as `electronAPI.assetBaseUrl` and `electronAPI.captionModelDirUrl`:

- `--asset-base-url=file:///.../resources/` (packaged) or `.../public/` (dev)
- `--caption-model-dir=file:///.../userData/caption-models/`

The worker sets `env.allowRemoteModels = false`, `env.localModelPath = <that URL>`
and `env.backends.onnx.wasm.wasmPaths = { 'ort-wasm-simd.wasm': <page URL>/ort/ort-wasm-simd.wasm }`. Transformers.js then
`fetch()`es `file://` URLs; this relies on the editor window's
`webSecurity: false` (already set for local media playback). `useBrowserCache`
is off so the model is not duplicated into Cache Storage.

## Quality caveats

- `whisper-tiny` is the smallest model: acceptable for clear English, weak for
  Chinese and noisy audio. `CAPTION_MODEL_ID` is a single constant so
  `whisper-base` (~150 MB) / `whisper-small` (~500 MB) can be offered later;
  `electron/ipc/captionHandlers.ts` `CAPTION_MODELS` is the registry.
- Word-level timestamps need the `output_attentions` weights, which upstream
  found unreliable, so Windows/Linux users mostly get phrase timing split
  proportionally by word length. Subtitles are fine; silence-based rough cuts
  are coarser (only phrase boundaries).
- Inference runs single-threaded wasm on the CPU: roughly real-time / 2 on a
  laptop for the tiny model. Progress is by phase, not percentage.
- Sources above the in-memory limit are captioned for the first 30 minutes
  only (`truncated` -> warning toast).

## Manual smoke list

- Linux/Windows: Generate Subtitles -> prompt -> Download -> progress toast ->
  "Transcribing..." -> subtitles + rough cuts appear; `<video>.analysis.json`
  written; reopening the project restores them.
- Cancel during download: toast "cancelled", `.partial` file left, next run
  resumes.
- Offline with no model: clear error (HTTP/DNS failure message), no crash.
- macOS: native engine still used by default (`auto`); deny Speech Recognition
  in System Settings -> Whisper fallback + "system recognizer not available" toast.
- Settings > Captions engine = Whisper on macOS: native skipped.
- Dev (`npm run dev`) and packaged build both load `ort/*.wasm` and the model
  from `userData` (check the worker console for `Unable to load from local path`).
