import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Media-links registry: which project-state file and which cursor sidecar
 * belong to a recording, keyed by a content fingerprint instead of by path.
 *
 * Project state lives under `<userData>/projects/<basename>_<pathHash>.json`
 * and the cursor track next to the recording as `<name>.cursor.json`. Both
 * conventions break the moment the user moves or renames the recording. The
 * registry (`<userData>/media-links.json`) remembers the fingerprint of every
 * recording whose project state was saved, so a later open of the same bytes
 * from a different path can find the orphaned state again.
 *
 * The fingerprint is deliberately not a full-file hash: recordings can be
 * gigabytes, and hashing them on every auto-save would make editing feel
 * broken. Size plus a SHA-256 of the first and last 64 KiB is enough to
 * survive a move/rename/copy, which is the only case this solves; it does not
 * try to recognise a re-encoded duplicate.
 *
 * Pure Node (`fs`, `path`, `crypto`): the registry directory is injected by the
 * caller so this module has no Electron dependency and runs under vitest.
 */

export const MEDIA_LINKS_REGISTRY_FILE = 'media-links.json'
export const FINGERPRINT_SAMPLE_BYTES = 64 * 1024
/** Oldest entries are dropped past this many so the file cannot grow unbounded. */
export const MEDIA_LINKS_MAX_ENTRIES = 500

export interface MediaFingerprint {
  sizeBytes: number
  headSha256: string
  tailSha256: string
}

export interface MediaLinkEntry {
  fingerprint: MediaFingerprint
  /** Where the recording was when the entry was last refreshed. */
  lastKnownPath: string
  /** File name (no directory) of the project state under `<userData>/projects`. */
  projectStateFile?: string
  /** Absolute path of the `<name>.cursor.json` sidecar last seen next to the recording. */
  cursorSidecarPath?: string
  updatedAt: string
}

export interface MediaLinksRegistryFile {
  version: 1
  entries: MediaLinkEntry[]
}

export type MediaLinkUpsert = Omit<MediaLinkEntry, 'updatedAt'>

export function mediaLinksRegistryPath(baseDir: string): string {
  return path.join(baseDir, MEDIA_LINKS_REGISTRY_FILE)
}

async function hashRange(handle: fs.FileHandle, length: number, position: number): Promise<string> {
  const buffer = Buffer.alloc(length)
  let filled = 0
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled)
    if (bytesRead === 0) break
    filled += bytesRead
  }
  return crypto.createHash('sha256').update(buffer.subarray(0, filled)).digest('hex')
}

/**
 * Reads at most `FINGERPRINT_SAMPLE_BYTES` from the head and the same from the
 * tail of the file (never the body), so the cost is flat regardless of size.
 */
export async function computeMediaFingerprint(filePath: string): Promise<MediaFingerprint> {
  const stat = await fs.stat(filePath)
  if (!stat.isFile()) throw new Error(`Not a file: ${filePath}`)
  const handle = await fs.open(filePath, 'r')
  try {
    const sample = Math.min(FINGERPRINT_SAMPLE_BYTES, stat.size)
    const headSha256 = await hashRange(handle, sample, 0)
    const tailSha256 = await hashRange(handle, sample, Math.max(0, stat.size - sample))
    return { sizeBytes: stat.size, headSha256, tailSha256 }
  } finally {
    await handle.close()
  }
}

export function fingerprintsMatch(a: MediaFingerprint, b: MediaFingerprint): boolean {
  return (
    a.sizeBytes === b.sizeBytes && a.headSha256 === b.headSha256 && a.tailSha256 === b.tailSha256
  )
}

/** Same file location. Compared resolved, so `/a/./b.webm` and `/a/b.webm` are one. */
export function samePath(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b)
}

function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

export function normalizeMediaLinkEntry(candidate: unknown): MediaLinkEntry | null {
  if (!candidate || typeof candidate !== 'object') return null
  const raw = candidate as Partial<MediaLinkEntry>
  const fp = raw.fingerprint
  if (
    typeof raw.lastKnownPath !== 'string' ||
    raw.lastKnownPath.length === 0 ||
    !fp ||
    typeof fp.sizeBytes !== 'number' ||
    !Number.isFinite(fp.sizeBytes) ||
    fp.sizeBytes < 0 ||
    !isSha256Hex(fp.headSha256) ||
    !isSha256Hex(fp.tailSha256)
  ) {
    return null
  }
  const entry: MediaLinkEntry = {
    fingerprint: { sizeBytes: fp.sizeBytes, headSha256: fp.headSha256, tailSha256: fp.tailSha256 },
    lastKnownPath: raw.lastKnownPath,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date(0).toISOString(),
  }
  if (typeof raw.projectStateFile === 'string' && raw.projectStateFile.length > 0) {
    entry.projectStateFile = raw.projectStateFile
  }
  if (typeof raw.cursorSidecarPath === 'string' && raw.cursorSidecarPath.length > 0) {
    entry.cursorSidecarPath = raw.cursorSidecarPath
  }
  return entry
}

export async function readMediaLinksRegistry(baseDir: string): Promise<MediaLinksRegistryFile> {
  try {
    const raw = await fs.readFile(mediaLinksRegistryPath(baseDir), 'utf-8')
    const parsed = JSON.parse(raw) as { entries?: unknown }
    const entries = Array.isArray(parsed?.entries)
      ? parsed.entries
          .map((entry) => normalizeMediaLinkEntry(entry))
          .filter((entry): entry is MediaLinkEntry => entry !== null)
      : []
    return { version: 1, entries }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[media-links] registry unreadable, starting fresh:', error)
    }
    return { version: 1, entries: [] }
  }
}

async function writeMediaLinksRegistry(
  baseDir: string,
  file: MediaLinksRegistryFile,
): Promise<void> {
  await fs.mkdir(baseDir, { recursive: true })
  const target = mediaLinksRegistryPath(baseDir)
  const tmpPath = `${target}.tmp-${process.pid}-${Date.now()}`
  await fs.writeFile(tmpPath, JSON.stringify(file, null, 2), 'utf-8')
  await fs.rename(tmpPath, target)
}

// Single desktop process: a promise chain per registry directory is enough to
// keep two auto-saves from clobbering each other's read-modify-write.
const writeQueues = new Map<string, Promise<unknown>>()

function withWriteLock<T>(baseDir: string, fn: () => Promise<T>): Promise<T> {
  const queue = writeQueues.get(baseDir) ?? Promise.resolve()
  const result = queue.then(fn, fn)
  const tail = result.then(
    () => undefined,
    () => undefined,
  )
  writeQueues.set(baseDir, tail)
  void tail.then(() => {
    if (writeQueues.get(baseDir) === tail) writeQueues.delete(baseDir)
  })
  return result
}

/** Resolves once every queued registry write for `baseDir` has finished (tests, shutdown). */
export async function whenMediaLinksIdle(baseDir?: string): Promise<void> {
  for (;;) {
    const tails = baseDir ? [writeQueues.get(baseDir)] : [...writeQueues.values()]
    const pending = tails.filter((tail): tail is Promise<unknown> => tail !== undefined)
    if (pending.length === 0) return
    await Promise.all(pending)
  }
}

export async function updateMediaLinksRegistry(
  baseDir: string,
  mutate: (file: MediaLinksRegistryFile) => MediaLinksRegistryFile,
): Promise<void> {
  await withWriteLock(baseDir, async () => {
    const current = await readMediaLinksRegistry(baseDir)
    await writeMediaLinksRegistry(baseDir, mutate(current))
  })
}

/** Newest first; the tail beyond `MEDIA_LINKS_MAX_ENTRIES` is dropped. */
export function pruneMediaLinkEntries(
  entries: MediaLinkEntry[],
  max = MEDIA_LINKS_MAX_ENTRIES,
): MediaLinkEntry[] {
  if (entries.length <= max) return entries
  return [...entries].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, max)
}

/**
 * Inserts or refreshes the entry for `(fingerprint, lastKnownPath)`. Fields
 * omitted from `link` keep the value the entry for that same path had, so a
 * save with no cursor sidecar next to the file does not forget one recorded
 * earlier.
 *
 * Entries are keyed by path as well as by fingerprint on purpose. Two live
 * copies of the same bytes get one entry each, which lets a later lookup see
 * that the recording is ambiguous and refuse to relink, rather than silently
 * attaching one copy's edits to the other. `removePaths` drops entries the
 * caller knows are stale (the file that moved away).
 */
export async function upsertMediaLink(
  baseDir: string,
  link: MediaLinkUpsert,
  options: { removePaths?: readonly string[] } = {},
): Promise<void> {
  const removed = new Set((options.removePaths ?? []).map((entryPath) => path.resolve(entryPath)))
  await updateMediaLinksRegistry(baseDir, (file) => {
    const updatedAt = new Date().toISOString()
    const kept = file.entries.filter(
      (entry) =>
        !removed.has(path.resolve(entry.lastKnownPath)) ||
        samePath(entry.lastKnownPath, link.lastKnownPath),
    )
    const index = kept.findIndex(
      (entry) =>
        fingerprintsMatch(entry.fingerprint, link.fingerprint) &&
        samePath(entry.lastKnownPath, link.lastKnownPath),
    )
    const previous = index >= 0 ? kept[index] : undefined
    const merged: MediaLinkEntry = {
      fingerprint: link.fingerprint,
      lastKnownPath: link.lastKnownPath,
      updatedAt,
    }
    const projectStateFile = link.projectStateFile ?? previous?.projectStateFile
    if (projectStateFile) merged.projectStateFile = projectStateFile
    const cursorSidecarPath = link.cursorSidecarPath ?? previous?.cursorSidecarPath
    if (cursorSidecarPath) merged.cursorSidecarPath = cursorSidecarPath
    const entries =
      index >= 0 ? kept.map((entry, i) => (i === index ? merged : entry)) : [...kept, merged]
    return { version: 1, entries: pruneMediaLinkEntries(entries) }
  })
}

/**
 * Every entry recorded for these bytes, newest first. More than one means the
 * user has several copies of the same recording; callers must treat that as
 * ambiguous rather than picking one.
 */
export async function findMediaLinksByFingerprint(
  baseDir: string,
  fingerprint: MediaFingerprint,
): Promise<MediaLinkEntry[]> {
  const registry = await readMediaLinksRegistry(baseDir)
  return registry.entries
    .filter((entry) => fingerprintsMatch(entry.fingerprint, fingerprint))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}
