import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { whenMediaLinksIdle } from '../media/mediaLinksRegistry'
import { buildContext, fakeIpcMain } from './__tests__/ipcTestKit'
import { writeCursorTrackSidecar } from './cursorTrack'
import { approvedReadPaths } from './paths'
import { projectStateFileName, registerProjectStateHandlers } from './projectState'

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
    await whenMediaLinksIdle(userDataDir)
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

  it('load-project-state relinks a moved recording by fingerprint and restores its cursor track', async () => {
    const { ipc, ctx } = setup()
    const videoPath = path.join(recordingsDir, 'moved-source.webm')
    await writeFile(videoPath, Buffer.from('moved-source-bytes-'.repeat(40)))
    await writeCursorTrackSidecar(videoPath, { samples: [{ timeMs: 2, x: 0.1, y: 0.2 }] })
    await expect(
      ipc.invoke('save-project-state', videoPath, { version: 1, segments: [] }),
    ).resolves.toEqual({ success: true })

    const registry = JSON.parse(await readFile(path.join(userDataDir, 'media-links.json'), 'utf-8'))
    const entry = registry.entries.find(
      (candidate: { lastKnownPath: string }) => candidate.lastKnownPath === videoPath,
    )
    expect(entry).toMatchObject({
      lastKnownPath: videoPath,
      projectStateFile: projectStateFileName(videoPath),
      cursorSidecarPath: path.join(recordingsDir, 'moved-source.cursor.json'),
    })

    // Move the recording (sidecar left behind) and open it from the new place.
    const movedPath = path.join(recordingsDir, 'renamed.webm')
    await rename(videoPath, movedPath)
    await expect(ipc.invoke('set-current-video-path', movedPath)).resolves.toEqual({
      success: true,
    })
    // The cursor track came from the registry's sidecar, not from next to the file.
    expect(ctx.session.currentVideoMetadata?.cursorTrack?.samples).toHaveLength(1)

    await expect(ipc.invoke('load-project-state', movedPath)).resolves.toEqual({
      success: true,
      state: { version: 1, segments: [] },
      relinked: true,
      relinkedFrom: videoPath,
    })
    // Second open takes the cheap path: state under the new key, no relink flag.
    await expect(ipc.invoke('load-project-state', movedPath)).resolves.toEqual({
      success: true,
      state: { version: 1, segments: [] },
    })
    await expect(stat(path.join(recordingsDir, 'renamed.cursor.json'))).resolves.toBeTruthy()
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
