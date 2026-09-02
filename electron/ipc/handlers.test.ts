import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { fakeIpcMain, fakeWindow } from './__tests__/ipcTestKit'
import { registerIpcHandlers } from './handlers'

vi.mock('electron', async () => (await import('./__tests__/ipcTestKit')).createElectronMock())

/**
 * The complete `ipcMain.handle` channel surface of the main process, captured
 * from `handlers.ts` before the F11 decomposition (2346-line version, tip
 * `6d5ace8`) plus the sub-registrations it already delegated to. The split
 * must not add, drop or rename a channel: preload and the renderer `.d.ts`
 * are untouched.
 */
const CHANNELS_BEFORE_DECOMPOSITION = [
  // fileReadHandlers.ts
  'read-binary-file',
  'get-readable-file-info',
  'read-file-chunk',
  // captionHandlers.ts
  'caption-model-dir',
  'caption-model-status',
  'caption-model-download',
  'caption-model-download-cancel',
  'analysis-save-sidecar',
  // recordingStream.ts
  'open-recording-stream',
  'append-recording-chunk',
  'close-recording-stream',
  // handlers.ts (monolith) in source order
  'cursor-tracker-start',
  'cursor-tracker-stop',
  'get-sources',
  'get-screen-capture-access-status',
  'get-capture-permission-snapshot',
  'request-capture-permission-access',
  'open-permission-settings',
  'open-screen-capture-settings',
  'open-permission-checker',
  'select-source',
  'get-selected-source',
  'open-source-selector',
  'switch-to-editor',
  'store-recorded-video',
  'get-recorded-video-path',
  'set-recording-state',
  'native-screen-recorder-start',
  'native-screen-recorder-stop',
  'open-external-url',
  'get-asset-base-path',
  'reveal-in-folder',
  'save-exported-video',
  'pick-save-file-path',
  'pick-export-directory',
  'open-video-file-picker',
  'set-current-video-path',
  'get-current-video-path',
  'clear-current-video-path',
  'save-project-state',
  'load-project-state',
  'get-platform',
  'analysis-start',
  'analysis-status',
  'analysis-result',
  'analysis-get-current',
  'get-shortcuts',
  'save-shortcuts',
]

/** Registered only when `main.ts` passes the HUD window plumbing. */
const HUD_CHANNELS = ['countdown-overlay-show', 'countdown-overlay-set-value', 'countdown-overlay-hide', 'open-notes']

const HUD_WINDOWS = {
  createCountdownOverlayWindow: () => fakeWindow(),
  getCountdownOverlayWindow: () => null,
  createNotesWindow: () => fakeWindow(),
  getNotesWindow: () => null,
}

function register(ipc: ReturnType<typeof fakeIpcMain>, userDataDir: string, withHud: boolean) {
  return registerIpcHandlers(
    vi.fn(),
    () => fakeWindow(),
    () => fakeWindow(),
    () => null,
    () => null,
    () => null,
    undefined,
    undefined,
    withHud ? HUD_WINDOWS : undefined,
    { ipcMain: ipc.ipcMain, recordingsDir: path.join(userDataDir, 'recordings'), userDataDir },
  )
}

describe('registerIpcHandlers (composition root)', () => {
  let userDataDir: string

  beforeAll(async () => {
    userDataDir = await mkdtemp(path.join(os.tmpdir(), 'capturia-ipc-'))
  })

  afterAll(async () => {
    await rm(userDataDir, { recursive: true, force: true })
  })

  it('registers exactly the pre-decomposition channel set (plus HUD when wired)', () => {
    const ipc = fakeIpcMain()
    register(ipc, userDataDir, true)
    expect([...ipc.registered].sort()).toEqual([...CHANNELS_BEFORE_DECOMPOSITION, ...HUD_CHANNELS].sort())
  })

  it('registers the same set without the HUD channels when no HUD plumbing is given', () => {
    const ipc = fakeIpcMain()
    register(ipc, userDataDir, false)
    expect([...ipc.registered].sort()).toEqual([...CHANNELS_BEFORE_DECOMPOSITION].sort())
  })

  it('never registers a channel twice', () => {
    const ipc = fakeIpcMain()
    register(ipc, userDataDir, true)
    expect(new Set(ipc.registered).size).toBe(ipc.registered.length)
  })

  it('shares one session across modules: select-source is visible to set-recording-state', async () => {
    const ipc = fakeIpcMain()
    const onRecordingStateChange = vi.fn()
    registerIpcHandlers(
      vi.fn(),
      () => fakeWindow(),
      () => fakeWindow(),
      () => null,
      () => null,
      () => null,
      onRecordingStateChange,
      undefined,
      undefined,
      { ipcMain: ipc.ipcMain, recordingsDir: path.join(userDataDir, 'recordings'), userDataDir },
    )
    await ipc.invoke('select-source', { id: 'screen:1:0', name: 'Display 1' })
    await ipc.invoke('set-recording-state', true)
    expect(onRecordingStateChange).toHaveBeenCalledWith(true, 'Display 1')
    expect(await ipc.invoke('get-platform')).toBe(process.platform)
  })

  it('shutdown resolves when nothing is running', async () => {
    const ipc = fakeIpcMain()
    const runtime = register(ipc, userDataDir, false)
    await expect(runtime.shutdown()).resolves.toBeUndefined()
  })
})
