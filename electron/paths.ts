import path from 'node:path'
import { app } from 'electron'

/**
 * App-owned directories, resolved lazily.
 *
 * `main.ts` used to export `RECORDINGS_DIR` computed with `app.getPath()` at
 * import time, and `ipc/handlers.ts` imported it back — an import cycle that
 * also made every IPC module unloadable under vitest (upstream's own note in
 * `deviceNameMatching.ts`: handlers.ts "calls app.getPath() while being
 * imported and cannot be loaded from a test"). Everything here calls into
 * `app` only when invoked, so importing this module never touches Electron.
 */

const RECORDINGS_DIR_NAME = 'recordings'
const PROJECTS_DIR_NAME = 'projects'

/** `<userData>/recordings` — every capture lands here; read policy is keyed on it. */
export function getRecordingsDir(): string {
  return path.join(app.getPath('userData'), RECORDINGS_DIR_NAME)
}

/** `<userData>/projects` — per-video editor state (`save-project-state`). */
export function getProjectsDir(): string {
  return path.join(app.getPath('userData'), PROJECTS_DIR_NAME)
}

/** `<userData>` itself, for callers that build their own sub-paths. */
export function getUserDataDir(): string {
  return app.getPath('userData')
}

/** Pure form of `getRecordingsDir` for tests and for callers that already hold `userData`. */
export function resolveRecordingsDir(userDataDir: string): string {
  return path.join(userDataDir, RECORDINGS_DIR_NAME)
}
