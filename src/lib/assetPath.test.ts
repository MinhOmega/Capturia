import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getAssetPath, getAssetPathSync } from './assetPath'

type FakeWindow = { location: { protocol: string }; electronAPI?: Record<string, unknown> }

function installWindow(win: FakeWindow) {
  vi.stubGlobal('window', win)
}

describe('assetPath', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('dev server: returns the web path and never touches electronAPI', async () => {
    const getAssetBasePath = vi.fn()
    installWindow({
      location: { protocol: 'http:' },
      electronAPI: { assetBaseUrl: 'file:///opt/app/resources/', getAssetBasePath },
    })
    await expect(getAssetPath('wallpapers/wallpaper1.jpg')).resolves.toBe(
      '/wallpapers/wallpaper1.jpg',
    )
    await expect(getAssetPath('/wallpapers/wallpaper1.jpg')).resolves.toBe(
      '/wallpapers/wallpaper1.jpg',
    )
    expect(getAssetBasePath).not.toHaveBeenCalled()
  })

  it('packaged: resolves synchronously from electronAPI.assetBaseUrl without the IPC', async () => {
    const getAssetBasePath = vi.fn(async () => '/opt/app/resources/assets')
    installWindow({
      location: { protocol: 'file:' },
      electronAPI: { assetBaseUrl: 'file:///opt/app/resources/', getAssetBasePath },
    })
    expect(getAssetPathSync('wallpapers/thumbs/wallpaper1.jpg')).toBe(
      'file:///opt/app/resources/assets/wallpapers/thumbs/wallpaper1.jpg',
    )
    await expect(getAssetPath('/wallpapers/wallpaper1.jpg')).resolves.toBe(
      'file:///opt/app/resources/assets/wallpapers/wallpaper1.jpg',
    )
    expect(getAssetBasePath).not.toHaveBeenCalled()
  })

  it('packaged: tolerates a base URL without a trailing slash', () => {
    installWindow({
      location: { protocol: 'file:' },
      electronAPI: { assetBaseUrl: 'file:///opt/app/resources' },
    })
    expect(getAssetPathSync('wallpapers/wallpaper1.jpg')).toBe(
      'file:///opt/app/resources/assets/wallpapers/wallpaper1.jpg',
    )
  })

  it('older preload without assetBaseUrl: falls back to the get-asset-base-path IPC', async () => {
    const getAssetBasePath = vi.fn(async () => 'C:\\App\\resources\\assets')
    installWindow({
      location: { protocol: 'file:' },
      electronAPI: { assetBaseUrl: '', getAssetBasePath },
    })
    expect(getAssetPathSync('wallpapers/wallpaper1.jpg')).toBeNull()
    await expect(getAssetPath('wallpapers/wallpaper1.jpg')).resolves.toBe(
      'file://C:/App/resources/assets/wallpapers/wallpaper1.jpg',
    )
    expect(getAssetBasePath).toHaveBeenCalledTimes(1)
  })

  it('no electronAPI at all: falls back to the web path', async () => {
    installWindow({ location: { protocol: 'file:' } })
    expect(getAssetPathSync('wallpapers/wallpaper1.jpg')).toBeNull()
    await expect(getAssetPath('wallpapers/wallpaper1.jpg')).resolves.toBe(
      '/wallpapers/wallpaper1.jpg',
    )
  })

  it('a rejecting IPC falls back to the web path', async () => {
    installWindow({
      location: { protocol: 'file:' },
      electronAPI: { getAssetBasePath: vi.fn(async () => Promise.reject(new Error('gone'))) },
    })
    await expect(getAssetPath('wallpapers/wallpaper1.jpg')).resolves.toBe(
      '/wallpapers/wallpaper1.jpg',
    )
  })
})
