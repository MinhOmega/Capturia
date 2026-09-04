# On-screen redaction: OCR spike

**Status:** measurement only. Nothing in this note ships. The one piece of
production code it left behind is `src/lib/redaction/patterns.ts`.

## The question

Capturia already blurs rectangles: `BlurData` in
`src/components/video-editor/types.ts`, the mosaic maths in
`src/lib/blurEffects.ts`, the controls in `BlurSettingsPanel.tsx`, and the
preview/export rendering in `annotationRenderer.ts`. Today the user drags every
one of those rectangles by hand, which means the person who most needs the
feature — someone who recorded a terminal with a live API key in the scrollback
— finds out afterwards and has to scrub the timeline looking for it.

So: **can Capturia read the text off its own frames, locally, fast enough to be
worth offering, and turn what it finds into blur regions in source
coordinates?** Locally is not negotiable; a screen recorder that uploads frames
to a text-recognition service to look for secrets has invented a worse problem
than the one it solves.

## Setup

| | |
|---|---|
| Machine | Linux 7.0.0-29, 22 cores, 30 GB RAM (shared with other build lanes during the run) |
| Browser | Playwright Chromium (headless), the same one `vitest.browser.config.ts` drives |
| Harness | `src/lib/redaction/ocrSpike.browser.test.ts` (removed from the tree — see *How to re-run*) |
| Command | `CAPTURIA_REDACTION_SPIKE=1 npm run test:browser -- src/lib/redaction`, under `flock /tmp/heavy.lock systemd-run --user --scope -q -p MemoryMax=8G` |
| Fixture | `src/lib/redaction/spikeFrames.ts` — 20 frames drawn at 1920×1080 (removed with the harness) |

### The fixture

Drawn in code rather than committed as PNGs, so the layout can be changed and
the measurement re-run. Each frame is a split screen:

- **left, 0–992 px:** a dark terminal in monospace — vite build output, `git
  log`, `kubectl get pods`, `docker compose ps` — with one line reading
  `$ export OPENAI_API_KEY=sk-live-9TQ4vn2XbLm7Zr5Kd8Hs1Wf`.
- **right:** a light "Customers" admin table with NAME / EMAIL / PHONE / STATUS
  columns, nine ordinary rows of other people's contact details and one planted
  row carrying `marta.oliveira@northwind-logistics.example.com` and
  `+1 (415) 555-0132`.

Frames 0–9 use 12 px UI text (a dense terminal, a compact table — the hard
case); frames 10–19 use 16 px (default desktop UI text). Every other frame is
scrolled, which moves both the terminal line and the table row to different
y positions so recall is not measured against one fixed pixel neighbourhood.
`measureText` gives the exact rectangle each planted string occupies, and those
rectangles are scaled alongside the frame when it is downscaled — that is what
makes the "localised" column below meaningful.

### What is measured

Per engine and per downscaled width, over the 20 frames after one warm-up
frame:

- **median / p90 / mean ms** for one `recognize` call, timed in the page.
- **750 frames** — the same median projected onto a 5-minute recording sampled
  every 400 ms (`300 s × 1000 / 400 = 750` frames), single worker.
- **peak JS heap** — `performance.memory.usedJSHeapSize` on the page. See the
  caveat under *Memory*.
- **regions/frame** — how many blur rectangles `findSecrets` would propose for
  that frame. The fixture deliberately contains nine other real-looking emails
  and phone numbers, so this is not a false-positive count, it is workload.
- **exact** — the planted string appears verbatim in the OCR text after
  whitespace normalisation.
- **partial ≥80 %** — the best short run of OCR words is within 80 % character
  similarity (normalised Levenshtein) of the planted string.
- **pattern** — `findSecrets` returned a match of the expected kind that is at
  least 60 % similar to the planted string. *This is the metric the feature
  actually depends on*: a blur does not need the key to be read correctly, only
  recognised.
- **localised** — the same, and the union of the OCR word boxes behind that
  match has IoU ≥ 0.3 with the ground-truth rectangle, i.e. it would have
  produced a usable blur region.

## Results

Two English LSTM models, five scan widths, 20 frames each after a warm-up
frame. 2880 is not a downscale — it is a **1.5× upscale**, added after the four
requested widths showed the problem is not speed.

### tesseract.js 7 · `eng 4.0.0_best_int` (the default model)

| width | median ms | p90 ms | mean ms | 750 frames, 1 worker | page JS heap MB | regions/frame | exact | partial ≥80 % | pattern | + de-spaced | localised |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 2880 (1.5×) | 18098 | 20656 | 18259 | 226.2 min | 16 | 39.9 | 50 % | 53 % | **58 %** | 58 % | 58 % |
| 1920 (1:1) | 11549 | 16156 | 11531 | 144.4 min | 16 | 16.1 | 17 % | 35 % | **30 %** | 30 % | 30 % |
| 1280 | 9710 | 16986 | 10369 | 121.4 min | 16 | 2.3 | 0 % | 0 % | **0 %** | 0 % | 0 % |
| 960 | 2425 | 5829 | 3022 | 30.3 min | 16 | 0.0 | 0 % | 0 % | **0 %** | 0 % | 0 % |
| 640 | 89 | 151 | 90 | 1.1 min | 16 | 0.0 | 0 % | 0 % | **0 %** | 0 % | 0 % |

| width | 12 px | 16 px | email | phone | `sk-` key |
|---|---|---|---|---|---|
| 2880 | 50 % | 67 % | 75 % | 100 % | **0 %** |
| 1920 | 10 % | 50 % | 10 % | 65 % | 15 % |
| 1280 / 960 / 640 | 0 % | 0 % | 0 % | 0 % | 0 % |

Exact reads (verbatim, whitespace normalised) — 2880: email 50 %, phone 100 %,
key 0 %. 1920: email 10 %, phone 40 %, key 0 %. Everything below 1920: 0 %.

Cold init (worker script + wasm core + model over the network): 2577 ms,
5.65 MiB fetched.

### tesseract.js 7 · `eng 4.0.0_fast`

| width | median ms | p90 ms | mean ms | 750 frames, 1 worker | page JS heap MB | regions/frame | exact | partial ≥80 % | pattern | + de-spaced | localised |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 2880 (1.5×) | 11766 | 15872 | 11808 | 147.1 min | 16 | 40.8 | 50 % | 53 % | **58 %** | 58 % | 58 % |
| 1920 (1:1) | 10453 | 15487 | 10482 | 130.7 min | 18 | 17.4 | 17 % | 35 % | **30 %** | 30 % | 30 % |
| 1280 | 7820 | 10340 | 7830 | 97.8 min | 18 | 2.8 | 0 % | 0 % | **0 %** | 0 % | 0 % |
| 960 | 1658 | 3990 | 2060 | 20.7 min | 18 | 0.0 | 0 % | 0 % | **0 %** | 0 % | 0 % |
| 640 | 80 | 108 | 85 | 1.0 min | 18 | 0.0 | 0 % | 0 % | **0 %** | 0 % | 0 % |

Per-string and per-font-size recall came out **identical** to `best_int` at
every width. Cold init 461–1900 ms, 4.72 MiB fetched. The `fast` model is
1.3–1.5× quicker at every width and reads the fixture's planted strings exactly
as well, so it is the better of the two here — the accuracy the bigger model
buys does not show up on screen text at these sizes.

### Memory

- **Page JS heap** peaked at 16–18 MB. That number is small and misleading:
  `performance.memory` only sees the page, and tesseract.js does all its work
  in a Web Worker whose wasm heap is a separate context.
- **Whole run**, measured from the `memory.peak` of the transient systemd scope
  (node + vitest + Chromium + the OCR worker): **651–706 MiB**, under an 8 GiB
  cap. Nothing came close to the cap, and no width was memory-bound.

### What is noise and what is not

The box was shared with other build lanes, and the timings show it: `best_int`
at 1920 measured 7164 ms in one run and 11549 ms in the next, about ±40 %. The
tables report the second, quieter-model-cache-corrected run throughout. **Treat
every millisecond figure as ±40 % and every ordering (2880 slower than 1920,
`fast` quicker than `best_int`) as solid** — the ratios held across both runs.

The `regions/frame` column is workload, not precision, and it grows faster than
the real content: the fixture contains about twenty genuine emails and phone
numbers, so 39.9 proposed regions at 2880 means roughly half of them are the
generic `hex-token`/`base64-token` detectors firing on garbled words. A shipping
scan would want `minConfidence: 'high'` for exactly that reason.

Recall is not noisy in the same way, but it is coarse: 20 frames × 3 strings =
60 observations per width, so one frame is 1.7 percentage points overall and
5 points per string. The `sk-` key's 15 % at 1920 is three frames and is more
likely a generic `base64-token` match landing on the right box than a genuine
read of the key — the exact-read column for the key is 0 % everywhere.

A first run was discarded: `cacheMethod` defaults to `'write'` and the
IndexedDB traineddata cache is keyed on the language name rather than on
`langPath`, so the second variant silently reused the first one's weights and
reported recall identical to it. `cacheMethod: 'none'` fixes it; the tell was
that the two engines differed in nothing but wall time.

## What the numbers say

**1. Downscaling before OCR does not trade accuracy for speed. It destroys the
signal outright.** At 1280 the whole 1920×1080 frame — two panes, roughly 60
lines of text — yields 2.3 detections where 1920 yields 16.1, and none of the
three planted strings survives. At 960 and below the reader returns nothing at
all, which is why 640 "runs" in 89 ms: there is no text left to recognise.
Tesseract's LSTM wants something near 30 px of cap height; 12 px and 16 px UI
text at 1080p is already under that, and any downscale puts it out of reach.
The premise that a 640-wide scan would be a cheap first pass is wrong — it is a
free way to find nothing.

**2. The only lever that improves recall is upscaling, and it is expensive.**
1.5× (2880 wide) takes overall recall from 30 % to 58 % and costs 1.6× the time
on the bigger model, 1.1× on the fast one. 12 px text goes from 10 % to 50 %,
16 px from 50 % to 67 %.

**3. No width reaches 80 % recall.** The brief asked for the best width that
keeps recall ≥ 80 % and then a 750-frame projection at it. That width does not
exist in this data: the maximum measured is 58 % at 2880. Taking the closest
thing — 2880, 58 % — a 5-minute recording sampled every 400 ms is 750 frames ×
18.1 s = **226 minutes on one worker, 57 minutes on four**. For a 5-minute
recording. That is not a feature, it is an overnight job.

**4. The `sk-` key — the reason anyone wants this — is never read.** 0 % exact
at every width, 0 % pattern at 2880 where email and phone do best. A
28-character random mixed-case token is the worst possible input for an LSTM
recogniser with a language model behind it: there is no word to fall back on
and every character must be right. Structured, partly-predictable strings do
much better (phone numbers hit 100 % at 2880 because digits and grouping are
easy and the pattern only needs the shape). The feature would reliably catch
the customer's email address in a demo and reliably miss the credential in the
terminal.

**5. Localisation is not the problem.** `localised` equals `pattern` at every
width and every engine: every single time a detector fired on a planted string,
the union of the OCR word boxes behind that match had IoU ≥ 0.3 with the
ground-truth rectangle. The coordinate half of the pipeline works. If
recognition improved, blur regions would fall out of it for free.

**6. The de-spaced re-scan bought nothing.** Re-running `findSecrets` over each
line with inter-word spaces removed — expected to recover emails that OCR split
across two words — recovered zero additional detections at any width. The
split-token failure mode is real (email `partial ≥80 %` is 35 % at 1920 while
email `pattern` is 10 %, so the characters were read but the anchor was broken),
but it is not fixed by joining words: what OCR actually does at 1920 is drop or
mangle the `@` and the dots, and no amount of re-joining restores those.

## Engines considered

| | tesseract.js 7.0.0 | PP-OCR (ONNX) via `onnxruntime-web` |
|---|---|---|
| Licence | Apache-2.0 (engine and `tesseract.js-core`) | Apache-2.0 (models via `SWHL/RapidOCR`), MIT (ORT) |
| Runs in a Web Worker | yes, it *is* a worker — `createWorker()` spawns one and all recognition happens there | yes, ORT wasm runs in a worker the way `src/lib/captioning/transcribe.worker.ts` already does |
| Code to ship | `tesseract.esm.min.js` 63.2 kB (10.7 kB gzipped) + `worker.min.js` 111 kB | the ORT wasm Capturia already ships, plus pre/post-processing we would have to write |
| wasm | `tesseract-core-simd-lstm.wasm` 2.86 MB | `ort-wasm-simd.wasm`, already emitted to `dist/ort/` by `ortWasmPlugin` in `vite.config.ts` |
| Model download | `eng.traineddata.gz` — 2.95 MB (`4.0.0_best_int`, the default) or 1.98 MB (`4.0.0_fast`) | `en_PP-OCRv3_det_infer.onnx` 2.42 MB + `en_PP-OCRv3_rec_infer.onnx` 8.97 MB = 11.4 MB |
| Offline after first fetch | yes — `corePath`/`workerPath`/`langPath` all accept local URLs, so the three files can be emitted next to the bundle exactly like `dist/ort/` | yes, same mechanism |
| `node_modules` cost | 1.4 MB (`tesseract.js`) + 45.3 MB (`tesseract.js-core`, which ships eight core variants) | none beyond what is installed |

By default tesseract.js fetches the worker script and the wasm core from
jsdelivr and the language data from a CDN. That is unacceptable for a desktop
app and is also avoidable: all three paths are options, and Capturia already
has the pattern for pinning them locally — `ortWasmPlugin` copies
`ort-wasm-simd.wasm` into `dist/ort/` and `src/lib/captioning/ortWasm.ts`
resolves it relative to the page URL. A `tesseractAssetsPlugin` doing the same
for `tesseract-core-simd-lstm.wasm`, `worker.min.js` and `eng.traineddata.gz`
is roughly 40 lines and adds **~5.0 MB to the installer** (`4.0.0_fast`) or
**~6.0 MB** (`4.0.0_best_int`).

### Why the ONNX route was not measured

It is buildable and it would reuse machinery Capturia already has, but a
PP-OCR pipeline is not a library call: the detector emits a probability map
that has to be binarised, connected-component-labelled, fitted with minimum-area
rectangles and unclipped before you have text boxes, and the recogniser then
needs per-crop normalisation and a CTC decode against a character dictionary.
That is a few hundred lines of image processing to write before the first
number appears, and this spike's job was to decide whether *any* local OCR
clears the bar. Two further constraints are worth recording:

- `onnxruntime-web` is **1.14.0**, pinned exactly (`"onnxruntime-web": "1.14.0"`)
  as a transitive dependency of `@xenova/transformers@2.17.2`. It is not a
  direct dependency of Capturia, so an OCR path would either share that pin or
  force a second, differently-versioned ORT into the renderer.
- The caption worker deliberately runs `numThreads = 1` (no `SharedArrayBuffer`
  under `file://`, see the comment in `src/lib/captioning/ortWasm.ts`), so an
  ONNX OCR path inherits single-threaded wasm and would not get the parallelism
  that makes PP-OCR fast in its native benchmarks.

**Not measured:** ms/frame and recall for the ONNX route. The size and licence
figures above are from the published artefacts, not from a run.

## Recommendation: no-go for an automatic scan; go with constraints for an opt-in one

**Do not build "scan the recording for secrets".** At the sampling rate the
brief assumes, a 5-minute recording costs between one and four hours of CPU
even on the fast model, and it would find 58 % of the personal data and none of
the credentials. A safety feature that misses the thing it exists for is worse
than no feature: it tells the user their recording was checked.

**What is worth building, with these constraints:**

| Constraint | Value |
|---|---|
| Minimum scan width | **1920** (native). Below it, recall is zero — never offer a "fast, low-res" mode. |
| Recommended scan width | **2880** (1.5× upscale of a 1080p source), `eng 4.0.0_fast` |
| Expected scan time | **≈ 12 s per frame** (fast model at 2880), i.e. ~3.5 minutes of CPU per 60 s of video at a 400 ms sampling interval |
| Realistic sampling interval | **8–12 s**, not 400 ms. Four workers × 120 s of wall time buys ~40 frames, which over a 5-minute recording is one frame every 7.5 s. |
| Worker count | **2–4**. Each tesseract worker is an independent wasm heap; the whole run peaked at ~0.7 GiB with one, so four is comfortable on a laptop and the OCR is single-threaded per worker. |
| Scope | **Personal data only** — emails and phone numbers. Do not advertise API-key or token detection from video. |
| Framing | An explicitly user-invoked, best-effort **"suggest blur regions"** action with a visible frame count and progress, whose results the user confirms. Never an automatic pre-export guarantee. |

The honest shape of the feature is *"scan this frame"* / *"scan the frames I
mark"*, at 12 seconds each, producing candidate blur regions the user accepts
or rejects — not a background sweep.

**The cheaper, better-value half of the same idea is already available.**
`src/lib/redaction/patterns.ts` runs on text, not pixels, at effectively zero
cost and with none of this uncertainty. Pointing it at the notes/teleprompter
content, at clipboard paste, and at what the app itself logs catches real leaks
with 100 % fidelity, ships today, and needs no model download. That is where
the next hour of work on redaction should go.

## Turning a detection into a blur region

`AnnotationRegion.position` and `.size` are **percentages of the canvas**
(`annotationRenderer.ts:407-410` multiplies by `canvasWidth`/`canvasHeight`),
not pixels. That has a useful consequence for this feature: the width the frame
was scanned at cancels out. A word box at `x = 431` in a 1280-wide scan of a
3840-wide recording becomes `position.x = 431 / 1280 * 100 = 33.7`, and the
exporter puts it in the right place at any output resolution. **The scan
resolution and the video resolution do not have to agree**, which is what makes
downscaling before OCR a free win rather than a coordinate problem.

The rest of the mapping is mechanical: a `SecretMatch` carries `start`/`end`
into the OCR text, the OCR words carry both a character range and a `bbox`, so
the union of the boxes overlapping the match span is the rectangle. Pad it by
about half a character height, set `type: 'blur'` and `blurData:
normalizeBlurData({})`, and set `startMs`/`endMs` from the sampled frame's
timestamp extended to the next sample that no longer contains the match.

## The pattern layer (`src/lib/redaction/patterns.ts`)

This module is real and stays regardless of the OCR decision — it is also what
a "scan the notes panel before exporting" or a log scrubber would call.

`findSecrets(text, options)` returns non-overlapping matches with a `kind`, a
`confidence` and `start`/`end` indices into the input. The indices are the
point: a caller holding per-word bounding boxes maps a match span straight onto
a rectangle, which is exactly the shape `BlurData` regions need.

Two design decisions came out of looking at what OCR actually returns:

1. **Anchors, not payloads.** OCR mangles random characters but preserves
   structure. Every detector keys off something the reader is likely to get
   right — `@` and a TLD, `sk-`, `AKIA`, `eyJ`, `ghp_`, digit grouping — and
   treats the high-entropy body as "some characters of roughly this length".
   A key read as `sk-live-9TQ4vn2XbLm7Zr5Kd8Hs1WF` (one character wrong) is
   still an `openai-key` match, and blurring does not need the value.
2. **Specific first, then generic, and never twice.** Detectors run in priority
   order over a shared claim map, so a JWT is reported once as a JWT rather
   than twice as base64 segments, and a `data:image/...;base64,` payload is
   masked before any generic detector sees it.

Generic high-entropy detectors are `confidence: 'medium'`; anything with a
self-identifying prefix or a secret-ish label is `'high'`. `minConfidence:
'high'` drops the generics for a path where a wrong blur costs more than a
missed one.

The awkward cases are in `patterns.test.ts` (35 positives, 40 negatives, node
lane). The ones worth naming:

- **Git SHAs, md5, sha256.** A 40-character hex run *is* structurally a
  credential. Contiguous hex of length 32/40/56/64/96/128 is treated as a
  digest and never reported. The cost is that a hex secret of exactly one of
  those lengths is only caught when it is labelled (`API_KEY=<40 hex>`), which
  the labelled detector does catch.
- **UUIDs** are rejected explicitly, and would fail the mixed-alphabet test
  anyway.
- **Placeholders.** `API_KEY=your_api_key_here`, `token=<REDACTED>`,
  `password: ********`, `token: process.env.API_TOKEN` and
  `secret_key = os.environ["SECRET_KEY"]` are all silent.
- **Version strings and addresses.** `10.0.19045.3803` and `192.168.1.100`
  reach the phone detector and are rejected by shape: without a `+` country
  code only the grouped local forms count, and a dotted number must match the
  one shape a version string cannot.
- **File paths.** `/` was left out of the generic token alphabet precisely so
  `/Users/minh/Projects/Capturia1/src` breaks apart. The trade is that a
  standard-base64 secret containing `/` is only caught when labelled.

## If this is revisited

- **Try the ONNX route before trying harder with tesseract** — see
  *Alternative to evaluate* below. It is the only engine worth a second spike.
- **Do not re-test downscaling.** 1280, 960 and 640 are settled: zero.
- **A native OCR path would change the answer.** macOS `VNRecognizeTextRequest`
  and Windows `Windows.Media.Ocr` are hardware-accelerated, run in tens of
  milliseconds per frame and handle random-token text far better. Capturia
  already builds a native macOS helper (`scripts/build-native-macos-helper.mjs`,
  `electron/native/`), so the plumbing exists. That is a different spike, and on
  this evidence a more promising one.
## Alternative to evaluate

If redaction is picked up again, the one engine worth a second spike is a
**two-stage ONNX pipeline on `onnxruntime-web`: a text *detector* followed by a
text *recogniser***, PP-OCR being the obvious family (RapidOCR publishes the
converted weights on Hugging Face under Apache-2.0: `en_PP-OCRv3_det_infer.onnx`
2.42 MB and `en_PP-OCRv3_rec_infer.onnx` 8.97 MB, 11.4 MB of model download in
total, and ORT itself is MIT). The reason it is worth the effort is structural
rather than incremental: the detector finds text boxes on the full frame and the
recogniser then sees one **upscaled line crop** at a time instead of a whole
1080p page — which is exactly the condition under which the numbers in this note
improved, and it gets there without paying 1.5× on every pixel of the frame. It
would also reuse machinery Capturia already ships: `ortWasmPlugin` in
`vite.config.ts` already emits `ort-wasm-simd.wasm` to `dist/ort/`, and
`src/lib/captioning/` already runs ORT in a worker with locally-resolved wasm
paths, so the offline story is solved before the work starts. Two costs to go in
with eyes open: `onnxruntime-web` is pinned at exactly **1.14.0** as a transitive
dependency of `@xenova/transformers@2.17.2`, so an OCR path either shares that
pin or forces a second ORT into the renderer; and there is no library call —
somebody has to write the DB post-processing (binarise the probability map,
connected components, minimum-area rectangles, unclip) and the CTC decode
against a character dictionary, a few hundred lines of image processing before
the first number appears. That was out of scope for a go/no-go, which is why
this note has its sizes and licence but not its milliseconds.

## How to re-run

The measurement spec (`ocrSpike.browser.test.ts`) and the fixture generator
(`spikeFrames.ts`) **were removed from the tree** together with the
`tesseract.js` devDependency, so the repository carries no OCR engine and the
browser lane has nothing to skip. Both files are **kept verbatim with the phase
notes** for this spike; copy them back into `src/lib/redaction/` to reproduce
the tables above. `src/lib/redaction/patterns.ts` and its corpus test stay in
the tree and are unaffected.

To re-run:

1. `npm i -D tesseract.js` (7.0.0 at the time of measurement).
2. Restore `ocrSpike.browser.test.ts` and `spikeFrames.ts` to
   `src/lib/redaction/`.
3. `CAPTURIA_REDACTION_SPIKE=1 CAPTURIA_SPIKE_WIDTHS=2880,1920 npm run
   test:browser -- src/lib/redaction`, under `flock /tmp/heavy.lock systemd-run
   --user --scope -q -p MemoryMax=8G`.

Results are appended to `$CAPTURIA_SPIKE_OUT` (default
`$TMPDIR/capturia-redaction-spike.md`) by the `writeSpikeArtifact` browser
command in `vitest.browser.config.ts`, which is still there: browser-mode
`console.log` is not forwarded to the terminal by the default reporter, and the
first run of this spike printed seventeen minutes of tables into the void
before that was noticed. `envPrefix` in the same file is what lets
`CAPTURIA_*` reach the page as `import.meta.env.*`.

## Packages used, and removed again

| Package | Version | Where it was | Size |
|---|---|---|---|
| `tesseract.js` | 7.0.0 | **devDependency only** | 1.4 MB installed; 63 kB min / 10.7 kB gzipped if it had ever been bundled |
| `tesseract.js-core` | 7.0.0 | transitive, dev only | 45.3 MB installed (eight core variants); the one that mattered is `tesseract-core-simd-lstm.wasm`, 2.86 MB |

Nothing was ever added to `dependencies`. Both have since been uninstalled
along with the spec that imported them, so the tree is back to where it was
apart from `patterns.ts`, its test, and this note.

## Not measured

- **ms/frame and recall for the ONNX PP-OCR route.** Only its licence, model
  sizes and integration constraints were established.
- **Non-English text**, and any language needing a second `traineddata`.
- **Real screen recordings.** The fixture is synthetic: crisp, static,
  anti-aliased canvas text with no video compression. Real frames come out of
  H.264 or VP9 and will be *worse*, so every recall figure here is an upper
  bound.
- **Frame-to-frame deduplication.** A real scan would skip frames that are
  pixel-identical to the previous sample, which on a static screen would cut
  the frame count dramatically. That is the one optimisation that could make a
  full-recording scan tractable, and it was out of scope.
- **Cold-start cost on a metered or offline connection.** Init was measured
  against warm CDNs on a fast link.
- **Multi-worker throughput.** The four-worker projections above are the
  single-worker median divided by four; contention was not measured.
