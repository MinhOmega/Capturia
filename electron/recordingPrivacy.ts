/**
 * Whether Capturia's own HUD family (launch HUD, countdown overlay, source
 * selector) is kept out of the recording.
 *
 * The preference itself lives with the other user preferences in the renderer
 * (`src/lib/userPreferences.ts`); this module is the main-process mirror the
 * window layer and the native recorder read, because both run long before any
 * renderer is asked. The HUD pushes the stored value up on mount and on every
 * change (`hud-hide-from-recording-set`).
 *
 * Deliberately free of Electron imports so the window code, the IPC layer and
 * the native recorder can all read it without an import cycle, and so it is
 * testable on its own.
 */

export const DEFAULT_HIDE_HUD_FROM_RECORDING = true

let hideHudFromRecording = DEFAULT_HIDE_HUD_FROM_RECORDING

export function getHideHudFromRecording(): boolean {
  return hideHudFromRecording
}

/** Sets the mirror and answers with the value now in effect (unknown input is ignored). */
export function setHideHudFromRecording(enabled: unknown): boolean {
  if (typeof enabled === 'boolean') {
    hideHudFromRecording = enabled
  }
  return hideHudFromRecording
}

/** Test seam: restores the default so one spec cannot leak into the next. */
export function resetHideHudFromRecording(): void {
  hideHudFromRecording = DEFAULT_HIDE_HUD_FROM_RECORDING
}
