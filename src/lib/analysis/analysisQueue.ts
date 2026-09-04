export type AnalysisJobState = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

/** How much of a job's audio has been transcribed (P2-F4). */
export interface AnalysisJobProgress {
  completedMs: number
  totalMs: number
}

export interface AnalysisJobStatus {
  id: string
  status: AnalysisJobState
  createdAt: number
  startedAt?: number
  finishedAt?: number
  error?: string
  /** Absent until the runner reports something. */
  progress?: AnalysisJobProgress
}

/** What a runner is handed alongside its input: cancellation and progress. */
export interface AnalysisJobControls {
  signal: AbortSignal
  /** Ignored once the job has finished; `totalMs <= 0` clears the progress. */
  reportProgress: (completedMs: number, totalMs: number) => void
}

export type AnalysisJobRunner<TInput, TResult> = (
  input: TInput,
  controls: AnalysisJobControls,
) => Promise<TResult>

/**
 * Percentage 0..100 for a job status, or null when nothing has been reported.
 * Shared by the renderer's progress toast and the tests, so "what percent" has
 * one definition.
 */
export function analysisProgressPercent(
  status: AnalysisJobStatus | null | undefined,
): number | null {
  const progress = status?.progress
  if (!progress || !Number.isFinite(progress.totalMs) || progress.totalMs <= 0) return null
  const ratio = progress.completedMs / progress.totalMs
  if (!Number.isFinite(ratio)) return null
  return Math.max(0, Math.min(100, Math.round(ratio * 100)))
}

export class AnalysisJobQueue<TInput, TResult> {
  private queue: Promise<void> = Promise.resolve()
  private counter = 0
  private statuses = new Map<string, AnalysisJobStatus>()
  private results = new Map<string, TResult>()
  private controllers = new Map<string, AbortController>()

  enqueue(input: TInput, runner: AnalysisJobRunner<TInput, TResult>): Promise<TResult> {
    return this.enqueueWithId(input, runner).promise
  }

  enqueueWithId(
    input: TInput,
    runner: AnalysisJobRunner<TInput, TResult>,
  ): { id: string; promise: Promise<TResult> } {
    const id = `job-${++this.counter}`
    const createdAt = Date.now()

    this.statuses.set(id, {
      id,
      status: 'pending',
      createdAt,
    })
    const controller = new AbortController()
    this.controllers.set(id, controller)

    let resolvePromise: (value: TResult) => void
    let rejectPromise: (reason?: unknown) => void

    const resultPromise = new Promise<TResult>((resolve, reject) => {
      resolvePromise = resolve
      rejectPromise = reject
    })

    const isSettled = () => {
      const state = this.statuses.get(id)?.status
      return state === 'completed' || state === 'failed' || state === 'cancelled'
    }

    const controls: AnalysisJobControls = {
      signal: controller.signal,
      reportProgress: (completedMs, totalMs) => {
        const current = this.statuses.get(id)
        if (!current || isSettled()) return
        const safeTotal = Math.max(0, Math.round(Number(totalMs) || 0))
        const safeCompleted = Math.max(0, Math.min(safeTotal, Math.round(Number(completedMs) || 0)))
        this.statuses.set(id, {
          ...current,
          progress: safeTotal > 0 ? { completedMs: safeCompleted, totalMs: safeTotal } : undefined,
        })
      },
    }

    this.queue = this.queue
      .catch(() => {
        // Keep queue chain alive after previous failures.
      })
      .then(async () => {
        // A job cancelled while it was still queued never starts.
        if (controller.signal.aborted) {
          this.statuses.set(id, {
            ...this.statuses.get(id)!,
            status: 'cancelled',
            finishedAt: Date.now(),
          })
          this.controllers.delete(id)
          rejectPromise(cancelledError())
          return
        }

        this.statuses.set(id, {
          ...this.statuses.get(id)!,
          status: 'running',
          startedAt: Date.now(),
        })

        try {
          const result = await runner(input, controls)
          if (controller.signal.aborted) {
            this.statuses.set(id, {
              ...this.statuses.get(id)!,
              status: 'cancelled',
              finishedAt: Date.now(),
            })
            rejectPromise(cancelledError())
            return
          }
          this.results.set(id, result)
          this.statuses.set(id, {
            ...this.statuses.get(id)!,
            status: 'completed',
            finishedAt: Date.now(),
          })
          resolvePromise(result)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          this.statuses.set(id, {
            ...this.statuses.get(id)!,
            status: controller.signal.aborted ? 'cancelled' : 'failed',
            finishedAt: Date.now(),
            error: controller.signal.aborted ? undefined : message,
          })
          rejectPromise(error)
        } finally {
          this.controllers.delete(id)
        }
      })

    return {
      id,
      promise: resultPromise,
    }
  }

  /**
   * Ask a pending or running job to stop. Returns false for an unknown or
   * already-finished job, so a caller can tell "cancelled" from "too late".
   */
  cancel(id: string): boolean {
    const controller = this.controllers.get(id)
    const status = this.statuses.get(id)
    if (!controller || !status) return false
    if (status.status === 'completed' || status.status === 'failed') return false
    controller.abort()
    return true
  }

  getStatus(id: string): AnalysisJobStatus | undefined {
    return this.statuses.get(id)
  }

  getResult(id: string): TResult | undefined {
    return this.results.get(id)
  }

  listStatuses(): AnalysisJobStatus[] {
    return Array.from(this.statuses.values())
  }
}

function cancelledError(): Error {
  const error = new Error('Analysis job cancelled')
  error.name = 'AbortError'
  return error
}
