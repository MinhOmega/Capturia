/**
 * Bringing a Pixi `Application` up, and taking it down again, without leaking
 * a GPU context or hanging the UI.
 *
 * `await app.init(...)` has three ways to go wrong that the editor and the
 * exporter both used to ignore:
 *
 *  - it never settles. On a software GL stack the driver can sit on the
 *    context request; the preview then shows its loading state forever and
 *    nothing tells the user why. A promise with no timeout is not a failure
 *    mode anyone can report.
 *  - the component unmounts while it is still running. The old code tracked a
 *    `mounted` flag and, on the error path, dropped the reference with
 *    `app = null` — the half-built renderer stayed alive with its canvas and
 *    its GL context, and the next mount asked the driver for another one.
 *  - it rejects after the renderer exists but before the stage does. Calling
 *    `app.destroy()` on that throws from inside Pixi, so the teardown that was
 *    supposed to clean up leaves more behind than it removes.
 *
 * This module handles all three: each backend attempt gets its own timeout, a
 * destroy requested mid-init is remembered and applied the moment init
 * settles, and teardown falls back to destroying the stage and the renderer
 * separately when the application-level destroy is not available or throws.
 *
 * It is deliberately structural rather than typed against Pixi: the tests
 * drive it with an application that never resolves, one that rejects after a
 * partial init, and one that resolves after a destroy was requested.
 */

/** How Pixi is asked to pick a renderer. */
export type PixiBackendPreference = 'webgl' | 'webgpu'

/** The bits of `Application` this module touches. */
export interface PixiApplicationLike {
  init(options: Record<string, unknown>): Promise<unknown>
  // Method syntax on purpose: Pixi's own signatures are narrower than
  // `unknown`, and only a bivariant method position accepts them.
  destroy?(rendererDestroyOptions?: unknown, options?: unknown): void
  stage?: { destroy?(options?: unknown): void } | null
  renderer?: { destroy?(options?: unknown): void } | null
}

export type PixiInitOutcome<TApp> =
  /** The application is up and belongs to the caller. */
  | { readonly status: 'ready'; readonly app: TApp }
  /** A destroy was requested before init finished; nothing is left running. */
  | { readonly status: 'destroyed' }
  /** Every backend failed or timed out. Hand `error` to the recovery policy. */
  | { readonly status: 'failed'; readonly error: unknown }

export interface PixiLifecycleOptions<TApp extends PixiApplicationLike> {
  /** Builds a fresh application. Called once per backend attempt. */
  create: () => TApp
  /** Init options, per backend. Merged with `{ preference }` when a backend is named. */
  initOptions: (backend: PixiBackendPreference | undefined) => Record<string, unknown>
  /**
   * Backends to try in order. `undefined` means "whatever Pixi picks".
   * Defaults to WebGL first (Pixi's own default) and WebGPU as a fallback for
   * the stacks where a WebGL context request never comes back.
   */
  backends?: readonly (PixiBackendPreference | undefined)[]
  /** Budget for one backend attempt. Default 8000 ms. */
  timeoutMs?: number
  log?: Pick<Console, 'warn' | 'error'>
  /** Injectable timers for tests. */
  schedule?: (fn: () => void, delayMs: number) => unknown
  cancel?: (handle: unknown) => void
}

export interface PixiLifecycle<TApp extends PixiApplicationLike> {
  /** Runs the backends in order. Safe to call once per lifecycle. */
  init: () => Promise<PixiInitOutcome<TApp>>
  /**
   * Tear the application down. Before `init` settles this only records the
   * request; the teardown then runs as soon as init does, so a context is
   * never left running behind an unmounted component.
   */
  destroy: () => void
  /** The live application, or null before init succeeded / after destroy. */
  readonly app: TApp | null
}

export const DEFAULT_PIXI_INIT_TIMEOUT_MS = 8000

const DEFAULT_BACKENDS: readonly (PixiBackendPreference | undefined)[] = ['webgl', 'webgpu']

const FULL_DESTROY_OPTIONS = { children: true, texture: true, textureSource: true } as const

/** Thrown when one backend's `init` does not settle inside its budget. */
export class PixiInitTimeoutError extends Error {
  constructor(
    readonly backend: PixiBackendPreference | undefined,
    readonly timeoutMs: number,
  ) {
    super(
      `Pixi did not finish initialising the ${backend ?? 'default'} renderer within ${timeoutMs} ms`,
    )
    this.name = 'PixiInitTimeoutError'
  }
}

/**
 * Destroy an application that may be fully built, half built, or already dead.
 *
 * The application-level destroy is tried first because it is the only one that
 * detaches the canvas and stops the ticker. When it is unavailable (init never
 * got as far as a renderer) or throws (Pixi reaching into a renderer that does
 * not exist), the stage and the renderer are destroyed separately so whatever
 * *was* built still releases its GPU memory.
 */
export function destroyPixiApplication(
  app: PixiApplicationLike | null | undefined,
  log: Pick<Console, 'warn'> = console,
): void {
  if (!app) return

  if (typeof app.destroy === 'function' && app.renderer) {
    try {
      app.destroy(true, FULL_DESTROY_OPTIONS)
      return
    } catch (error) {
      log.warn('[pixi] application destroy threw; tearing the parts down separately:', error)
    }
  }

  try {
    app.stage?.destroy?.(FULL_DESTROY_OPTIONS)
  } catch (error) {
    log.warn('[pixi] stage destroy threw during partial teardown:', error)
  }
  try {
    app.renderer?.destroy?.()
  } catch (error) {
    log.warn('[pixi] renderer destroy threw during partial teardown:', error)
  }
}

export function createPixiLifecycle<TApp extends PixiApplicationLike>(
  options: PixiLifecycleOptions<TApp>,
): PixiLifecycle<TApp> {
  const {
    create,
    initOptions,
    backends = DEFAULT_BACKENDS,
    timeoutMs = DEFAULT_PIXI_INIT_TIMEOUT_MS,
    log = console,
    schedule = (fn, delayMs) => setTimeout(fn, delayMs),
    cancel = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  } = options

  let destroyRequested = false
  let liveApp: TApp | null = null

  async function attempt(backend: PixiBackendPreference | undefined): Promise<TApp> {
    const app = create()
    const merged = backend ? { ...initOptions(backend), preference: backend } : initOptions(backend)

    let timedOut = false
    let timer: unknown = null
    const initPromise = Promise.resolve(app.init(merged))

    try {
      await new Promise<void>((resolve, reject) => {
        timer = schedule(() => {
          timedOut = true
          reject(new PixiInitTimeoutError(backend, timeoutMs))
        }, timeoutMs)
        initPromise.then(
          () => resolve(),
          (error) => reject(error),
        )
      })
    } catch (error) {
      if (timedOut) {
        // The init may still land later. Whatever it built is nobody's now, so
        // clean it up when it does rather than leaving a context behind.
        initPromise.then(
          () => destroyPixiApplication(app, log),
          () => destroyPixiApplication(app, log),
        )
      } else {
        destroyPixiApplication(app, log)
      }
      throw error
    } finally {
      if (timer !== null) cancel(timer)
    }

    return app
  }

  return {
    async init(): Promise<PixiInitOutcome<TApp>> {
      let lastError: unknown = new Error('No renderer backend was attempted')

      for (const backend of backends) {
        if (destroyRequested) return { status: 'destroyed' }

        let app: TApp
        try {
          app = await attempt(backend)
        } catch (error) {
          lastError = error
          log.warn(`[pixi] ${backend ?? 'default'} renderer init failed:`, error)
          continue
        }

        if (destroyRequested) {
          // The caller gave up while the driver was working. Honour it here
          // rather than dropping the reference and leaking the context.
          destroyPixiApplication(app, log)
          return { status: 'destroyed' }
        }

        liveApp = app
        return { status: 'ready', app }
      }

      log.error('[pixi] every renderer backend failed to initialise', lastError)
      return { status: 'failed', error: lastError }
    },

    destroy(): void {
      destroyRequested = true
      const app = liveApp
      liveApp = null
      destroyPixiApplication(app, log)
    },

    get app(): TApp | null {
      return liveApp
    },
  }
}
