import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildContext, fakeIpcMain, fakeWindow } from './__tests__/ipcTestKit'
import {
  applyLongEdgeLimit,
  clampRecorderDimension,
  collectOwnWindowSourceIds,
  excludeOwnWindowSources,
  normalizeGetSourcesOptions,
  registerPermissionHandlers,
} from './permissions'

vi.mock('electron', async () => (await import('./__tests__/ipcTestKit')).createElectronMock())

const REAL_PLATFORM = process.platform
function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

describe('permission IPC handlers', () => {
  afterEach(() => {
    setPlatform(REAL_PLATFORM)
  })

  it('registers the permission and source channels', () => {
    const ipc = fakeIpcMain()
    registerPermissionHandlers(buildContext(ipc))
    expect(ipc.registered).toEqual([
      'get-sources',
      'get-screen-capture-access-status',
      'get-capture-permission-snapshot',
      'request-capture-permission-access',
      'open-permission-settings',
      'open-screen-capture-settings',
      'open-permission-checker',
    ])
  })

  it('reports everything granted and no System Settings off macOS', async () => {
    setPlatform('linux')
    const ipc = fakeIpcMain()
    registerPermissionHandlers(buildContext(ipc))
    const snapshot = await ipc.invoke<{
      canOpenSystemSettings: boolean
      items: Array<{ key: string; status: string }>
    }>('get-capture-permission-snapshot')
    expect(snapshot.canOpenSystemSettings).toBe(false)
    expect(snapshot.items.map((item) => item.key)).toEqual([
      'screen',
      'camera',
      'microphone',
      'accessibility',
      'input-monitoring',
    ])
    expect(snapshot.items.every((item) => item.status === 'granted')).toBe(true)

    await expect(ipc.invoke('request-capture-permission-access', 'screen')).resolves.toMatchObject({
      success: false,
    })
    await expect(ipc.invoke('open-permission-settings', 'camera')).resolves.toMatchObject({
      success: false,
    })
    await expect(ipc.invoke('open-screen-capture-settings')).resolves.toMatchObject({
      success: false,
    })
    await expect(ipc.invoke('get-screen-capture-access-status')).resolves.toEqual({
      status: 'granted',
      canOpenSystemSettings: false,
    })
  })

  it('opens the matching Privacy pane on macOS and rejects unknown targets', async () => {
    setPlatform('darwin')
    const { shell } = await import('electron')
    const ipc = fakeIpcMain()
    registerPermissionHandlers(buildContext(ipc))

    await expect(ipc.invoke('open-permission-settings', 'microphone')).resolves.toEqual({
      success: true,
    })
    expect(shell.openExternal).toHaveBeenCalledWith(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
    )
    await expect(ipc.invoke('open-permission-settings', 'wifi')).resolves.toMatchObject({
      success: false,
    })
    await expect(ipc.invoke('request-capture-permission-access', 'wifi')).resolves.toMatchObject({
      success: false,
    })
  })

  it('open-permission-checker focuses an existing window or creates one', async () => {
    const ipc = fakeIpcMain()
    const existing = fakeWindow()
    const createPermissionCheckerWindow = vi.fn(() => fakeWindow())
    registerPermissionHandlers(
      buildContext(ipc, {
        getPermissionCheckerWindow: () => existing,
        createPermissionCheckerWindow,
      }),
    )
    await expect(ipc.invoke('open-permission-checker')).resolves.toEqual({ success: true })
    expect(existing.focus).toHaveBeenCalled()
    expect(createPermissionCheckerWindow).not.toHaveBeenCalled()

    const ipc2 = fakeIpcMain()
    registerPermissionHandlers(buildContext(ipc2, { createPermissionCheckerWindow }))
    await ipc2.invoke('open-permission-checker')
    expect(createPermissionCheckerWindow).toHaveBeenCalledTimes(1)
  })

  it('get-sources maps desktopCapturer results and falls back to defaults', async () => {
    setPlatform('linux')
    const { desktopCapturer } = await import('electron')
    vi.mocked(desktopCapturer.getSources).mockResolvedValueOnce([
      {
        id: 'window:1:0',
        name: 'Terminal',
        display_id: '',
        thumbnail: { toDataURL: () => 'data:thumb' },
        appIcon: null,
      } as unknown as Electron.DesktopCapturerSource,
    ])
    const ipc = fakeIpcMain()
    registerPermissionHandlers(buildContext(ipc))
    const sources = await ipc.invoke<Array<Record<string, unknown>>>('get-sources', {
      types: ['bogus'],
    })
    expect(sources).toEqual([
      {
        id: 'window:1:0',
        name: 'Terminal',
        display_id: '',
        thumbnail: 'data:thumb',
        appIcon: null,
      },
    ])
    expect(desktopCapturer.getSources).toHaveBeenCalledWith(
      expect.objectContaining({
        types: ['screen', 'window'],
        thumbnailSize: { width: 320, height: 180 },
      }),
    )
  })
})

describe('own-window exclusion', () => {
  const ownWindow = (id: string | null, destroyed = false) => ({
    isDestroyed: () => destroyed,
    getMediaSourceId: () => {
      if (id === null) throw new Error('no media source id')
      return id
    },
  })

  it('collects media source ids of live windows and skips destroyed or failing ones', () => {
    const ids = collectOwnWindowSourceIds([
      ownWindow('window:11:0'),
      ownWindow('window:12:0', true),
      ownWindow(null),
      ownWindow(''),
      ownWindow('window:13:0'),
    ])
    expect([...ids]).toEqual(['window:11:0', 'window:13:0'])
  })

  it('excludeOwnWindowSources keeps every source when nothing is owned', () => {
    const sources = [{ id: 'screen:0:0' }, { id: 'window:1:0' }]
    const result = excludeOwnWindowSources(sources, new Set())
    expect(result).toEqual(sources)
    expect(result).not.toBe(sources)
  })

  it('get-sources drops the HUD, selector and editor windows from the picker feed', async () => {
    setPlatform('linux')
    const { desktopCapturer, BrowserWindow } = await import('electron')
    const source = (id: string, name: string) =>
      ({
        id,
        name,
        display_id: '',
        thumbnail: null,
        appIcon: null,
      }) as unknown as Electron.DesktopCapturerSource
    vi.mocked(desktopCapturer.getSources).mockResolvedValueOnce([
      source('screen:0:0', 'Entire screen'),
      source('window:100:0', 'Capturia'),
      source('window:101:0', 'Terminal'),
      source('window:102:0', 'Capturia'),
    ])
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValueOnce([
      ownWindow('window:100:0'),
      ownWindow('window:102:0'),
      ownWindow('window:103:0', true),
    ])
    const ipc = fakeIpcMain()
    registerPermissionHandlers(buildContext(ipc))
    const sources = await ipc.invoke<Array<{ id: string }>>('get-sources', {
      types: ['screen', 'window'],
    })
    expect(sources.map((s) => s.id)).toEqual(['screen:0:0', 'window:101:0'])
  })

  it('get-sources logs enumeration timing under CAPTURIA_DIAGNOSTIC', async () => {
    setPlatform('linux')
    const { desktopCapturer } = await import('electron')
    vi.mocked(desktopCapturer.getSources).mockResolvedValueOnce([
      {
        id: 'screen:0:0',
        name: 'Entire screen',
        display_id: '',
        thumbnail: null,
        appIcon: null,
      } as unknown as Electron.DesktopCapturerSource,
    ])
    const previous = process.env.CAPTURIA_DIAGNOSTIC
    process.env.CAPTURIA_DIAGNOSTIC = '1'
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const ipc = fakeIpcMain()
      registerPermissionHandlers(buildContext(ipc))
      await ipc.invoke('get-sources', { types: ['screen'] })
      expect(log).toHaveBeenCalledWith(
        expect.stringMatching(
          /^\[get-sources\] 1 source\(s\) \(0 own window\(s\) excluded\) in \d+ ms; types=screen$/,
        ),
      )
    } finally {
      log.mockRestore()
      if (previous === undefined) delete process.env.CAPTURIA_DIAGNOSTIC
      else process.env.CAPTURIA_DIAGNOSTIC = previous
    }
  })
})

describe('source geometry helpers', () => {
  it('normalizeGetSourcesOptions keeps only screen/window types and positive sizes', () => {
    expect(
      normalizeGetSourcesOptions({ types: ['window'], thumbnailSize: { width: 10.7, height: -1 } }),
    ).toEqual({
      types: ['window'],
      thumbnailSize: { width: 10, height: 180 },
      fetchWindowIcons: true,
    })
    expect(normalizeGetSourcesOptions(undefined).types).toEqual(['screen', 'window'])
  })

  it('clampRecorderDimension yields even integers >= 2', () => {
    expect(clampRecorderDimension(0)).toBe(2)
    expect(clampRecorderDimension(1919.6)).toBe(1920)
    expect(clampRecorderDimension(1921)).toBe(1920)
  })

  it('applyLongEdgeLimit scales down only when the long edge exceeds the limit', () => {
    expect(applyLongEdgeLimit(3840, 2160, 1920)).toEqual({ width: 1920, height: 1080 })
    expect(applyLongEdgeLimit(1280, 720, 1920)).toEqual({ width: 1280, height: 720 })
    expect(applyLongEdgeLimit(1281, 721, 0)).toEqual({ width: 1280, height: 720 })
  })
})
