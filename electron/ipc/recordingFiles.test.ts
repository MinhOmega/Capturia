import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { buildContext, fakeIpcMain, fakeWindow } from './__tests__/ipcTestKit'
import { registerRecordingFilesHandlers } from './recordingFiles'

vi.mock('electron', async () => (await import('./__tests__/ipcTestKit')).createElectronMock())
vi.mock('../native/sckRecorder', () => ({
  forceTerminateNativeMacRecorder: vi.fn(),
  getNativeMacRecorderOutputPath: vi.fn(() => null),
  isNativeMacRecorderActive: vi.fn(() => false),
  startNativeMacRecorder: vi.fn(async () => ({ success: false, message: 'not in test' })),
  stopNativeMacRecorder: vi.fn(async () => ({ success: true })),
  pauseNativeMacRecorder: vi.fn(async () => ({
    success: false,
    supported: false,
    message: 'Native recorder is not active.',
  })),
  resumeNativeMacRecorder: vi.fn(async () => ({
    success: false,
    supported: false,
    message: 'Native recorder is not active.',
  })),
}))
vi.mock('../recordingsCleanup', () => ({ scheduleRecordingsCleanup: vi.fn() }))
vi.mock('../recording/webm-duration', () => ({
  patchWebmDurationOnDisk: vi.fn(async () => ({ patched: true })),
}))

const REAL_PLATFORM = process.platform
function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

describe('recording files IPC handlers', () => {
  let recordingsDir: string

  beforeAll(async () => {
    recordingsDir = await mkdtemp(path.join(os.tmpdir(), 'capturia-recfiles-'))
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterAll(async () => {
    vi.restoreAllMocks()
    await rm(recordingsDir, { recursive: true, force: true })
  })

  afterEach(() => {
    setPlatform(REAL_PLATFORM)
  })

  it('registers the stream, source-selection and recorder channels', () => {
    const ipc = fakeIpcMain()
    registerRecordingFilesHandlers(buildContext(ipc, { recordingsDir }))
    expect(ipc.registered).toEqual([
      'open-recording-stream',
      'append-recording-chunk',
      'close-recording-stream',
      'select-source',
      'get-selected-source',
      'open-source-selector',
      'switch-to-editor',
      'store-recorded-video',
      'get-recorded-video-path',
      'set-recording-state',
      'native-screen-recorder-start',
      'pause-native-recording',
      'resume-native-recording',
      'native-screen-recorder-stop',
    ])
  })

  it('pause / resume forward the helper answer and degrade to unsupported on a throw', async () => {
    const sck = await import('../native/sckRecorder')
    const ipc = fakeIpcMain()
    registerRecordingFilesHandlers(buildContext(ipc, { recordingsDir }))

    // Old helper (no caps line): unsupported, not an error.
    await expect(ipc.invoke('pause-native-recording')).resolves.toMatchObject({
      success: false,
      supported: false,
    })

    vi.mocked(sck.pauseNativeMacRecorder).mockResolvedValueOnce({ success: true, supported: true })
    await expect(ipc.invoke('pause-native-recording')).resolves.toEqual({
      success: true,
      supported: true,
    })

    vi.mocked(sck.resumeNativeMacRecorder).mockResolvedValueOnce({
      success: false,
      supported: true,
      message: 'timeout',
    })
    await expect(ipc.invoke('resume-native-recording')).resolves.toEqual({
      success: false,
      supported: true,
      message: 'timeout',
    })

    vi.mocked(sck.resumeNativeMacRecorder).mockRejectedValueOnce(new Error('boom'))
    await expect(ipc.invoke('resume-native-recording')).resolves.toEqual({
      success: false,
      supported: false,
      message: 'boom',
    })
  })

  it('select-source stores the source, notifies the HUD and closes the picker', async () => {
    const ipc = fakeIpcMain()
    const mainWindow = fakeWindow()
    const selector = fakeWindow()
    const onSourceSelectionChange = vi.fn()
    const ctx = buildContext(ipc, {
      recordingsDir,
      getMainWindow: () => mainWindow,
      getSourceSelectorWindow: () => selector,
      onSourceSelectionChange,
    })
    registerRecordingFilesHandlers(ctx)

    const source = { id: 'screen:1:0', name: 'Display 1' }
    await expect(ipc.invoke('select-source', source)).resolves.toEqual(source)
    expect(ctx.session.selectedSource).toEqual(source)
    expect(onSourceSelectionChange).toHaveBeenCalledWith(source)
    expect(mainWindow.webContents.send).toHaveBeenCalledWith('selected-source-changed', source)
    expect(selector.close).toHaveBeenCalled()
    await expect(ipc.invoke('get-selected-source')).resolves.toEqual(source)
  })

  it('open-source-selector focuses an existing picker, switch-to-editor swaps windows', async () => {
    const ipc = fakeIpcMain()
    const selector = fakeWindow()
    const mainWindow = fakeWindow()
    const createEditorWindow = vi.fn()
    const createSourceSelectorWindow = vi.fn(() => fakeWindow())
    registerRecordingFilesHandlers(
      buildContext(ipc, {
        recordingsDir,
        getMainWindow: () => mainWindow,
        getSourceSelectorWindow: () => selector,
        createSourceSelectorWindow,
        createEditorWindow,
      }),
    )
    await ipc.invoke('open-source-selector')
    expect(selector.focus).toHaveBeenCalled()
    expect(createSourceSelectorWindow).not.toHaveBeenCalled()

    await ipc.invoke('switch-to-editor')
    expect(mainWindow.close).toHaveBeenCalled()
    expect(createEditorWindow).toHaveBeenCalled()
  })

  it('store-recorded-video writes the buffer into the recordings dir and refuses traversal', async () => {
    const ipc = fakeIpcMain()
    const ctx = buildContext(ipc, { recordingsDir })
    registerRecordingFilesHandlers(ctx)

    const bytes = new Uint8Array([1, 2, 3]).buffer
    const stored = await ipc.invoke<{ success: boolean; path: string }>(
      'store-recorded-video',
      bytes,
      'recording-1.webm',
      {
        frameRate: 30,
      },
    )
    expect(stored.success).toBe(true)
    expect(stored.path).toBe(path.join(recordingsDir, 'recording-1.webm'))
    expect(await readFile(stored.path)).toEqual(Buffer.from([1, 2, 3]))
    expect(ctx.session.currentVideoPath).toBe(stored.path)
    expect(ctx.session.currentVideoMetadata).toEqual({ frameRate: 30 })

    const refused = await ipc.invoke<{ success: boolean }>(
      'store-recorded-video',
      bytes,
      '../escape.webm',
    )
    expect(refused.success).toBe(false)
  })

  it('get-recorded-video-path returns the newest .webm', async () => {
    await writeFile(path.join(recordingsDir, 'recording-2.webm'), 'x')
    await writeFile(path.join(recordingsDir, 'notes.txt'), 'x')
    const ipc = fakeIpcMain()
    registerRecordingFilesHandlers(buildContext(ipc, { recordingsDir }))
    await expect(ipc.invoke('get-recorded-video-path')).resolves.toEqual({
      success: true,
      path: path.join(recordingsDir, 'recording-2.webm'),
    })
  })

  it('set-recording-state forwards the selected source name', async () => {
    const ipc = fakeIpcMain()
    const onRecordingStateChange = vi.fn()
    const ctx = buildContext(ipc, { recordingsDir, onRecordingStateChange })
    registerRecordingFilesHandlers(ctx)
    await ipc.invoke('set-recording-state', true)
    expect(onRecordingStateChange).toHaveBeenLastCalledWith(true, 'Screen')
    ctx.session.selectedSource = { name: 'Window A' }
    await ipc.invoke('set-recording-state', false)
    expect(onRecordingStateChange).toHaveBeenLastCalledWith(false, 'Window A')
  })

  it('native recorder start is macOS-only; stop still notifies the tray', async () => {
    setPlatform('linux')
    const ipc = fakeIpcMain()
    const onRecordingStateChange = vi.fn()
    registerRecordingFilesHandlers(buildContext(ipc, { recordingsDir, onRecordingStateChange }))
    await expect(ipc.invoke('native-screen-recorder-start', {})).resolves.toMatchObject({
      success: false,
    })
    await expect(ipc.invoke('native-screen-recorder-stop', { discard: true })).resolves.toEqual({
      success: true,
      discarded: true,
    })
    expect(onRecordingStateChange).toHaveBeenCalledWith(false, 'Screen')
  })
})
