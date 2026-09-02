/**
 * Platform detection for the renderer.
 *
 * The renderer runs with `contextIsolation: true` / `nodeIntegration: false`,
 * so the Node `process` global does not exist here. `electron/preload.ts`
 * snapshots `process.platform` once and exposes it as the plain string
 * `electronAPI.platform`; `getPlatformSync()` reads that, so the first render
 * already knows whether it is on macOS (no `isMac` flicker).
 *
 * Outside Electron (vitest, a plain browser) there is no `electronAPI`, so the
 * sync path falls back to sniffing `navigator`. The async `getPlatform()` is
 * kept for the call sites that still await it: it answers from the snapshot
 * immediately and only reaches for the `get-platform` IPC when the preload
 * predates the snapshot.
 */

export type RendererPlatform = 'darwin' | 'win32' | 'linux' | (string & {})

let cachedPlatform: string | null = null

function readPreloadSnapshot(): string | null {
  if (typeof window === 'undefined') return null
  const value = (window as { electronAPI?: { platform?: unknown } }).electronAPI?.platform
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** `navigator`-based guess for environments without a preload (tests, browsers). */
export function guessPlatformFromNavigator(
  nav: { platform?: string; userAgent?: string } | undefined = typeof navigator !== 'undefined'
    ? navigator
    : undefined,
): RendererPlatform {
  if (!nav) return 'win32'
  const hint = `${nav.platform ?? ''} ${nav.userAgent ?? ''}`
  if (/Mac|iPhone|iPad|iPod/.test(hint)) return 'darwin'
  if (/Linux|Android|X11/.test(hint)) return 'linux'
  return 'win32'
}

/**
 * Synchronous platform read: preload snapshot first, then the cached IPC
 * answer, then the navigator guess. Never throws.
 */
export function getPlatformSync(): RendererPlatform {
  const snapshot = readPreloadSnapshot()
  if (snapshot) {
    cachedPlatform = snapshot
    return snapshot
  }
  if (cachedPlatform) return cachedPlatform
  return guessPlatformFromNavigator()
}

/** Synchronous macOS check for first-render decisions (modifier glyphs, menu placement). */
export function isMacSync(): boolean {
  return getPlatformSync() === 'darwin'
}

/**
 * Gets the current platform. Resolves from the preload snapshot without an IPC
 * round-trip; the `get-platform` IPC is the fallback for an older preload.
 */
export const getPlatform = async (): Promise<string> => {
  const snapshot = readPreloadSnapshot()
  if (snapshot) {
    cachedPlatform = snapshot
    return snapshot
  }
  if (cachedPlatform) return cachedPlatform

  try {
    const ipc = (window as { electronAPI?: { getPlatform?: () => Promise<string> } }).electronAPI
      ?.getPlatform
    if (!ipc) throw new Error('electronAPI.getPlatform unavailable')
    const platform = await ipc()
    if (typeof platform !== 'string' || platform.length === 0) {
      throw new Error('get-platform returned no platform')
    }
    cachedPlatform = platform
    return platform
  } catch (error) {
    console.warn('Failed to get platform from Electron, falling back to navigator:', error)
    const fallbackPlatform = guessPlatformFromNavigator()
    cachedPlatform = fallbackPlatform
    return fallbackPlatform
  }
}

/** Test hook: forget the cached IPC answer (the preload snapshot is re-read on every call). */
export function resetPlatformCacheForTests(): void {
  cachedPlatform = null
}

/**
 * Detects if the current platform is macOS
 */
export const isMac = async (): Promise<boolean> => {
  const platform = await getPlatform()
  return platform === 'darwin'
}

/**
 * Gets the modifier key symbol based on the platform
 */
export const getModifierKey = async (): Promise<string> => {
  return (await isMac()) ? '⌘' : 'Ctrl'
}

/**
 * Gets the shift key symbol based on the platform
 */
export const getShiftKey = async (): Promise<string> => {
  return (await isMac()) ? '⇧' : 'Shift'
}

/**
 * Formats a keyboard shortcut for display based on the platform
 * @param keys Array of key combinations (e.g., ['mod', 'D'] or ['shift', 'mod', 'Scroll'])
 */
export const formatShortcut = async (keys: string[]): Promise<string> => {
  const isMacPlatform = await isMac()
  return keys
    .map((key) => {
      if (key.toLowerCase() === 'mod') return isMacPlatform ? '⌘' : 'Ctrl'
      if (key.toLowerCase() === 'shift') return isMacPlatform ? '⇧' : 'Shift'
      return key
    })
    .join(' + ')
}
