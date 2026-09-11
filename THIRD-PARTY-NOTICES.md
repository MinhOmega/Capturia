# Third-party notices

Capturia is MIT licensed (see [LICENSE](LICENSE)). The installers additionally
bundle the pre-built native components below. This file ships inside the
application resources and satisfies the attribution and source-offer obligations
that come with them.

## Capturia is a fork of OpenScreen

Capturia derives from **OpenScreen** — <https://github.com/getopenscreen/openscreen> —
and is baselined on upstream commit `70e30c1f`, released as **v1.10.0**. OpenScreen
is MIT licensed; its copyright notice is reproduced in [LICENSE](LICENSE) alongside
Capturia's, which is what that licence requires of a derivative work. Everything
below this section was inherited from that baseline unless noted otherwise, and the
components it describes are bundled by Capturia on the same terms.

npm dependencies are not listed here: they are resolved from `package.json` and
distributed by their own registries, not redistributed inside our binaries.

---

## FFmpeg — shared libraries (Windows only)

- **Components**: `avcodec-*.dll`, `avformat-*.dll`, `avutil-*.dll`,
  `swresample-*.dll`, `swscale-*.dll` and their siblings, under
  `resources/electron/native/bin/win32-*/`.
- **Used by**: the native D3D11 compositor addon, which links against them at
  load time.
- **License**: **GNU Lesser General Public License v2.1 or later**
  (<https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html>). FFmpeg's own
  licensing page: <https://ffmpeg.org/legal.html>.
- **This is an LGPL build, not a GPL one.** It is configured without
  `--enable-gpl` and without `--enable-nonfree`, and links no GPL-only library
  (x264, x265, xvid, vidstab, rubberband, frei0r, …). `scripts/fetch-ffmpeg.mjs`
  verifies this before vendoring — it reads `ffmpeg -L`, `-buildconf` and
  `-encoders` and refuses any binary that reports otherwise.
- **Upstream binaries**: BtbN/FFmpeg-Builds, release
  `autobuild-2026-07-31-14-10`, the `*-lgpl-shared-8.1` assets. Pinned by
  SHA-256 in `scripts/fetch-ffmpeg.mjs`; the digests there identify the exact
  artifacts we ship.
  <https://github.com/BtbN/FFmpeg-Builds/releases/tag/autobuild-2026-07-31-14-10>
- **Corresponding source**: FFmpeg n8.1.2, commit `9b6c8969e0`, from
  <https://github.com/FFmpeg/FFmpeg>. The build configuration and scripts that
  produced these exact binaries are published at
  <https://github.com/BtbN/FFmpeg-Builds>.
- **Relinking**: as required by the LGPL, these are dynamic libraries. You may
  replace them with your own build of the same FFmpeg version by overwriting the
  DLLs in `resources/electron/native/bin/win32-*/`.

## whisper.cpp and ggml

- **Components**: `whisper-stt-server` and its ggml backend sidecars, under
  `resources/electron/native/bin/<platform>-<arch>/`.
- **License**: MIT — <https://github.com/ggml-org/whisper.cpp> and
  <https://github.com/ggml-org/ggml>.
- Built from source by `scripts/build-whisper-stt.sh`; the pinned upstream
  revision is in `electron/native/whisper-stt/CMakeLists.txt`.
- The speech model (`ggml-*.bin`) is **not** bundled — it is downloaded into the
  user's data directory on first use by `electron/stt/modelManager.ts`.

## ONNX Runtime (Windows and Apple Silicon macOS)

- **Component**: `onnxruntime.dll` / `libonnxruntime.dylib`, under
  `resources/electron/native/bin/<platform>-<arch>/`.
- **License**: MIT — <https://github.com/microsoft/onnxruntime>.
- Not built here: the pinned upstream release archive is downloaded, SHA-256
  verified and unpacked by `scripts/fetch-onnxruntime.mjs`, which also checks the
  archive's own LICENSE really is MIT before vendoring anything.
- **Why it ships**: the native compositor segments the webcam subject with it, on
  the CPU execution provider, to drive the camera background cutout/blur/custom
  modes. The `gpu_cuda*` builds are deliberately not used — they are an order of
  magnitude larger and carry NVIDIA redistribution terms.
- **Not on Intel macOS**: upstream publishes no `osx-x86_64` asset from 1.27 on,
  so the x64 DMG ships without it and the camera background effects are simply
  absent there. Not shipped on Linux either, where the compositor has no capture
  path for the mask yet.
- The segmentation model it runs is a separate component, immediately below.

## MediaPipe Selfie Segmentation — model weights

- **Components**: `selfie_segmentation.tflite`,
  `selfie_segmentation_landscape.tflite` and the `selfie_segmentation_landscape.onnx`
  derived from them, shipped under `resources/mediapipe/`.
- **License**: Apache-2.0 — <https://google.github.io/mediapipe/solutions/selfie_segmentation>.
  Copyright The MediaPipe Authors.
- The `.onnx` is a **derived work**, generated from the vendored `.tflite` by
  `scripts/convert-selfie-segmentation-to-onnx.py`. No third-party weights are
  downloaded at build time.
- **Why it is listed here**: these weights are redistributed inside the installer,
  and Apache-2.0 §4 asks that the attribution travel with them. The provenance note
  in `public/mediapipe/selfie_segmentation/README.md` does not — electron-builder's
  `"!*.md"` filter strips it from the package — so this file is the only copy a user
  ever receives.
- The MediaPipe **JavaScript** solution and its two ~5.6 MB WASM builds are no longer
  bundled: inference moved into the native compositor, and nothing loaded them.

## Microsoft Visual C++ runtime — `vcomp140.dll`, `msvcp140*.dll`, `vcruntime140*.dll` (Windows only)

- **Components**: under `resources/electron/native/bin/win32-x64/` —
  `vcomp140.dll`, `msvcp140.dll`, `msvcp140_1.dll`, `vcruntime140.dll`,
  `vcruntime140_1.dll`.
- **License**: redistributable under the Microsoft Visual C++ Redistributable
  terms accompanying Visual Studio; the copies shipped are taken from the
  `VC\Redist\MSVC\<version>\x64\Microsoft.VC<nnn>.OpenMP\` and
  `…\Microsoft.VC<nnn>.CRT\` directories of the Visual Studio installation that
  builds the release, never from `System32`.
- **Why they ship**: two prebuilt binaries in the payload import them, and
  neither is ours to recompile against the static CRT. The ggml backends above
  are compiled with OpenMP and import `vcomp140.dll`; the vendored ONNX Runtime
  imports the CRT proper. None of these are **part of Windows**, so without them
  `whisper-stt-server` dies in the loader before `main()` on any machine that has
  no Visual C++ Redistributable — transcription and captions fail with no usable
  error — and `onnxruntime.dll` fails to load, leaving the camera background
  silently inert. Staged by `scripts/stage-vcomp-runtime.mjs`;
  `scripts/before-pack.cjs` refuses to package if any is missing while something
  still imports it.

## PipeWire — headers (Linux only)

- **Components**: header sources under
  `electron/native/pipewire-capture/vendor/pipewire-1.0.5/include/`, compiled
  into `openscreen-pipewire-helper` (the Linux cursor/capture helper) under
  `resources/electron/native/bin/linux-*/`.
- **License**: **MIT** — <https://gitlab.freedesktop.org/pipewire/pipewire>.
  Every vendored file keeps its upstream `SPDX-License-Identifier: MIT` header,
  and the project's licence text is copied alongside them as `COPYING`.
- **Upstream**: PipeWire release 1.0.5. Only the header subset the helper
  includes was vendored; `vendor/README.md` records exactly what was copied and
  how to reproduce the selection.
- **No PipeWire binary is redistributed.** The helper resolves
  `libpipewire-0.3.so.0` with `dlopen` at runtime, from the user's own system,
  so nothing of PipeWire's ships inside our installers beyond the compiled
  result of its headers (inline functions and struct layouts).

## Geist and Geist Mono — fonts

- **Components**: `Geist-Variable.woff2` and `GeistMono-Variable.woff2`, bundled
  into the renderer by Vite from `src/assets/fonts/` and served from `app.asar`.
- **License**: **SIL Open Font License 1.1** —
  <https://github.com/vercel/geist-font>. The full licence text is committed at
  `src/assets/fonts/OFL.txt`.
- **Why it is listed here**: the OFL requires its text to travel with the font
  files wherever they are redistributed. `OFL.txt` is not imported by any module,
  so Vite does not emit it into `dist/` and it does not reach the installer — this
  file, which ships in `resources/`, is the only copy of the notice a user
  receives. Do not drop this section while those two `.woff2` files ship.

## Native capture helpers

`wgc-capture` (Windows Graphics Capture), the ScreenCaptureKit helper (macOS),
the PipeWire helper (Linux) and the compositor addon are part of this repository
and are covered by [LICENSE](LICENSE). They originate in OpenScreen; see the fork
note at the top of this file.

## Bundled fonts — SIL Open Font License 1.1

<!-- Additive block, self-contained: everything about redistributed font files
     lives between this heading and the next `##`. -->

- **Components**: the woff2 files under `src/assets/fonts/annotation/`, and the Geist pair under
  `src/assets/fonts/`. All are redistributed inside the installers.
- **License**: **SIL Open Font License, Version 1.1** —
  <https://openfontlicense.org/>. The OFL permits bundling and redistribution as
  part of a larger work; it forbids selling the fonts on their own and requires
  that a Reserved Font Name not be reused by a modified version. Nothing here is
  modified — the files are the upstream binaries, subset by Google Fonts' own
  service to latin / latin-ext / vietnamese — so no renaming obligation arises.
- **On-canvas faces** (`src/assets/fonts/annotation/`, ~582 KB total): Inter. Fetched
  from Google Fonts by `scripts/fetch-fonts.mjs`, which also writes a `LICENSES.txt`
  beside it listing the family and its source. Its copyright notice and OFL text is on
  its Google Fonts page. Fifteen further families (Plus Jakarta Sans, Space Grotesk,
  DM Sans, Sora, Manrope, IBM Plex Sans, Playfair Display, Merriweather, Lora, IBM Plex
  Mono, Fira Code, Bebas Neue, Oswald, Caveat, Permanent Marker) were bundled up to
  v2.1 and are no longer redistributed.
- **UI faces** (`src/assets/fonts/`): Geist and Geist Mono —
  <https://github.com/vercel/geist-font>. `src/assets/fonts/OFL.txt` ships next to
  the woff2 as the licence requires. These were already bundled and were simply
  not recorded in this file.

---

To report an omission or request source for anything bundled here, open an issue
at <https://github.com/MinhOmega/Capturia/issues>.
