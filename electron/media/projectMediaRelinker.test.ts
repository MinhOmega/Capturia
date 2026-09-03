import { copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveCursorSidecarPath, writeCursorTrackSidecar } from '../ipc/cursorTrack'
import { approvedReadPaths } from '../ipc/paths'
import { readMediaLinksRegistry, whenMediaLinksIdle } from './mediaLinksRegistry'
import {
  decideRelink,
  findLinkedCursorSidecar,
  isTrustedCursorSidecarPath,
  registerProjectMedia,
  relinkProjectStateForVideo,
} from './projectMediaRelinker'

describe('decideRelink', () => {
  const match = {
    lastKnownPath: '/old/a.webm',
    projectStateFile: 'a.webm_1234.json',
    projectStateExists: true,
    cursorSidecarPath: '/old/a.cursor.json',
    cursorSidecarExists: true,
  }
  const second = {
    lastKnownPath: '/other/copy.webm',
    projectStateFile: 'copy.webm_5678.json',
    projectStateExists: true,
    cursorSidecarPath: '/other/copy.cursor.json',
    cursorSidecarExists: true,
  }

  it.each([
    ['state already exists for the path', true, [match], { action: 'keep' }],
    ['no registry match', false, [], { action: 'none', reason: 'no-match' }],
    [
      'the only match is this same path (state file deleted by hand)',
      false,
      [{ ...match, lastKnownPath: '/new/b.webm' }],
      { action: 'none', reason: 'same-path' },
    ],
    [
      'a match for this same path is ignored alongside a usable one',
      false,
      [{ ...match, lastKnownPath: '/new/b.webm', projectStateFile: 'self.json' }, match],
      {
        action: 'relink',
        fromPath: '/old/a.webm',
        projectStateFile: 'a.webm_1234.json',
        cursorSidecarPath: '/old/a.cursor.json',
      },
    ],
    [
      'match has no project state file',
      false,
      [{ ...match, projectStateFile: undefined }],
      { action: 'none', reason: 'state-missing' },
    ],
    [
      'match state file is gone',
      false,
      [{ ...match, projectStateExists: false }],
      { action: 'none', reason: 'state-missing' },
    ],
    [
      'moved file with state and sidecar',
      false,
      [match],
      {
        action: 'relink',
        fromPath: '/old/a.webm',
        projectStateFile: 'a.webm_1234.json',
        cursorSidecarPath: '/old/a.cursor.json',
      },
    ],
    [
      'moved file whose old sidecar is gone',
      false,
      [{ ...match, cursorSidecarExists: false }],
      {
        action: 'relink',
        fromPath: '/old/a.webm',
        projectStateFile: 'a.webm_1234.json',
        cursorSidecarPath: null,
      },
    ],
    [
      'two copies with their own project state are ambiguous',
      false,
      [match, second],
      { action: 'none', reason: 'ambiguous' },
    ],
    [
      'a second copy without usable state does not make it ambiguous',
      false,
      [match, { ...second, projectStateExists: false }],
      {
        action: 'relink',
        fromPath: '/old/a.webm',
        projectStateFile: 'a.webm_1234.json',
        cursorSidecarPath: '/old/a.cursor.json',
      },
    ],
    [
      'copies pointing at one state file relink, but a disagreeing sidecar is dropped',
      false,
      [match, { ...second, projectStateFile: match.projectStateFile }],
      {
        action: 'relink',
        fromPath: '/old/a.webm',
        projectStateFile: 'a.webm_1234.json',
        cursorSidecarPath: null,
      },
    ],
  ])('%s', (_label, hasProjectStateForPath, matches, expected) => {
    expect(decideRelink({ videoPath: '/new/b.webm', hasProjectStateForPath, matches })).toEqual(
      expected,
    )
  })
})

describe('isTrustedCursorSidecarPath', () => {
  it('accepts only the sidecar derived from the recorded path', () => {
    expect(isTrustedCursorSidecarPath('/old/a.cursor.json', '/old/a.webm')).toBe(true)
    expect(isTrustedCursorSidecarPath('/old/a.cursor.json', '/old/b.webm')).toBe(false)
    expect(isTrustedCursorSidecarPath('/etc/passwd', '/old/a.webm')).toBe(false)
    expect(isTrustedCursorSidecarPath('a.cursor.json', '/old/a.webm')).toBe(false)
    expect(isTrustedCursorSidecarPath(undefined, '/old/a.webm')).toBe(false)
  })
})

describe('relinkProjectStateForVideo', () => {
  let root: string
  let userDataDir: string
  let projectsDir: string
  let recordingsDir: string
  let elsewhere: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'capturia-relink-'))
    userDataDir = path.join(root, 'userData')
    projectsDir = path.join(userDataDir, 'projects')
    recordingsDir = path.join(userDataDir, 'recordings')
    elsewhere = path.join(root, 'Desktop')
    await mkdir(projectsDir, { recursive: true })
    await mkdir(recordingsDir, { recursive: true })
    await mkdir(elsewhere, { recursive: true })
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    approvedReadPaths.clear()
    await whenMediaLinksIdle(userDataDir)
    await rm(root, { recursive: true, force: true })
  })

  async function recordAndSave(name = 'recording-1.webm') {
    const videoPath = path.join(recordingsDir, name)
    await writeFile(videoPath, Buffer.from('webm-bytes-'.repeat(50)))
    await writeCursorTrackSidecar(videoPath, { samples: [{ timeMs: 1, x: 0.5, y: 0.5 }] })
    const stateFile = 'recording-1.webm_oldkey.json'
    await writeFile(path.join(projectsDir, stateFile), JSON.stringify({ version: 1, zoom: 1 }))
    await registerProjectMedia({
      registryDir: userDataDir,
      recordingsDir,
      videoPath,
      projectStateFile: stateFile,
    })
    return { videoPath, stateFile }
  }

  it('records the state file and the adjacent cursor sidecar on save', async () => {
    const { videoPath, stateFile } = await recordAndSave()
    const registry = await readMediaLinksRegistry(userDataDir)
    expect(registry.entries).toHaveLength(1)
    expect(registry.entries[0]).toMatchObject({
      lastKnownPath: videoPath,
      projectStateFile: stateFile,
      cursorSidecarPath: resolveCursorSidecarPath(videoPath),
    })
  })

  it('refuses to register a path outside the read policy', async () => {
    const outside = path.join(elsewhere, 'x.webm')
    await writeFile(outside, 'x')
    await expect(
      registerProjectMedia({
        registryDir: userDataDir,
        recordingsDir,
        videoPath: outside,
        projectStateFile: 'x.json',
      }),
    ).resolves.toBeNull()
    expect((await readMediaLinksRegistry(userDataDir)).entries).toHaveLength(0)
  })

  it('copies the state and the cursor sidecar to a moved recording opened via the picker', async () => {
    const { videoPath, stateFile } = await recordAndSave()
    const movedPath = path.join(elsewhere, 'renamed.webm')
    await rename(videoPath, movedPath)
    approvedReadPaths.approveFile(movedPath)

    const result = await relinkProjectStateForVideo({
      registryDir: userDataDir,
      projectsDir,
      recordingsDir,
      videoPath: movedPath,
      projectStateFile: 'renamed.webm_newkey.json',
    })
    expect(result).toEqual({
      relinked: true,
      fromPath: videoPath,
      state: { version: 1, zoom: 1 },
      cursorSidecarWritten: true,
    })

    // The new key now has its own copy; the old one is untouched.
    expect(
      JSON.parse(await readFile(path.join(projectsDir, 'renamed.webm_newkey.json'), 'utf-8')),
    ).toEqual({ version: 1, zoom: 1 })
    await expect(stat(path.join(projectsDir, stateFile))).resolves.toBeTruthy()
    // The cursor sidecar sits next to the moved file.
    const movedSidecar = JSON.parse(await readFile(resolveCursorSidecarPath(movedPath), 'utf-8'))
    expect(movedSidecar.cursorTrack.samples).toHaveLength(1)

    await whenMediaLinksIdle(userDataDir)
    const registry = await readMediaLinksRegistry(userDataDir)
    expect(registry.entries).toHaveLength(1)
    expect(registry.entries[0]).toMatchObject({
      lastKnownPath: movedPath,
      projectStateFile: 'renamed.webm_newkey.json',
      cursorSidecarPath: resolveCursorSidecarPath(movedPath),
    })
  })

  it('keeps an existing state file and never touches the registry for it', async () => {
    const { videoPath } = await recordAndSave()
    await writeFile(path.join(projectsDir, 'present.json'), '{"version":1}')
    const result = await relinkProjectStateForVideo({
      registryDir: userDataDir,
      projectsDir,
      recordingsDir,
      videoPath,
      projectStateFile: 'present.json',
    })
    expect(result).toEqual({ relinked: false, decision: { action: 'keep' } })
  })

  it('does nothing for an unknown recording or a path outside the read policy', async () => {
    const unknown = path.join(recordingsDir, 'fresh.webm')
    await writeFile(unknown, 'fresh')
    await expect(
      relinkProjectStateForVideo({
        registryDir: userDataDir,
        projectsDir,
        recordingsDir,
        videoPath: unknown,
        projectStateFile: 'fresh.json',
      }),
    ).resolves.toEqual({ relinked: false, decision: { action: 'none', reason: 'no-match' } })

    const outside = path.join(elsewhere, 'nope.webm')
    await writeFile(outside, 'fresh')
    await expect(
      relinkProjectStateForVideo({
        registryDir: userDataDir,
        projectsDir,
        recordingsDir,
        videoPath: outside,
        projectStateFile: 'nope.json',
      }),
    ).resolves.toEqual({ relinked: false, decision: { action: 'none', reason: 'no-match' } })
  })

  it('ignores a registry entry whose state file name is not a bare .json name', async () => {
    const { videoPath } = await recordAndSave()
    const registryFile = path.join(userDataDir, 'media-links.json')
    const raw = JSON.parse(await readFile(registryFile, 'utf-8'))
    raw.entries[0].projectStateFile = '../shortcuts.json'
    await writeFile(registryFile, JSON.stringify(raw))

    const movedPath = path.join(recordingsDir, 'moved.webm')
    await rename(videoPath, movedPath)
    await expect(
      relinkProjectStateForVideo({
        registryDir: userDataDir,
        projectsDir,
        recordingsDir,
        videoPath: movedPath,
        projectStateFile: 'moved.json',
      }),
    ).resolves.toEqual({
      relinked: false,
      decision: { action: 'none', reason: 'state-missing' },
    })
  })

  it('refuses to relink when two live copies of the same bytes have their own state', async () => {
    const { videoPath } = await recordAndSave()
    // A second copy of the same bytes, edited separately: same fingerprint,
    // its own project state.
    const copyPath = path.join(recordingsDir, 'copy.webm')
    await copyFile(videoPath, copyPath)
    await writeCursorTrackSidecar(copyPath, { samples: [{ timeMs: 9, x: 0.9, y: 0.9 }] })
    await writeFile(path.join(projectsDir, 'copy.webm_otherkey.json'), JSON.stringify({ v: 2 }))
    await registerProjectMedia({
      registryDir: userDataDir,
      recordingsDir,
      videoPath: copyPath,
      projectStateFile: 'copy.webm_otherkey.json',
    })
    await whenMediaLinksIdle(userDataDir)
    expect((await readMediaLinksRegistry(userDataDir)).entries).toHaveLength(2)

    const thirdPath = path.join(recordingsDir, 'third.webm')
    await copyFile(videoPath, thirdPath)
    await expect(
      relinkProjectStateForVideo({
        registryDir: userDataDir,
        projectsDir,
        recordingsDir,
        videoPath: thirdPath,
        projectStateFile: 'third.webm_key.json',
      }),
    ).resolves.toEqual({ relinked: false, decision: { action: 'none', reason: 'ambiguous' } })
    await expect(stat(path.join(projectsDir, 'third.webm_key.json'))).rejects.toThrow()
    // Same rule for the cursor sidecar once the copies have one each: no
    // answer beats the wrong answer.
    await expect(
      findLinkedCursorSidecar({ registryDir: userDataDir, recordingsDir, videoPath: thirdPath }),
    ).resolves.toBeNull()
  })

  it('relinks again after a second move because the stale entry was dropped', async () => {
    const { videoPath } = await recordAndSave()
    const firstMove = path.join(recordingsDir, 'move-1.webm')
    await rename(videoPath, firstMove)
    await expect(
      relinkProjectStateForVideo({
        registryDir: userDataDir,
        projectsDir,
        recordingsDir,
        videoPath: firstMove,
        projectStateFile: 'move-1.json',
      }),
    ).resolves.toMatchObject({ relinked: true, fromPath: videoPath })
    await whenMediaLinksIdle(userDataDir)
    expect((await readMediaLinksRegistry(userDataDir)).entries).toHaveLength(1)

    const secondMove = path.join(recordingsDir, 'move-2.webm')
    await rename(firstMove, secondMove)
    await expect(
      relinkProjectStateForVideo({
        registryDir: userDataDir,
        projectsDir,
        recordingsDir,
        videoPath: secondMove,
        projectStateFile: 'move-2.json',
      }),
    ).resolves.toMatchObject({ relinked: true, fromPath: firstMove })
    expect(JSON.parse(await readFile(path.join(projectsDir, 'move-2.json'), 'utf-8'))).toEqual({
      version: 1,
      zoom: 1,
    })
  })

  it('findLinkedCursorSidecar returns the old sidecar for a moved recording, read-only', async () => {
    const { videoPath } = await recordAndSave()
    const movedPath = path.join(recordingsDir, 'sub', 'moved.webm')
    await mkdir(path.dirname(movedPath), { recursive: true })
    await rename(videoPath, movedPath)

    await expect(
      findLinkedCursorSidecar({ registryDir: userDataDir, recordingsDir, videoPath: movedPath }),
    ).resolves.toBe(resolveCursorSidecarPath(videoPath))
    // Not copied: that is the relinker's job.
    await expect(stat(resolveCursorSidecarPath(movedPath))).rejects.toThrow()
    // The file at its recorded location has its sidecar next to it: no fallback needed.
    await expect(
      findLinkedCursorSidecar({ registryDir: userDataDir, recordingsDir, videoPath }),
    ).resolves.toBeNull()
  })
})
