import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { vi } from 'vitest'
import { createIpcSession, type IpcContext } from '../context'

/**
 * Shared scaffolding for the `register*Handlers(ctx)` module tests: a fake
 * `ipcMain` that records channels and lets a test invoke them, a context
 * builder, and the `electron` module mock every domain module needs.
 *
 * Usage in a test file (the factory must stay inline because `vi.mock` is hoisted):
 *
 *   vi.mock('electron', async () => (await import('./__tests__/ipcTestKit')).createElectronMock())
 */

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

export type FakeIpcMain = {
  ipcMain: { handle: (channel: string, handler: Handler) => void }
  /** Channels in registration order; duplicates are kept so a test can assert none. */
  registered: string[]
  invoke: <T = unknown>(channel: string, ...args: unknown[]) => Promise<T>
  /** The event `invoke` passes to handlers; `event.sender` is the calling renderer. */
  event: IpcMainInvokeEvent
  /** Like `invoke`, but from an arbitrary sender (a window other than the expected one). */
  invokeFrom: <T = unknown>(sender: unknown, channel: string, ...args: unknown[]) => Promise<T>
}

export function fakeIpcMain(): FakeIpcMain {
  const handlers = new Map<string, Handler>()
  const registered: string[] = []
  const event = {
    sender: { isDestroyed: () => false, send: vi.fn() },
  } as unknown as IpcMainInvokeEvent
  const call = async <T>(evt: IpcMainInvokeEvent, channel: string, args: unknown[]) => {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`no handler for ${channel}`)
    return (await handler(evt, ...args)) as T
  }
  return {
    ipcMain: {
      handle: (channel, handler) => {
        registered.push(channel)
        handlers.set(channel, handler)
      },
    },
    registered,
    event,
    invoke: <T>(channel: string, ...args: unknown[]) => call<T>(event, channel, args),
    invokeFrom: <T>(sender: unknown, channel: string, ...args: unknown[]) =>
      call<T>({ sender } as IpcMainInvokeEvent, channel, args),
  }
}

export function fakeWindow(): BrowserWindow {
  return {
    isDestroyed: () => false,
    focus: vi.fn(),
    close: vi.fn(),
    webContents: { send: vi.fn() },
  } as unknown as BrowserWindow
}

export function buildContext(
  ipc: FakeIpcMain,
  overrides: Partial<Omit<IpcContext, 'ipcMain'>> = {},
): IpcContext {
  return {
    ipcMain: ipc.ipcMain,
    session: createIpcSession(),
    recordingsDir: '/tmp/capturia-test/recordings',
    userDataDir: '/tmp/capturia-test',
    createEditorWindow: vi.fn(),
    createSourceSelectorWindow: vi.fn(() => fakeWindow()),
    createPermissionCheckerWindow: vi.fn(() => fakeWindow()),
    getMainWindow: () => null,
    getSourceSelectorWindow: () => null,
    getPermissionCheckerWindow: () => null,
    ...overrides,
  }
}

/**
 * The `electron` surface the domain modules touch. Every function is a `vi.fn`
 * so a test can override behaviour per case with `vi.mocked(...)`.
 */
export function createElectronMock() {
  const getPath = vi.fn((name: string) => `/tmp/capturia-test/${name}`)
  return {
    app: {
      getPath,
      isPackaged: false,
      getAppPath: vi.fn(() => '/tmp/capturia-test/app'),
      getLocale: vi.fn(() => 'en-US'),
      getVersion: vi.fn(() => '0.0.0-test'),
      name: 'Capturia',
    },
    ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() },
    screen: {
      getCursorScreenPoint: vi.fn(() => ({ x: 10, y: 10 })),
      getAllDisplays: vi.fn(() => [
        {
          id: 1,
          bounds: { x: 0, y: 0, width: 1920, height: 1080 },
          scaleFactor: 1,
          size: { width: 1920, height: 1080 },
        },
      ]),
      getDisplayNearestPoint: vi.fn(() => ({
        id: 1,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        workArea: { x: 0, y: 0, width: 1920, height: 1080 },
        scaleFactor: 1,
      })),
      getPrimaryDisplay: vi.fn(() => ({
        id: 1,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        workArea: { x: 0, y: 0, width: 1920, height: 1080 },
        scaleFactor: 1,
      })),
      getDisplayMatching: vi.fn(() => ({
        id: 1,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        workArea: { x: 0, y: 0, width: 1920, height: 1080 },
        scaleFactor: 1,
      })),
    },
    shell: {
      openExternal: vi.fn(async () => undefined),
      showItemInFolder: vi.fn(),
      openPath: vi.fn(async () => ''),
    },
    dialog: {
      showSaveDialog: vi.fn(async () => ({ canceled: true, filePath: '' })),
      showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
      showMessageBox: vi.fn(async () => ({ response: 0 })),
    },
    desktopCapturer: {
      getSources: vi.fn(async () => []),
    },
    systemPreferences: {
      getMediaAccessStatus: vi.fn(() => 'granted'),
      isTrustedAccessibilityClient: vi.fn(() => true),
      askForMediaAccess: vi.fn(async () => true),
    },
    BrowserWindow: class {
      static getAllWindows = vi.fn((): unknown[] => [])
    },
    Menu: { buildFromTemplate: vi.fn(), setApplicationMenu: vi.fn() },
  }
}
