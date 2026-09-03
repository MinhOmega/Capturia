import type { ShortcutAction } from '@/lib/shortcuts'

/**
 * Editor feature flags. Each flag is a build-time constant so a feature can be
 * switched off in one line without touching its call sites.
 */

/**
 * Blur (mosaic) regions: timeline row, `addBlur` shortcut, settings panel,
 * preview overlay and export pass. Regions already saved in a project are kept
 * in the annotation list when the flag is off; they are just not rendered or
 * editable until it is switched back on.
 */
export const BLUR_REGIONS_ENABLED = true

/**
 * Blur regions that follow their content (`src/lib/blurTracking`): the "Track
 * content" action, the keyframe ticks on the timeline and the source-space
 * render path. Off until phase 2 ships the UI and the renderers; with it off
 * nothing is offered and a `blurTrack` already in a project is carried through
 * save/load untouched but never rendered, so the region stays the static box
 * it has always been.
 *
 * See `docs/specs/tracked-blur-regions.md`.
 */
export const BLUR_TRACKING_ENABLED = false

/** Shortcut actions that belong to a flagged-off feature are hidden from the help and config dialogs. */
export function isShortcutActionVisible(action: ShortcutAction): boolean {
  if (action === 'addBlur') return BLUR_REGIONS_ENABLED
  return true
}
