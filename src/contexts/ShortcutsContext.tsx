import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import {
  DEFAULT_SHORTCUTS,
  GLOBAL_SHORTCUT_ACTIONS,
  type GlobalShortcutAction,
  mergeWithDefaults,
  STOP_RECORDING_ACCELERATOR_STORAGE_KEY,
  type ShortcutsConfig,
} from '@/lib/shortcuts'
import { isMac as getIsMac } from '@/utils/platformUtils'

/** Outcome of `persistShortcuts`: which step failed, so the dialog can keep the draft open. */
export type PersistShortcutsResult =
  | { ok: true }
  | { ok: false; reason: 'registration'; action: GlobalShortcutAction; error?: string }
  | { ok: false; reason: 'save'; error?: string }

interface ShortcutsContextValue {
  shortcuts: ShortcutsConfig
  isMac: boolean
  setShortcuts: (config: ShortcutsConfig) => void
  /**
   * Register the global (OS-level) bindings with the main process first, then
   * write shortcuts.json. Returns `{ ok: false }` instead of throwing when a
   * global accelerator cannot be registered (another app owns it) so the
   * previous binding stays active and the caller can surface the failure.
   */
  persistShortcuts: (config?: ShortcutsConfig) => Promise<PersistShortcutsResult>
  isConfigOpen: boolean
  openConfig: () => void
  closeConfig: () => void
}

const ShortcutsContext = createContext<ShortcutsContextValue | null>(null)

export function useShortcuts(): ShortcutsContextValue {
  const ctx = useContext(ShortcutsContext)
  if (!ctx) throw new Error('useShortcuts must be used within <ShortcutsProvider>')
  return ctx
}

/** Keep the HUD's localStorage mirror of the stop-recording accelerator in sync (see shortcuts.ts). */
function mirrorStopRecordingAccelerator(accelerator: string): void {
  if (!accelerator) return
  try {
    window.localStorage.setItem(STOP_RECORDING_ACCELERATOR_STORAGE_KEY, accelerator)
  } catch {
    // localStorage may be unavailable
  }
}

export function ShortcutsProvider({ children }: { children: ReactNode }) {
  const [shortcuts, setShortcuts] = useState<ShortcutsConfig>(DEFAULT_SHORTCUTS)
  const [isMac, setIsMac] = useState(false)
  const [isConfigOpen, setIsConfigOpen] = useState(false)

  useEffect(() => {
    getIsMac()
      .then(setIsMac)
      .catch(() => {})

    window.electronAPI
      .getShortcuts?.()
      .then((saved) => {
        if (saved) {
          setShortcuts(mergeWithDefaults(saved as Partial<ShortcutsConfig>))
        }
      })
      .catch(() => {})
  }, [])

  const persistShortcuts = useCallback(
    async (config?: ShortcutsConfig): Promise<PersistShortcutsResult> => {
      const next = config ?? shortcuts

      // Global bindings go through main first: a refused accelerator must not
      // end up in shortcuts.json, or the next launch would silently lose it.
      if (window.electronAPI.updateGlobalShortcut) {
        for (const action of GLOBAL_SHORTCUT_ACTIONS) {
          try {
            const result = await window.electronAPI.updateGlobalShortcut(action, next[action])
            if (!result.ok) {
              return { ok: false, reason: 'registration', action, error: result.error }
            }
            if (action === 'stopRecording') mirrorStopRecordingAccelerator(result.accelerator)
          } catch (error) {
            return { ok: false, reason: 'registration', action, error: String(error) }
          }
        }
      }

      try {
        const saved = await window.electronAPI.saveShortcuts?.(next)
        if (saved && saved.success === false) {
          return { ok: false, reason: 'save', error: saved.error }
        }
      } catch (error) {
        return { ok: false, reason: 'save', error: String(error) }
      }
      return { ok: true }
    },
    [shortcuts],
  )

  const openConfig = useCallback(() => setIsConfigOpen(true), [])
  const closeConfig = useCallback(() => setIsConfigOpen(false), [])

  const value = useMemo<ShortcutsContextValue>(
    () => ({
      shortcuts,
      isMac,
      setShortcuts,
      persistShortcuts,
      isConfigOpen,
      openConfig,
      closeConfig,
    }),
    [shortcuts, isMac, persistShortcuts, isConfigOpen, openConfig, closeConfig],
  )

  return <ShortcutsContext.Provider value={value}>{children}</ShortcutsContext.Provider>
}
