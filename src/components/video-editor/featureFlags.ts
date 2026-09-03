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

/** Shortcut actions that belong to a flagged-off feature are hidden from the help and config dialogs. */
export function isShortcutActionVisible(action: ShortcutAction): boolean {
  if (action === 'addBlur') return BLUR_REGIONS_ENABLED
  return true
}
