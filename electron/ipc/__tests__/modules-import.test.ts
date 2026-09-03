import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('./ipcTestKit')).createElectronMock())

/**
 * F11 guard: every IPC module (and the composition root) must load under
 * vitest's node environment without calling into `app` at import time. The
 * old `handlers.ts` computed `RECORDINGS_DIR` via `app.getPath()` while being
 * imported, which is what made it untestable.
 */
const MODULES = [
  '../../paths',
  '../context',
  '../cursorTrack',
  '../cursorTracker',
  '../permissions',
  '../recordingFiles',
  '../exportFiles',
  '../projectState',
  '../analysis',
  '../handlers',
] as const

/**
 * These cases assert an import-time side effect, not speed, but each one pays
 * for a cold transform of the module's whole graph. On a loaded worker pool
 * that can exceed the default 5 s, so the budget is raised rather than the
 * assertion weakened.
 */
const IMPORT_TIMEOUT_MS = 30_000

describe('IPC modules are importable without touching app', () => {
  it.each(MODULES)(
    '%s',
    async (specifier) => {
      const { app } = await import('electron')
      vi.mocked(app.getPath).mockClear()
      const mod = await import(specifier)
      expect(Object.keys(mod).length).toBeGreaterThan(0)
      expect(app.getPath).not.toHaveBeenCalled()
    },
    IMPORT_TIMEOUT_MS,
  )
})
