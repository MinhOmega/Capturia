import { mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runRecordingsCleanup } from './recordingsCleanup'
import { projectStateFileName } from './ipc/projectState'

vi.mock('electron', async () => (await import('./ipc/__tests__/ipcTestKit')).createElectronMock())

const DAY_MS = 24 * 60 * 60 * 1000

describe('recordings cleanup against saved projects', () => {
  let userDataDir: string
  let recordingsDir: string
  let projectsDir: string

  /** A recording old enough that the age rule wants it gone. */
  async function writeAgedRecording(name: string, sizeBytes: number, ageDays: number) {
    const filePath = path.join(recordingsDir, name)
    await writeFile(filePath, Buffer.alloc(sizeBytes))
    const when = new Date(Date.now() - ageDays * DAY_MS)
    await utimes(filePath, when, when)
    return filePath
  }

  async function writeProjectState(videoPath: string) {
    await mkdir(projectsDir, { recursive: true })
    await writeFile(
      path.join(projectsDir, projectStateFileName(videoPath)),
      JSON.stringify({ version: 1, savedAt: Date.now(), videoFilePath: videoPath, segments: [] }),
      'utf-8',
    )
  }

  beforeEach(async () => {
    userDataDir = await mkdtemp(path.join(os.tmpdir(), 'capturia-cleanup-'))
    recordingsDir = path.join(userDataDir, 'recordings')
    projectsDir = path.join(userDataDir, 'projects')
    await mkdir(recordingsDir, { recursive: true })
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(userDataDir, { recursive: true, force: true })
  })

  const agedOutPolicy = {
    maxVideoAgeMs: DAY_MS,
    minKeepVideoGroups: 1,
    maxTotalBytes: 1_000,
    targetTotalBytes: 500,
  }

  it('keeps a referenced recording that is both too old and over budget, and deletes the rest', async () => {
    const referenced = await writeAgedRecording('recording-1.webm', 4_000, 40)
    await writeAgedRecording('recording-1.cursor.json', 100, 40)
    await writeAgedRecording('recording-2.webm', 4_000, 40)
    await writeAgedRecording('recording-3.webm', 100, 0)
    await writeProjectState(referenced)

    await runRecordingsCleanup({
      recordingsDir,
      userDataDir,
      reason: 'startup',
      policy: agedOutPolicy,
    })

    expect((await readdir(recordingsDir)).sort()).toEqual([
      'recording-1.cursor.json',
      'recording-1.webm',
      'recording-3.webm',
    ])
  })

  it('resolves a project reference through a symlink to the same recording', async () => {
    const referenced = await writeAgedRecording('recording-1.webm', 4_000, 40)
    await writeAgedRecording('recording-2.webm', 4_000, 40)
    await writeAgedRecording('recording-3.webm', 100, 0)
    // The user opened the recording through a link elsewhere; the project state
    // holds the link's path, not the file's.
    const linkPath = path.join(userDataDir, 'linked-recording.webm')
    await symlink(referenced, linkPath)
    await writeProjectState(linkPath)

    await runRecordingsCleanup({
      recordingsDir,
      userDataDir,
      reason: 'startup',
      policy: agedOutPolicy,
    })

    expect((await readdir(recordingsDir)).sort()).toEqual(['recording-1.webm', 'recording-3.webm'])
  })

  it('protects the recording the media-links registry points at', async () => {
    const referenced = await writeAgedRecording('recording-1.webm', 4_000, 40)
    await writeAgedRecording('recording-2.webm', 4_000, 40)
    await writeAgedRecording('recording-3.webm', 100, 0)
    await writeFile(
      path.join(userDataDir, 'media-links.json'),
      JSON.stringify({
        version: 1,
        entries: [
          {
            fingerprint: {
              sizeBytes: 4_000,
              headSha256: 'a'.repeat(64),
              tailSha256: 'b'.repeat(64),
            },
            lastKnownPath: referenced,
            projectStateFile: 'whatever.json',
            updatedAt: new Date().toISOString(),
          },
        ],
      }),
      'utf-8',
    )

    await runRecordingsCleanup({
      recordingsDir,
      userDataDir,
      reason: 'startup',
      policy: agedOutPolicy,
    })

    expect((await readdir(recordingsDir)).sort()).toEqual(['recording-1.webm', 'recording-3.webm'])
  })

  it('skips the whole run and logs once when a project file cannot be parsed', async () => {
    await writeAgedRecording('recording-1.webm', 4_000, 40)
    await writeAgedRecording('recording-2.webm', 4_000, 40)
    await mkdir(projectsDir, { recursive: true })
    await writeFile(path.join(projectsDir, 'broken.json'), '{ not json', 'utf-8')

    await runRecordingsCleanup({
      recordingsDir,
      userDataDir,
      reason: 'startup',
      policy: agedOutPolicy,
    })

    // Nothing was deleted, and exactly one line explains why.
    expect((await readdir(recordingsDir)).sort()).toEqual(['recording-1.webm', 'recording-2.webm'])
    const warnings = vi
      .mocked(console.warn)
      .mock.calls.map((call) => String(call[0]))
      .filter((line) => line.includes('[recordings-cleanup] skipped'))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('broken.json')
  })

  it('still deletes unreferenced recordings when no project has ever been saved', async () => {
    await writeAgedRecording('recording-1.webm', 4_000, 40)
    await writeAgedRecording('recording-2.webm', 100, 0)

    await runRecordingsCleanup({
      recordingsDir,
      userDataDir,
      reason: 'startup',
      policy: agedOutPolicy,
    })

    expect(await readdir(recordingsDir)).toEqual(['recording-2.webm'])
  })
})
