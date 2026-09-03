import { ORT_WASM_PUBLIC_DIR } from './captionConstants'

/**
 * ONNX Runtime wasm selection for the caption worker.
 *
 * Only the single-threaded SIMD build is shipped: the worker runs
 * `numThreads = 1` (no SharedArrayBuffer under file://) and every Chromium the
 * app can run in has WebAssembly SIMD, so the ~9 MB non-SIMD build was dead
 * weight. ORT picks the file name from `env.wasm.simd` and its own SIMD probe;
 * `buildOrtWasmPaths` only maps that one name, and `assertWasmSimdSupport`
 * fails fast with a readable message on the (hypothetical) runtime without
 * SIMD instead of letting ORT 404 on a file that is not bundled.
 */

/** The one ORT wasm binary bundled by the `capturia-ort-wasm` Vite plugin. */
export const ORT_WASM_SIMD_FILE = 'ort-wasm-simd.wasm'

/** Per-file override map accepted by `env.backends.onnx.wasm.wasmPaths`. */
export type OrtWasmPaths = { [ORT_WASM_SIMD_FILE]: string }

/**
 * Absolute URL map for `wasmPaths`. Given the renderer page URL (or any base
 * URL) it resolves `ort/ort-wasm-simd.wasm` next to the bundle; a base that is
 * already the `ort/` directory is accepted as-is.
 */
export function buildOrtWasmPaths(baseUrl: string): OrtWasmPaths {
  const ortDirName = ORT_WASM_PUBLIC_DIR.replace(/\/$/, '')
  let dir: string
  if (baseUrl.endsWith(ORT_WASM_PUBLIC_DIR)) {
    dir = baseUrl
  } else if (baseUrl.endsWith(`/${ortDirName}`)) {
    dir = `${baseUrl}/`
  } else {
    // Page href (`.../index.html` or `http://host/`): `ort/` next to it.
    dir = new URL(ORT_WASM_PUBLIC_DIR, baseUrl).href
  }
  return { [ORT_WASM_SIMD_FILE]: new URL(ORT_WASM_SIMD_FILE, dir).href }
}

/**
 * Minimal module that uses a SIMD instruction (`i8x16.splat`): validates only
 * when the engine implements WebAssembly SIMD. Same probe ORT runs internally.
 */
const WASM_SIMD_PROBE: Uint8Array<ArrayBuffer> = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 10, 30, 1, 28, 0, 65, 0, 253, 15, 253,
  12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 253, 186, 1, 26, 11,
])

export function isWasmSimdSupported(
  validate: (bytes: Uint8Array<ArrayBuffer>) => boolean = (bytes) => WebAssembly.validate(bytes),
): boolean {
  try {
    return validate(WASM_SIMD_PROBE)
  } catch {
    return false
  }
}

/** Throws a descriptive error when the runtime cannot run the bundled SIMD build. */
export function assertWasmSimdSupport(
  validate?: (bytes: Uint8Array<ArrayBuffer>) => boolean,
): void {
  if (!isWasmSimdSupported(validate)) {
    throw new Error(
      'In-app captions need WebAssembly SIMD, which this runtime does not support (only the SIMD ONNX Runtime build is bundled).',
    )
  }
}
