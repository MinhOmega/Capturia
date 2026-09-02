import type { MenuItemConstructorOptions } from 'electron'

/**
 * Pure builder for the tray context menu so its shape can be tested without
 * a running Electron.
 *
 * While recording the tray holds nothing but "Stop Recording". Otherwise it
 * carries Open, Check for Updates (only when this install may offer one, see
 * `offersUpdateCheck` in install-channel.ts), About, Save Diagnostics and Quit.
 * About and Save Diagnostics live here because no window this app creates
 * shows a menu bar on Windows/Linux: the HUD is frameless and the editor and
 * notes windows auto-hide theirs, so without the tray those two entries are
 * reachable only by opening the editor and holding Alt.
 */

export interface TrayMenuLabels {
  stopRecording: string
  open: string
  checkForUpdates: string
  about: string
  saveDiagnostics: string
  quit: string
}

export interface TrayMenuActions {
  stopRecording: () => void
  open: () => void
  checkForUpdates: () => void
  about: () => void
  saveDiagnostics: () => void
  quit: () => void
}

export interface TrayMenuInput {
  recording: boolean
  /** `offersUpdateCheck(channel, { recording })` — false hides the entry entirely. */
  offersUpdateCheck: boolean
  /** macOS: About opens the native panel through `role: 'about'`. */
  nativeAboutPanel: boolean
  labels: TrayMenuLabels
  actions: TrayMenuActions
}

export function buildTrayMenuTemplate(input: TrayMenuInput): MenuItemConstructorOptions[] {
  const { labels, actions } = input
  if (input.recording) {
    return [{ id: 'stop-recording', label: labels.stopRecording, click: actions.stopRecording }]
  }
  const template: MenuItemConstructorOptions[] = [
    { id: 'open', label: labels.open, click: actions.open },
  ]
  if (input.offersUpdateCheck) {
    template.push({
      id: 'check-for-updates',
      label: labels.checkForUpdates,
      click: actions.checkForUpdates,
    })
  }
  template.push(
    input.nativeAboutPanel
      ? { id: 'about', role: 'about', label: labels.about }
      : { id: 'about', label: labels.about, click: actions.about },
    { id: 'save-diagnostics', label: labels.saveDiagnostics, click: actions.saveDiagnostics },
    { type: 'separator' },
    { id: 'quit', label: labels.quit, click: actions.quit },
  )
  return template
}

/** Ids of the non-separator items, in order — what the tests assert on. */
export function trayMenuItemIds(template: readonly MenuItemConstructorOptions[]): string[] {
  return template.filter((item) => item.type !== 'separator').map((item) => item.id ?? '')
}
