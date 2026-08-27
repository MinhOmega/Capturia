// Configurable keyboard shortcuts — types, defaults, matching, formatting, conflict detection.

export const SHORTCUT_ACTIONS = [
  'addZoom',
  'addAnnotation',
  'addKeyframe',
  'toggleScissors',
  'deleteSelected',
  'playPause',
  'speedUp',
  'speedDown',
  'copySelected',
  'paste',
] as const;

export type ShortcutAction = (typeof SHORTCUT_ACTIONS)[number];

export interface ShortcutBinding {
  key: string;
  /** Maps to Cmd on macOS, Ctrl on Windows/Linux */
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
}

export type ShortcutsConfig = Record<ShortcutAction, ShortcutBinding>;

export interface FixedShortcut {
  labelKey: string;
  display: string;
  bindings: ShortcutBinding[];
}

export type ShortcutConflict =
  | { type: 'configurable'; action: ShortcutAction }
  | { type: 'fixed'; labelKey: string };

// ---------------------------------------------------------------------------
// Labels — maps each action to an i18n key so the UI can call t(labelKey)
// ---------------------------------------------------------------------------

export const SHORTCUT_LABEL_KEYS: Record<ShortcutAction, string> = {
  addZoom: 'shortcuts.addZoom',
  addAnnotation: 'shortcuts.addAnnotation',
  addKeyframe: 'shortcuts.addKeyframe',
  toggleScissors: 'shortcuts.toggleScissors',
  deleteSelected: 'shortcuts.deleteSelected',
  playPause: 'shortcuts.playPause',
  speedUp: 'shortcuts.speedUp',
  speedDown: 'shortcuts.speedDown',
  copySelected: 'shortcuts.copySelected',
  paste: 'shortcuts.paste',
};

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_SHORTCUTS: ShortcutsConfig = {
  addZoom: { key: 'z' },
  addAnnotation: { key: 'a' },
  addKeyframe: { key: 'f' },
  toggleScissors: { key: 's' },
  deleteSelected: { key: 'd', ctrl: true },
  playPause: { key: ' ' },
  speedUp: { key: ']' },
  speedDown: { key: '[' },
  copySelected: { key: 'c', ctrl: true },
  paste: { key: 'v', ctrl: true },
};

// ---------------------------------------------------------------------------
// Fixed (non-configurable) shortcuts — listed in the help panel only
// ---------------------------------------------------------------------------

export const FIXED_SHORTCUTS: FixedShortcut[] = [
  { labelKey: 'shortcuts.seekForward', display: '→', bindings: [{ key: 'arrowright' }] },
  { labelKey: 'shortcuts.seekBackward', display: '←', bindings: [{ key: 'arrowleft' }] },
  { labelKey: 'shortcuts.seekFine', display: 'Shift + ←/→', bindings: [] },
  { labelKey: 'shortcuts.zoomIn', display: '=', bindings: [{ key: '=' }] },
  { labelKey: 'shortcuts.zoomOut', display: '-', bindings: [{ key: '-' }] },
  { labelKey: 'shortcuts.fullscreen', display: 'F11', bindings: [{ key: 'f11' }] },
  { labelKey: 'shortcuts.undo', display: 'Ctrl+Z', bindings: [{ key: 'z', ctrl: true }] },
  { labelKey: 'shortcuts.redo', display: 'Ctrl+Shift+Z', bindings: [{ key: 'z', ctrl: true, shift: true }] },
  { labelKey: 'shortcuts.panTimeline', display: 'Shift+Ctrl+Scroll', bindings: [] },
  { labelKey: 'shortcuts.zoomTimeline', display: 'Ctrl+Scroll', bindings: [] },
];

// ---------------------------------------------------------------------------
// Comparison helpers
// ---------------------------------------------------------------------------

export function bindingsEqual(a: ShortcutBinding, b: ShortcutBinding): boolean {
  return (
    a.key.toLowerCase() === b.key.toLowerCase() &&
    !!a.ctrl === !!b.ctrl &&
    !!a.shift === !!b.shift &&
    !!a.alt === !!b.alt
  );
}

export function findConflict(
  binding: ShortcutBinding,
  forAction: ShortcutAction,
  config: ShortcutsConfig,
): ShortcutConflict | null {
  // Check against fixed shortcuts first
  for (const fixed of FIXED_SHORTCUTS) {
    if (fixed.bindings.some((b) => bindingsEqual(b, binding))) {
      return { type: 'fixed', labelKey: fixed.labelKey };
    }
  }
  // Check against other configurable shortcuts
  for (const action of SHORTCUT_ACTIONS) {
    if (action !== forAction && bindingsEqual(config[action], binding)) {
      return { type: 'configurable', action };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Runtime matching — used in keydown handlers
// ---------------------------------------------------------------------------

export function matchesShortcut(
  e: KeyboardEvent,
  binding: ShortcutBinding,
  isMac: boolean,
): boolean {
  if (e.key.toLowerCase() !== binding.key.toLowerCase()) return false;

  const primaryMod = isMac ? e.metaKey : e.ctrlKey;
  if (primaryMod !== !!binding.ctrl) return false;
  if (e.shiftKey !== !!binding.shift) return false;
  if (e.altKey !== !!binding.alt) return false;

  // Reject when the non-primary modifier is held (Ctrl on Mac, Meta on Linux)
  const secondaryMod = isMac ? e.ctrlKey : e.metaKey;
  if (secondaryMod) return false;

  return true;
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
  if (!target || typeof HTMLElement === 'undefined') return false;
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
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
};

export function formatBinding(binding: ShortcutBinding, isMac: boolean): string {
  const parts: string[] = [];
  if (binding.ctrl) parts.push(isMac ? '⌘' : 'Ctrl');
  if (binding.shift) parts.push(isMac ? '⇧' : 'Shift');
  if (binding.alt) parts.push(isMac ? '⌥' : 'Alt');
  parts.push(KEY_LABELS[binding.key.toLowerCase()] ?? binding.key.toUpperCase());
  return parts.join(' + ');
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

export function mergeWithDefaults(partial: Partial<ShortcutsConfig>): ShortcutsConfig {
  const merged = { ...DEFAULT_SHORTCUTS };
  for (const action of SHORTCUT_ACTIONS) {
    const value = partial[action];
    if (value && typeof value === 'object' && typeof value.key === 'string') {
      merged[action] = value as ShortcutBinding;
    }
  }
  return merged;
}
