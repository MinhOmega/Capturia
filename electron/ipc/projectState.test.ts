import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { buildContext, fakeIpcMain } from './__tests__/ipcTestKit'
import { writeCursorTrackSidecar } from './cursorTrack'
import { approvedReadPaths } from './paths'
import { registerProjectStateHandlers } from './projectState'

vi.mock('electron', async () => (await import('./__tests__/ipcTestKit')).createElectronMock())

describe('project state IPC handlers', () => {
  let userDataDir: string
  let recordingsDir: string

  beforeAll(async () => {
    userDataDir = await mkdtemp(path.join(os.tmpdir(), 'capturia-project-'))
    recordingsDir = path.join(userDataDir, 'recordings')
    await mkdir(recordingsDir, { recursive: true })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterAll(async () => {
    vi.restoreAllMocks()
    approvedReadPaths.clear()
    await rm(userDataDir, { recursive: true, force: true })
  })

  function setup() {
    const ipc = fakeIpcMain()
    const ctx = buildContext(ipc, { recordingsDir, userDataDir })
    registerProjectStateHandlers(ctx)
    return { ipc, ctx }
  }

  it('registers the current-video, project-state and shortcuts channels', () => {
    const { ipc } = setup()
    expect(ipc.registered).toEqual([
      'set-current-video-path',
      'get-current-video-path',
      'clear-current-video-path',
      'save-project-state',
      'load-project-state',
      'get-platform',
      'get-shortcuts',
      'save-shortcuts',
    ])
  })

  it('set-current-video-path accepts recordings-dir files, reads the sidecar, and refuses others', async () => {
    const { ipc, ctx } = setup()
    const videoPath = path.join(recordingsDir, 'recording-9.webm')
    await writeFile(videoPath, 'x')
    await writeCursorTrackSidecar(videoPath, { samples: [{ timeMs: 1, x: 0.5, y: 0.5 }] })

    await expect(
      ipc.invoke('set-current-video-path', videoPath, { frameRate: 24 }),
    ).resolves.toEqual({ success: true })
    expect(ctx.session.currentVideoPath).toBe(videoPath)
    expect(ctx.session.currentVideoMetadata?.frameRate).toBe(24)
    expect(ctx.session.currentVideoMetadata?.cursorTrack?.samples).toHaveLength(1)

    const current = await ipc.invoke<{ success: boolean; path: string }>('get-current-video-path')
    expect(current).toMatchObject({ success: true, path: videoPath })

    await expect(ipc.invoke('set-current-video-path', '/etc/passwd.webm')).resolves.toMatchObject({
      success: false,
    })
    // A refused path leaves the session untouched.
    expect(ctx.session.currentVideoPath).toBe(videoPath)

    await expect(ipc.invoke('clear-current-video-path')).resolves.toEqual({ success: true })
    await expect(ipc.invoke('get-current-video-path')).resolves.toEqual({ success: false })
  })

  it('save/load project state round-trips through <userData>/projects and reports notFound', async () => {
    const { ipc } = setup()
    const videoPath = path.join(recordingsDir, 'recording-9.webm')
    await expect(ipc.invoke('save-project-state', videoPath, { zoom: [1, 2] })).resolves.toEqual({
      success: true,
    })
    await expect(ipc.invoke('load-project-state', videoPath)).resolves.toEqual({
      success: true,
      state: { zoom: [1, 2] },
    })
    await expect(
      ipc.invoke('load-project-state', path.join(recordingsDir, 'never.webm')),
    ).resolves.toEqual({
      success: false,
      notFound: true,
    })
  })

  it('shortcuts persist to <userData>/shortcuts.json', async () => {
    const { ipc } = setup()
    await expect(ipc.invoke('get-shortcuts')).resolves.toBeNull()
    await expect(ipc.invoke('save-shortcuts', { play: 'Space' })).resolves.toEqual({
      success: true,
    })
    await expect(ipc.invoke('get-shortcuts')).resolves.toEqual({ play: 'Space' })
  })

  it('get-platform reports the host platform', async () => {
    const { ipc } = setup()
    await expect(ipc.invoke('get-platform')).resolves.toBe(process.platform)
  })
})
