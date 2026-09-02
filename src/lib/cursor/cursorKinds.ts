/**
 * Cursor kinds a recorded sample can carry. Mirrors upstream OpenScreen's
 * `NativeCursorType` set (v1.7 `src/native/contracts.ts`) so sidecars stay
 * interchangeable. Dependency-free: shared by the Electron main process (the
 * tracker + sidecar sanitiser) and the renderer (composer + editor).
 */
export const CURSOR_KINDS = [
  'arrow',
  'text',
  'pointer',
  'crosshair',
  'open-hand',
  'closed-hand',
  'resize-ew',
  'resize-ns',
  'resize-nesw',
  'resize-nwse',
  'move',
  'not-allowed',
  'wait',
  'app-starting',
  'help',
  'up-arrow',
] as const

export type CursorKind = (typeof CURSOR_KINDS)[number]

const CURSOR_KIND_SET: ReadonlySet<string> = new Set(CURSOR_KINDS)

/**
 * Legacy names written by older Capturia sidecars / helpers. `ibeam` was the
 * only non-arrow kind before the widened set.
 */
const LEGACY_CURSOR_KIND_ALIASES: Readonly<Record<string, CursorKind>> = {
  ibeam: 'text',
  'i-beam': 'text',
  hand: 'pointer',
  'pointing-hand': 'pointer',
  grab: 'open-hand',
  grabbing: 'closed-hand',
  'col-resize': 'resize-ew',
  'row-resize': 'resize-ns',
  'ew-resize': 'resize-ew',
  'ns-resize': 'resize-ns',
  'nesw-resize': 'resize-nesw',
  'nwse-resize': 'resize-nwse',
  busy: 'wait',
  progress: 'app-starting',
}

export function isCursorKind(value: unknown): value is CursorKind {
  return typeof value === 'string' && CURSOR_KIND_SET.has(value)
}

/**
 * Coerce any persisted / parsed value into a known kind. Unknown or missing
 * values become `arrow` so an old sidecar (or a helper that does not report a
 * kind) still renders.
 */
export function normalizeCursorKind(value: unknown): CursorKind {
  if (typeof value !== 'string') return 'arrow'
  const normalized = value.trim().toLowerCase()
  if (CURSOR_KIND_SET.has(normalized)) return normalized as CursorKind
  return LEGACY_CURSOR_KIND_ALIASES[normalized] ?? 'arrow'
}
