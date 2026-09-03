import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Durable, serialised file replacement for the small JSON documents the main
 * process owns (project state, keyboard shortcuts, update preferences, the
 * media-links registry).
 *
 * "Write a temp file then rename it" is only half of an atomic save. Without an
 * `fsync` the rename can reach the directory before the data reaches the disk,
 * so a power cut or a kernel panic leaves a correctly named file full of zero
 * bytes — worse than the old content, because the old content is gone. And
 * without serialisation two saves of the same document race: the editor
 * auto-saves on a debounce and Capturia also flushes on window close, so the
 * slower of the two renames last and the newest edit is the one that is lost.
 *
 * The sequence here is the durable one:
 *
 *   1. queue behind any save already in flight for the same target path;
 *   2. `open(tmp, 'wx')` in the *same* directory (a cross-device rename is not
 *      atomic, and `wx` means a stale temp file is never silently reused);
 *   3. write, `fsync` the handle, close;
 *   4. optionally copy the previous file to `<target>.bak`;
 *   5. `rename` over the target — atomic on POSIX and on NTFS;
 *   6. `fsync` the parent directory so the rename itself is durable.
 *
 * A failure anywhere before step 5 leaves the previous file untouched and
 * removes the temp file.
 */

/** Directory-fsync failures that mean "this platform does not do that". */
const DIR_FSYNC_TOLERATED_CODES: ReadonlySet<string> = new Set([
  'EINVAL',
  'ENOTSUP',
  'EPERM',
  'EACCES',
  'EISDIR',
  'EBADF',
])

export interface AtomicWriteOptions {
  /**
   * Copy the file being replaced to `<target>.bak` before the rename. Cheap for
   * the few-KB documents this module is used for; leaves the user one
   * generation of history when a save lands mid-corruption.
   */
  keepBackup?: boolean
  /** Skip the `mkdir -p` of the target directory when the caller already did it. */
  ensureDir?: boolean
  /**
   * Test seam: runs after the temp file is written and synced, before the
   * rename. Throwing here simulates a crash in exactly the window the design
   * has to survive.
   */
  beforeRename?: (tmpPath: string) => void | Promise<void>
}

/** Per-target-path save queues, so a later save never overtakes an earlier one. */
const saveQueues = new Map<string, Promise<unknown>>()

let tmpCounter = 0

function tempPathFor(targetPath: string): string {
  tmpCounter = (tmpCounter + 1) % Number.MAX_SAFE_INTEGER
  const unique = `${process.pid.toString(36)}-${Date.now().toString(36)}-${tmpCounter.toString(36)}`
  return `${targetPath}.${unique}.tmp`
}

async function fsyncDirectory(dirPath: string): Promise<void> {
  let handle: fs.FileHandle | undefined
  try {
    handle = await fs.open(dirPath, 'r')
    await handle.sync()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (!code || !DIR_FSYNC_TOLERATED_CODES.has(code)) {
      // A directory that cannot be synced is not a reason to fail a save whose
      // data already landed; the rename itself succeeded.
      console.warn('[atomic-save] could not fsync the directory:', dirPath, error)
    }
  } finally {
    await handle?.close().catch(() => {
      // Already reported above; a failed close on a directory handle is inert.
    })
  }
}

async function writeBackup(targetPath: string): Promise<void> {
  try {
    await fs.copyFile(targetPath, `${targetPath}.bak`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    console.warn('[atomic-save] could not refresh the backup for:', targetPath, error)
  }
}

async function performAtomicWrite(
  targetPath: string,
  data: string | Uint8Array,
  options: AtomicWriteOptions,
): Promise<void> {
  const dir = path.dirname(targetPath)
  if (options.ensureDir !== false) {
    await fs.mkdir(dir, { recursive: true })
  }

  let tmpPath = tempPathFor(targetPath)
  let handle: fs.FileHandle | undefined
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      handle = await fs.open(tmpPath, 'wx')
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt === 4) throw error
      tmpPath = tempPathFor(targetPath)
    }
  }
  if (!handle) throw new Error(`Could not create a temporary file next to ${targetPath}`)

  try {
    await handle.writeFile(data, typeof data === 'string' ? 'utf-8' : undefined)
    await handle.sync()
  } finally {
    await handle.close().catch(() => {
      // The data is already synced; a failing close must not fail the save.
    })
  }

  try {
    if (options.beforeRename) await options.beforeRename(tmpPath)
    if (options.keepBackup) await writeBackup(targetPath)
    await fs.rename(tmpPath, targetPath)
  } catch (error) {
    // The target still holds the previous content; drop the temp file so the
    // directory does not fill up with abandoned saves.
    await fs.rm(tmpPath, { force: true }).catch(() => {
      // Best-effort cleanup; the original error below is the one that matters.
    })
    throw error
  }

  await fsyncDirectory(dir)
}

/**
 * Replace `targetPath` with `data` atomically and durably. Saves to the same
 * path run one at a time in call order, so the last caller's content wins.
 */
export function atomicWriteFile(
  targetPath: string,
  data: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const key = path.resolve(targetPath)
  const previous = saveQueues.get(key) ?? Promise.resolve()
  const run = previous.then(
    () => performAtomicWrite(targetPath, data, options),
    () => performAtomicWrite(targetPath, data, options),
  )
  const tail = run.then(
    () => undefined,
    () => undefined,
  )
  saveQueues.set(key, tail)
  void tail.then(() => {
    if (saveQueues.get(key) === tail) saveQueues.delete(key)
  })
  return run
}

/** `atomicWriteFile` for a JSON document. `space` matches `JSON.stringify`. */
export function atomicWriteJson(
  targetPath: string,
  value: unknown,
  options: AtomicWriteOptions & { space?: number } = {},
): Promise<void> {
  const { space, ...writeOptions } = options
  return atomicWriteFile(targetPath, JSON.stringify(value, null, space), writeOptions)
}

/** Test helper: resolves once every queued save has settled. */
export async function waitForPendingAtomicWrites(): Promise<void> {
  while (saveQueues.size > 0) {
    await Promise.all([...saveQueues.values()])
  }
}
