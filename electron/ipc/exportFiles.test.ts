import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildContext, fakeIpcMain, fakeWindow } from './__tests__/ipcTestKit'
import { registerExportFilesHandlers } from './exportFiles'
import { approvedExportPaths, approvedReadPaths } from './paths'

vi.mock('electron', async () => (await import('./__tests__/ipcTestKit')).createElectronMock())

describe('export files IPC handlers', () => {
  let recordingsDir: string
  let exportDir: string

  beforeAll(async () => {
    recordingsDir = await mkdtemp(path.join(os.tmpdir(), 'capturia-export-rec-'))
    exportDir = await mkdtemp(path.join(os.tmpdir(), 'capturia-export-out-'))
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterAll(async () => {
    vi.restoreAllMocks()
    approvedExportPaths.clear()
    approvedReadPaths.clear()
    await rm(recordingsDir, { recursive: true, force: true })
    await rm(exportDir, { recursive: true, force: true })
  })

  beforeEach(() => {
    approvedExportPaths.clear()
    approvedReadPaths.clear()
  })

  it('registers the dialog, export and URL channels', () => {
    const ipc = fakeIpcMain()
    registerExportFilesHandlers(buildContext(ipc, { recordingsDir }))
    expect(ipc.registered).toEqual([
      'open-external-url',
      'get-asset-base-path',
      'reveal-in-folder',
      'save-exported-video',
      'pick-save-file-path',
      'pick-export-directory',
      'open-video-file-picker',
    ])
  })

  it('open-external-url honours the scheme allowlist', async () => {
    const { shell } = await import('electron')
    const ipc = fakeIpcMain()
    registerExportFilesHandlers(buildContext(ipc, { recordingsDir }))
    await expect(ipc.invoke('open-external-url', 'https://github.com/MinhOmega/Capturia')).resolves.toEqual({ success: true })
    expect(shell.openExternal).toHaveBeenCalledWith('https://github.com/MinhOmega/Capturia')
    await expect(ipc.invoke('open-external-url', 'file:///etc/passwd')).resolves.toMatchObject({ success: false })
    await expect(ipc.invoke('open-external-url', 'javascript:alert(1)')).resolves.toMatchObject({ success: false })
  })

  it('get-asset-base-path points at public/assets in dev', async () => {
    const ipc = fakeIpcMain()
    registerExportFilesHandlers(buildContext(ipc, { recordingsDir }))
    await expect(ipc.invoke('get-asset-base-path')).resolves.toBe(path.join('/tmp/capturia-test/app', 'public', 'assets'))
  })

  it('reveal-in-folder only reveals app-managed files', async () => {
    const { shell } = await import('electron')
    const ipc = fakeIpcMain()
    registerExportFilesHandlers(buildContext(ipc, { recordingsDir }))
    const inside = path.join(recordingsDir, 'recording-1.webm')
    await expect(ipc.invoke('reveal-in-folder', inside)).resolves.toEqual({ success: true })
    expect(shell.showItemInFolder).toHaveBeenCalledWith(inside)
    await expect(ipc.invoke('reveal-in-folder', '/etc/passwd')).resolves.toMatchObject({ success: false })
  })

  it('save-exported-video refuses a target path that did not come from the save dialog', async () => {
    const ipc = fakeIpcMain()
    registerExportFilesHandlers(buildContext(ipc, { recordingsDir }))
    const result = await ipc.invoke<{ success: boolean; message: string }>(
      'save-exported-video',
      new Uint8Array([1]).buffer,
      'clip.mp4',
      'en',
      { targetFilePath: path.join(exportDir, 'sneaky.mp4') },
    )
    expect(result.success).toBe(false)
    expect(result.message).toBe('Export destination must be chosen through the save dialog')
  })

  it('save-exported-video writes to a path approved by pick-save-file-path (extension enforced)', async () => {
    const { dialog } = await import('electron')
    const mainWindow = fakeWindow()
    const chosen = path.join(exportDir, 'clip')
    vi.mocked(dialog.showSaveDialog).mockResolvedValueOnce({ canceled: false, filePath: chosen })
    const ipc = fakeIpcMain()
    registerExportFilesHandlers(buildContext(ipc, { recordingsDir, getMainWindow: () => mainWindow }))

    const picked = await ipc.invoke<{ success: boolean; path: string }>('pick-save-file-path', 'clip.mp4', 'en')
    expect(picked).toEqual({ success: true, path: `${chosen}.mp4` })
    // Dialog parent is the main window (Wayland needs it), as W0-b set up.
    expect(dialog.showSaveDialog).toHaveBeenCalledWith(expect.objectContaining({ parent: mainWindow }))

    const saved = await ipc.invoke<{ success: boolean; path: string }>(
      'save-exported-video',
      new Uint8Array([7, 7]).buffer,
      'clip.mp4',
      'en',
      { targetFilePath: picked.path },
    )
    expect(saved.success).toBe(true)
    expect(await readFile(saved.path)).toEqual(Buffer.from([7, 7]))
  })

  it('save-exported-video reports cancellation when the dialog is dismissed', async () => {
    const ipc = fakeIpcMain()
    registerExportFilesHandlers(buildContext(ipc, { recordingsDir }))
    await expect(ipc.invoke('save-exported-video', new Uint8Array([1]).buffer, 'clip.gif', 'en')).resolves.toMatchObject({
      success: false,
      cancelled: true,
    })
  })

  it('pick-export-directory approves the chosen folder for later bare-name exports', async () => {
    const { dialog } = await import('electron')
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: false, filePaths: [exportDir] })
    const ipc = fakeIpcMain()
    registerExportFilesHandlers(buildContext(ipc, { recordingsDir }))
    await expect(ipc.invoke('pick-export-directory', 'en')).resolves.toEqual({ success: true, path: exportDir })
    const saved = await ipc.invoke<{ success: boolean; path: string }>(
      'save-exported-video',
      new Uint8Array([1]).buffer,
      'batch.mp4',
      'en',
      { directoryPath: exportDir },
    )
    expect(saved).toMatchObject({ success: true, path: path.join(exportDir, 'batch.mp4') })
  })

  it('open-video-file-picker approves the picked file and rejects unsupported extensions', async () => {
    const { dialog } = await import('electron')
    const ipc = fakeIpcMain()
    registerExportFilesHandlers(buildContext(ipc, { recordingsDir }))

    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: false, filePaths: [path.join(exportDir, 'movie.mov')] })
    await expect(ipc.invoke('open-video-file-picker', 'en')).resolves.toEqual({
      success: true,
      path: path.join(exportDir, 'movie.mov'),
    })
    expect(approvedReadPaths.isApprovedFile(path.join(exportDir, 'movie.mov'))).toBe(true)

    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: false, filePaths: [path.join(exportDir, 'notes.txt')] })
    await expect(ipc.invoke('open-video-file-picker', 'en')).resolves.toMatchObject({ success: false })
  })
})
