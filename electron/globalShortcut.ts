// OS-level (global) shortcuts: "open Capturia" and "stop recording".
//
// Both global actions share one registry, one persistence file
// (`shortcuts.json`, the same file the editor's ShortcutsConfigDialog writes)
// and one accelerator conversion. The Electron `globalShortcut` API is injected
// (`GlobalShortcutRegistry`) so the registration logic runs under vitest.
//
// Rules:
// - register the NEW accelerator before unregistering the old one, so a failure
//   leaves the previous binding working;
// - a failure is reported to the caller (`{ ok: false, error }`), never thrown;
// - the two actions may not share an accelerator.

import fs from 'node:fs/promises'
import path from 'node:path'
import { DEFAULT_SHORTCUTS, type ShortcutBinding } from '../src/lib/shortcuts'

export type GlobalShortcutAction = 'openApp' | 'stopRecording'

export const GLOBAL_SHORTCUT_ACTIONS: readonly GlobalShortcutAction[] = ['openApp', 'stopRecording']

/** Same file `get-shortcuts` / `save-shortcuts` in ipc/handlers.ts read and write. */
export const SHORTCUTS_FILE_NAME = 'shortcuts.json'

export interface GlobalShortcutRegistry {
  register: (accelerator: string, callback: () => void) => boolean
  unregister: (accelerator: string) => void
  unregisterAll: () => void
  /** Optional: Electron's `isRegistered`; used for the conflict pre-check when available. */
  isRegistered?: (accelerator: string) => boolean
}

export type GlobalShortcutError = 'empty' | 'conflict' | 'unavailable'

export interface GlobalShortcutResult {
  ok: boolean
  /** Accelerator now bound to the action (the previous one when `ok` is false). */
  accelerator: string
  error?: GlobalShortcutError
}

// Maps KeyboardEvent.key values to Electron accelerator key names.
const KEY_TO_ACCELERATOR: Record<string, string> = {
  ' ': 'Space',
  '+': 'Plus',
  '-': 'numsub',
  '*': 'nummult',
  '/': 'numdiv',
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
  escape: 'Escape',
  enter: 'Return',
  backspace: 'Backspace',
  delete: 'Delete',
  tab: 'Tab',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  insert: 'Insert',
}

const ACCELERATOR_TO_KEY: Record<string, string> = Object.fromEntries(
  Object.entries(KEY_TO_ACCELERATOR).map(([key, accelerator]) => [accelerator.toLowerCase(), key]),
)

/** `{ key: 'o', ctrl, shift }` -> `CommandOrControl+Shift+O`. */
export function bindingToAccelerator(binding: ShortcutBinding): string {
  const parts: string[] = []
  if (binding.ctrl) parts.push('CommandOrControl')
  if (binding.shift) parts.push('Shift')
  if (binding.alt) parts.push('Alt')

  const keyLower = binding.key.toLowerCase()
  const isSingleCharOrFKey = keyLower.length === 1 || /^f\d{1,2}$/.test(keyLower)
  const acceleratorKey =
    KEY_TO_ACCELERATOR[keyLower] ?? (isSingleCharOrFKey ? keyLower.toUpperCase() : binding.key)
  parts.push(acceleratorKey)

  return parts.join('+')
}

/**
 * Inverse of `bindingToAccelerator` for the raw accelerator strings the HUD
 * still sends (`Command+Shift+2`, `Control+Alt+R`). Command/Control/Cmd/Ctrl
 * all map to the platform-neutral `ctrl` flag. Returns null for an empty or
 * modifier-only string.
 */
export function acceleratorToBinding(accelerator: string): ShortcutBinding | null {
  const parts = accelerator
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
  if (parts.length === 0) return null

  const binding: ShortcutBinding = { key: '' }
  for (const part of parts) {
    const lower = part.toLowerCase()
    switch (lower) {
      case 'commandorcontrol':
      case 'cmdorctrl':
      case 'command':
      case 'cmd':
      case 'control':
      case 'ctrl':
      case 'super':
      case 'meta':
        binding.ctrl = true
        break
      case 'shift':
        binding.shift = true
        break
      case 'alt':
      case 'option':
      case 'altgr':
        binding.alt = true
        break
      default:
        binding.key = ACCELERATOR_TO_KEY[lower] ?? (part.length === 1 ? lower : lower)
    }
  }
  if (!binding.key) return null
  return binding
}

/** Global accelerators without a modifier would swallow a plain key system-wide. */
export function isGlobalBindingAllowed(binding: ShortcutBinding): boolean {
  return Boolean(binding.ctrl || binding.alt) && binding.key.trim().length > 0
}

export const DEFAULT_GLOBAL_BINDINGS: Record<GlobalShortcutAction, ShortcutBinding> = {
  openApp: DEFAULT_SHORTCUTS.openApp,
  stopRecording: DEFAULT_SHORTCUTS.stopRecording,
}

type Handlers = Record<GlobalShortcutAction, () => void>

export class GlobalShortcutManager {
  private readonly current = new Map<GlobalShortcutAction, string>()

  constructor(
    private readonly registry: GlobalShortcutRegistry,
    private readonly handlers: Handlers,
  ) {}

  getAccelerator(action: GlobalShortcutAction): string | null {
    return this.current.get(action) ?? null
  }

  /** Register `binding` (or a raw accelerator) for `action`, keeping the old one on failure. */
  register(action: GlobalShortcutAction, binding: ShortcutBinding | string): GlobalShortcutResult {
    const previous = this.current.get(action) ?? ''
    const accelerator = typeof binding === 'string' ? binding.trim() : bindingToAccelerator(binding)
    if (!accelerator) {
      return { ok: false, accelerator: previous, error: 'empty' }
    }
    if (accelerator === previous) {
      return { ok: true, accelerator }
    }

    for (const [otherAction, otherAccelerator] of this.current) {
      if (otherAction !== action && otherAccelerator === accelerator) {
        return { ok: false, accelerator: previous, error: 'conflict' }
      }
    }

    // Register the new shortcut before unregistering the old, so a failure
    // leaves the old binding intact.
    let registered = false
    try {
      registered = this.registry.register(accelerator, () => this.handlers[action]())
    } catch (error) {
      console.warn(`[global-shortcut] register threw for ${accelerator}:`, error)
      registered = false
    }
    if (!registered) {
      console.warn(`[global-shortcut] failed to register ${action}: ${accelerator}`)
      return { ok: false, accelerator: previous, error: 'unavailable' }
    }

    if (previous) {
      try {
        this.registry.unregister(previous)
      } catch {
        // ignore unregister errors
      }
    }
    this.current.set(action, accelerator)
    console.log(`[global-shortcut] ${action} = ${accelerator}`)
    return { ok: true, accelerator }
  }

  /** Register every action from `bindings`, falling back to the default binding when a custom one fails. */
  registerAll(bindings: Partial<Record<GlobalShortcutAction, ShortcutBinding>>): void {
    for (const action of GLOBAL_SHORTCUT_ACTIONS) {
      const binding = bindings[action] ?? DEFAULT_GLOBAL_BINDINGS[action]
      const result = this.register(action, binding)
      if (!result.ok && bindings[action]) {
        this.register(action, DEFAULT_GLOBAL_BINDINGS[action])
      }
    }
  }

  unregisterAll(): void {
    this.registry.unregisterAll()
    this.current.clear()
  }
}

function isBinding(value: unknown): value is ShortcutBinding {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    typeof (value as ShortcutBinding).key === 'string'
  )
}

/** Read the global bindings stored in `shortcuts.json` (missing/invalid entries are skipped). */
export async function readStoredGlobalBindings(
  shortcutsFile: string,
): Promise<Partial<Record<GlobalShortcutAction, ShortcutBinding>>> {
  try {
    const data = await fs.readFile(shortcutsFile, 'utf-8')
    const parsed = JSON.parse(data) as Record<string, unknown>
    const bindings: Partial<Record<GlobalShortcutAction, ShortcutBinding>> = {}
    for (const action of GLOBAL_SHORTCUT_ACTIONS) {
      const value = parsed?.[action]
      if (isBinding(value)) bindings[action] = value
    }
    return bindings
  } catch {
    return {}
  }
}

/** Merge one global binding into `shortcuts.json` (used by the HUD's legacy raw-accelerator path). */
export async function persistStoredGlobalBinding(
  shortcutsFile: string,
  action: GlobalShortcutAction,
  binding: ShortcutBinding,
): Promise<void> {
  let existing: Record<string, unknown> = {}
  try {
    existing = JSON.parse(await fs.readFile(shortcutsFile, 'utf-8')) as Record<string, unknown>
    if (!existing || typeof existing !== 'object') existing = {}
  } catch {
    existing = {}
  }
  existing[action] = binding
  await fs.mkdir(path.dirname(shortcutsFile), { recursive: true })
  await fs.writeFile(shortcutsFile, JSON.stringify(existing, null, 2), 'utf-8')
}
