/**
 * In-place updates for the installers Capturia builds and can replace itself:
 * the macOS .app (dmg + zip), the NSIS installer and the AppImage. Everything
 * else stays on the manual "Check for Updates…" dialog from `update-checker.ts`
 * (deb/rpm/pacman are left to the package manager even though electron-updater
 * could technically serve them; Store/Flatpak/Snap/Nix are filtered out by
 * `install-channel.ts` before we get here).
 *
 * The flow is opt-in at every step and never surprises the user:
 *   check (10 s after launch, or from the menu)
 *     -> "Download now / Later" dialog
 *     -> download with progress forwarded to the renderer as `update-progress`
 *     -> "Restart now / On next quit" dialog.
 * `autoDownload` is off, `autoInstallOnAppQuit` is on (an already downloaded
 * update is applied when the user quits explicitly; closing the HUD does not
 * quit Capturia), prereleases are ignored.
 *
 * Everything that decides is pure and takes the electron-updater instance,
 * dialogs and facts as parameters, so it is tested from a Linux-only CI with
 * neither Electron nor a signed build. `main.ts` only wires the pieces up.
 */

import type { InstallChannel } from './install-channel'

// ── Eligibility ───────────────────────────────────────────────────────────

/** Channels the updater can serve: each maps to an electron-updater backend and a feed we publish. */
export const SELF_UPDATE_CHANNELS: ReadonlySet<InstallChannel> = new Set<InstallChannel>([
  'dmg',
  'nsis',
  'appimage',
])

export type UpdaterEligibility =
  | { eligible: true }
  | { eligible: false; reason: 'unpacked' | 'channel' }

/** May this copy of Capturia download and install a new version over itself? */
export function getUpdaterEligibility(
  channel: InstallChannel,
  isPackaged: boolean,
): UpdaterEligibility {
  if (!isPackaged) return { eligible: false, reason: 'unpacked' }
  if (!SELF_UPDATE_CHANNELS.has(channel)) return { eligible: false, reason: 'channel' }
  return { eligible: true }
}

/** Launch check runs only when the updater can act on the answer and nothing is being recorded. */
export function shouldRunLaunchCheck(state: {
  eligible: boolean
  autoUpdateCheck: boolean
  recording: boolean
}): boolean {
  return state.eligible && state.autoUpdateCheck && !state.recording
}

// ── Preferences ───────────────────────────────────────────────────────────

/** Stored next to the shortcuts file in `userData`; the renderer only toggles it through IPC. */
export const UPDATE_PREFERENCES_FILE_NAME = 'update-preferences.json'

export interface UpdatePreferences {
  /** Check for a new version shortly after launch (default on). */
  autoUpdateCheck: boolean
}

export const DEFAULT_UPDATE_PREFERENCES: UpdatePreferences = { autoUpdateCheck: true }

/** Tolerates a missing or malformed file: anything but an explicit `false` keeps the default. */
export function parseUpdatePreferences(text: string | null | undefined): UpdatePreferences {
  if (!text) return { ...DEFAULT_UPDATE_PREFERENCES }
  try {
    const raw = JSON.parse(text) as unknown
    if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_UPDATE_PREFERENCES }
    const value = (raw as Record<string, unknown>).autoUpdateCheck
    return { autoUpdateCheck: value !== false }
  } catch {
    return { ...DEFAULT_UPDATE_PREFERENCES }
  }
}

export function serializeUpdatePreferences(preferences: UpdatePreferences): string {
  return JSON.stringify({ autoUpdateCheck: preferences.autoUpdateCheck !== false }, null, 2)
}

// ── Error classification ──────────────────────────────────────────────────

export type UpdateErrorKind =
  /** No network, DNS failure, connection reset or timeout. */
  | 'offline'
  /** The feed (`latest*.yml`) does not exist for this release yet. */
  | 'no-release'
  /** The running app or the downloaded payload is not code-signed; Squirrel/NSIS refuse to install. */
  | 'unsigned'
  | 'unknown'

const OFFLINE_CODES = new Set([
  'ENOTFOUND',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ERR_INTERNET_DISCONNECTED',
  'ERR_NAME_NOT_RESOLVED',
  'ERR_NETWORK_CHANGED',
  'ERR_CONNECTION_REFUSED',
  'ERR_CONNECTION_RESET',
  'ERR_CONNECTION_TIMED_OUT',
  'ERR_TIMED_OUT',
])

const OFFLINE_MESSAGE =
  /net::ERR_(INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|NETWORK_CHANGED|CONNECTION_|TIMED_OUT)|getaddrinfo|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|network is unreachable/i
const UNSIGNED_MESSAGE =
  /code signature|not signed|invalid signature|signature verification|ERR_UPDATER_INVALID_SIGNATURE|publisher name/i
const NO_RELEASE_MESSAGE =
  /ERR_UPDATER_LATEST_VERSION_NOT_FOUND|cannot find latest|latest(-mac|-linux)?\.yml|no published versions|unable to find latest version|HttpError: 404|status(Code)?:? 404|\b404\b/i

function errorField(error: unknown, key: string): unknown {
  return typeof error === 'object' && error !== null
    ? (error as Record<string, unknown>)[key]
    : undefined
}

export function describeUpdateError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Maps whatever electron-updater threw onto the four cases the UI can act on.
 * Signature and missing-feed failures are expected on unsigned builds and on
 * releases published before the feeds existed; both fall back to the release
 * page, which still works.
 */
export function classifyUpdateError(error: unknown): UpdateErrorKind {
  const code = errorField(error, 'code')
  const statusCode = errorField(error, 'statusCode')
  const message = describeUpdateError(error)

  if (typeof code === 'string' && OFFLINE_CODES.has(code)) return 'offline'
  if (OFFLINE_MESSAGE.test(message)) return 'offline'
  if (UNSIGNED_MESSAGE.test(message)) return 'unsigned'
  if (code === 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND' || statusCode === 404) return 'no-release'
  if (NO_RELEASE_MESSAGE.test(message)) return 'no-release'
  return 'unknown'
}

/** Failures the updater cannot fix itself; the manual release-page flow takes over. */
export function shouldFallBackToReleasePage(kind: UpdateErrorKind): boolean {
  return kind === 'unsigned' || kind === 'no-release'
}

// ── Dialog decisions ──────────────────────────────────────────────────────

/** Button order of the "update available" dialog; index 0 is the default. */
export const AVAILABLE_DIALOG_ACTIONS = ['download', 'later'] as const
export type AvailableDialogAction = (typeof AVAILABLE_DIALOG_ACTIONS)[number]

/** Button order of the "update downloaded" dialog; index 0 is the default. */
export const DOWNLOADED_DIALOG_ACTIONS = ['restart', 'on-quit'] as const
export type DownloadedDialogAction = (typeof DOWNLOADED_DIALOG_ACTIONS)[number]

/** Anything but an explicit "Download now" (including Escape / closing the dialog) means later. */
export function availableDialogAction(response: number): AvailableDialogAction {
  return response === 0 ? 'download' : 'later'
}

/** Anything but an explicit "Restart now" leaves the update to `autoInstallOnAppQuit`. */
export function downloadedDialogAction(response: number): DownloadedDialogAction {
  return response === 0 ? 'restart' : 'on-quit'
}

/**
 * Restarting mid-recording would lose the take, and on Windows NSIS cannot
 * overwrite the running capture helpers anyway: the install waits for quit.
 */
export function resolveInstallAction(
  action: DownloadedDialogAction,
  state: { recording: boolean },
): DownloadedDialogAction {
  if (action === 'restart' && state.recording) return 'on-quit'
  return action
}

// ── electron-updater surface ──────────────────────────────────────────────

export interface UpdateInfoLike {
  version: string
}

export interface UpdateCheckResultLike {
  isUpdateAvailable?: boolean
  updateInfo?: UpdateInfoLike | null
}

export interface DownloadProgressLike {
  percent: number
  transferred: number
  total: number
  bytesPerSecond: number
}

export type UpdaterEvent = 'download-progress' | 'update-downloaded' | 'error'

/**
 * The slice of `electron-updater`'s `AppUpdater` this module touches. Injected
 * so tests (and the unpacked dev build) never load the real module.
 */
export interface UpdaterLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  allowPrerelease: boolean
  logger: unknown
  on(event: 'download-progress', listener: (progress: DownloadProgressLike) => void): unknown
  on(event: 'update-downloaded', listener: (info: UpdateInfoLike) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  checkForUpdates(): Promise<UpdateCheckResultLike | null>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(isSilent: boolean, isForceRunAfter: boolean): void
}

/**
 * The three settings that make the updater safe to leave on. Reapplied before
 * every check rather than once: three property writes cost nothing and a
 * "configured" flag would silently stop correcting anything that reset them.
 */
export function configureUpdater(updater: UpdaterLike): void {
  updater.autoDownload = false
  updater.autoInstallOnAppQuit = true
  updater.allowPrerelease = false
  updater.logger = null
}

// ── Renderer events ───────────────────────────────────────────────────────

/** Payload of the `update-progress` IPC event (renderer subscribes via `onUpdateProgress`). */
export type UpdateProgressEvent =
  | { phase: 'checking' }
  | { phase: 'current'; version: string }
  | { phase: 'available'; version: string }
  | {
      phase: 'downloading'
      version: string
      percent: number
      transferred: number
      total: number
      bytesPerSecond: number
    }
  | { phase: 'downloaded'; version: string }
  | { phase: 'error'; kind: UpdateErrorKind; message: string }

// ── Controller ────────────────────────────────────────────────────────────

export type UpdateCheckSource = 'launch' | 'menu'

export type UpdateOutcome =
  | { kind: 'busy' }
  | { kind: 'current'; version: string }
  | { kind: 'available'; version: string; action: AvailableDialogAction }
  | { kind: 'downloaded'; version: string; action: DownloadedDialogAction }
  | { kind: 'failed'; errorKind: UpdateErrorKind; message: string; stage: 'check' | 'download' }

export interface AutoUpdaterPrompts {
  /** "Capturia X is available" with Download now / Later. */
  available(version: string): Promise<AvailableDialogAction>
  /** "Capturia X has been downloaded" with Restart now / On next quit. */
  downloaded(version: string): Promise<DownloadedDialogAction>
  /** "Up to date" - shown for menu-driven checks only. */
  current(version: string): Promise<void>
  /** Offline / unknown failures - shown for menu-driven checks and for any failed download. */
  failed(kind: UpdateErrorKind, message: string): Promise<void>
}

export interface AutoUpdaterDeps {
  updater: UpdaterLike
  currentVersion: string
  isRecording(): boolean
  /** Forwards progress to every renderer window. */
  emit(event: UpdateProgressEvent): void
  prompts: AutoUpdaterPrompts
  /** The manual GitHub-release flow; used when the updater cannot act (unsigned build, no feed). */
  fallbackToReleasePage(): Promise<void>
  log?: (message: string, ...detail: unknown[]) => void
}

export interface AutoUpdaterController {
  /** One check at a time; a second call while one is in flight returns `busy`. */
  check(source: UpdateCheckSource): Promise<UpdateOutcome>
  /** Version already downloaded and waiting for a restart / quit, if any. */
  downloadedVersion(): string | null
}

function isNewerVersionAvailable(
  result: UpdateCheckResultLike | null,
  currentVersion: string,
): string | null {
  const version = result?.updateInfo?.version
  if (!version) return null
  if (result?.isUpdateAvailable === false) return null
  if (result?.isUpdateAvailable === undefined && version === currentVersion) return null
  return version
}

export function createAutoUpdater(deps: AutoUpdaterDeps): AutoUpdaterController {
  const log = deps.log ?? (() => undefined)
  let inFlight = false
  let downloaded: string | null = null
  let downloadingVersion: string | null = null
  let downloadError: Error | null = null

  deps.updater.on('download-progress', (progress) => {
    if (!downloadingVersion) return
    deps.emit({
      phase: 'downloading',
      version: downloadingVersion,
      percent: Number.isFinite(progress.percent) ? progress.percent : 0,
      transferred: progress.transferred,
      total: progress.total,
      bytesPerSecond: progress.bytesPerSecond,
    })
  })
  deps.updater.on('update-downloaded', (info) => {
    downloaded = info?.version ?? downloadingVersion
  })
  // Some backends (Squirrel on macOS) report install-time failures only through
  // the `error` event, after `downloadUpdate()` has already resolved.
  deps.updater.on('error', (error) => {
    if (downloadingVersion) downloadError = error
    log('[updates] updater error:', error)
  })

  async function download(version: string): Promise<UpdateOutcome> {
    downloadingVersion = version
    downloadError = null
    try {
      await deps.updater.downloadUpdate()
      if (downloadError) throw downloadError
    } catch (error) {
      const errorKind = classifyUpdateError(error)
      const message = describeUpdateError(error)
      deps.emit({ phase: 'error', kind: errorKind, message })
      if (shouldFallBackToReleasePage(errorKind)) {
        await deps.fallbackToReleasePage()
      } else {
        await deps.prompts.failed(errorKind, message)
      }
      return { kind: 'failed', errorKind, message, stage: 'download' }
    } finally {
      downloadingVersion = null
    }

    downloaded = version
    deps.emit({ phase: 'downloaded', version })
    return promptInstall(version)
  }

  async function promptInstall(version: string): Promise<UpdateOutcome> {
    const requested = await deps.prompts.downloaded(version)
    const action = resolveInstallAction(requested, { recording: deps.isRecording() })
    if (action === 'restart') {
      // Non-silent so a per-machine Windows install can show its elevation
      // prompt; force-run so the app comes back after the installer.
      deps.updater.quitAndInstall(false, true)
    }
    return { kind: 'downloaded', version, action }
  }

  return {
    downloadedVersion: () => downloaded,
    async check(source) {
      if (inFlight) return { kind: 'busy' }
      inFlight = true
      try {
        if (downloaded) {
          // Nothing to fetch; remind the user (menu) or stay silent (launch).
          if (source === 'menu') return await promptInstall(downloaded)
          return { kind: 'downloaded', version: downloaded, action: 'on-quit' }
        }

        configureUpdater(deps.updater)
        deps.emit({ phase: 'checking' })
        let version: string | null
        try {
          const result = await deps.updater.checkForUpdates()
          version = isNewerVersionAvailable(result, deps.currentVersion)
        } catch (error) {
          const errorKind = classifyUpdateError(error)
          const message = describeUpdateError(error)
          log('[updates] check failed:', error)
          deps.emit({ phase: 'error', kind: errorKind, message })
          if (source === 'menu') {
            if (shouldFallBackToReleasePage(errorKind)) await deps.fallbackToReleasePage()
            else await deps.prompts.failed(errorKind, message)
          }
          return { kind: 'failed', errorKind, message, stage: 'check' }
        }

        if (!version) {
          deps.emit({ phase: 'current', version: deps.currentVersion })
          if (source === 'menu') await deps.prompts.current(deps.currentVersion)
          return { kind: 'current', version: deps.currentVersion }
        }

        deps.emit({ phase: 'available', version })
        const action = await deps.prompts.available(version)
        if (action === 'later') return { kind: 'available', version, action }
        return await download(version)
      } finally {
        inFlight = false
      }
    },
  }
}
