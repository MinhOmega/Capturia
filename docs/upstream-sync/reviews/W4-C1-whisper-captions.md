# Review — C-1: in-browser Whisper caption fallback

Merged as `a4710c7` (agent branch `worktree-agent-a0e13f4b2e09c37b9`, 6 commits, clean merge).

## Scope delivered

- `TranscriptionEngine` seam (`src/lib/analysis/transcriptionEngine.ts`): `macos-speech`
  (existing IPC round trip, polling moved out of `VideoEditor.tsx` into
  `createNativeSpeechEngine`, tested) and `whisper-web`. Native stays primary; Whisper runs only
  on `unsupported_platform | speech_permission_denied | recognizer_unavailable` or when the new
  `captions.engine` setting is `whisper`.
- `whisperWords.ts`: caption segments → `TranscriptWord[]`; phrase granularity produces
  pseudo-words flagged `synthetic`; `roughCutEngine` ignores gaps between synthetic words of the
  same phrase (test).
- `src/lib/captioning/*` ported (worker with `@xenova/transformers`, `numThreads=1`, mono-16k
  extraction via `decodeAudioData` with a **mediabunny** demux fallback, leading-silence
  placement, `transcribeCore` with fake-transcriber tests). Vite stubs for node modules, worker
  `es` format, ORT wasm served by a Vite plugin (`/ort/` in dev, `dist/ort/` at build).
- `electron/ipc/captionHandlers.ts`: model catalogue (`Xenova/whisper-tiny`, quantized), download
  into `userData/caption-models/<id>/` with progress events, abort, retry, SHA-256 on the two ONNX
  files, temp-file + rename; `analysis-save-sidecar` reuses the file-read approval policy
  (`normalizeVideoSourcePath` + extension + `isReadablePathAllowed`). Registered with one line in
  `handlers.ts`. Editor window gets `--asset-base-url` / `--caption-model-dir`.
- Editor: first-use prompt ("~45 MB"), phase toasts, engine attribution, Settings selector
  `auto | native | whisper`. `analysisLocale` maps `vi` → `vi-VN` (was `en-US`).
- `docs/captions.md`: bundled vs downloaded assets, args, caveats, smoke list.
- Deps: `@xenova/transformers@^2.17.2` (+ `onnxruntime-web@1.14.0`; optional `sharp` installed).

## Lead verification (merged tree)

- `npm run lint` 0 errors / 116 warnings; `tsc` + test types clean
- `npm run i18n:check` PASS — 613 en keys
- `npx vitest --run` **100 files / 1054 tests** (was 95 / 1006)
- `npx vite build` OK: worker chunk + `dist/ort/ort-wasm{,-simd}.wasm` (9.2 + 10.0 MB)

## Review notes

- Security: model id resolves only against the in-code catalogue; URLs are built from a fixed
  `huggingface.co` base; sidecar path is validated with the same registry the readers use.
  Nothing new is exposed that accepts an arbitrary renderer path.
- Model revision is `main` (config/tokenizer files unverified, ONNX digests verified). Pin a
  commit revision before release so a Hub change cannot silently alter the tokenizer.
- Not verified at runtime here: `fetch(file://)` from the worker relies on the editor window's
  existing `webSecurity: false`. If that flag is ever tightened, serve the model dir through
  `local-media://` (already path-gated) instead.
- `--asset-base-url` is exposed but unused by the worker (ORT comes from the bundle). Harmless;
  F7 may pick it up for wallpapers.

## Follow-ups

- Swap the demux fallback to `extractMono16kWebDemuxer.ts` now that `web-demuxer` is on the tip
  (one-file change; optional).
- Pin the HF revision; consider bundling only `ort-wasm-simd.wasm` if size matters (Electron's
  Chromium always has SIMD).

## Manual smoke (needs Electron)

1. Linux: Generate Subtitles → download prompt → progress → subtitles + rough cuts; sidecar
   `<video>.analysis.json` written; engine attribution toast says Whisper.
2. Cancel mid-download; next run resumes. Offline → clear error.
3. macOS: native still used; deny Speech Recognition → Whisper fallback toast; Settings engine =
   Whisper skips native.
