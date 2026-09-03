import { describe, expect, it, vi } from 'vitest'
import {
  createPixiLifecycle,
  DEFAULT_PIXI_INIT_TIMEOUT_MS,
  destroyPixiApplication,
  type PixiApplicationLike,
  type PixiBackendPreference,
  PixiInitTimeoutError,
} from './pixiLifecycle'

/** A controllable stand-in for `Application`. */
class FakeApplication implements PixiApplicationLike {
  initCalls: Record<string, unknown>[] = []
  destroyCalls = 0
  stageDestroyCalls = 0
  rendererDestroyCalls = 0
  destroyThrows = false
  stage: { destroy?: (options?: unknown) => void } | null = {
    destroy: () => {
      this.stageDestroyCalls += 1
    },
  }
  renderer: { destroy?: (options?: unknown) => void } | null = {
    destroy: () => {
      this.rendererDestroyCalls += 1
    },
  }
  private settle: { resolve: () => void; reject: (error: unknown) => void } | null = null

  constructor(private readonly behaviour: 'resolve' | 'reject' | 'hang' | 'manual' = 'resolve') {}

  init(options: Record<string, unknown>): Promise<unknown> {
    this.initCalls.push(options)
    if (this.behaviour === 'resolve') return Promise.resolve()
    if (this.behaviour === 'reject') return Promise.reject(new Error('no GL context'))
    if (this.behaviour === 'hang') {
      // A driver that takes the context request and never answers it.
      return new Promise<void>(() => undefined)
    }
    return new Promise<void>((resolve, reject) => {
      this.settle = { resolve, reject }
    })
  }

  resolveInit(): void {
    this.settle?.resolve()
  }

  rejectInit(error: unknown): void {
    this.settle?.reject(error)
  }

  destroyArgs: unknown[][] = []

  destroy = (rendererOptions?: unknown, options?: unknown): void => {
    this.destroyCalls += 1
    this.destroyArgs.push([rendererOptions, options])
    if (this.destroyThrows) throw new Error('destroy reached into a renderer that is not there')
  }
}

/** Timer stub: `schedule` records, `fire` runs everything queued. */
function fakeTimers() {
  const queued: Array<{ id: number; fn: () => void; cancelled: boolean }> = []
  let nextId = 1
  return {
    schedule: (fn: () => void) => {
      const entry = { id: nextId++, fn, cancelled: false }
      queued.push(entry)
      return entry.id
    },
    cancel: (handle: unknown) => {
      const entry = queued.find((candidate) => candidate.id === handle)
      if (entry) entry.cancelled = true
    },
    fire: () => {
      for (const entry of queued) {
        if (!entry.cancelled) entry.fn()
      }
    },
    get pending() {
      return queued.filter((entry) => !entry.cancelled).length
    },
  }
}

const silentLog = () => ({ warn: vi.fn(), error: vi.fn() })

function lifecycleFor(
  apps: FakeApplication[],
  overrides: {
    backends?: readonly (PixiBackendPreference | undefined)[]
    timers?: ReturnType<typeof fakeTimers>
    log?: ReturnType<typeof silentLog>
  } = {},
) {
  const timers = overrides.timers ?? fakeTimers()
  const log = overrides.log ?? silentLog()
  let index = 0
  const lifecycle = createPixiLifecycle<FakeApplication>({
    create: () => {
      const app = apps[Math.min(index, apps.length - 1)]
      index += 1
      return app
    },
    initOptions: () => ({ width: 640, height: 360 }),
    backends: overrides.backends ?? ['webgl'],
    log,
    schedule: timers.schedule,
    cancel: timers.cancel,
  })
  return { lifecycle, timers, log }
}

describe('destroyPixiApplication', () => {
  it('prefers the application destroy when the renderer exists', () => {
    const app = new FakeApplication()
    destroyPixiApplication(app, { warn: vi.fn() })

    expect(app.destroyCalls).toBe(1)
    expect(app.stageDestroyCalls).toBe(0)
    expect(app.rendererDestroyCalls).toBe(0)
  })

  it('never releases the Pixi pools the other live renderer shares', () => {
    const app = new FakeApplication()
    destroyPixiApplication(app, { warn: vi.fn() })

    // A bare `true` would also mean `releaseGlobalResources`, and the preview
    // and the export renderer are both alive at export time.
    expect(app.destroyArgs[0]).toEqual([
      { removeView: true },
      { children: true, texture: true, textureSource: true },
    ])
  })

  it('destroys the parts separately when the application destroy throws', () => {
    const app = new FakeApplication()
    app.destroyThrows = true
    const log = { warn: vi.fn() }

    destroyPixiApplication(app, log)

    expect(app.destroyCalls).toBe(1)
    expect(app.stageDestroyCalls).toBe(1)
    expect(app.rendererDestroyCalls).toBe(1)
    expect(log.warn).toHaveBeenCalled()
  })

  it('still releases the renderer when init never built a stage', () => {
    const app = new FakeApplication()
    app.stage = null
    app.destroyThrows = true

    destroyPixiApplication(app, { warn: vi.fn() })

    expect(app.rendererDestroyCalls).toBe(1)
  })

  it('destroys the stage when init never built a renderer', () => {
    const app = new FakeApplication()
    app.renderer = null

    destroyPixiApplication(app, { warn: vi.fn() })

    // No renderer means the application destroy is not even attempted.
    expect(app.destroyCalls).toBe(0)
    expect(app.stageDestroyCalls).toBe(1)
  })

  it('tolerates a missing application', () => {
    expect(() => destroyPixiApplication(null, { warn: vi.fn() })).not.toThrow()
    expect(() => destroyPixiApplication(undefined, { warn: vi.fn() })).not.toThrow()
  })
})

describe('createPixiLifecycle', () => {
  it('reports the application when init succeeds', async () => {
    const app = new FakeApplication('resolve')
    const { lifecycle } = lifecycleFor([app])

    const outcome = await lifecycle.init()

    expect(outcome).toEqual({ status: 'ready', app })
    expect(lifecycle.app).toBe(app)
  })

  it('passes the backend preference to init', async () => {
    const app = new FakeApplication('resolve')
    const { lifecycle } = lifecycleFor([app], { backends: ['webgpu'] })

    await lifecycle.init()

    expect(app.initCalls[0]).toMatchObject({ preference: 'webgpu', width: 640 })
  })

  it('gives up on a backend whose init never settles and reports the timeout', async () => {
    const app = new FakeApplication('hang')
    const { lifecycle, timers } = lifecycleFor([app])

    const pending = lifecycle.init()
    timers.fire()
    const outcome = await pending

    expect(outcome.status).toBe('failed')
    if (outcome.status !== 'failed') return
    expect(outcome.error).toBeInstanceOf(PixiInitTimeoutError)
    expect((outcome.error as PixiInitTimeoutError).timeoutMs).toBe(DEFAULT_PIXI_INIT_TIMEOUT_MS)
    expect(lifecycle.app).toBeNull()
  })

  it('cleans up a timed-out init that lands afterwards', async () => {
    const app = new FakeApplication('manual')
    const { lifecycle, timers } = lifecycleFor([app])

    const pending = lifecycle.init()
    timers.fire()
    await pending

    app.resolveInit()
    await Promise.resolve()
    await Promise.resolve()

    expect(app.destroyCalls).toBe(1)
  })

  it('tries the next backend when the first one fails', async () => {
    const failing = new FakeApplication('reject')
    const working = new FakeApplication('resolve')
    const { lifecycle } = lifecycleFor([failing, working], { backends: ['webgl', 'webgpu'] })

    const outcome = await lifecycle.init()

    expect(outcome).toEqual({ status: 'ready', app: working })
    expect(failing.initCalls[0]).toMatchObject({ preference: 'webgl' })
    expect(working.initCalls[0]).toMatchObject({ preference: 'webgpu' })
  })

  it('reports a failure when every backend fails', async () => {
    const first = new FakeApplication('reject')
    const second = new FakeApplication('reject')
    const { lifecycle, log } = lifecycleFor([first, second], { backends: ['webgl', 'webgpu'] })

    const outcome = await lifecycle.init()

    expect(outcome.status).toBe('failed')
    if (outcome.status !== 'failed') return
    expect(String((outcome.error as Error).message)).toContain('no GL context')
    expect(log.error).toHaveBeenCalled()
  })

  it('tears down an application whose init rejected after a partial build', async () => {
    const app = new FakeApplication('manual')
    app.destroyThrows = true
    const { lifecycle } = lifecycleFor([app])

    const pending = lifecycle.init()
    app.rejectInit(new Error('renderer built, stage did not'))
    const outcome = await pending

    expect(outcome.status).toBe('failed')
    expect(app.destroyCalls).toBe(1)
    expect(app.stageDestroyCalls).toBe(1)
    expect(app.rendererDestroyCalls).toBe(1)
  })

  it('honours a destroy requested while init was still running', async () => {
    const app = new FakeApplication('manual')
    const { lifecycle } = lifecycleFor([app])

    const pending = lifecycle.init()
    lifecycle.destroy()
    app.resolveInit()
    const outcome = await pending

    expect(outcome).toEqual({ status: 'destroyed' })
    expect(app.destroyCalls).toBe(1)
    expect(lifecycle.app).toBeNull()
  })

  it('does not start a backend once destroy was requested', async () => {
    const app = new FakeApplication('resolve')
    const { lifecycle } = lifecycleFor([app])

    lifecycle.destroy()
    const outcome = await lifecycle.init()

    expect(outcome).toEqual({ status: 'destroyed' })
    expect(app.initCalls).toHaveLength(0)
  })

  it('destroys a live application when destroy comes after init', async () => {
    const app = new FakeApplication('resolve')
    const { lifecycle } = lifecycleFor([app])

    await lifecycle.init()
    lifecycle.destroy()

    expect(app.destroyCalls).toBe(1)
    expect(lifecycle.app).toBeNull()
  })

  it('cancels the timeout once init settles', async () => {
    const app = new FakeApplication('resolve')
    const { lifecycle, timers } = lifecycleFor([app])

    await lifecycle.init()

    expect(timers.pending).toBe(0)
  })
})
