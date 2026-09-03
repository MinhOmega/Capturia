import fs from 'node:fs/promises'
import path from 'node:path'
import {
  readCursorTrackSidecar,
  resolveCursorSidecarPath,
  writeCursorTrackSidecar,
} from '../ipc/cursorTrack'
import {
  hasAllowedReadableExtension,
  isReadablePathAllowed,
  resolveOutputPathInDir,
} from '../ipc/paths'
import {
  computeMediaFingerprint,
  findMediaLinksByFingerprint,
  type MediaFingerprint,
  type MediaLinkEntry,
  samePath,
  upsertMediaLink,
} from './mediaLinksRegistry'

/**
 * Re-attaches project state and the cursor sidecar to a recording that was
 * moved or renamed after it was edited.
 *
 * Strategy (the simple one): when a recording opens at a path that has no
 * project-state file, look the recording up by fingerprint. On a hit, the old
 * project state is copied to the key of the new path and the cursor sidecar is
 * copied next to the new file, so every later open takes the cheap path again
 * and the registry only has to work once per move. Copies rather than moves:
 * if the user keeps both locations, both stay editable.
 *
 * Ambiguity never relinks. If the bytes match more than one registry entry
 * with a project state of its own, the user has several copies of the same
 * recording with diverging edits and there is no way to tell which one this is;
 * attaching the wrong edits silently would be worse than attaching none.
 *
 * Every path that comes out of the registry is treated as data, not as trust:
 * project-state file names go through `resolveOutputPathInDir` (bare name, no
 * traversal), sidecar paths must be exactly the sidecar derived from the
 * entry's own recording path, and the recording path itself must pass the
 * read policy in `../ipc/paths`.
 */

export interface RelinkMatch {
  lastKnownPath: string
  projectStateFile?: string
  projectStateExists: boolean
  cursorSidecarPath?: string
  cursorSidecarExists: boolean
}

export type RelinkDecision =
  | { action: 'keep' }
  | { action: 'none'; reason: 'no-match' | 'same-path' | 'state-missing' | 'ambiguous' }
  | {
      action: 'relink'
      fromPath: string
      projectStateFile: string
      cursorSidecarPath: string | null
    }

/**
 * Pure decision: what to do for `videoPath` given whether it already has a
 * project state and every registry entry recorded for the same bytes.
 *
 * `matches` is a list because the same bytes can sit at several paths. Only
 * entries for some OTHER path that still have a project state can be relinked
 * from; two of those disagreeing on which state file to use is ambiguous.
 */
export function decideRelink(input: {
  videoPath: string
  hasProjectStateForPath: boolean
  matches: readonly RelinkMatch[]
}): RelinkDecision {
  if (input.hasProjectStateForPath) return { action: 'keep' }
  if (input.matches.length === 0) return { action: 'none', reason: 'no-match' }

  const fromOtherPaths = input.matches.filter(
    (match) => !samePath(match.lastKnownPath, input.videoPath),
  )
  if (fromOtherPaths.length === 0) return { action: 'none', reason: 'same-path' }

  const usable = fromOtherPaths.filter(
    (match) => match.projectStateFile !== undefined && match.projectStateExists,
  )
  if (usable.length === 0) return { action: 'none', reason: 'state-missing' }

  const stateFiles = new Set(usable.map((match) => match.projectStateFile))
  if (stateFiles.size > 1) return { action: 'none', reason: 'ambiguous' }

  // One state file, so the edits are the same whichever entry we came through.
  // The sidecars can still disagree; drop it rather than guess.
  const sidecars = new Set(
    usable
      .filter((match) => match.cursorSidecarExists && match.cursorSidecarPath)
      .map((match) => match.cursorSidecarPath as string),
  )
  const chosen = usable[0]
  return {
    action: 'relink',
    fromPath: chosen.lastKnownPath,
    projectStateFile: chosen.projectStateFile as string,
    cursorSidecarPath: sidecars.size === 1 ? [...sidecars][0] : null,
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile()
  } catch {
    return false
  }
}

/** A registry file name is only usable as a bare `.json` name inside `projectsDir`. */
function resolveProjectStateFile(projectsDir: string, fileName: string | undefined): string | null {
  if (!fileName || path.extname(fileName).toLowerCase() !== '.json') return null
  try {
    return resolveOutputPathInDir(projectsDir, fileName)
  } catch {
    return null
  }
}

/**
 * A registry sidecar path is only accepted when it is exactly the sidecar the
 * entry's own recording path implies: absolute, `.json`, and derived rather
 * than free-form.
 */
export function isTrustedCursorSidecarPath(sidecarPath: unknown, lastKnownPath: string): boolean {
  if (typeof sidecarPath !== 'string' || sidecarPath.length === 0) return false
  if (!path.isAbsolute(sidecarPath)) return false
  if (!hasAllowedReadableExtension(sidecarPath)) return false
  return path.resolve(sidecarPath) === path.resolve(resolveCursorSidecarPath(lastKnownPath))
}

export interface RegisterProjectMediaOptions {
  registryDir: string
  recordingsDir: string
  videoPath: string
  projectStateFile: string
  fingerprint?: MediaFingerprint
}

/**
 * Records (or refreshes) the registry entry for a recording whose project
 * state was just saved. Skipped silently for paths outside the read policy.
 */
export async function registerProjectMedia(
  options: RegisterProjectMediaOptions,
): Promise<MediaFingerprint | null> {
  const { registryDir, recordingsDir, videoPath, projectStateFile } = options
  if (!isReadablePathAllowed(videoPath, { recordingsDir })) return null
  const fingerprint = options.fingerprint ?? (await computeMediaFingerprint(videoPath))
  const sidecarPath = resolveCursorSidecarPath(videoPath)
  const link = {
    fingerprint,
    lastKnownPath: videoPath,
    projectStateFile,
    ...((await fileExists(sidecarPath)) ? { cursorSidecarPath: sidecarPath } : {}),
  }
  await upsertMediaLink(registryDir, link)
  return fingerprint
}

export interface RelinkProjectStateOptions {
  registryDir: string
  projectsDir: string
  recordingsDir: string
  videoPath: string
  /** File name the project state would have for `videoPath`. */
  projectStateFile: string
}

export type RelinkProjectStateResult =
  | { relinked: false; decision: RelinkDecision }
  | {
      relinked: true
      fromPath: string
      state: unknown
      cursorSidecarWritten: boolean
    }

async function describeMatch(projectsDir: string, entry: MediaLinkEntry): Promise<RelinkMatch> {
  const statePath = resolveProjectStateFile(projectsDir, entry.projectStateFile)
  const sidecarTrusted = isTrustedCursorSidecarPath(entry.cursorSidecarPath, entry.lastKnownPath)
  return {
    lastKnownPath: entry.lastKnownPath,
    projectStateFile: statePath ? entry.projectStateFile : undefined,
    projectStateExists: statePath ? await fileExists(statePath) : false,
    cursorSidecarPath: sidecarTrusted ? entry.cursorSidecarPath : undefined,
    cursorSidecarExists:
      sidecarTrusted && entry.cursorSidecarPath ? await fileExists(entry.cursorSidecarPath) : false,
  }
}

/**
 * Called by `load-project-state` when no state file exists for `videoPath`.
 * Returns the relinked state (already copied to the new key) or the decision
 * that explains why nothing happened.
 */
export async function relinkProjectStateForVideo(
  options: RelinkProjectStateOptions,
): Promise<RelinkProjectStateResult> {
  const { registryDir, projectsDir, recordingsDir, videoPath, projectStateFile } = options
  const targetStatePath = resolveProjectStateFile(projectsDir, projectStateFile)
  if (!targetStatePath || !isReadablePathAllowed(videoPath, { recordingsDir })) {
    return { relinked: false, decision: { action: 'none', reason: 'no-match' } }
  }
  if (await fileExists(targetStatePath)) {
    return { relinked: false, decision: { action: 'keep' } }
  }

  const fingerprint = await computeMediaFingerprint(videoPath)
  const entries = await findMediaLinksByFingerprint(registryDir, fingerprint)
  const decision = decideRelink({
    videoPath,
    hasProjectStateForPath: false,
    matches: await Promise.all(entries.map((entry) => describeMatch(projectsDir, entry))),
  })
  if (decision.action !== 'relink') return { relinked: false, decision }

  const sourceStatePath = resolveProjectStateFile(projectsDir, decision.projectStateFile)
  if (!sourceStatePath) return { relinked: false, decision: { action: 'none', reason: 'no-match' } }
  const raw = await fs.readFile(sourceStatePath, 'utf-8')
  const state: unknown = JSON.parse(raw)

  // Copy the state to the new key atomically so the cheap path works next time.
  await fs.mkdir(projectsDir, { recursive: true })
  const tmpPath = `${targetStatePath}.tmp`
  await fs.writeFile(tmpPath, raw, 'utf-8')
  await fs.rename(tmpPath, targetStatePath)

  // Best effort: put the cursor sidecar next to the moved recording too, unless
  // one is already there. A read-only folder just leaves the registry link.
  let cursorSidecarWritten = false
  const newSidecarPath = resolveCursorSidecarPath(videoPath)
  if (decision.cursorSidecarPath && !(await fileExists(newSidecarPath))) {
    try {
      const track = await readCursorTrackSidecar(decision.fromPath)
      if (track) {
        await writeCursorTrackSidecar(videoPath, track)
        cursorSidecarWritten = true
      }
    } catch (error) {
      console.warn(
        '[media-relink] could not copy the cursor sidecar next to the moved file:',
        error,
      )
    }
  }
  console.log(`[media-relink] project state ${decision.fromPath} -> ${videoPath}`)

  // The recording was moved rather than copied when nothing is left at the old
  // path: drop that entry so a second move is not read as two rival copies.
  const stalePaths: string[] = []
  for (const entry of entries) {
    if (!samePath(entry.lastKnownPath, videoPath) && !(await fileExists(entry.lastKnownPath))) {
      stalePaths.push(entry.lastKnownPath)
    }
  }

  await upsertMediaLink(
    registryDir,
    {
      fingerprint,
      lastKnownPath: videoPath,
      projectStateFile,
      ...(cursorSidecarWritten
        ? { cursorSidecarPath: newSidecarPath }
        : decision.cursorSidecarPath
          ? { cursorSidecarPath: decision.cursorSidecarPath }
          : {}),
    },
    { removePaths: stalePaths },
  )

  return { relinked: true, fromPath: decision.fromPath, state, cursorSidecarWritten }
}

/**
 * Cursor-sidecar lookup by fingerprint for `get-current-video-path`: the
 * sidecar next to `videoPath` is gone (moved recording), so return the sidecar
 * the registry last saw for the same bytes, if it still exists. Read-only;
 * copying it next to the new path happens on relink.
 */
export async function findLinkedCursorSidecar(options: {
  registryDir: string
  recordingsDir: string
  videoPath: string
}): Promise<string | null> {
  const { registryDir, recordingsDir, videoPath } = options
  if (!isReadablePathAllowed(videoPath, { recordingsDir })) return null
  try {
    const fingerprint = await computeMediaFingerprint(videoPath)
    const entries = await findMediaLinksByFingerprint(registryDir, fingerprint)
    const ownSidecar = resolveCursorSidecarPath(videoPath)
    const candidates = new Set<string>()
    for (const entry of entries) {
      const sidecar = entry.cursorSidecarPath
      if (!sidecar) continue
      if (!isTrustedCursorSidecarPath(sidecar, entry.lastKnownPath)) continue
      if (samePath(sidecar, ownSidecar)) continue
      if (await fileExists(sidecar)) candidates.add(path.resolve(sidecar))
    }
    // Same rule as the state relink: several copies disagreeing means no answer.
    return candidates.size === 1 ? [...candidates][0] : null
  } catch {
    return null
  }
}
