import nodePath from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Pure path/URL policy helpers for the main process.
 *
 * This module must stay free of `electron` imports and of `app.getPath` calls at
 * import time so it can be unit-tested under plain Node. Callers pass the
 * directories they trust (e.g. the recordings dir) explicitly.
 */

export type PlatformPath = typeof nodePath

/** Video containers the editor can open. */
export const ALLOWED_IMPORT_VIDEO_EXTENSIONS: ReadonlySet<string> = new Set([
  '.webm',
  '.mp4',
  '.mov',
  '.avi',
  '.mkv',
  '.m4v',
  '.wmv',
  '.flv',
  '.ts',
])

/** Capturia sidecars stored next to a recording (`*.cursor.json`, `*.analysis.json`). */
export const ALLOWED_SIDECAR_EXTENSIONS: ReadonlySet<string> = new Set(['.json'])

/**
 * Everything `local-media://` may serve. The renderer only fetches the video
 * itself through the protocol today (see `VideoEditor.tsx#toFileUrl`); sidecars are
 * read by the main process. Images are deliberately not on the list.
 */
export const ALLOWED_READABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  ...ALLOWED_IMPORT_VIDEO_EXTENSIONS,
  ...ALLOWED_SIDECAR_EXTENSIONS,
])

/** Export containers `save-exported-video` may write. */
export const ALLOWED_EXPORT_EXTENSIONS: ReadonlySet<string> = new Set(['.mp4', '.gif'])

/** Protocols `open-external-url` may hand to `shell.openExternal`. */
export const EXTERNAL_URL_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:', 'mailto:'])

function isWindowsPath(platformPath: PlatformPath): boolean {
  return platformPath === nodePath.win32
}

function canonicalize(filePath: string, platformPath: PlatformPath): string {
  const resolved = platformPath.resolve(filePath)
  return isWindowsPath(platformPath) ? resolved.toLowerCase() : resolved
}

export function hasAllowedExtension(
  filePath: string,
  allowed: ReadonlySet<string>,
  platformPath: PlatformPath = nodePath,
): boolean {
  return allowed.has(platformPath.extname(filePath).toLowerCase())
}

export function hasAllowedImportVideoExtension(
  filePath: string,
  platformPath: PlatformPath = nodePath,
): boolean {
  return hasAllowedExtension(filePath, ALLOWED_IMPORT_VIDEO_EXTENSIONS, platformPath)
}

export function hasAllowedReadableExtension(
  filePath: string,
  platformPath: PlatformPath = nodePath,
): boolean {
  return hasAllowedExtension(filePath, ALLOWED_READABLE_EXTENSIONS, platformPath)
}

export function hasAllowedExportExtension(
  filePath: string,
  platformPath: PlatformPath = nodePath,
): boolean {
  return hasAllowedExtension(filePath, ALLOWED_EXPORT_EXTENSIONS, platformPath)
}

/** True when `filePath` resolves to `dirPath` itself or to something below it. */
export function isPathWithinDir(
  filePath: string,
  dirPath: string,
  platformPath: PlatformPath = nodePath,
): boolean {
  const resolved = canonicalize(filePath, platformPath)
  const resolvedDir = canonicalize(dirPath, platformPath)
  if (resolved === resolvedDir) return true
  const prefix = resolvedDir.endsWith(platformPath.sep)
    ? resolvedDir
    : resolvedDir + platformPath.sep
  return resolved.startsWith(prefix)
}

/**
 * Registry of exact paths the user explicitly handed to the app (file picker
 * results, save dialog results, ...). Keyed by resolved path.
 */
export class ApprovedPathRegistry {
  private readonly files = new Set<string>()
  private readonly dirs = new Set<string>()

  constructor(private readonly platformPath: PlatformPath = nodePath) {}

  approveFile(filePath: string): string {
    const resolved = this.platformPath.resolve(filePath)
    this.files.add(canonicalize(resolved, this.platformPath))
    return resolved
  }

  approveDirectory(dirPath: string): string {
    const resolved = this.platformPath.resolve(dirPath)
    this.dirs.add(canonicalize(resolved, this.platformPath))
    return resolved
  }

  isApprovedFile(filePath: string): boolean {
    return this.files.has(canonicalize(filePath, this.platformPath))
  }

  isApprovedDirectory(dirPath: string): boolean {
    return this.dirs.has(canonicalize(dirPath, this.platformPath))
  }

  isWithinApprovedDirectory(filePath: string): boolean {
    for (const dir of this.dirs) {
      if (isPathWithinDir(filePath, dir, this.platformPath)) return true
    }
    return false
  }

  /** Exact file match or below an approved directory. */
  isApproved(filePath: string): boolean {
    return this.isApprovedFile(filePath) || this.isWithinApprovedDirectory(filePath)
  }

  clear(): void {
    this.files.clear()
    this.dirs.clear()
  }

  get size(): number {
    return this.files.size + this.dirs.size
  }
}

/** Paths the user opened for reading (video picker, native recorder output, ...). */
export const approvedReadPaths = new ApprovedPathRegistry()
/** Paths/dirs the user chose as export destinations via a dialog. */
export const approvedExportPaths = new ApprovedPathRegistry()

export function approveFilePath(filePath: string): string {
  return approvedReadPaths.approveFile(filePath)
}

export function isApprovedPath(filePath: string): boolean {
  return approvedReadPaths.isApproved(filePath)
}

export interface ReadPolicyOptions {
  recordingsDir: string
  registry?: ApprovedPathRegistry
  platformPath?: PlatformPath
}

/**
 * Read policy shared by `local-media://`, `set-current-video-path`, `analysis-*`:
 * absolute path, allowed extension, and located inside the recordings dir OR
 * explicitly approved by the user.
 */
export function isReadablePathAllowed(filePath: string, options: ReadPolicyOptions): boolean {
  const platformPath = options.platformPath ?? nodePath
  const registry = options.registry ?? approvedReadPaths
  if (typeof filePath !== 'string' || filePath.trim().length === 0) return false
  if (!platformPath.isAbsolute(filePath)) return false
  if (!hasAllowedReadableExtension(filePath, platformPath)) return false
  if (isPathWithinDir(filePath, options.recordingsDir, platformPath)) return true
  return registry.isApproved(filePath)
}

/**
 * Turn a renderer-provided video reference into a normalized filesystem path.
 * Accepts plain paths and `file://` URLs; returns null for empty/non-string input.
 */
export function normalizeVideoSourcePath(
  videoPath: unknown,
  platformPath: PlatformPath = nodePath,
): string | null {
  if (typeof videoPath !== 'string') return null
  const trimmed = videoPath.trim()
  if (!trimmed) return null

  let candidate = trimmed
  if (/^file:\/\//i.test(trimmed)) {
    try {
      candidate = fileURLToPath(trimmed)
    } catch {
      // keep the raw string; normalize() below is best-effort
    }
  }

  return platformPath.normalize(candidate)
}

/**
 * Convert a `local-media://host/<path>` URL into a filesystem path. Returns null
 * when the URL cannot be parsed. Handles the `/C:/...` form the renderer produces
 * on Windows.
 */
export function localMediaUrlToPath(
  rawUrl: string,
  platformPath: PlatformPath = nodePath,
): string | null {
  let pathname: string
  try {
    pathname = new URL(rawUrl).pathname
  } catch {
    return null
  }

  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }

  if (isWindowsPath(platformPath) && /^\/[a-zA-Z]:/.test(decoded)) {
    decoded = decoded.slice(1)
  }

  return platformPath.normalize(decoded)
}

/**
 * Validate a renderer-supplied file name and join it under `dirPath`.
 * Rejects empty names, absolute paths, any separator and `..` segments.
 */
export function resolveOutputPathInDir(
  dirPath: string,
  fileName: unknown,
  platformPath: PlatformPath = nodePath,
): string {
  if (typeof fileName !== 'string') {
    throw new Error('Invalid file name')
  }
  const trimmed = fileName.trim()
  if (!trimmed) {
    throw new Error('Invalid file name')
  }

  const parsed = platformPath.parse(trimmed)
  const hasTraversalSegments = trimmed.split(/[\\/]+/).some((segment) => segment === '..')
  const isNestedPath =
    parsed.dir !== '' ||
    platformPath.isAbsolute(trimmed) ||
    nodePath.posix.isAbsolute(trimmed) ||
    nodePath.win32.isAbsolute(trimmed) ||
    trimmed.includes('/') ||
    trimmed.includes('\\')
  if (
    hasTraversalSegments ||
    isNestedPath ||
    parsed.base !== trimmed ||
    trimmed === '.' ||
    trimmed === '..'
  ) {
    throw new Error('File name must not contain path segments')
  }

  return platformPath.join(dirPath, parsed.base)
}

/** `store-recorded-video` destination: a bare file name inside the recordings dir. */
export function resolveRecordingOutputPath(
  recordingsDir: string,
  fileName: unknown,
  platformPath: PlatformPath = nodePath,
): string {
  try {
    return resolveOutputPathInDir(recordingsDir, fileName, platformPath)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`Invalid recording file name: ${reason}`)
  }
}

/** Parse and allowlist an external URL. Returns the serialized URL or null. */
export function normalizeExternalUrl(rawUrl: unknown): string | null {
  if (typeof rawUrl !== 'string') return null
  const trimmed = rawUrl.trim()
  if (!trimmed) return null
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }
  if (!EXTERNAL_URL_PROTOCOLS.has(parsed.protocol)) return null
  return parsed.toString()
}

export function isAllowedExternalUrl(rawUrl: unknown): boolean {
  return normalizeExternalUrl(rawUrl) !== null
}

export interface ExportPolicyOptions {
  registry?: ApprovedPathRegistry
  platformPath?: PlatformPath
}

/**
 * Export write policy: absolute path, `.mp4`/`.gif`, and either an exact path
 * returned by a save dialog or a file directly inside a directory returned by the
 * export-directory picker.
 */
export function isAllowedExportPath(
  targetPath: unknown,
  options: ExportPolicyOptions = {},
): boolean {
  const platformPath = options.platformPath ?? nodePath
  const registry = options.registry ?? approvedExportPaths
  if (typeof targetPath !== 'string' || targetPath.trim().length === 0) return false
  if (!platformPath.isAbsolute(targetPath)) return false
  if (!hasAllowedExportExtension(targetPath, platformPath)) return false
  if (registry.isApprovedFile(targetPath)) return true
  const parentDir = platformPath.dirname(platformPath.resolve(targetPath))
  return registry.isApprovedDirectory(parentDir)
}

export interface RevealPolicyOptions {
  recordingsDir: string
  readRegistry?: ApprovedPathRegistry
  exportRegistry?: ApprovedPathRegistry
  platformPath?: PlatformPath
}

/** `reveal-in-folder`: recordings dir, approved read paths, or approved export paths/dirs. */
export function isAllowedRevealPath(filePath: unknown, options: RevealPolicyOptions): boolean {
  const platformPath = options.platformPath ?? nodePath
  const readRegistry = options.readRegistry ?? approvedReadPaths
  const exportRegistry = options.exportRegistry ?? approvedExportPaths
  if (typeof filePath !== 'string' || filePath.trim().length === 0) return false
  if (!platformPath.isAbsolute(filePath)) return false
  if (isPathWithinDir(filePath, options.recordingsDir, platformPath)) return true
  if (readRegistry.isApproved(filePath)) return true
  return exportRegistry.isApproved(filePath)
}
