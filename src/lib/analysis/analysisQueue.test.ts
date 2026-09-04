import { describe, expect, it } from 'vitest'
import { analysisProgressPercent, AnalysisJobQueue } from './analysisQueue'

describe('AnalysisJobQueue', () => {
  it('runs jobs sequentially and stores completion results', async () => {
    const queue = new AnalysisJobQueue<number, number>()
    const order: number[] = []

    const first = queue.enqueue(1, async (input) => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      order.push(input)
      return input + 1
    })

    const second = queue.enqueue(2, async (input) => {
      order.push(input)
      return input + 1
    })

    await Promise.all([first, second])

    expect(order).toEqual([1, 2])
    expect(queue.getStatus('job-1')?.status).toBe('completed')
    expect(queue.getStatus('job-2')?.status).toBe('completed')
    expect(queue.getResult('job-1')).toBe(2)
    expect(queue.getResult('job-2')).toBe(3)
  })

  it('marks failed jobs and keeps queue alive', async () => {
    const queue = new AnalysisJobQueue<number, number>()

    await expect(
      queue.enqueue(1, async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    const status = queue.getStatus('job-1')
    expect(status?.status).toBe('failed')

    const result = await queue.enqueue(2, async (input) => input * 2)
    expect(result).toBe(4)
    expect(queue.getStatus('job-2')?.status).toBe('completed')
  })

  it('records the progress a runner reports', async () => {
    const queue = new AnalysisJobQueue<number, number>()
    const seen: Array<number | null> = []

    await queue.enqueue(0, async (_input, controls) => {
      controls.reportProgress(0, 4_000)
      seen.push(analysisProgressPercent(queue.getStatus('job-1')))
      controls.reportProgress(3_000, 4_000)
      seen.push(analysisProgressPercent(queue.getStatus('job-1')))
      return 1
    })

    expect(seen).toEqual([0, 75])
    expect(queue.getStatus('job-1')?.progress).toEqual({ completedMs: 3_000, totalMs: 4_000 })
  })

  it('clamps a nonsensical progress report instead of trusting it', async () => {
    const queue = new AnalysisJobQueue<number, number>()
    await queue.enqueue(0, async (_input, controls) => {
      controls.reportProgress(9_000, 4_000)
      expect(queue.getStatus('job-1')?.progress).toEqual({ completedMs: 4_000, totalMs: 4_000 })
      controls.reportProgress(-5, 4_000)
      expect(queue.getStatus('job-1')?.progress).toEqual({ completedMs: 0, totalMs: 4_000 })
      controls.reportProgress(1_000, 0)
      expect(queue.getStatus('job-1')?.progress).toBeUndefined()
      return 1
    })
  })

  it('cancels a running job through the signal it handed the runner', async () => {
    const queue = new AnalysisJobQueue<number, number>()
    let aborted = false

    const promise = queue.enqueue(0, async (_input, controls) => {
      await new Promise<void>((resolve) => {
        controls.signal.addEventListener('abort', () => {
          aborted = true
          resolve()
        })
      })
      return 1
    })

    // The job has to reach 'running' before there is anything to cancel.
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(queue.cancel('job-1')).toBe(true)
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    expect(aborted).toBe(true)
    expect(queue.getStatus('job-1')?.status).toBe('cancelled')
    expect(queue.getStatus('job-1')?.error).toBeUndefined()
  })

  it('never starts a job cancelled while it was still queued', async () => {
    const queue = new AnalysisJobQueue<number, number>()
    let ranSecond = false

    const first = queue.enqueue(0, async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      return 1
    })
    const second = queue.enqueue(0, async () => {
      ranSecond = true
      return 2
    })

    expect(queue.cancel('job-2')).toBe(true)
    await first
    await expect(second).rejects.toMatchObject({ name: 'AbortError' })
    expect(ranSecond).toBe(false)
    expect(queue.getStatus('job-2')?.status).toBe('cancelled')
  })

  it('reports false when there is nothing left to cancel', async () => {
    const queue = new AnalysisJobQueue<number, number>()
    await queue.enqueue(1, async (input) => input)
    expect(queue.cancel('job-1')).toBe(false)
    expect(queue.cancel('job-404')).toBe(false)
  })
})

describe('analysisProgressPercent', () => {
  const base = { id: 'job-1', status: 'running' as const, createdAt: 0 }

  it('rounds the ratio to a whole percent', () => {
    expect(analysisProgressPercent({ ...base, progress: { completedMs: 1, totalMs: 3 } })).toBe(33)
    expect(analysisProgressPercent({ ...base, progress: { completedMs: 3, totalMs: 3 } })).toBe(100)
  })

  it('is null when nothing has been reported yet', () => {
    expect(analysisProgressPercent(base)).toBe(null)
    expect(analysisProgressPercent(null)).toBe(null)
    expect(analysisProgressPercent(undefined)).toBe(null)
  })

  it('is null for a zero or non-finite total', () => {
    expect(analysisProgressPercent({ ...base, progress: { completedMs: 1, totalMs: 0 } })).toBe(
      null,
    )
    expect(
      analysisProgressPercent({ ...base, progress: { completedMs: 1, totalMs: Number.NaN } }),
    ).toBe(null)
  })
})
