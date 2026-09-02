import path from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { buildContext, fakeIpcMain } from './__tests__/ipcTestKit'
import { registerAnalysisHandlers } from './analysis'

vi.mock('electron', async () => (await import('./__tests__/ipcTestKit')).createElectronMock())

const service = vi.hoisted(() => ({
  start: vi.fn(() => ({ jobId: 'job-1' })),
  getStatus: vi.fn((jobId: string) => (jobId === 'job-1' ? { status: 'completed' } : null)),
  getResult: vi.fn(() => ({ subtitles: [] })),
}))
vi.mock('../analysis/videoAnalysisService', () => ({
  VideoAnalysisService: class {
    start = service.start
    getStatus = service.getStatus
    getResult = service.getResult
  },
  readAnalysisSidecar: vi.fn(async () => ({ subtitles: [{ text: 'hi' }] })),
}))

const RECORDINGS_DIR = path.resolve('/tmp/capturia-analysis/recordings')

describe('analysis IPC handlers', () => {
  beforeAll(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  function setup() {
    const ipc = fakeIpcMain()
    const ctx = buildContext(ipc, { recordingsDir: RECORDINGS_DIR })
    registerAnalysisHandlers(ctx)
    return { ipc, ctx }
  }

  it('registers the four analysis channels', () => {
    const { ipc } = setup()
    expect(ipc.registered).toEqual(['analysis-start', 'analysis-status', 'analysis-result', 'analysis-get-current'])
  })

  it('analysis-start needs a video and keeps the read policy', async () => {
    const { ipc, ctx } = setup()
    await expect(ipc.invoke('analysis-start', {})).resolves.toMatchObject({ success: false })
    await expect(ipc.invoke('analysis-start', { videoPath: '/etc/passwd.webm' })).resolves.toMatchObject({ success: false })
    expect(service.start).not.toHaveBeenCalled()

    ctx.session.currentVideoPath = path.join(RECORDINGS_DIR, 'recording-1.webm')
    await expect(ipc.invoke('analysis-start', { locale: ' vi ', durationMs: 1000 })).resolves.toEqual({
      success: true,
      jobId: 'job-1',
    })
    expect(service.start).toHaveBeenCalledWith(
      expect.objectContaining({ videoPath: ctx.session.currentVideoPath, locale: 'vi', durationMs: 1000, videoWidth: 1920 }),
    )
  })

  it('analysis-status / analysis-result resolve known jobs and reject unknown ones', async () => {
    const { ipc } = setup()
    await expect(ipc.invoke('analysis-status', 'nope')).resolves.toMatchObject({ success: false })
    await expect(ipc.invoke('analysis-status', 'job-1')).resolves.toEqual({ success: true, status: { status: 'completed' } })
    await expect(ipc.invoke('analysis-result', 'job-1')).resolves.toEqual({
      success: true,
      status: { status: 'completed' },
      result: { subtitles: [] },
    })
  })

  it('analysis-get-current reads the sidecar only for approved paths', async () => {
    const { ipc, ctx } = setup()
    await expect(ipc.invoke('analysis-get-current')).resolves.toMatchObject({ success: false })
    await expect(ipc.invoke('analysis-get-current', '/etc/passwd.webm')).resolves.toMatchObject({ success: false })
    ctx.session.currentVideoPath = path.join(RECORDINGS_DIR, 'recording-1.webm')
    await expect(ipc.invoke('analysis-get-current')).resolves.toEqual({
      success: true,
      analysis: { subtitles: [{ text: 'hi' }] },
    })
  })
})
