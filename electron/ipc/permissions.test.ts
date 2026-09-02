import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildContext, fakeIpcMain, fakeWindow } from './__tests__/ipcTestKit'
import {
  applyLongEdgeLimit,
  clampRecorderDimension,
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
    const snapshot = await ipc.invoke<{ canOpenSystemSettings: boolean; items: Array<{ key: string; status: string }> }>(
      'get-capture-permission-snapshot',
    )
    expect(snapshot.canOpenSystemSettings).toBe(false)
    expect(snapshot.items.map((item) => item.key)).toEqual(['screen', 'camera', 'microphone', 'accessibility', 'input-monitoring'])
    expect(snapshot.items.every((item) => item.status === 'granted')).toBe(true)

    await expect(ipc.invoke('request-capture-permission-access', 'screen')).resolves.toMatchObject({ success: false })
    await expect(ipc.invoke('open-permission-settings', 'camera')).resolves.toMatchObject({ success: false })
    await expect(ipc.invoke('open-screen-capture-settings')).resolves.toMatchObject({ success: false })
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

    await expect(ipc.invoke('open-permission-settings', 'microphone')).resolves.toEqual({ success: true })
    expect(shell.openExternal).toHaveBeenCalledWith(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
    )
    await expect(ipc.invoke('open-permission-settings', 'wifi')).resolves.toMatchObject({ success: false })
    await expect(ipc.invoke('request-capture-permission-access', 'wifi')).resolves.toMatchObject({ success: false })
  })

  it('open-permission-checker focuses an existing window or creates one', async () => {
    const ipc = fakeIpcMain()
    const existing = fakeWindow()
    const createPermissionCheckerWindow = vi.fn(() => fakeWindow())
    registerPermissionHandlers(
      buildContext(ipc, { getPermissionCheckerWindow: () => existing, createPermissionCheckerWindow }),
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
    const sources = await ipc.invoke<Array<Record<string, unknown>>>('get-sources', { types: ['bogus'] })
    expect(sources).toEqual([{ id: 'window:1:0', name: 'Terminal', display_id: '', thumbnail: 'data:thumb', appIcon: null }])
    expect(desktopCapturer.getSources).toHaveBeenCalledWith(
      expect.objectContaining({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 } }),
    )
  })
})

describe('source geometry helpers', () => {
  it('normalizeGetSourcesOptions keeps only screen/window types and positive sizes', () => {
    expect(normalizeGetSourcesOptions({ types: ['window'], thumbnailSize: { width: 10.7, height: -1 } })).toEqual({
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
