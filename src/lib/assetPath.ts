/**
 * Resolve a bundled asset (`wallpapers/wallpaper1.jpg`, ...) to a URL the
 * renderer can load.
 *
 * - Dev server (http/https): the asset is served from `public/`, so the
 *   web path is returned as-is.
 * - Packaged app (file://): the preload exposes `electronAPI.assetBaseUrl`,
 *   a `file://` URL of the resources directory computed once by the main
 *   process, so the answer is available synchronously and every caller does
 *   not pay an IPC round trip per asset. Bundled assets live under
 *   `<resources>/assets/` (electron-builder `extraResources`), the same
 *   directory the `get-asset-base-path` IPC hands back.
 * - Older preloads without `assetBaseUrl` fall back to that IPC.
 */

const PACKAGED_ASSET_SUBDIR = 'assets/'

function stripLeadingSlash(relativePath: string): string {
  return relativePath.replace(/^\/+/, '')
}

function readAssetBaseUrl(): string | null {
  if (typeof window === 'undefined') return null
  const api = (window as any).electronAPI
  const base = api?.assetBaseUrl
  return typeof base === 'string' && base.length > 0 ? base : null
}

/**
 * Synchronous resolution through `electronAPI.assetBaseUrl`. Returns `null`
 * when the preload does not expose the base (older preload, plain browser).
 */
export function getAssetPathSync(relativePath: string): string | null {
  const base = readAssetBaseUrl()
  if (!base) return null
  const withSlash = base.endsWith('/') ? base : `${base}/`
  return `${withSlash}${PACKAGED_ASSET_SUBDIR}${stripLeadingSlash(relativePath)}`
}

export async function getAssetPath(relativePath: string): Promise<string> {
  try {
    if (typeof window !== 'undefined') {
      // If running in a dev server (http/https), prefer the web-served path
      if (
        window.location &&
        window.location.protocol &&
        window.location.protocol.startsWith('http')
      ) {
        return `/${stripLeadingSlash(relativePath)}`
      }

      const sync = getAssetPathSync(relativePath)
      if (sync) return sync

      if (
        (window as any).electronAPI &&
        typeof (window as any).electronAPI.getAssetBasePath === 'function'
      ) {
        const base = await (window as any).electronAPI.getAssetBasePath()
        if (base) {
          const normalized = base.replace(/\\/g, '/')
          return `file://${normalized}/${relativePath}`
        }
      }
    }
  } catch {
    // ignore and use fallback
  }

  // Fallback for web/dev server: public/wallpapers are served at '/wallpapers/...'
  return `/${stripLeadingSlash(relativePath)}`
}

export default getAssetPath
