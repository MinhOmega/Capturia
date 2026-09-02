import { describe, expect, it } from 'vitest'
import {
  ORT_WASM_SIMD_FILE,
  assertWasmSimdSupport,
  buildOrtWasmPaths,
  isWasmSimdSupported,
} from './ortWasm'

describe('buildOrtWasmPaths', () => {
  it('maps only the SIMD build, resolved under ort/ next to the page', () => {
    const paths = buildOrtWasmPaths('file:///opt/app/dist/index.html')
    expect(paths).toEqual({ [ORT_WASM_SIMD_FILE]: 'file:///opt/app/dist/ort/ort-wasm-simd.wasm' })
    expect(Object.keys(paths)).toEqual(['ort-wasm-simd.wasm'])
    expect(Object.keys(paths)).not.toContain('ort-wasm.wasm')
    expect(Object.keys(paths)).not.toContain('ort-wasm-threaded.wasm')
  })

  it('accepts a base that already points at the ort/ directory', () => {
    expect(buildOrtWasmPaths('http://localhost:5173/ort/')).toEqual({
      'ort-wasm-simd.wasm': 'http://localhost:5173/ort/ort-wasm-simd.wasm',
    })
    expect(buildOrtWasmPaths('http://localhost:5173/ort')).toEqual({
      'ort-wasm-simd.wasm': 'http://localhost:5173/ort/ort-wasm-simd.wasm',
    })
  })
})

describe('WebAssembly SIMD probe', () => {
  it('validates on this runtime and reports the probe result', () => {
    expect(isWasmSimdSupported()).toBe(true)
    expect(isWasmSimdSupported(() => false)).toBe(false)
    expect(
      isWasmSimdSupported(() => {
        throw new Error('no wasm')
      }),
    ).toBe(false)
  })

  it('throws a readable error without SIMD', () => {
    expect(() => assertWasmSimdSupport(() => false)).toThrow(/WebAssembly SIMD/)
    expect(() => assertWasmSimdSupport()).not.toThrow()
  })
})
