import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('./__tests__/ipcTestKit')).createElectronMock())

const execFileMock = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}))

const accessMock = vi.hoisted(() => vi.fn())
vi.mock('node:fs/promises', () => ({
  default: { access: accessMock, constants: { X_OK: 1 } },
}))

import {
  getWindowBoundsById,
  parseWindowBoundsOutput,
  parseWindowIdFromSourceId,
  resetWindowBoundsHelperCacheForTests,
  resolveWindowBoundsHelperPath,
} from './windowBounds'

describe('resolveWindowBoundsHelperPath', () => {
  it('uses Resources/native when packaged and electron/native/bin in development', () => {
    expect(
      resolveWindowBoundsHelperPath({
        isPackaged: true,
        resourcesPath: '/Applications/Capturia.app/Contents/Resources',
        appPath: '/ignored',
      }),
    ).toBe('/Applications/Capturia.app/Contents/Resources/native/window-bounds-helper')
    expect(
      resolveWindowBoundsHelperPath({
        isPackaged: false,
        resourcesPath: '/ignored',
        appPath: '/repo',
      }),
    ).toBe('/repo/electron/native/bin/window-bounds-helper')
  })
})

describe('parseWindowBoundsOutput', () => {
  it('accepts the helper payload and clamps sizes to at least 1', () => {
    expect(parseWindowBoundsOutput('{"x":10,"y":20.5,"width":800,"height":600}')).toEqual({
      x: 10,
      y: 20.5,
      width: 800,
      height: 600,
    })
    expect(parseWindowBoundsOutput('{"x":0,"y":0,"width":0.4,"height":0.2}')).toEqual({
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    })
  })

  it('rejects malformed, non-finite or empty rectangles', () => {
    expect(parseWindowBoundsOutput('')).toBeNull()
    expect(parseWindowBoundsOutput('window_not_found')).toBeNull()
    expect(parseWindowBoundsOutput('[]')).toBeNull()
    expect(parseWindowBoundsOutput('{"x":1,"y":2}')).toBeNull()
    expect(parseWindowBoundsOutput('{"x":"a","y":2,"width":3,"height":4}')).toBeNull()
    expect(parseWindowBoundsOutput('{"x":1,"y":2,"width":0,"height":4}')).toBeNull()
    expect(parseWindowBoundsOutput('{"x":1,"y":2,"width":3,"height":-4}')).toBeNull()
  })
})

describe('parseWindowIdFromSourceId', () => {
  it('reads the numeric id out of a window source id only', () => {
    expect(parseWindowIdFromSourceId('window:1234:0')).toBe(1234)
    expect(parseWindowIdFromSourceId('screen:1:0')).toBeUndefined()
    expect(parseWindowIdFromSourceId('window:0:0')).toBeUndefined()
    expect(parseWindowIdFromSourceId('window:abc:0')).toBeUndefined()
    expect(parseWindowIdFromSourceId(undefined)).toBeUndefined()
  })
})

describe('getWindowBoundsById', () => {
  const originalPlatform = process.platform
  const originalResourcesPath = process.resourcesPath

  beforeEach(() => {
    resetWindowBoundsHelperCacheForTests()
    execFileMock.mockReset()
    accessMock.mockReset()
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    Object.defineProperty(process, 'resourcesPath', { value: '/res', configurable: true })
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    Object.defineProperty(process, 'resourcesPath', {
      value: originalResourcesPath,
      configurable: true,
    })
    vi.restoreAllMocks()
  })

  it('returns null and never runs anything when the helper binary is missing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    accessMock.mockRejectedValue(new Error('ENOENT'))

    await expect(getWindowBoundsById(42)).resolves.toBeNull()
    await expect(getWindowBoundsById(42)).resolves.toBeNull()

    expect(execFileMock).not.toHaveBeenCalled()
    // The lookup is cached: one warning, not one per call.
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('window-bounds-helper')
  })

  it('runs the prebuilt helper and parses its output', async () => {
    accessMock.mockResolvedValue(undefined)
    execFileMock.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, result: { stdout: string; stderr: string }) => void,
      ) => {
        callback(null, { stdout: '{"x":5,"y":6,"width":700,"height":500}', stderr: '' })
      },
    )

    await expect(getWindowBoundsById(42)).resolves.toEqual({
      x: 5,
      y: 6,
      width: 700,
      height: 500,
    })
    expect(execFileMock).toHaveBeenCalledTimes(1)
    expect(execFileMock.mock.calls[0]?.[0]).toBe(
      '/tmp/capturia-test/app/electron/native/bin/window-bounds-helper',
    )
    expect(execFileMock.mock.calls[0]?.[1]).toEqual(['42'])
  })

  it('returns null when the helper exits with an error', async () => {
    accessMock.mockResolvedValue(undefined)
    execFileMock.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, result: { stdout: string; stderr: string }) => void,
      ) => {
        callback(Object.assign(new Error('exit 66'), { code: 66 }), {
          stdout: '',
          stderr: 'window_not_found',
        })
      },
    )
    await expect(getWindowBoundsById(42)).resolves.toBeNull()
  })

  it('answers null off macOS and for invalid ids without touching the filesystem', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    await expect(getWindowBoundsById(42)).resolves.toBeNull()
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    await expect(getWindowBoundsById(0)).resolves.toBeNull()
    await expect(getWindowBoundsById(Number.NaN)).resolves.toBeNull()
    expect(accessMock).not.toHaveBeenCalled()
  })
})
