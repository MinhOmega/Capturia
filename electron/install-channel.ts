// How this copy of Capturia was installed (ported from OpenScreen).
//
// The channel feeds the About box and the diagnostic / bug-report bodies, and is
// the single fact any future updater must key off: on the Microsoft Store,
// Flathub, Snap and Nix the package manager already updates the app, so a
// self-updater must not be offered there at all.
//
// The classification is a pure decision table over an `InstallProbe` so it can
// be tested on every platform from a Linux-only CI; `probeInstall` reads the
// real facts and takes the Electron `app` bits as parameters so this module
// never imports `electron` at runtime (vitest runs it under node).

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

/** Where the running binary came from. */
export type InstallChannel =
  /** We own the update: an installer/bundle we built and can replace in place. */
  | 'nsis'
  | 'dmg'
  | 'appimage'
  | 'deb'
  | 'rpm'
  | 'pacman'
  /** A package manager owns the update; we must stay out of its way. */
  | 'store'
  | 'flatpak'
  | 'snap'
  | 'nix'
  /** Unpacked `npm run dev`, or a build we cannot classify. */
  | 'dev'
  | 'unknown'

export interface InstallProbe {
  platform: NodeJS.Platform
  /** `false` for `npm run dev` - but NOT sufficient on its own: Flatpak and Snap are packaged. */
  isPackaged: boolean
  execPath: string
  /** `process.windowsStore` is `true` or **undefined**, never `false`. Normalise before passing. */
  windowsStore: boolean
  /** `FLATPAK_ID`, `SNAP`, `SNAP_REVISION`, `APPIMAGE`. */
  env: Readonly<Record<string, string | undefined>>
  /** `/.flatpak-info` exists (the env var leaks to child processes; the file does not). */
  hasFlatpakInfo: boolean
  /** Contents of `<resourcesPath>/package-type`, or null (electron-builder writes it for deb/rpm/pacman). */
  packageType: string | null
}

const SELF_UPDATING: ReadonlySet<InstallChannel> = new Set<InstallChannel>([
  'nsis',
  'dmg',
  'appimage',
  'deb',
  'rpm',
  'pacman',
])

const PLATFORM_OWNED: ReadonlySet<InstallChannel> = new Set<InstallChannel>([
  'store',
  'flatpak',
  'snap',
  'nix',
])

/**
 * Pure decision table. Platform-owned markers are checked FIRST because they
 * coexist with the self-owned ones: a Flatpak build still carries a
 * `package-type` file, and a Snap still looks like a plain Linux install.
 */
export function classifyInstall(probe: InstallProbe): InstallChannel {
  if (!probe.isPackaged) return 'dev'

  // --- platform-owned ---
  if (probe.windowsStore) return 'store'
  if (probe.env.FLATPAK_ID || probe.hasFlatpakInfo) return 'flatpak'
  // Two markers, not one: a bare `SNAP` is a plausible collision with an unrelated variable.
  if (probe.env.SNAP && probe.env.SNAP_REVISION) return 'snap'
  if (probe.execPath.startsWith('/nix/store/')) return 'nix'

  // --- self-owned ---
  if (probe.env.APPIMAGE) return 'appimage'
  if (
    probe.packageType === 'deb' ||
    probe.packageType === 'rpm' ||
    probe.packageType === 'pacman'
  ) {
    return probe.packageType
  }
  if (probe.platform === 'win32') return 'nsis'
  if (probe.platform === 'darwin') return 'dmg'

  // A packaged Linux build with no APPIMAGE and no package-type: do not guess.
  return 'unknown'
}

/** May this copy download and install a new version over itself? */
export function ownsItsUpdates(channel: InstallChannel): boolean {
  return SELF_UPDATING.has(channel)
}

/**
 * Does a package manager already keep this copy up to date? When true the app
 * must show no update affordance at all. Distinct from `!ownsItsUpdates`: a
 * `dev` or `unknown` build cannot self-update either, but pointing its user at
 * the release page is still useful.
 */
export function platformOwnsUpdates(channel: InstallChannel): boolean {
  return PLATFORM_OWNED.has(channel)
}

/** The single rule every update affordance keys off (no check mid-recording either). */
export function offersUpdateCheck(
  channel: InstallChannel,
  state: { readonly recording: boolean },
): boolean {
  return !platformOwnsUpdates(channel) && !state.recording
}

export interface InstallProbeSource {
  /** `app.isPackaged` */
  isPackaged: boolean
  /** `process.resourcesPath` */
  resourcesPath: string
}

export function probeInstall(source: InstallProbeSource): InstallProbe {
  return {
    platform: process.platform,
    isPackaged: source.isPackaged,
    execPath: process.execPath,
    windowsStore: process.windowsStore === true,
    env: process.env,
    hasFlatpakInfo: process.platform === 'linux' && existsSync('/.flatpak-info'),
    packageType: readPackageType(source.resourcesPath),
  }
}

function readPackageType(resourcesPath: string): string | null {
  try {
    return readFileSync(path.join(resourcesPath, 'package-type'), 'utf8').trim()
  } catch {
    // Absent on every platform except a deb/rpm/pacman install. Not an error.
    return null
  }
}

/** Memoized: `probeInstall()` touches the filesystem, and the answer cannot change while the process lives. */
let cachedChannel: InstallChannel | null = null

export function getInstallChannel(source: InstallProbeSource): InstallChannel {
  if (cachedChannel === null) cachedChannel = classifyInstall(probeInstall(source))
  return cachedChannel
}
