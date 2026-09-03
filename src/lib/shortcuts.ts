// Configurable keyboard shortcuts — types, defaults, matching, formatting, conflict detection.

export const SHORTCUT_ACTIONS = [
  'addZoom',
  'addAnnotation',
  'addBlur',
  'addKeyframe',
  'toggleScissors',
  'deleteSelected',
  'playPause',
  'speedUp',
  'speedDown',
  'copySelected',
  'paste',
  // Global (OS-level) shortcuts, registered by the main process
  // (electron/globalShortcut.ts). Stored in the same shortcuts.json.
  'openApp',
  'stopRecording',
] as const

export type ShortcutAction = (typeof SHORTCUT_ACTIONS)[number]

/** Actions bound system-wide through Electron's globalShortcut rather than the editor keydown path. */
export const GLOBAL_SHORTCUT_ACTIONS = [
  'openApp',
  'stopRecording',
] as const satisfies readonly ShortcutAction[]

export type GlobalShortcutAction = (typeof GLOBAL_SHORTCUT_ACTIONS)[number]

export function isGlobalShortcutAction(action: ShortcutAction): action is GlobalShortcutAction {
  return (GLOBAL_SHORTCUT_ACTIONS as readonly ShortcutAction[]).includes(action)
}

/** Editor-only actions (everything the in-window keydown handlers match). */
export const EDITOR_SHORTCUT_ACTIONS: readonly ShortcutAction[] = SHORTCUT_ACTIONS.filter(
  (action) => !isGlobalShortcutAction(action),
)

/**
 * localStorage mirror of the stop-recording accelerator that the HUD
 * (LaunchWindow) reads on mount and re-applies. The shortcuts dialog writes
 * the same key after a successful registration so both surfaces agree.
 */
export const STOP_RECORDING_ACCELERATOR_STORAGE_KEY = 'capturia.stopRecordingShortcut'

export interface ShortcutBinding {
  key: string
  /** Maps to Cmd on macOS, Ctrl on Windows/Linux */
  ctrl?: boolean
  shift?: boolean
  alt?: boolean
}

export type ShortcutsConfig = Record<ShortcutAction, ShortcutBinding>

export interface FixedShortcut {
  labelKey: string
  display: string
  bindings: ShortcutBinding[]
}

export type ShortcutConflict =
  | { type: 'configurable'; action: ShortcutAction }
  | { type: 'fixed'; labelKey: string }

// ---------------------------------------------------------------------------
// Labels — maps each action to an i18n key so the UI can call t(labelKey)
// ---------------------------------------------------------------------------

export const SHORTCUT_LABEL_KEYS: Record<ShortcutAction, string> = {
  addZoom: 'shortcuts.addZoom',
  addAnnotation: 'shortcuts.addAnnotation',
  addBlur: 'shortcuts.addBlur',
  addKeyframe: 'shortcuts.addKeyframe',
  toggleScissors: 'shortcuts.toggleScissors',
  deleteSelected: 'shortcuts.deleteSelected',
  playPause: 'shortcuts.playPause',
  speedUp: 'shortcuts.speedUp',
  speedDown: 'shortcuts.speedDown',
  copySelected: 'shortcuts.copySelected',
  paste: 'shortcuts.paste',
  openApp: 'shortcuts.openApp',
  stopRecording: 'shortcuts.stopRecording',
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_SHORTCUTS: ShortcutsConfig = {
  addZoom: { key: 'z' },
  addAnnotation: { key: 'a' },
  addBlur: { key: 'b' },
  addKeyframe: { key: 'f' },
  toggleScissors: { key: 's' },
  // Delete, not Ctrl/Cmd+D: Ctrl/Cmd+D is the fixed "duplicate region"
  // shortcut, and Delete/Backspace already delete the selection, so this
  // default loses nothing and leaves the duplicate combo free.
  deleteSelected: { key: 'delete' },
  playPause: { key: ' ' },
  speedUp: { key: ']' },
  speedDown: { key: '[' },
  copySelected: { key: 'c', ctrl: true },
  paste: { key: 'v', ctrl: true },
  openApp: { key: 'o', ctrl: true, shift: true },
  stopRecording: { key: '2', ctrl: true, shift: true },
}

// ---------------------------------------------------------------------------
// Fixed (non-configurable) shortcuts — listed in the help panel only
// ---------------------------------------------------------------------------

/** Number keys that set the selected zoom's depth (ZoomDepth 1..6). */
export const ZOOM_DEPTH_SHORTCUT_KEYS = ['1', '2', '3', '4', '5', '6'] as const

/** J / K / L transport: step the preview rate down, pause, step it up. */
export const TRANSPORT_SHORTCUT_KEYS = { slower: 'j', pause: 'k', faster: 'l' } as const

export const FIXED_SHORTCUTS: FixedShortcut[] = [
  { labelKey: 'shortcuts.seekForward', display: '→', bindings: [{ key: 'arrowright' }] },
  { labelKey: 'shortcuts.seekBackward', display: '←', bindings: [{ key: 'arrowleft' }] },
  { labelKey: 'shortcuts.seekFine', display: 'Shift + ←/→', bindings: [] },
  { labelKey: 'shortcuts.frameBack', display: ',', bindings: [{ key: ',' }] },
  { labelKey: 'shortcuts.frameForward', display: '.', bindings: [{ key: '.' }] },
  { labelKey: 'shortcuts.zoomIn', display: '=', bindings: [{ key: '=' }] },
  { labelKey: 'shortcuts.zoomOut', display: '-', bindings: [{ key: '-' }] },
  { labelKey: 'shortcuts.fullscreen', display: 'F11', bindings: [{ key: 'f11' }] },
  { labelKey: 'shortcuts.undo', display: 'Ctrl+Z', bindings: [{ key: 'z', ctrl: true }] },
  {
    labelKey: 'shortcuts.redo',
    display: 'Ctrl+Shift+Z',
    bindings: [{ key: 'z', ctrl: true, shift: true }],
  },
  { labelKey: 'shortcuts.panTimeline', display: 'Shift+Ctrl+Scroll', bindings: [] },
  { labelKey: 'shortcuts.zoomTimeline', display: 'Ctrl+Scroll', bindings: [] },
  {
    labelKey: 'shortcuts.zoomLevel',
    display: '1 – 6',
    bindings: ZOOM_DEPTH_SHORTCUT_KEYS.map((key) => ({ key })),
  },
  {
    labelKey: 'shortcuts.transportSlower',
    display: 'J',
    bindings: [{ key: TRANSPORT_SHORTCUT_KEYS.slower }],
  },
  {
    labelKey: 'shortcuts.transportPause',
    display: 'K',
    bindings: [{ key: TRANSPORT_SHORTCUT_KEYS.pause }],
  },
  {
    labelKey: 'shortcuts.transportFaster',
    display: 'L',
    bindings: [{ key: TRANSPORT_SHORTCUT_KEYS.faster }],
  },
  {
    labelKey: 'shortcuts.duplicateRegion',
    display: 'Ctrl+D',
    bindings: [{ key: 'd', ctrl: true }],
  },
]

// ---------------------------------------------------------------------------
// Comparison helpers
// ---------------------------------------------------------------------------

export function bindingsEqual(a: ShortcutBinding, b: ShortcutBinding): boolean {
  return (
    a.key.toLowerCase() === b.key.toLowerCase() &&
    !!a.ctrl === !!b.ctrl &&
    !!a.shift === !!b.shift &&
    !!a.alt === !!b.alt
  )
}

export function findConflict(
  binding: ShortcutBinding,
  forAction: ShortcutAction,
  config: ShortcutsConfig,
): ShortcutConflict | null {
  // Check against fixed shortcuts first
  for (const fixed of FIXED_SHORTCUTS) {
    if (fixed.bindings.some((b) => bindingsEqual(b, binding))) {
      return { type: 'fixed', labelKey: fixed.labelKey }
    }
  }
  // Check against other configurable shortcuts
  for (const action of SHORTCUT_ACTIONS) {
    if (action !== forAction && bindingsEqual(config[action], binding)) {
      return { type: 'configurable', action }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Runtime matching — used in keydown handlers
// ---------------------------------------------------------------------------

export function matchesShortcut(
  e: KeyboardEvent,
  binding: ShortcutBinding,
  isMac: boolean,
): boolean {
  if (e.key.toLowerCase() !== binding.key.toLowerCase()) return false

  const primaryMod = isMac ? e.metaKey : e.ctrlKey
  if (primaryMod !== !!binding.ctrl) return false
  if (e.shiftKey !== !!binding.shift) return false
  if (e.altKey !== !!binding.alt) return false

  // Reject when the non-primary modifier is held (Ctrl on Mac, Meta on Linux)
  const secondaryMod = isMac ? e.ctrlKey : e.metaKey
  if (secondaryMod) return false

  return true
}

// ---------------------------------------------------------------------------
// Event target guards
// ---------------------------------------------------------------------------

/**
 * True when the event target is a text-editing surface (input, textarea,
 * contentEditable) where editor shortcuts must not fire so native text
 * editing keeps working.
 */
export function isTextEditingTarget(target: EventTarget | null): boolean {
  if (!target || typeof HTMLElement === 'undefined') return false
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  )
}

/** Form controls and ARIA widgets that handle the arrow keys themselves. */
const ARROW_KEY_WIDGET_SELECTOR = [
  'select',
  '[role="separator"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[role="listbox"]',
  '[role="option"]',
  '[role="combobox"]',
  '[role="menu"]',
  '[role="menubar"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="tablist"]',
  '[role="tab"]',
  '[role="radiogroup"]',
  '[role="radio"]',
  '[role="tree"]',
  '[role="treeitem"]',
  '[role="grid"]',
  '[role="gridcell"]',
].join(', ')

/**
 * True when the event target is a text-editing surface, a form control or an
 * ARIA widget that owns the arrow keys (slider, listbox, tabs, menu, ...).
 * Seek and frame-step keys must not fire there, otherwise arrows on the
 * seek-step slider would both move the slider and seek the video.
 */
export function isArrowKeyOwningTarget(target: EventTarget | null): boolean {
  if (isTextEditingTarget(target)) return true
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false
  return target.closest(ARROW_KEY_WIDGET_SELECTOR) !== null
}

// ---------------------------------------------------------------------------
// Display formatting
// ---------------------------------------------------------------------------

const KEY_LABELS: Record<string, string> = {
  ' ': 'Space',
  'delete': 'Del',
  'backspace': '⌫',
  'escape': 'Esc',
  'arrowup': '↑',
  'arrowdown': '↓',
  'arrowleft': '←',
  'arrowright': '→',
  'enter': 'Enter',
  'tab': 'Tab',
}

export function formatBinding(binding: ShortcutBinding, isMac: boolean): string {
  const parts: string[] = []
  if (binding.ctrl) parts.push(isMac ? '⌘' : 'Ctrl')
  if (binding.shift) parts.push(isMac ? '⇧' : 'Shift')
  if (binding.alt) parts.push(isMac ? '⌥' : 'Alt')
  parts.push(KEY_LABELS[binding.key.toLowerCase()] ?? binding.key.toUpperCase())
  return parts.join(' + ')
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

export function mergeWithDefaults(partial: Partial<ShortcutsConfig>): ShortcutsConfig {
  const merged = { ...DEFAULT_SHORTCUTS }
  for (const action of SHORTCUT_ACTIONS) {
    const value = partial[action]
    if (value && typeof value === 'object' && typeof value.key === 'string') {
      merged[action] = value as ShortcutBinding
    }
  }
  return merged
}
