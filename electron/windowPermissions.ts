/**
 * Which Capturia window may hold which web permission.
 *
 * Capture is one window's job. The recorder HUD picks the camera and the
 * microphone, draws the input level meter and starts the screen capture; every
 * other window — the editor, the source selector, the countdown overlay, the
 * permission checker, the release notes — only ever plays back or displays.
 * Granting `media` and `display-capture` to whichever WebContents happened to
 * ask meant the editor (which runs with `webSecurity: false`) could have opened
 * the camera without a single line of Capturia's own code asking for it.
 *
 * The window's identity is recorded by the main process when it creates the
 * window, not read back from `webContents.getURL()`. A renderer can rewrite the
 * URL the browser reports with `history.replaceState` — that is precisely the
 * kind of claim this policy must not accept — while `rememberWindowType` states
 * what the main process actually built.
 */

export type CapturiaWindowType =
  | 'hud-overlay'
  | 'source-selector'
  | 'countdown-overlay'
  | 'permission-checker'
  | 'editor'
  | 'notes'

/**
 * Camera, microphone and screen capture. Chromium spells the same underlying
 * request several ways depending on the API and the platform, so all of them
 * are gated together.
 */
export const CAPTURE_PERMISSIONS: ReadonlySet<string> = new Set([
  'media',
  'audioCapture',
  'videoCapture',
  'microphone',
  'camera',
  'screen',
  'display-capture',
])

/** Permissions any Capturia window may hold. `fullscreen` is the editor's preview. */
export const WINDOW_PERMISSIONS: ReadonlySet<string> = new Set(['fullscreen'])

/** The only window that captures. */
export const CAPTURE_WINDOW_TYPES: ReadonlySet<CapturiaWindowType> = new Set<CapturiaWindowType>([
  'hud-overlay',
])

export interface PermissionDecisionInput {
  readonly permission: string
  /** What the main process built this WebContents as; null when it built no such window. */
  readonly windowType: CapturiaWindowType | null | undefined
  /** Subframes never get capture or fullscreen: only the window's own document asks. */
  readonly isMainFrame: boolean
}

/** Pure predicate behind both permission handlers. */
export function isPermissionAllowed(input: PermissionDecisionInput): boolean {
  if (!input.windowType) return false
  if (!input.isMainFrame) return false
  if (CAPTURE_PERMISSIONS.has(input.permission)) {
    return CAPTURE_WINDOW_TYPES.has(input.windowType)
  }
  return WINDOW_PERMISSIONS.has(input.permission)
}

const windowTypes = new WeakMap<object, CapturiaWindowType>()

/** Record what the main process just created. Call once per window. */
export function rememberWindowType(contents: object, windowType: CapturiaWindowType): void {
  windowTypes.set(contents, windowType)
}

/** The recorded type, or null for a WebContents Capturia did not create (DevTools, ...). */
export function windowTypeForContents(
  contents: object | null | undefined,
): CapturiaWindowType | null {
  if (!contents) return null
  return windowTypes.get(contents) ?? null
}
