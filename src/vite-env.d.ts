/// <reference types="vite/client" />
/// <reference types="../electron/electron-env" />

declare const __APP_VERSION__: string

/**
 * The preload bridge, declared once for the whole program.
 *
 * This file used to carry a second, hand-written copy of the bridge next to the
 * one in `electron/electron-env.d.ts`. TypeScript merged the two `interface
 * Window` blocks and `skipLibCheck` swallowed the conflict, so the copies
 * drifted apart in silence — `getAssetBasePath` lived only in the copy that
 * lost the merge, which is why `src/lib/assetPath.ts` had to reach it through
 * `window as any`. The shape now comes from `electron/bridge-types.ts`, which
 * `electron/preload.ts` annotates the exposed object with, so the renderer's
 * view of the bridge and what the preload actually exposes cannot disagree.
 *
 * The `import(...)` type stays type-only: nothing from the preload is bundled
 * into the renderer.
 */
interface Window {
  electronAPI: import('../electron/bridge-types').ElectronAPI
}
