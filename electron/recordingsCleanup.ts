import fs from 'node:fs/promises'
import path from 'node:path'
import { readMediaLinksRegistry } from './media/mediaLinksRegistry'
import {
  createRecordingCleanupPolicy,
  planRecordingCleanup,
  recordingGroupKeyFromFileName,
  type RecordingArtifactEntry,
  type RecordingCleanupPolicy,
} from '../src/lib/recordingsCleanupPolicy'

const BYTES_PER_GB = 1024 * 1024 * 1024
const MS_PER_DAY = 24 * 60 * 60 * 1000
let cleanupQueue: Promise<void> = Promise.resolve()

type CleanupReason = 'startup' | 'post-recording' | 'post-native-recording'

export type RecordingsCleanupOptions = {
  recordingsDir: string
  /**
   * `<userData>`: holds `projects/` and `media-links.json`, which together say
   * which recordings a saved project still needs. Without it the run is
   * skipped rather than deleting media it cannot vouch for.
   */
  userDataDir: string
  excludePaths?: string[]
  reason: CleanupReason
  policy?: Partial<RecordingCleanupPolicy>
}

type ProtectedMediaScan =
  /** Names inside the recordings dir that a project or the registry points at. */
  | { ok: true; fileNames: Set<string>; projectCount: number }
  /** Something the scan needed could not be read; the caller must not delete anything. */
  | { ok: false; reason: string }

function parseNumber(value: string | undefined): number | undefined {
  if (!value || value.trim().length === 0) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function clampNumber(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Number(value)))
}

function resolvePolicyFromEnv(overrides?: Partial<RecordingCleanupPolicy>): RecordingCleanupPolicy {
  const maxGb = clampNumber(parseNumber(process.env.CAPTURIA_RECORDINGS_MAX_GB), 8, 1, 512)
  const trimRatio = clampNumber(
    parseNumber(process.env.CAPTURIA_RECORDINGS_TRIM_RATIO),
    0.8,
    0.25,
    0.95,
  )
  const maxDays = clampNumber(parseNumber(process.env.CAPTURIA_RECORDINGS_MAX_DAYS), 30, 1, 3650)
  const minKeep = Math.round(
    clampNumber(parseNumber(process.env.CAPTURIA_RECORDINGS_MIN_KEEP), 20, 1, 1_000),
  )
  const orphanDays = clampNumber(parseNumber(process.env.CAPTURIA_ORPHAN_CURSOR_DAYS), 3, 0, 365)

  const maxTotalBytes = Math.floor(maxGb * BYTES_PER_GB)
  const targetTotalBytes = Math.floor(maxTotalBytes * trimRatio)
  const maxVideoAgeMs = Math.floor(maxDays * MS_PER_DAY)
  const orphanSidecarAgeMs = Math.floor(orphanDays * MS_PER_DAY)

  return createRecordingCleanupPolicy({
    maxTotalBytes,
    targetTotalBytes,
    maxVideoAgeMs,
    minKeepVideoGroups: minKeep,
    orphanSidecarAgeMs,
    ...overrides,
  })
}

/**
 * Every recording a saved project still references.
 *
 * Project state lives in `<userData>/projects/*.json` keyed by the recording's
 * path (`videoFilePath`), and `<userData>/media-links.json` remembers where a
 * recording was last seen plus its cursor sidecar, which is how a moved file is
 * found again. Both are read here; anything they name is off limits.
 *
 * Paths are resolved through `realpath` before being compared, so a symlinked
 * recordings dir or a symlinked recording still matches the file on disk.
 *
 * Any project file that cannot be read or parsed aborts the whole scan. A
 * partial protected set is worse than no cleanup: it would look like a
 * successful run while deleting exactly the media whose project was unreadable.
 */
async function collectProtectedRecordingNames(options: {
  recordingsDir: string
  userDataDir: string
}): Promise<ProtectedMediaScan> {
  const referencedPaths = new Set<string>()
  const projectsDir = path.join(options.userDataDir, 'projects')

  let projectFiles: string[] = []
  try {
    projectFiles = (await fs.readdir(projectsDir)).filter((name) => name.endsWith('.json'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { ok: false, reason: `projects dir unreadable: ${String(error)}` }
    }
  }

  for (const fileName of projectFiles) {
    const filePath = path.join(projectsDir, fileName)
    try {
      const state = JSON.parse(await fs.readFile(filePath, 'utf-8')) as {
        videoFilePath?: unknown
      }
      if (typeof state?.videoFilePath === 'string' && state.videoFilePath.length > 0) {
        referencedPaths.add(state.videoFilePath)
      }
    } catch (error) {
      return { ok: false, reason: `project state unreadable (${fileName}): ${String(error)}` }
    }
  }

  // The registry is best-effort by design (`readMediaLinksRegistry` answers with
  // an empty list rather than throwing), so it can only widen the protected set.
  const registry = await readMediaLinksRegistry(options.userDataDir)
  for (const entry of registry.entries) {
    if (entry.lastKnownPath) referencedPaths.add(entry.lastKnownPath)
    if (entry.cursorSidecarPath) referencedPaths.add(entry.cursorSidecarPath)
  }

  let realRecordingsDir: string
  try {
    realRecordingsDir = await fs.realpath(options.recordingsDir)
  } catch (error) {
    return { ok: false, reason: `recordings dir unresolvable: ${String(error)}` }
  }

  const fileNames = new Set<string>()
  for (const referenced of referencedPaths) {
    // The name is protected whether or not the file is still there: a project
    // pointing at a path in the recordings dir keeps that name reserved.
    let resolved = path.resolve(referenced)
    try {
      resolved = await fs.realpath(resolved)
    } catch {
      // Missing or unresolvable: fall back to the lexical path.
    }
    if (path.dirname(resolved) !== realRecordingsDir) continue
    fileNames.add(path.basename(resolved))
  }

  return { ok: true, fileNames, projectCount: projectFiles.length }
}

async function readRecordingEntries(recordingsDir: string): Promise<RecordingArtifactEntry[]> {
  const dirEntries = await fs.readdir(recordingsDir, { withFileTypes: true })
  const fileEntries = dirEntries.filter((entry) => entry.isFile())
  const stats = await Promise.all(
    fileEntries.map(async (entry) => {
      const fullPath = path.join(recordingsDir, entry.name)
      try {
        const stat = await fs.stat(fullPath)
        return {
          name: entry.name,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        } satisfies RecordingArtifactEntry
      } catch {
        return null
      }
    }),
  )

  return stats.filter((item): item is RecordingArtifactEntry => Boolean(item))
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

/**
 * One cleanup pass, awaited. `scheduleRecordingsCleanup` is the fire-and-forget
 * form the app uses; this is the same work with a promise to hold on to.
 */
export async function runRecordingsCleanup(options: RecordingsCleanupOptions): Promise<void> {
  const normalizedDir = path.resolve(options.recordingsDir)
  const protectedMedia = await collectProtectedRecordingNames({
    recordingsDir: normalizedDir,
    userDataDir: options.userDataDir,
  })
  if (!protectedMedia.ok) {
    console.warn(
      `[recordings-cleanup] skipped reason=${options.reason}: cannot tell which recordings a project still needs (${protectedMedia.reason})`,
    )
    return
  }

  const policy = resolvePolicyFromEnv(options.policy)
  const entries = await readRecordingEntries(normalizedDir)
  const plan = planRecordingCleanup(entries, {
    policy,
    protectedFileNames: protectedMedia.fileNames,
  })
  if (plan.filesToDelete.length === 0) {
    return
  }

  const excludedGroupKeys = new Set(
    (options.excludePaths ?? [])
      .map((filePath) => path.basename(filePath))
      .map((fileName) => recordingGroupKeyFromFileName(fileName))
      .filter((key): key is string => Boolean(key)),
  )

  let deletedCount = 0
  let deletedBytes = 0
  const entryByName = new Map(entries.map((entry) => [entry.name, entry]))
  for (const fileName of plan.filesToDelete) {
    const groupKey = recordingGroupKeyFromFileName(fileName)
    if (groupKey && excludedGroupKeys.has(groupKey)) {
      continue
    }

    if (path.basename(fileName) !== fileName) {
      continue
    }

    const fullPath = path.join(normalizedDir, fileName)
    try {
      await fs.rm(fullPath, { force: true })
      deletedCount += 1
      deletedBytes += entryByName.get(fileName)?.size ?? 0
    } catch (error) {
      console.warn('[recordings-cleanup] failed to remove file:', fileName, error)
    }
  }

  if (deletedCount > 0) {
    console.info(
      `[recordings-cleanup] reason=${options.reason} deleted=${deletedCount} freed=${formatMegabytes(deletedBytes)} managedGroups=${plan.managedGroupCount} protected=${protectedMedia.fileNames.size} projects=${protectedMedia.projectCount}`,
    )
  }
}

export function scheduleRecordingsCleanup(options: RecordingsCleanupOptions): void {
  cleanupQueue = cleanupQueue
    .then(() => runRecordingsCleanup(options))
    .catch((error) => {
      console.warn('[recordings-cleanup] cleanup run failed:', error)
    })
}
