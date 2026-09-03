import { useState, useEffect, useCallback, useRef } from 'react'
import styles from './LaunchWindow.module.css'
import {
  useScreenRecorder,
  type CaptureFrameRate,
  type CaptureProfile,
  type CaptureResolutionPreset,
} from '../../hooks/useScreenRecorder'
import type { CameraOverlayShape } from '../../hooks/cameraOverlay'
import { useCameraDevices } from '../../hooks/useCameraDevices'
import { useMicrophoneDevices } from '../../hooks/useMicrophoneDevices'
import { useAudioLevelMeter } from '../../hooks/useAudioLevelMeter'
import { AudioLevelMeter } from '../ui/audio-level-meter'
import { Button } from '../ui/button'
import { BsRecordCircle } from 'react-icons/bs'
import { FaRegStopCircle } from 'react-icons/fa'
import { MdMonitor } from 'react-icons/md'
import { RxDragHandleDots2 } from 'react-icons/rx'
import { FaFolderMinus } from 'react-icons/fa6'
import { FiCamera, FiMinus, FiMousePointer, FiX } from 'react-icons/fi'
import {
  Columns3,
  EyeOff,
  Flag,
  Keyboard,
  Mic,
  MicOff,
  Monitor,
  MonitorOff,
  NotebookPen,
  Pause,
  Play,
  RotateCcw,
  Rows3,
  Settings2,
  Shield,
  SlidersHorizontal,
  Timer,
  Trash2,
  Volume2,
  VolumeX,
} from 'lucide-react'
import { getAvailableLocales, getLocaleName, useI18n } from '@/i18n'
import { toast } from 'sonner'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  HUD_INTERACTIVE_SELECTOR,
  type HudOrientation,
  type HudRect,
  type HudSize,
  isHudInteractiveTarget,
  measureHudWindowSize,
  nextHudOrientation,
} from '@/hooks/useHudLayout'
import { reportUserActionError } from '@/lib/userErrorFeedback'
import { loadUserPreferences, saveUserPreferences } from '@/lib/userPreferences'
import { resolveRecordingPermissionReadiness } from '@/lib/permissions/capturePermissions'

const CAMERA_SHAPE_CYCLE: CameraOverlayShape[] = ['rounded', 'square', 'circle']
// Slack the HUD window keeps around its content so outlines and popover
// shadows are not clipped by the window edge.
const HUD_WINDOW_SIDE_MARGIN = 16
const HUD_WINDOW_TOP_MARGIN = 16
const CAPTURE_PROFILE_CYCLE: CaptureProfile[] = ['balanced', 'quality', 'ultra']
const CAPTURE_FRAME_RATE_OPTIONS: CaptureFrameRate[] = [24, 30, 60, 120]
const CAPTURE_RESOLUTION_OPTIONS: CaptureResolutionPreset[] = ['auto', '1080p', '1440p', '2160p']
const RECORD_COUNTDOWN_CYCLE = [0, 3, 5, 8] as const

// Migrate old localStorage keys to "capturia.*" (one-time)
try {
  if (!window.localStorage.getItem('capturia._migrated')) {
    for (const OLD_PREFIX of ['openscreen.', 'cursorlens.']) {
      const keys = Object.keys(window.localStorage).filter((k) => k.startsWith(OLD_PREFIX))
      for (const oldKey of keys) {
        const newKey = 'capturia.' + oldKey.slice(OLD_PREFIX.length)
        if (!window.localStorage.getItem(newKey)) {
          const value = window.localStorage.getItem(oldKey)
          if (value !== null) window.localStorage.setItem(newKey, value)
        }
      }
    }
    window.localStorage.setItem('capturia._migrated', '1')
  }
} catch {
  /* no-op */
}

const STOP_SHORTCUT_STORAGE_KEY = 'capturia.stopRecordingShortcut'
const CAMERA_DEVICE_STORAGE_KEY = 'capturia.cameraDeviceId'
const MICROPHONE_ENABLED_STORAGE_KEY = 'capturia.microphoneEnabled'
const MICROPHONE_DEVICE_STORAGE_KEY = 'capturia.microphoneDeviceId'
const SYSTEM_AUDIO_ENABLED_STORAGE_KEY = 'capturia.systemAudioEnabled'
const DEFAULT_STOP_RECORDING_SHORTCUT = 'CommandOrControl+Shift+2'
/**
 * D2: shown on the flag button until main answers with the accelerator actually
 * registered. Mirrors DEFAULT_SHORTCUTS.markMoment; main owns the real binding.
 */
const DEFAULT_MARK_MOMENT_SHORTCUT = 'CommandOrControl+Alt+F'
const AUTO_HIDE_HUD_ON_RECORD_STORAGE_KEY = 'capturia.autoHideHudOnRecord'
const CAPTURE_MODE_STORAGE_KEY = 'capturia.captureMode'
const CAPTURE_FRAME_RATE_STORAGE_KEY = 'capturia.captureFrameRate'
const CAPTURE_RESOLUTION_STORAGE_KEY = 'capturia.captureResolutionPreset'
type RecordCountdownSeconds = (typeof RECORD_COUNTDOWN_CYCLE)[number]
type CaptureMode = 'standard' | 'pro'
type SelectedSourceSnapshot = {
  id?: string
  name?: string
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function readStoredString(key: string): string {
  try {
    return window.localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}

function writeStoredString(key: string, value: string): void {
  try {
    if (value) {
      window.localStorage.setItem(key, value)
    } else {
      window.localStorage.removeItem(key)
    }
  } catch {
    // no-op
  }
}

function isModifierKey(key: string): boolean {
  return key === 'Meta' || key === 'Control' || key === 'Alt' || key === 'Shift'
}

function resolveAcceleratorKey(event: KeyboardEvent): string | null {
  const key = event.key
  if (!key) return null

  if (/^[a-zA-Z]$/.test(key)) return key.toUpperCase()
  if (/^[0-9]$/.test(key)) return key
  if (/^F([1-9]|1[0-2])$/i.test(key)) return key.toUpperCase()

  if (key === ' ') return 'Space'
  if (key === 'Enter') return 'Enter'
  if (key === 'Tab') return 'Tab'
  if (key === 'Backspace') return 'Backspace'
  if (key === 'Delete') return 'Delete'
  if (key === 'ArrowUp') return 'Up'
  if (key === 'ArrowDown') return 'Down'
  if (key === 'ArrowLeft') return 'Left'
  if (key === 'ArrowRight') return 'Right'
  return null
}

function buildAcceleratorFromEvent(event: KeyboardEvent): string | null {
  if (isModifierKey(event.key)) return null
  const keyToken = resolveAcceleratorKey(event)
  if (!keyToken) return null

  const modifiers: string[] = []
  if (event.metaKey) modifiers.push('Command')
  if (event.ctrlKey) modifiers.push('Control')
  if (event.altKey) modifiers.push('Alt')
  if (event.shiftKey) modifiers.push('Shift')
  if (modifiers.length === 0) return null

  return [...modifiers, keyToken].join('+')
}

function normalizeSelectedSourceSnapshot(input: unknown): SelectedSourceSnapshot | null {
  if (!input || typeof input !== 'object') return null
  const row = input as Record<string, unknown>
  const id = typeof row.id === 'string' ? row.id : undefined
  const name = typeof row.name === 'string' ? row.name : undefined
  if (!id && !name) return null
  return { id, name }
}

function formatAccelerator(accelerator: string, isMacPlatform: boolean): string {
  if (!accelerator) return ''

  const parts = accelerator
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
  const mapped = parts.map((part) => {
    const normalized = part.toLowerCase()
    if (normalized === 'commandorcontrol') return isMacPlatform ? '⌘' : 'Ctrl'
    if (normalized === 'command') return isMacPlatform ? '⌘' : 'Cmd'
    if (normalized === 'control') return isMacPlatform ? '⌃' : 'Ctrl'
    if (normalized === 'alt' || normalized === 'option') return isMacPlatform ? '⌥' : 'Alt'
    if (normalized === 'shift') return isMacPlatform ? '⇧' : 'Shift'
    return part.length === 1 ? part.toUpperCase() : part
  })

  return isMacPlatform ? mapped.join('') : mapped.join(' + ')
}

export function LaunchWindow() {
  const { t, locale, setLocale } = useI18n()
  const [includeCamera, setIncludeCamera] = useState(() => {
    try {
      return window.localStorage.getItem('capturia.includeCamera') === '1'
    } catch {
      return false
    }
  })
  const [cameraShape, setCameraShape] = useState<CameraOverlayShape>(() => {
    try {
      const value = window.localStorage.getItem('capturia.cameraShape')
      if (value === 'rounded' || value === 'square' || value === 'circle') {
        return value
      }
    } catch {
      // no-op
    }
    return 'rounded'
  })
  const [cameraSizePercent, setCameraSizePercent] = useState<number>(() => {
    try {
      const value = Number(window.localStorage.getItem('capturia.cameraSizePercent'))
      if (Number.isFinite(value)) {
        return clamp(Math.round(value), 14, 40)
      }
    } catch {
      // no-op
    }
    return 22
  })
  // Camera picker (A12): the list is only enumerated while the overlay is on; the
  // persisted id seeds the selection and is replaced when that camera is unplugged.
  const {
    devices: cameraDevices,
    selectedDeviceId: cameraDeviceId,
    setSelectedDeviceId: setCameraDeviceId,
  } = useCameraDevices(includeCamera, readStoredString(CAMERA_DEVICE_STORAGE_KEY))
  const cameraDeviceName = cameraDevices.find((device) => device.deviceId === cameraDeviceId)?.label
  // Microphone (A13): off records without an audio track; "" = system default device.
  const [microphoneEnabled, setMicrophoneEnabled] = useState(
    () => readStoredString(MICROPHONE_ENABLED_STORAGE_KEY) !== '0',
  )
  const {
    devices: microphoneDevices,
    selectedDeviceId: microphoneDeviceId,
    setSelectedDeviceId: setMicrophoneDeviceId,
  } = useMicrophoneDevices(microphoneEnabled, readStoredString(MICROPHONE_DEVICE_STORAGE_KEY))
  const microphoneDeviceName = microphoneDevices.find(
    (device) => device.deviceId === microphoneDeviceId,
  )?.label
  const [microphonePopoverOpen, setMicrophonePopoverOpen] = useState(false)
  // System audio (what the computer plays), mixed with the mic. Off by default:
  // loopback capture is a deliberate choice, not something to surprise a user with.
  const [systemAudioEnabled, setSystemAudioEnabled] = useState(
    () => readStoredString(SYSTEM_AUDIO_ENABLED_STORAGE_KEY) === '1',
  )
  const [captureProfile, setCaptureProfile] = useState<CaptureProfile>(() => {
    try {
      const value = window.localStorage.getItem('capturia.captureProfile')
      if (value === 'balanced' || value === 'quality' || value === 'ultra') {
        return value
      }
    } catch {
      // no-op
    }
    return 'quality'
  })
  const [captureMode, setCaptureMode] = useState<CaptureMode>(() => {
    try {
      const value = window.localStorage.getItem(CAPTURE_MODE_STORAGE_KEY)
      if (value === 'pro' || value === 'standard') {
        return value
      }
    } catch {
      // no-op
    }
    return 'standard'
  })
  const [captureFrameRate, setCaptureFrameRate] = useState<CaptureFrameRate>(() => {
    try {
      const value = Number(window.localStorage.getItem(CAPTURE_FRAME_RATE_STORAGE_KEY))
      if (value === 24 || value === 30 || value === 60 || value === 120) {
        return value
      }
    } catch {
      // no-op
    }
    return 60
  })
  const [captureResolutionPreset, setCaptureResolutionPreset] = useState<CaptureResolutionPreset>(
    () => {
      try {
        const value = window.localStorage.getItem(CAPTURE_RESOLUTION_STORAGE_KEY)
        if (value === 'auto' || value === '1080p' || value === '1440p' || value === '2160p') {
          return value
        }
      } catch {
        // no-op
      }
      return 'auto'
    },
  )
  const [recordSystemCursor, setRecordSystemCursor] = useState(() => {
    try {
      const value = window.localStorage.getItem('capturia.recordSystemCursor')
      return value === null ? true : value === '1'
    } catch {
      return true
    }
  })
  const [autoHideHudOnRecord, setAutoHideHudOnRecord] = useState(() => {
    try {
      // Migration: the old default was true on Linux which persisted "1".
      // Clear that stale value so users get the new default (false).
      const migrationKey = 'capturia.autoHideHudOnRecord.v2'
      if (!window.localStorage.getItem(migrationKey)) {
        window.localStorage.removeItem(AUTO_HIDE_HUD_ON_RECORD_STORAGE_KEY)
        window.localStorage.setItem(migrationKey, '1')
      }
      const stored = window.localStorage.getItem(AUTO_HIDE_HUD_ON_RECORD_STORAGE_KEY)
      if (stored !== null) return stored === '1'
    } catch {
      // no-op
    }
    return false
  })
  const [stopRecordingShortcut, setStopRecordingShortcut] = useState(() => {
    try {
      return (
        window.localStorage.getItem(STOP_SHORTCUT_STORAGE_KEY) || DEFAULT_STOP_RECORDING_SHORTCUT
      )
    } catch {
      return DEFAULT_STOP_RECORDING_SHORTCUT
    }
  })
  // D2: the accelerator main actually registered for "flag this moment", shown
  // on the flag button. The default stands in until main answers.
  const [markMomentShortcut, setMarkMomentShortcut] = useState(DEFAULT_MARK_MOMENT_SHORTCUT)
  const [captureStopShortcut, setCaptureStopShortcut] = useState(false)
  const [stopShortcutPopoverOpen, setStopShortcutPopoverOpen] = useState(false)
  const [capturePopoverOpen, setCapturePopoverOpen] = useState(false)
  const [cameraPopoverOpen, setCameraPopoverOpen] = useState(false)
  const [isMacPlatform, setIsMacPlatform] = useState(() => {
    if (typeof navigator === 'undefined') return false
    return /Mac|iPhone|iPad|iPod/.test(navigator.platform)
  })
  // Notes window (A14): content protection does not exist on Linux, so the button
  // is hidden there rather than shipping a window that lands in the recording.
  const [isLinuxPlatform, setIsLinuxPlatform] = useState(() => {
    if (typeof navigator === 'undefined') return false
    return /Linux/.test(navigator.platform) && !/Android/.test(navigator.userAgent)
  })
  const [notesWindowOpen, setNotesWindowOpen] = useState(false)
  const [recordCountdownSeconds, setRecordCountdownSeconds] = useState<RecordCountdownSeconds>(
    () => {
      try {
        const value = Number(window.localStorage.getItem('capturia.recordCountdownSeconds'))
        if (value === 0 || value === 3 || value === 5 || value === 8) {
          return value
        }
      } catch {
        // no-op
      }
      return 0
    },
  )
  const {
    recording,
    recordingState,
    canPause,
    nativeSystemAudioSupported,
    toggleRecording,
    pauseRecording,
    resumeRecording,
    discardRecording,
    restartRecording,
    startTimeRef,
    cumulativePauseMsRef,
    pauseStartTimeRef,
  } = useScreenRecorder({
    includeCamera,
    cameraShape,
    cameraSizePercent,
    cameraDeviceId,
    cameraDeviceName,
    microphoneEnabled,
    microphoneDeviceId,
    // The hook ignores this on the macOS browser fallback path; on the native path
    // the helper answers with `canCaptureSystemAudio`, which gates the toggle below.
    systemAudioEnabled,
    captureProfile,
    captureFrameRate: captureMode === 'pro' ? captureFrameRate : undefined,
    captureResolutionPreset: captureMode === 'pro' ? captureResolutionPreset : undefined,
    recordSystemCursor,
  })
  const isTransitioning = recordingState === 'starting' || recordingState === 'stopping'
  // The browser recording path can only capture system audio on Windows (loopback)
  // and Linux (desktop audio source). On macOS it is the native helper's job, so the
  // toggle stays hidden there until the helper has reported that it can do it.
  const systemAudioToggleAvailable = !isMacPlatform || nativeSystemAudioSupported
  const [countdownRemaining, setCountdownRemaining] = useState<number | null>(null)
  const isCountingDown = countdownRemaining !== null
  const controlsLocked = recording || isTransitioning || isCountingDown
  // The meter opens the mic only while its popover is visible and no recording
  // owns the device, so the OS mic indicator does not stay on from the HUD.
  const { level: microphoneLevel } = useAudioLevelMeter({
    enabled: microphoneEnabled && microphonePopoverOpen && !controlsLocked,
    deviceId: microphoneDeviceId || undefined,
  })
  const countdownTimerRef = useRef<NodeJS.Timeout | null>(null)
  // Token of the countdown run currently shown in the overlay window. Every run
  // gets a fresh id so the overlay ignores ticks/hides from a cancelled run.
  const countdownRunIdRef = useRef(0)
  const previousRecordingRef = useRef(false)
  const selectedSourceSyncErrorAtRef = useRef(0)
  const [elapsed, setElapsed] = useState(0)

  // ---- HUD window geometry: orientation, click-through, drag, content-fit ----

  // One row (horizontal) or a stacked tray (vertical), remembered across launches.
  const [hudOrientation, setHudOrientation] = useState<HudOrientation>(
    () => loadUserPreferences().hudOrientation,
  )
  const isVerticalTray = hudOrientation === 'vertical'
  const toggleHudOrientation = useCallback(() => {
    const next = nextHudOrientation(hudOrientation)
    saveUserPreferences({ hudOrientation: next })
    setHudOrientation(next)
  }, [hudOrientation])

  // D1: keep Capturia's own windows out of the recording. The preference is
  // stored here; main owns applying OS content protection, so the stored value
  // is pushed up on mount and on every change.
  const [hideHudFromRecording, setHideHudFromRecording] = useState<boolean>(
    () => loadUserPreferences().hideHudFromRecording,
  )
  useEffect(() => {
    void window.electronAPI?.setHideHudFromRecording?.(hideHudFromRecording)
  }, [hideHudFromRecording])
  const toggleHideHudFromRecording = useCallback(() => {
    setHideHudFromRecording((current) => {
      const next = !current
      saveUserPreferences({ hideHudFromRecording: next })
      return next
    })
  }, [])

  // Boxes the user can interact with (bar + open popovers), viewport-relative.
  // Both the content-fit size and the main-process cursor poll derive from them.
  const collectInteractiveRects = useCallback((): HudRect[] => {
    const rects: HudRect[] = []
    for (const element of document.querySelectorAll<HTMLElement>(HUD_INTERACTIVE_SELECTOR)) {
      const rect = element.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        rects.push({ x: rect.left, y: rect.top, width: rect.width, height: rect.height })
      }
    }
    return rects
  }, [])

  // Click-through: while the pointer is over the transparent reserve the window
  // ignores mouse input so clicks reach the desktop underneath. `null` means the
  // state is unknown (initial, or the last request failed). Once main reports
  // the platform cannot do it (Wayland) the feature stays off for the session.
  const hudIgnoreMouseRef = useRef<boolean | null>(null)
  const clickThroughUnavailableRef = useRef(false)
  const popoverOpenRef = useRef(false)
  const isDraggingHudRef = useRef(false)
  const setHudMouseEventsEnabled = useCallback(
    (enabled: boolean) => {
      const request = window.electronAPI?.setHudOverlayIgnoreMouseEvents
      if (!request || clickThroughUnavailableRef.current) return
      const ignore = !enabled
      if (hudIgnoreMouseRef.current === ignore) return
      hudIgnoreMouseRef.current = ignore
      request(ignore, ignore ? collectInteractiveRects() : undefined)
        .then((result) => {
          if (result?.applied) return
          hudIgnoreMouseRef.current = null
          if (result?.reason === 'wayland' || result?.reason === 'no-window') {
            clickThroughUnavailableRef.current = true
          }
        })
        .catch(() => {
          hudIgnoreMouseRef.current = null
        })
    },
    [collectInteractiveRects],
  )
  /** Re-sends the boxes main polls against once they moved (window resize, popover). */
  const syncInteractiveRects = useCallback(() => {
    const request = window.electronAPI?.setHudOverlayIgnoreMouseEvents
    if (!request || hudIgnoreMouseRef.current !== true) return
    request(true, collectInteractiveRects()).catch(() => undefined)
  }, [collectInteractiveRects])

  useEffect(() => {
    if (!window.electronAPI?.setHudOverlayIgnoreMouseEvents) return
    const onPointerMove = (event: PointerEvent) => {
      if (isDraggingHudRef.current) return
      setHudMouseEventsEnabled(popoverOpenRef.current || isHudInteractiveTarget(event.target))
    }
    const onPointerLeave = () => {
      if (isDraggingHudRef.current || popoverOpenRef.current) return
      setHudMouseEventsEnabled(false)
    }
    window.addEventListener('pointermove', onPointerMove)
    document.documentElement.addEventListener('pointerleave', onPointerLeave)
    // The HUD appears under nobody's pointer: start transparent to clicks.
    setHudMouseEventsEnabled(false)
    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      document.documentElement.removeEventListener('pointerleave', onPointerLeave)
      hudIgnoreMouseRef.current = null
      void window.electronAPI?.setHudOverlayIgnoreMouseEvents?.(false)?.catch?.(() => undefined)
    }
  }, [setHudMouseEventsEnabled])

  // Content-fit: the window follows the bar (and any open popover) so the
  // transparent reserve around it stays small. Main keeps the bottom-centre
  // anchor, so measuring from the viewport's bottom-centre makes the result
  // independent of the window's current size and the loop settles at once.
  const hudBarRef = useRef<HTMLDivElement | null>(null)
  const lastHudSizeRef = useRef<HudSize | null>(null)
  const contentFitUnavailableRef = useRef(false)
  const measureFrameRef = useRef<number | null>(null)
  const measureHudSize = useCallback(() => {
    const request = window.electronAPI?.setHudOverlaySize
    // A drag moves the window frame by frame; a resize re-centring it at the
    // same time would fight that. Measure again once the drag ends.
    if (!request || contentFitUnavailableRef.current || isDraggingHudRef.current) return
    const size = measureHudWindowSize({
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      rects: collectInteractiveRects(),
      sideMargin: HUD_WINDOW_SIDE_MARGIN,
      topMargin: HUD_WINDOW_TOP_MARGIN,
    })
    const last = lastHudSizeRef.current
    if (last && last.width === size.width && last.height === size.height) return
    lastHudSizeRef.current = size
    request(size.width, size.height)
      .then((result) => {
        if (result?.applied) return
        // Refused (e.g. mid-countdown): forget it so the next change retries.
        lastHudSizeRef.current = null
        if (result?.reason === 'wayland' || result?.reason === 'no-window') {
          contentFitUnavailableRef.current = true
        }
      })
      .catch(() => {
        lastHudSizeRef.current = null
      })
  }, [collectInteractiveRects])
  const scheduleHudMeasure = useCallback(() => {
    if (measureFrameRef.current !== null) return
    measureFrameRef.current = window.requestAnimationFrame(() => {
      measureFrameRef.current = null
      measureHudSize()
      syncInteractiveRects()
    })
  }, [measureHudSize, syncInteractiveRects])

  const hudResizeObserverRef = useRef<ResizeObserver | null>(null)
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => scheduleHudMeasure())
    hudResizeObserverRef.current = observer
    if (hudBarRef.current) observer.observe(hudBarRef.current)

    // Popovers render into portals under <body>: watch them come and go so the
    // window grows around them and mouse input stays on while one is open.
    const observedPortals = new Set<Element>()
    const syncPortals = () => {
      const wrappers = document.querySelectorAll('[data-radix-popper-content-wrapper]')
      for (const wrapper of wrappers) {
        if (!observedPortals.has(wrapper)) {
          observedPortals.add(wrapper)
          observer.observe(wrapper)
        }
      }
      for (const element of observedPortals) {
        if (!element.isConnected) {
          observedPortals.delete(element)
          observer.unobserve(element)
        }
      }
      popoverOpenRef.current = wrappers.length > 0
      if (popoverOpenRef.current) setHudMouseEventsEnabled(true)
      scheduleHudMeasure()
    }
    const mutations = new MutationObserver(syncPortals)
    mutations.observe(document.body, { childList: true })
    const onWindowResize = () => scheduleHudMeasure()
    window.addEventListener('resize', onWindowResize)
    syncPortals()

    return () => {
      window.removeEventListener('resize', onWindowResize)
      mutations.disconnect()
      observer.disconnect()
      hudResizeObserverRef.current = null
      if (measureFrameRef.current !== null) {
        window.cancelAnimationFrame(measureFrameRef.current)
        measureFrameRef.current = null
      }
    }
  }, [scheduleHudMeasure, setHudMouseEventsEnabled])
  // The bar element changes between the idle bar and the compact recording bar.
  const setHudBarEl = useCallback(
    (element: HTMLDivElement | null) => {
      const observer = hudResizeObserverRef.current
      if (hudBarRef.current && observer) observer.unobserve(hudBarRef.current)
      hudBarRef.current = element
      if (element && observer) observer.observe(element)
      scheduleHudMeasure()
    },
    [scheduleHudMeasure],
  )

  // Drag: the handle moves the window through main, one batched delta per
  // frame. Where main cannot position windows (Wayland) the handle falls back
  // to the native drag region. Position memory is main's job (it watches the
  // window move), so nothing is persisted from here.
  const [nativeDragFallback, setNativeDragFallback] = useState(false)
  const dragLastPositionRef = useRef<{ x: number; y: number } | null>(null)
  const pendingDragDeltaRef = useRef({ x: 0, y: 0 })
  const dragFrameRef = useRef<number | null>(null)
  const flushHudDragMove = useCallback(() => {
    dragFrameRef.current = null
    const { x, y } = pendingDragDeltaRef.current
    pendingDragDeltaRef.current = { x: 0, y: 0 }
    if (x === 0 && y === 0) return
    window.electronAPI
      ?.moveHudOverlayBy?.(x, y)
      ?.then?.((result) => {
        if (result && !result.applied && result.reason === 'wayland') {
          setNativeDragFallback(true)
        }
      })
      ?.catch?.(() => undefined)
  }, [])
  useEffect(() => {
    return () => {
      if (dragFrameRef.current !== null) window.cancelAnimationFrame(dragFrameRef.current)
    }
  }, [])
  const handleHudDragPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (nativeDragFallback || event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    setHudMouseEventsEnabled(true)
    event.currentTarget.setPointerCapture?.(event.pointerId)
    dragLastPositionRef.current = { x: event.screenX, y: event.screenY }
    isDraggingHudRef.current = true
  }
  const handleHudDragPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const last = dragLastPositionRef.current
    if (!last) return
    pendingDragDeltaRef.current = {
      x: pendingDragDeltaRef.current.x + (event.screenX - last.x),
      y: pendingDragDeltaRef.current.y + (event.screenY - last.y),
    }
    dragLastPositionRef.current = { x: event.screenX, y: event.screenY }
    if (dragFrameRef.current === null) {
      dragFrameRef.current = window.requestAnimationFrame(flushHudDragMove)
    }
  }
  const handleHudDragPointerEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragLastPositionRef.current) return
    dragLastPositionRef.current = null
    if (dragFrameRef.current !== null) {
      window.cancelAnimationFrame(dragFrameRef.current)
      dragFrameRef.current = null
    }
    flushHudDragMove()
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    isDraggingHudRef.current = false
    scheduleHudMeasure()
  }
  const dragHandleClassName = `flex items-center justify-center shrink-0 h-7 w-6 ${styles.dragHandle} ${
    nativeDragFallback ? styles.electronDrag : styles.electronNoDrag
  }`
  const popoverSide = isVerticalTray ? 'right' : 'top'

  // Every HUD popover closes when the window loses focus. The HUD window is a
  // small bar on a mostly transparent (click-through) reserve: a click anywhere
  // else on screen never reaches this renderer as a pointerdown, so the popover's
  // own outside-click dismissal cannot fire, and once focus is gone Escape cannot
  // be delivered here either. `blur` is the one signal that crosses that boundary.
  // Registered on the window in bubble phase: element blur does not bubble, so
  // moving focus between the controls inside a popover never triggers this.
  const closePopovers = useCallback(() => {
    setMicrophonePopoverOpen(false)
    setCapturePopoverOpen(false)
    setStopShortcutPopoverOpen(false)
    setCaptureStopShortcut(false)
    setCameraPopoverOpen(false)
  }, [])
  useEffect(() => {
    window.addEventListener('blur', closePopovers)
    return () => {
      window.removeEventListener('blur', closePopovers)
    }
  }, [closePopovers])

  useEffect(() => {
    let timer: NodeJS.Timeout | null = null
    const isActive = recording || recordingState === 'paused'
    if (isActive && (startTimeRef.current ?? 0) > 0) {
      timer = setInterval(() => {
        const now = Date.now()
        const totalMs = now - (startTimeRef.current ?? now)
        let pauseMs = cumulativePauseMsRef.current ?? 0
        // Include the in-progress pause duration so the timer freezes while paused
        const pauseStart = pauseStartTimeRef.current ?? 0
        if (pauseStart > 0) {
          pauseMs += now - pauseStart
        }
        setElapsed(Math.max(0, Math.floor((totalMs - pauseMs) / 1000)))
      }, 500)
    } else {
      setElapsed(0)
    }
    return () => {
      if (timer) clearInterval(timer)
    }
  }, [recording, recordingState, startTimeRef, cumulativePauseMsRef, pauseStartTimeRef])

  const clearRecordCountdown = useCallback(() => {
    if (countdownTimerRef.current) {
      clearInterval(countdownTimerRef.current)
      countdownTimerRef.current = null
    }
    const runId = countdownRunIdRef.current
    if (runId > 0) {
      countdownRunIdRef.current = 0
      void window.electronAPI?.hideCountdownOverlay?.(runId)?.catch?.(() => undefined)
    }
    setCountdownRemaining(null)
  }, [])

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60)
      .toString()
      .padStart(2, '0')
    const s = (seconds % 60).toString().padStart(2, '0')
    return `${m}:${s}`
  }
  /**
   * D2: turn the outcome of a flagged moment into user-visible feedback. Shared
   * by the HUD button and by the `markMoment` global shortcut, which main pushes
   * back over `recording-marker-added` so both surfaces confirm identically.
   */
  const announceMarkerResult = useCallback(
    (result: RecordingMarkerOutcome | undefined) => {
      if (!result) return
      if (result.added) {
        toast.success(
          t('launch.markMomentAdded', {
            time: formatTime(Math.floor(result.timeMs / 1000)),
            count: result.count,
          }),
        )
        return
      }
      if (result.reason === 'paused') {
        toast.error(t('launch.markMomentPaused'))
        return
      }
      if (result.reason === 'limit') {
        toast.error(t('launch.markMomentLimit'))
      }
      // 'not-recording': the shortcut is global, so it fires when nothing is
      // being recorded too. Silence is the right answer there.
    },
    [t],
  )

  const flagRecordingMoment = useCallback(() => {
    void (async () => {
      try {
        announceMarkerResult(await window.electronAPI?.addRecordingMarker?.())
      } catch (error) {
        console.warn('[hud] could not flag the moment', error)
      }
    })()
  }, [announceMarkerResult])

  useEffect(() => {
    return window.electronAPI?.onRecordingMarkerAdded?.(announceMarkerResult)
  }, [announceMarkerResult])

  useEffect(() => {
    void (async () => {
      try {
        const accelerators = await window.electronAPI?.getGlobalShortcuts?.()
        if (accelerators?.markMoment) setMarkMomentShortcut(accelerators.markMoment)
      } catch {
        // Keep the default label; the binding is main's to own either way.
      }
    })()
  }, [])

  const [selectedSource, setSelectedSource] = useState(t('launch.sourceFallback'))
  const [hasSelectedSource, setHasSelectedSource] = useState(false)
  // Set when the record button opened the picker: the next `selected-source-changed`
  // event starts recording (through the countdown + permission preflight). Cleared
  // when the picker closes without a pick or fails to open.
  const recordAfterSourceSelectionRef = useRef(false)
  // Incremented by the chained-start path; the effect below consumes it once
  // `hasSelectedSource` reflects the new source, so the start never runs against
  // a stale closure.
  const [chainedStartRequest, setChainedStartRequest] = useState(0)

  const applySelectedSource = useCallback(
    (input: unknown) => {
      const source = normalizeSelectedSourceSnapshot(input)
      if (source) {
        setSelectedSource(source.name || t('launch.sourceFallback'))
        setHasSelectedSource(true)
        return
      }
      setSelectedSource(t('launch.sourceFallback'))
      setHasSelectedSource(false)
    },
    [t],
  )

  useEffect(() => {
    try {
      window.localStorage.setItem('capturia.includeCamera', includeCamera ? '1' : '0')
    } catch {
      // no-op
    }
  }, [includeCamera])

  useEffect(() => {
    try {
      window.localStorage.setItem('capturia.cameraShape', cameraShape)
    } catch {
      // no-op
    }
  }, [cameraShape])

  useEffect(() => {
    try {
      window.localStorage.setItem('capturia.cameraSizePercent', String(cameraSizePercent))
    } catch {
      // no-op
    }
  }, [cameraSizePercent])

  useEffect(() => {
    // Only persist a real choice: the hook reports "" until the list has loaded.
    if (cameraDeviceId) writeStoredString(CAMERA_DEVICE_STORAGE_KEY, cameraDeviceId)
  }, [cameraDeviceId])

  useEffect(() => {
    writeStoredString(MICROPHONE_ENABLED_STORAGE_KEY, microphoneEnabled ? '1' : '0')
  }, [microphoneEnabled])

  useEffect(() => {
    writeStoredString(MICROPHONE_DEVICE_STORAGE_KEY, microphoneDeviceId)
  }, [microphoneDeviceId])

  useEffect(() => {
    writeStoredString(SYSTEM_AUDIO_ENABLED_STORAGE_KEY, systemAudioEnabled ? '1' : '0')
  }, [systemAudioEnabled])

  useEffect(() => {
    try {
      window.localStorage.setItem('capturia.captureProfile', captureProfile)
    } catch {
      // no-op
    }
  }, [captureProfile])

  useEffect(() => {
    try {
      window.localStorage.setItem(CAPTURE_MODE_STORAGE_KEY, captureMode)
    } catch {
      // no-op
    }
  }, [captureMode])

  useEffect(() => {
    try {
      window.localStorage.setItem(CAPTURE_FRAME_RATE_STORAGE_KEY, String(captureFrameRate))
    } catch {
      // no-op
    }
  }, [captureFrameRate])

  useEffect(() => {
    try {
      window.localStorage.setItem(CAPTURE_RESOLUTION_STORAGE_KEY, captureResolutionPreset)
    } catch {
      // no-op
    }
  }, [captureResolutionPreset])

  useEffect(() => {
    try {
      window.localStorage.setItem('capturia.recordSystemCursor', recordSystemCursor ? '1' : '0')
    } catch {
      // no-op
    }
  }, [recordSystemCursor])

  useEffect(() => {
    try {
      window.localStorage.setItem(
        AUTO_HIDE_HUD_ON_RECORD_STORAGE_KEY,
        autoHideHudOnRecord ? '1' : '0',
      )
    } catch {
      // no-op
    }
  }, [autoHideHudOnRecord])

  useEffect(() => {
    try {
      window.localStorage.setItem('capturia.recordCountdownSeconds', String(recordCountdownSeconds))
    } catch {
      // no-op
    }
  }, [recordCountdownSeconds])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const platform = await window.electronAPI.getPlatform()
        if (!cancelled) {
          setIsMacPlatform(platform === 'darwin')
          setIsLinuxPlatform(platform === 'linux')
        }
      } catch {
        // ignore platform probe failures
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const applyStopRecordingShortcut = useCallback(
    async (accelerator: string, options?: { silent?: boolean }) => {
      try {
        const result = await window.electronAPI.setStopRecordingShortcut(accelerator)
        const applied = result.accelerator || DEFAULT_STOP_RECORDING_SHORTCUT
        setStopRecordingShortcut(applied)
        try {
          window.localStorage.setItem(STOP_SHORTCUT_STORAGE_KEY, applied)
        } catch {
          // no-op
        }
        if (!result.success && !options?.silent) {
          reportUserActionError({
            t,
            userMessage: result.message || t('launch.stopShortcutApplyError'),
            error: result.message || t('launch.stopShortcutApplyError'),
            context: 'launch-window.apply-stop-shortcut',
            details: { accelerator },
            dedupeKey: `launch-window.apply-stop-shortcut:${accelerator}`,
          })
        }
        return result.success
      } catch (error) {
        if (!options?.silent) {
          reportUserActionError({
            t,
            userMessage: t('launch.stopShortcutApplyError'),
            error,
            context: 'launch-window.apply-stop-shortcut',
            details: { accelerator },
            dedupeKey: `launch-window.apply-stop-shortcut:${accelerator}`,
          })
        }
        return false
      }
    },
    [t],
  )

  // Mount: main owns the registered stop shortcut (it persists it with the other
  // global shortcuts), so ask it first and mirror the answer into localStorage.
  // Only when main has nothing registered (older main, first run) is the persisted
  // HUD value pushed through as before.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      let registered = ''
      try {
        const result = await window.electronAPI?.getStopRecordingShortcut?.()
        registered = result?.accelerator || ''
      } catch {
        registered = ''
      }
      if (cancelled) return
      if (registered) {
        setStopRecordingShortcut(registered)
        writeStoredString(STOP_SHORTCUT_STORAGE_KEY, registered)
        return
      }
      void applyStopRecordingShortcut(stopRecordingShortcut, { silent: true })
    })()
    return () => {
      cancelled = true
    }
    // apply once using persisted value
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!hasSelectedSource && countdownRemaining !== null) {
      clearRecordCountdown()
    }
  }, [hasSelectedSource, countdownRemaining, clearRecordCountdown])

  useEffect(() => {
    if (controlsLocked && captureStopShortcut) {
      setCaptureStopShortcut(false)
    }
  }, [captureStopShortcut, controlsLocked])

  useEffect(() => {
    if (!captureStopShortcut) return

    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault()
      event.stopPropagation()

      if (event.key === 'Escape') {
        setCaptureStopShortcut(false)
        return
      }

      const accelerator = buildAcceleratorFromEvent(event)
      if (!accelerator) {
        return
      }

      void (async () => {
        const success = await applyStopRecordingShortcut(accelerator)
        if (success) {
          toast.success(
            t('launch.stopShortcutUpdated', {
              shortcut: formatAccelerator(accelerator, isMacPlatform),
            }),
          )
          setCaptureStopShortcut(false)
        }
      })()
    }

    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true })
    }
  }, [applyStopRecordingShortcut, captureStopShortcut, isMacPlatform, t])

  useEffect(() => {
    return () => {
      clearRecordCountdown()
    }
  }, [clearRecordCountdown])

  const cycleCameraShape = () => {
    setCameraShape((current) => {
      const index = CAMERA_SHAPE_CYCLE.indexOf(current)
      const nextIndex = index >= 0 ? (index + 1) % CAMERA_SHAPE_CYCLE.length : 0
      return CAMERA_SHAPE_CYCLE[nextIndex] ?? 'rounded'
    })
  }

  const cycleRecordCountdown = () => {
    setRecordCountdownSeconds((current) => {
      const index = RECORD_COUNTDOWN_CYCLE.indexOf(current)
      const nextIndex = index >= 0 ? (index + 1) % RECORD_COUNTDOWN_CYCLE.length : 0
      return RECORD_COUNTDOWN_CYCLE[nextIndex] ?? 3
    })
  }

  useEffect(() => {
    const checkSelectedSource = async () => {
      if (!window.electronAPI) return

      try {
        applySelectedSource(await window.electronAPI.getSelectedSource())
      } catch (error) {
        const now = Date.now()
        if (now - selectedSourceSyncErrorAtRef.current >= 10_000) {
          selectedSourceSyncErrorAtRef.current = now
          reportUserActionError({
            t,
            userMessage: t('launch.sourceStatusSyncFailed'),
            error,
            context: 'launch-window.sync-selected-source',
            dedupeKey: 'launch-window.sync-selected-source',
            dedupeMs: 8_000,
          })
        }
      }
    }

    void checkSelectedSource()

    const interval = setInterval(checkSelectedSource, 500)
    return () => clearInterval(interval)
  }, [applySelectedSource, t])

  useEffect(() => {
    const cleanupSourceChanged = window.electronAPI?.onSelectedSourceChanged?.((source) => {
      applySelectedSource(source)
      if (!recordAfterSourceSelectionRef.current) return
      recordAfterSourceSelectionRef.current = false
      setChainedStartRequest((value) => value + 1)
    })
    const cleanupSelectorClosed = window.electronAPI?.onSourceSelectorClosed?.(() => {
      recordAfterSourceSelectionRef.current = false
    })
    return () => {
      cleanupSourceChanged?.()
      cleanupSelectorClosed?.()
    }
  }, [applySelectedSource])

  const cameraShapeLabelMap: Record<CameraOverlayShape, string> = {
    rounded: t('launch.shape.rounded'),
    square: t('launch.shape.square'),
    circle: t('launch.shape.circle'),
  }
  const captureProfileLabelMap: Record<CaptureProfile, string> = {
    balanced: t('launch.captureProfile.balanced'),
    quality: t('launch.captureProfile.quality'),
    ultra: t('launch.captureProfile.ultra'),
  }
  const captureResolutionLabelMap: Record<CaptureResolutionPreset, string> = {
    auto: t('launch.captureResolution.auto'),
    '1080p': t('launch.captureResolution.1080p'),
    '1440p': t('launch.captureResolution.1440p'),
    '2160p': t('launch.captureResolution.2160p'),
  }
  const captureSummaryLabel =
    captureMode === 'pro'
      ? t('launch.captureProButtonLabel', {
          resolution: captureResolutionLabelMap[captureResolutionPreset],
          fps: captureFrameRate,
        })
      : captureProfileLabelMap[captureProfile]

  /** Resolves to `true` only when the picker window was actually opened. */
  const openSourceSelector = useCallback(async (): Promise<boolean> => {
    if (!window.electronAPI) return false

    try {
      const permissionSnapshot = await window.electronAPI.getCapturePermissionSnapshot()
      const readiness = resolveRecordingPermissionReadiness(permissionSnapshot)
      if (!readiness.ready) {
        await window.electronAPI.openPermissionChecker()
        toast.error(t('launch.permission.missingRequiredHint'))
        return false
      }
      await window.electronAPI.openSourceSelector()
      return true
    } catch (error) {
      reportUserActionError({
        t,
        userMessage: t('launch.openSourceSelectorFailed'),
        error,
        context: 'launch-window.open-source-selector',
        dedupeKey: 'launch-window.open-source-selector',
      })
      return false
    }
  }, [t])

  const openPermissionChecker = useCallback(() => {
    if (!window.electronAPI) return
    void (async () => {
      try {
        await window.electronAPI.openPermissionChecker()
      } catch (error) {
        reportUserActionError({
          t,
          userMessage: t('launch.permission.openSettingsFailed'),
          error,
          context: 'launch-window.open-permission-checker',
          dedupeKey: 'launch-window.open-permission-checker',
        })
      }
    })()
  }, [t])

  useEffect(() => {
    const subscribe = window.electronAPI?.onNotesWindowClosed
    if (!subscribe) return
    return subscribe(() => setNotesWindowOpen(false))
  }, [])

  const openNotes = useCallback(() => {
    if (!window.electronAPI?.openNotes) return
    void (async () => {
      try {
        const result = await window.electronAPI.openNotes()
        if (result?.success) {
          setNotesWindowOpen(true)
          return
        }
        toast.error(result?.message || t('launch.openNotesFailed'))
      } catch (error) {
        reportUserActionError({
          t,
          userMessage: t('launch.openNotesFailed'),
          error,
          context: 'launch-window.open-notes',
          dedupeKey: 'launch-window.open-notes',
        })
      }
    })()
  }, [t])

  const beginRecordCountdown = useCallback(() => {
    if (!hasSelectedSource || recording || isTransitioning || countdownRemaining !== null) {
      return
    }

    if (recordCountdownSeconds === 0) {
      toggleRecording()
      return
    }

    let remaining = recordCountdownSeconds
    setCountdownRemaining(remaining)

    // The overlay window mirrors the HUD countdown; the token lets a late IPC
    // round-trip from this run be ignored once it is cancelled or finished.
    const runId = Date.now()
    countdownRunIdRef.current = runId
    void window.electronAPI?.showCountdownOverlay?.(remaining, runId)?.catch?.((error: unknown) => {
      console.warn('Failed to show the countdown overlay.', error)
    })

    countdownTimerRef.current = setInterval(() => {
      remaining -= 1
      if (remaining <= 0) {
        clearRecordCountdown()
        toggleRecording()
        return
      }
      setCountdownRemaining(remaining)
      if (countdownRunIdRef.current === runId) {
        void window.electronAPI
          ?.setCountdownOverlayValue?.(remaining, runId)
          ?.catch?.(() => undefined)
      }
    }, 1000)
  }, [
    countdownRemaining,
    hasSelectedSource,
    isTransitioning,
    recordCountdownSeconds,
    recording,
    clearRecordCountdown,
    toggleRecording,
  ])

  /** Permission preflight, then the user's countdown (which starts the recording). */
  const requestRecordStart = useCallback(async () => {
    try {
      const permissionSnapshot = await window.electronAPI.getCapturePermissionSnapshot()
      const readiness = resolveRecordingPermissionReadiness(permissionSnapshot)
      if (!readiness.ready) {
        await window.electronAPI.openPermissionChecker()
        toast.error(t('launch.permission.missingRequiredHint'))
        return
      }
      beginRecordCountdown()
    } catch (error) {
      reportUserActionError({
        t,
        userMessage: t('launch.permission.refreshFailed'),
        error,
        context: 'launch-window.record-permission-preflight',
        dedupeKey: 'launch-window.record-permission-preflight',
      })
    }
  }, [beginRecordCountdown, t])

  // Chained start: the record button opened the picker and a source was chosen.
  // Runs once `hasSelectedSource` is true so the countdown guard sees the source.
  useEffect(() => {
    if (chainedStartRequest === 0 || !hasSelectedSource) return
    setChainedStartRequest(0)
    void requestRecordStart()
  }, [chainedStartRequest, hasSelectedSource, requestRecordStart])

  const handleRecordButtonClick = useCallback(() => {
    if (recording || recordingState === 'recording') {
      clearRecordCountdown()
      toggleRecording()
      return
    }

    if (isTransitioning) return

    if (!hasSelectedSource) {
      recordAfterSourceSelectionRef.current = true
      void openSourceSelector().then((opened) => {
        if (!opened) {
          recordAfterSourceSelectionRef.current = false
        }
      })
      return
    }

    if (countdownRemaining !== null) {
      clearRecordCountdown()
      return
    }

    void requestRecordStart()
  }, [
    countdownRemaining,
    hasSelectedSource,
    isTransitioning,
    openSourceSelector,
    recording,
    recordingState,
    requestRecordStart,
    clearRecordCountdown,
    toggleRecording,
  ])

  const openVideoFile = async () => {
    try {
      const result = await window.electronAPI.openVideoFilePicker(locale)

      if (result.cancelled) {
        return
      }

      if (!result.success || !result.path) {
        reportUserActionError({
          t,
          userMessage: t('launch.openVideoFailed'),
          error: result,
          context: 'launch-window.open-video-file-picker',
          dedupeKey: 'launch-window.open-video-file-picker',
        })
        return
      }

      await window.electronAPI.setCurrentVideoPath(result.path)
      await window.electronAPI.switchToEditor()
    } catch (error) {
      reportUserActionError({
        t,
        userMessage: t('launch.openVideoFailed'),
        error,
        context: 'launch-window.open-video-file',
        dedupeKey: 'launch-window.open-video-file',
      })
    }
  }

  // IPC events for hide/close
  const sendHudOverlayHide = useCallback(() => {
    if (window.electronAPI && window.electronAPI.hudOverlayHide) {
      window.electronAPI.hudOverlayHide()
    }
  }, [])
  const sendHudOverlayClose = () => {
    if (window.electronAPI && window.electronAPI.hudOverlayClose) {
      window.electronAPI.hudOverlayClose()
    }
  }

  useEffect(() => {
    const justStartedRecording = recording && !previousRecordingRef.current
    const justStoppedRecording = !recording && previousRecordingRef.current
    previousRecordingRef.current = recording
    if (justStartedRecording) {
      // Re-enforce always-on-top
      window.electronAPI?.hudOverlayResize?.()
      // Hide the HUD so it doesn't appear in the screen capture.
      // On Linux there is no OS-level way to exclude a window from capture,
      // so we hide it entirely.  The user stops recording via the keyboard
      // shortcut (displayed in the idle HUD).
      if (autoHideHudOnRecord) {
        window.electronAPI?.hudOverlayHide?.()
      }
    }
    if (justStoppedRecording) {
      window.electronAPI?.hudOverlayRestore?.()
    }
  }, [recording, autoHideHudOnRecord])

  const displayedStopShortcut = formatAccelerator(stopRecordingShortcut, isMacPlatform)
  const displayedMarkMomentShortcut = formatAccelerator(markMomentShortcut, isMacPlatform)

  const resetStopRecordingShortcut = () => {
    void (async () => {
      const success = await applyStopRecordingShortcut(DEFAULT_STOP_RECORDING_SHORTCUT)
      if (success) {
        toast.success(
          t('launch.stopShortcutResetOk', {
            shortcut: formatAccelerator(DEFAULT_STOP_RECORDING_SHORTCUT, isMacPlatform),
          }),
        )
        setCaptureStopShortcut(false)
      }
    })()
  }

  // Compact recording bar: shown during active recording or paused state
  const showCompactBar = recording || recordingState === 'paused'

  if (showCompactBar) {
    return (
      <div className="w-full h-full flex items-end justify-center pb-2 bg-transparent overflow-hidden pointer-events-none">
        <div
          ref={setHudBarEl}
          data-hud-interactive="true"
          data-testid="hud-compact-bar"
          className={`inline-flex items-center gap-2 px-3 py-1.5 pointer-events-auto ${nativeDragFallback ? styles.electronDrag : ''}`}
          style={{
            borderRadius: 12,
            background: 'linear-gradient(135deg, rgba(30,30,40,0.94) 0%, rgba(20,20,30,0.88) 100%)',
            backdropFilter: 'blur(32px) saturate(180%)',
            WebkitBackdropFilter: 'blur(32px) saturate(180%)',
            boxShadow: '0 4px 24px 0 rgba(0,0,0,0.32), 0 1px 3px 0 rgba(0,0,0,0.14) inset',
            border: '1px solid rgba(80,80,120,0.22)',
            minHeight: 40,
          }}
        >
          {/* Left: Red dot + elapsed time + Stop */}
          <div className={`flex items-center gap-1.5 shrink-0 ${styles.electronNoDrag}`}>
            <div
              className={`w-2 h-2 rounded-full ${recordingState === 'paused' ? 'bg-amber-400' : 'bg-red-500 animate-pulse'}`}
            />
            <span className="text-white text-[11px] font-medium tabular-nums">
              {formatTime(elapsed)}
            </span>
            <button
              onClick={toggleRecording}
              className="p-1 rounded hover:bg-white/10 transition-colors"
              title={t('launch.stopRecording')}
            >
              <FaRegStopCircle size={14} className="text-red-400" />
            </button>
          </div>

          {/* Center: Drag handle */}
          <div
            className={dragHandleClassName}
            title={t('launch.dragHandle')}
            data-testid="hud-drag-handle"
            onPointerDown={handleHudDragPointerDown}
            onPointerMove={handleHudDragPointerMove}
            onPointerUp={handleHudDragPointerEnd}
            onPointerCancel={handleHudDragPointerEnd}
          >
            <RxDragHandleDots2 size={16} className="text-white/30" />
          </div>

          {/* Right: Pause/Resume + Discard. Pause is hidden while the native macOS
              recorder owns the session: it cannot pause yet, so the button would lie. */}
          <div className={`flex items-center gap-1 shrink-0 ${styles.electronNoDrag}`}>
            <button
              onClick={flagRecordingMoment}
              disabled={recordingState === 'paused'}
              className="p-1 rounded hover:bg-white/10 transition-colors disabled:opacity-40"
              title={t('launch.markMomentHint', { shortcut: displayedMarkMomentShortcut })}
              data-testid="launch-mark-moment-button"
            >
              <Flag size={13} className="text-white/60 hover:text-cyan-300" />
            </button>
            {canPause && (
              <button
                onClick={recordingState === 'paused' ? resumeRecording : pauseRecording}
                className="p-1 rounded hover:bg-white/10 transition-colors"
                title={
                  recordingState === 'paused'
                    ? t('launch.resumeRecording')
                    : t('launch.pauseRecording')
                }
              >
                {recordingState === 'paused' ? (
                  <Play size={14} className="text-green-400" />
                ) : (
                  <Pause size={14} className="text-amber-300" />
                )}
              </button>
            )}
            <button
              onClick={restartRecording}
              disabled={isTransitioning}
              className="p-1 rounded hover:bg-white/10 transition-colors disabled:opacity-40"
              title={t('launch.restartRecording')}
              data-testid="launch-restart-button"
            >
              <RotateCcw size={13} className="text-white/50 hover:text-amber-300" />
            </button>
            <button
              onClick={discardRecording}
              className="p-1 rounded hover:bg-white/10 transition-colors"
              title={t('launch.discardRecording')}
            >
              <Trash2 size={13} className="text-white/50 hover:text-red-400" />
            </button>
          </div>
        </div>
      </div>
    )
  }

  const windowButtons = (
    <div className={`flex items-center gap-1 shrink-0 ${styles.electronNoDrag}`}>
      <Button
        variant="link"
        size="icon"
        className={`h-7 w-7 ${styles.electronNoDrag} hudOverlayButton`}
        title={t('launch.hideHud')}
        onClick={sendHudOverlayHide}
      >
        <FiMinus size={18} style={{ color: '#fff', opacity: 0.7 }} />
      </Button>

      <Button
        variant="link"
        size="icon"
        className={`h-7 w-7 ${styles.electronNoDrag} hudOverlayButton`}
        title={t('launch.closeApp')}
        onClick={sendHudOverlayClose}
      >
        <FiX size={18} style={{ color: '#fff', opacity: 0.7 }} />
      </Button>
    </div>
  )

  return (
    <div className="w-full h-full flex items-end justify-center pb-2 bg-transparent overflow-hidden pointer-events-none">
      <div
        ref={setHudBarEl}
        data-hud-interactive="true"
        data-hud-orientation={hudOrientation}
        data-testid="hud-bar"
        className={`pointer-events-auto ${
          isVerticalTray
            ? `flex flex-col items-stretch gap-1 px-2 py-2 w-[236px] max-h-[calc(100vh-16px)] overflow-y-auto ${styles.trayVertical}`
            : 'inline-flex max-w-[calc(100%-12px)] items-center gap-2 px-3 py-2'
        } ${nativeDragFallback ? styles.electronDrag : ''}`}
        style={{
          borderRadius: 16,
          background: 'linear-gradient(135deg, rgba(30,30,40,0.92) 0%, rgba(20,20,30,0.85) 100%)',
          backdropFilter: 'blur(32px) saturate(180%)',
          WebkitBackdropFilter: 'blur(32px) saturate(180%)',
          boxShadow: '0 4px 24px 0 rgba(0,0,0,0.28), 0 1px 3px 0 rgba(0,0,0,0.14) inset',
          border: '1px solid rgba(80,80,120,0.22)',
          minHeight: 44,
        }}
      >
        <div className={`flex items-center gap-1 shrink-0 ${styles.trayHeader}`}>
          <div
            className={dragHandleClassName}
            title={t('launch.dragHandle')}
            data-testid="hud-drag-handle"
            onPointerDown={handleHudDragPointerDown}
            onPointerMove={handleHudDragPointerMove}
            onPointerUp={handleHudDragPointerEnd}
            onPointerCancel={handleHudDragPointerEnd}
          >
            <RxDragHandleDots2 size={18} className="text-white/40" />
          </div>
          <Button
            variant="link"
            size="icon"
            className={`h-7 w-7 ${styles.electronNoDrag} hudOverlayButton`}
            title={isVerticalTray ? t('launch.tray.useHorizontal') : t('launch.tray.useVertical')}
            aria-label={
              isVerticalTray ? t('launch.tray.useHorizontal') : t('launch.tray.useVertical')
            }
            aria-pressed={isVerticalTray}
            onClick={toggleHudOrientation}
            data-testid="launch-tray-layout-button"
          >
            {isVerticalTray ? (
              <Rows3 size={15} style={{ color: '#fff', opacity: 0.7 }} />
            ) : (
              <Columns3 size={15} style={{ color: '#fff', opacity: 0.7 }} />
            )}
          </Button>
          {isVerticalTray ? <div className="ml-auto">{windowButtons}</div> : null}
        </div>

        <Button
          variant="link"
          size="sm"
          className={`gap-1 min-w-[120px] w-fit max-w-[280px] shrink-0 overflow-hidden text-white bg-transparent hover:bg-transparent px-1 justify-start text-xs ${styles.electronNoDrag}`}
          onClick={() => void openSourceSelector()}
          disabled={controlsLocked}
          title={selectedSource}
          data-testid="launch-source-button"
        >
          <MdMonitor size={14} className="text-white" />
          <span className="truncate max-w-[240px] block pointer-events-none">{selectedSource}</span>
        </Button>

        <Button
          variant="link"
          size="sm"
          onClick={handleRecordButtonClick}
          disabled={isTransitioning}
          data-testid="launch-record-button"
          className={`relative z-20 gap-1 shrink-0 min-w-[96px] text-white bg-white/5 hover:bg-white/10 border border-white/10 rounded-md px-2 text-center text-xs ${styles.electronNoDrag}`}
          title={
            countdownRemaining !== null
              ? t('launch.countdownCancelHint', { seconds: countdownRemaining })
              : hasSelectedSource
                ? selectedSource
                : t('launch.recordSourceRequired')
          }
        >
          {countdownRemaining !== null ? (
            <>
              <BsRecordCircle size={14} className="text-amber-300 animate-pulse" />
              <span className="text-amber-300">
                {t('launch.countdownStarting', { seconds: countdownRemaining })}
              </span>
            </>
          ) : recordingState === 'starting' ? (
            <>
              <BsRecordCircle size={14} className="text-amber-300 animate-pulse" />
              <span className="text-amber-300">{t('common.loading')}</span>
            </>
          ) : recordingState === 'stopping' ? (
            <>
              <FaRegStopCircle size={14} className="text-amber-300 animate-pulse" />
              <span className="text-amber-300">{t('common.processing')}</span>
            </>
          ) : (
            <>
              <BsRecordCircle
                size={14}
                className={hasSelectedSource ? 'text-white' : 'text-white/50'}
              />
              <span className={hasSelectedSource ? 'text-white' : 'text-white/50'}>
                {t('launch.record')}
              </span>
            </>
          )}
        </Button>

        <Button
          variant="link"
          size="sm"
          className={`gap-1 shrink-0 min-w-[92px] text-white bg-transparent hover:bg-transparent px-1 text-center text-xs ${styles.electronNoDrag}`}
          onClick={() => setIncludeCamera((value) => !value)}
          disabled={controlsLocked}
          title={includeCamera ? t('launch.cameraEnabled') : t('launch.cameraEnable')}
        >
          <FiCamera size={14} className={includeCamera ? 'text-cyan-300' : 'text-white/50'} />
          <span className={includeCamera ? 'text-cyan-300' : 'text-white/50'}>
            {t('launch.camera')}
          </span>
        </Button>

        <div className={`flex items-center shrink-0 ${styles.electronNoDrag}`}>
          <Button
            variant="link"
            size="sm"
            className={`gap-1 shrink-0 min-w-[64px] text-white bg-transparent hover:bg-transparent px-1 text-center text-xs ${styles.electronNoDrag}`}
            onClick={() => setMicrophoneEnabled((value) => !value)}
            disabled={controlsLocked}
            title={
              microphoneEnabled
                ? t('launch.audio.disableMicrophone')
                : t('launch.audio.enableMicrophone')
            }
            aria-pressed={microphoneEnabled}
            data-testid="launch-microphone-toggle"
          >
            {microphoneEnabled ? (
              <Mic size={14} className="text-cyan-300" />
            ) : (
              <MicOff size={14} className="text-white/50" />
            )}
            <span className={microphoneEnabled ? 'text-cyan-300' : 'text-white/50'}>
              {t('launch.microphone')}
            </span>
          </Button>
          {microphoneEnabled ? (
            <Popover open={microphonePopoverOpen} onOpenChange={setMicrophonePopoverOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="link"
                  size="icon"
                  className={`h-7 w-6 shrink-0 text-cyan-200 bg-transparent hover:bg-cyan-400/10 ${styles.electronNoDrag}`}
                  disabled={controlsLocked}
                  title={microphoneDeviceName ?? t('launch.audio.defaultMicrophone')}
                  data-testid="launch-microphone-settings"
                >
                  <Settings2 size={12} />
                </Button>
              </PopoverTrigger>
              <PopoverContent
                side="top"
                sideOffset={8}
                align="center"
                collisionPadding={12}
                className={`w-[230px] bg-[#11131a] border border-cyan-300/20 text-cyan-100 p-2 ${styles.electronNoDrag}`}
              >
                <div className="text-[11px] mb-2">{t('launch.audio.settings')}</div>
                <label className="flex items-center gap-2 text-[11px] mb-2">
                  <span className="shrink-0">{t('launch.audio.microphoneDevice')}</span>
                  <select
                    value={microphoneDeviceId}
                    onChange={(event) => setMicrophoneDeviceId(event.target.value)}
                    disabled={controlsLocked}
                    className={`h-6 min-w-0 flex-1 rounded bg-white/10 text-[10px] text-cyan-100 border border-cyan-300/20 px-1 ${styles.electronNoDrag}`}
                    data-testid="launch-microphone-device-select"
                  >
                    <option value="">{t('launch.audio.defaultMicrophone')}</option>
                    {microphoneDevices.map((device) => (
                      <option key={device.deviceId} value={device.deviceId}>
                        {device.label}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="flex items-center gap-2 text-[11px]">
                  <span className="shrink-0">{t('launch.audio.level')}</span>
                  <AudioLevelMeter level={microphoneLevel} className="flex-1" />
                </div>
              </PopoverContent>
            </Popover>
          ) : null}
        </div>

        {systemAudioToggleAvailable ? (
          <Button
            variant="link"
            size="sm"
            className={`gap-1 shrink-0 min-w-[96px] text-white bg-transparent hover:bg-transparent px-1 text-center text-xs ${styles.electronNoDrag}`}
            onClick={() => setSystemAudioEnabled((value) => !value)}
            disabled={controlsLocked}
            title={
              systemAudioEnabled
                ? t('launch.audio.disableSystemAudio')
                : t('launch.audio.enableSystemAudio')
            }
            aria-pressed={systemAudioEnabled}
            data-testid="launch-system-audio-toggle"
          >
            {systemAudioEnabled ? (
              <Volume2 size={14} className="text-cyan-300" />
            ) : (
              <VolumeX size={14} className="text-white/50" />
            )}
            <span className={systemAudioEnabled ? 'text-cyan-300' : 'text-white/50'}>
              {t('launch.systemAudio')}
            </span>
          </Button>
        ) : null}

        <Button
          variant="link"
          size="sm"
          className={`gap-1 shrink-0 min-w-[88px] text-white bg-transparent hover:bg-transparent px-1 text-center text-xs ${styles.electronNoDrag}`}
          onClick={openPermissionChecker}
          disabled={controlsLocked}
          title={t('launch.permissions')}
        >
          <Shield size={13} className="text-white/80" />
          <span className="text-white/90">{t('launch.permissions')}</span>
        </Button>

        {!isLinuxPlatform ? (
          <Button
            variant="link"
            size="sm"
            className={`gap-1 shrink-0 min-w-[70px] text-white bg-transparent hover:bg-transparent px-1 text-center text-xs ${styles.electronNoDrag}`}
            onClick={openNotes}
            title={t('launch.tooltips.openNotes')}
            data-testid="launch-notes-button"
          >
            <NotebookPen
              size={13}
              className={notesWindowOpen ? 'text-cyan-300' : 'text-white/80'}
            />
            <span className={notesWindowOpen ? 'text-cyan-300' : 'text-white/90'}>
              {t('launch.notes')}
            </span>
          </Button>
        ) : null}

        <Popover open={capturePopoverOpen} onOpenChange={setCapturePopoverOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="link"
              size="sm"
              className={`gap-1 shrink-0 min-w-[118px] text-white bg-transparent hover:bg-transparent px-1 text-center text-xs ${styles.electronNoDrag}`}
              disabled={controlsLocked}
              data-testid="launch-capture-settings-button"
              title={
                captureMode === 'pro'
                  ? t('launch.captureProLabel', {
                      resolution: captureResolutionLabelMap[captureResolutionPreset],
                      fps: captureFrameRate,
                    })
                  : t('launch.captureProfileLabel', {
                      profile: captureProfileLabelMap[captureProfile],
                    })
              }
            >
              <SlidersHorizontal size={13} className="text-white/80" />
              <span className="text-white/90">{captureSummaryLabel}</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent
            side={popoverSide}
            sideOffset={8}
            align="center"
            collisionPadding={12}
            className={`w-[360px] bg-[#11131a] border border-white/20 text-white p-2.5 ${styles.electronNoDrag}`}
            data-testid="launch-capture-settings-popover"
          >
            <div className="flex items-center justify-between gap-2 mb-2">
              <span className="text-[11px] text-white/80">{t('launch.captureSettingsTitle')}</span>
              <div className="flex items-center gap-1 rounded-md border border-white/10 bg-white/[0.04] p-0.5">
                <Button
                  variant="link"
                  size="sm"
                  className={`h-6 px-2 text-[10px] rounded ${captureMode === 'standard' ? 'bg-white/15 text-white' : 'text-white/65 hover:bg-white/10'} ${styles.electronNoDrag}`}
                  onClick={() => setCaptureMode('standard')}
                  disabled={controlsLocked}
                >
                  {t('launch.captureMode.standard')}
                </Button>
                <Button
                  variant="link"
                  size="sm"
                  className={`h-6 px-2 text-[10px] rounded ${captureMode === 'pro' ? 'bg-cyan-400/20 text-cyan-100' : 'text-white/65 hover:bg-white/10'} ${styles.electronNoDrag}`}
                  onClick={() => setCaptureMode('pro')}
                  disabled={controlsLocked}
                >
                  {t('launch.captureMode.pro')}
                </Button>
              </div>
            </div>

            {captureMode === 'standard' ? (
              <>
                <div className="text-[10px] text-white/55 mb-2">
                  {t('launch.captureProfileHint')}
                </div>
                <div className="grid grid-cols-3 gap-1.5">
                  {CAPTURE_PROFILE_CYCLE.map((profile) => {
                    const active = profile === captureProfile
                    return (
                      <Button
                        key={profile}
                        variant="link"
                        size="sm"
                        className={`h-7 px-2 text-[11px] rounded border ${active ? 'border-cyan-300/35 bg-cyan-400/20 text-cyan-100' : 'border-white/10 bg-white/5 text-white/80 hover:bg-white/10'} ${styles.electronNoDrag}`}
                        onClick={() => setCaptureProfile(profile)}
                        disabled={controlsLocked}
                      >
                        {captureProfileLabelMap[profile]}
                      </Button>
                    )
                  })}
                </div>
              </>
            ) : (
              <>
                <div className="text-[10px] text-white/55 mb-2">{t('launch.captureProHint')}</div>
                <div className="space-y-2">
                  <div>
                    <div className="text-[10px] text-white/65 mb-1">
                      {t('launch.captureResolution')}
                    </div>
                    <div className="grid grid-cols-2 gap-1.5">
                      {CAPTURE_RESOLUTION_OPTIONS.map((preset) => {
                        const active = preset === captureResolutionPreset
                        return (
                          <Button
                            key={preset}
                            variant="link"
                            size="sm"
                            className={`h-7 px-2 text-[11px] rounded border ${active ? 'border-cyan-300/35 bg-cyan-400/20 text-cyan-100' : 'border-white/10 bg-white/5 text-white/80 hover:bg-white/10'} ${styles.electronNoDrag}`}
                            onClick={() => setCaptureResolutionPreset(preset)}
                            disabled={controlsLocked}
                          >
                            {captureResolutionLabelMap[preset]}
                          </Button>
                        )
                      })}
                    </div>
                  </div>

                  <div>
                    <div className="text-[10px] text-white/65 mb-1">
                      {t('launch.captureFrameRate')}
                    </div>
                    <div className="grid grid-cols-4 gap-1.5">
                      {CAPTURE_FRAME_RATE_OPTIONS.map((fps) => {
                        const active = fps === captureFrameRate
                        return (
                          <Button
                            key={fps}
                            variant="link"
                            size="sm"
                            className={`h-7 px-2 text-[11px] rounded border ${active ? 'border-cyan-300/35 bg-cyan-400/20 text-cyan-100' : 'border-white/10 bg-white/5 text-white/80 hover:bg-white/10'} ${styles.electronNoDrag}`}
                            onClick={() => setCaptureFrameRate(fps)}
                            disabled={controlsLocked}
                          >
                            {fps}fps
                          </Button>
                        )
                      })}
                    </div>
                  </div>
                </div>
              </>
            )}
          </PopoverContent>
        </Popover>

        <Button
          variant="link"
          size="sm"
          className={`gap-1 shrink-0 min-w-[80px] text-white bg-transparent hover:bg-transparent px-1 text-center text-xs ${styles.electronNoDrag}`}
          onClick={cycleRecordCountdown}
          disabled={controlsLocked}
          title={
            recordCountdownSeconds === 0
              ? t('launch.countdownNone')
              : t('launch.countdownLabel', { seconds: recordCountdownSeconds })
          }
        >
          <Timer size={13} className="text-white/80" />
          <span className="text-white/90">
            {recordCountdownSeconds === 0
              ? t('launch.countdownNone')
              : `${recordCountdownSeconds}s`}
          </span>
        </Button>

        <Button
          variant="link"
          size="sm"
          className={`gap-1 shrink-0 min-w-[90px] text-white bg-transparent hover:bg-transparent px-1 text-center text-xs ${styles.electronNoDrag}`}
          onClick={() => setAutoHideHudOnRecord((value) => !value)}
          disabled={controlsLocked}
          title={
            autoHideHudOnRecord
              ? t('launch.autoHideHudOnRecordOn')
              : t('launch.autoHideHudOnRecordOff')
          }
        >
          <EyeOff size={13} className={autoHideHudOnRecord ? 'text-cyan-300' : 'text-white/60'} />
          <span className={autoHideHudOnRecord ? 'text-cyan-300' : 'text-white/80'}>
            {t('launch.autoHideHudOnRecord')}
          </span>
        </Button>

        <Button
          variant="link"
          size="sm"
          className={`gap-1 shrink-0 min-w-[104px] text-white bg-transparent hover:bg-transparent px-1 text-center text-xs ${styles.electronNoDrag}`}
          onClick={toggleHideHudFromRecording}
          disabled={controlsLocked}
          aria-pressed={hideHudFromRecording}
          data-testid="launch-hide-hud-from-recording"
          title={`${
            hideHudFromRecording
              ? t('launch.hideHudFromRecordingOn')
              : t('launch.hideHudFromRecordingOff')
          } ${t('launch.hideHudFromRecordingCaveat')}`}
        >
          {hideHudFromRecording ? (
            <MonitorOff size={13} className="text-cyan-300" />
          ) : (
            <Monitor size={13} className="text-white/60" />
          )}
          <span className={hideHudFromRecording ? 'text-cyan-300' : 'text-white/80'}>
            {t('launch.hideHudFromRecording')}
          </span>
        </Button>

        <Popover
          open={stopShortcutPopoverOpen}
          onOpenChange={(open) => {
            setStopShortcutPopoverOpen(open)
            if (!open) {
              setCaptureStopShortcut(false)
            }
          }}
        >
          <PopoverTrigger asChild>
            <Button
              variant="link"
              size="sm"
              className={`gap-1 shrink-0 min-w-[100px] text-white bg-transparent hover:bg-transparent px-1 text-center text-xs ${styles.electronNoDrag}`}
              disabled={controlsLocked}
              title={t('launch.stopShortcutLabel', { shortcut: displayedStopShortcut })}
              data-testid="launch-stop-shortcut-button"
            >
              <Keyboard size={13} className="text-white/80" />
              <span className="text-white/90">{displayedStopShortcut}</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent
            side={popoverSide}
            sideOffset={8}
            align="center"
            collisionPadding={12}
            className={`w-[250px] bg-[#11131a] border border-white/20 text-white p-2.5 ${styles.electronNoDrag}`}
            data-testid="launch-stop-shortcut-popover"
          >
            <div className="text-[11px] text-white/80 mb-2">
              {t('launch.stopShortcutConfigTitle')}
            </div>
            <div className="rounded-md border border-white/10 bg-white/5 px-2 py-1.5 text-xs mb-2">
              {captureStopShortcut
                ? t('launch.stopShortcutListening')
                : t('launch.stopShortcutCurrent', { shortcut: displayedStopShortcut })}
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="link"
                size="sm"
                className={`h-7 px-2 text-xs border border-white/15 rounded-md bg-white/5 hover:bg-white/10 ${styles.electronNoDrag}`}
                onClick={() => setCaptureStopShortcut((value) => !value)}
                disabled={controlsLocked}
              >
                {captureStopShortcut ? t('common.cancel') : t('launch.stopShortcutSet')}
              </Button>
              <Button
                variant="link"
                size="sm"
                className={`h-7 px-2 text-xs border border-white/15 rounded-md bg-white/5 hover:bg-white/10 ${styles.electronNoDrag}`}
                onClick={resetStopRecordingShortcut}
                disabled={controlsLocked}
              >
                <RotateCcw size={12} className="mr-1" />
                {t('launch.stopShortcutReset')}
              </Button>
            </div>
            <div className="text-[10px] text-white/50 mt-2">{t('launch.stopShortcutHint')}</div>
          </PopoverContent>
        </Popover>

        <Button
          variant="link"
          size="sm"
          className={`gap-1 shrink-0 min-w-[110px] text-white bg-transparent hover:bg-transparent px-1 text-center text-xs ${styles.electronNoDrag}`}
          onClick={() => setRecordSystemCursor((value) => !value)}
          disabled={controlsLocked}
          title={
            recordSystemCursor ? t('launch.systemCursorShown') : t('launch.systemCursorHidden')
          }
        >
          <FiMousePointer
            size={13}
            className={recordSystemCursor ? 'text-white/85' : 'text-[#34B27B]'}
          />
          <span className={recordSystemCursor ? 'text-white/85' : 'text-[#34B27B]'}>
            {recordSystemCursor ? t('launch.systemCursorOn') : t('launch.systemCursorOff')}
          </span>
        </Button>

        {includeCamera ? (
          <Popover open={cameraPopoverOpen} onOpenChange={setCameraPopoverOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="link"
                size="sm"
                className={`gap-1 shrink-0 min-w-[70px] text-cyan-200 bg-cyan-400/10 hover:bg-cyan-400/20 border border-cyan-300/20 px-1 text-xs ${styles.electronNoDrag}`}
                title={t('launch.cameraShapeLabel', { shape: cameraShapeLabelMap[cameraShape] })}
                data-testid="launch-camera-shape-button"
              >
                <SlidersHorizontal size={13} />
                <span>{t('launch.shape')}</span>
              </Button>
            </PopoverTrigger>
            <PopoverContent
              side={popoverSide}
              sideOffset={8}
              align="center"
              collisionPadding={12}
              className={`w-[210px] bg-[#11131a] border border-cyan-300/20 text-cyan-100 p-2 ${styles.electronNoDrag}`}
              data-testid="launch-camera-shape-popover"
            >
              <div className="flex items-center justify-between text-[11px] mb-2">
                <span>{t('launch.shape')}</span>
                <span className={styles.cameraConfigBadge}>{cameraShapeLabelMap[cameraShape]}</span>
              </div>
              <label className="flex items-center gap-2 text-[11px] mb-2">
                <span className="shrink-0">{t('launch.cameraDevice')}</span>
                <select
                  value={cameraDeviceId}
                  onChange={(event) => setCameraDeviceId(event.target.value)}
                  disabled={controlsLocked || cameraDevices.length === 0}
                  className={`h-6 min-w-0 flex-1 rounded bg-white/10 text-[10px] text-cyan-100 border border-cyan-300/20 px-1 ${styles.electronNoDrag}`}
                  title={cameraDeviceName ?? t('launch.webcam.defaultCamera')}
                  data-testid="launch-camera-device-select"
                >
                  {cameraDevices.length === 0 ? (
                    <option value="">{t('launch.webcam.noneFound')}</option>
                  ) : (
                    cameraDevices.map((device) => (
                      <option key={device.deviceId} value={device.deviceId}>
                        {device.label}
                      </option>
                    ))
                  )}
                </select>
              </label>
              <div className="flex items-center gap-2">
                <Button
                  variant="link"
                  size="sm"
                  className={`text-cyan-200 bg-transparent hover:bg-cyan-200/10 px-2 h-7 text-sm ${styles.electronNoDrag}`}
                  onClick={cycleCameraShape}
                  disabled={controlsLocked}
                >
                  {cameraShapeLabelMap[cameraShape]}
                </Button>
                <div className="ml-auto flex items-center gap-1">
                  <Button
                    variant="link"
                    size="sm"
                    className={`text-cyan-200 bg-transparent hover:bg-cyan-200/10 px-1 h-7 text-xs ${styles.electronNoDrag}`}
                    onClick={() => setCameraSizePercent((value) => clamp(value - 2, 14, 40))}
                    disabled={controlsLocked}
                    title={t('launch.sizeDecrease')}
                  >
                    -
                  </Button>
                  <span className={styles.cameraSizeReadout}>{cameraSizePercent}%</span>
                  <Button
                    variant="link"
                    size="sm"
                    className={`text-cyan-200 bg-transparent hover:bg-cyan-200/10 px-1 h-7 text-xs ${styles.electronNoDrag}`}
                    onClick={() => setCameraSizePercent((value) => clamp(value + 2, 14, 40))}
                    disabled={controlsLocked}
                    title={t('launch.sizeIncrease')}
                  >
                    +
                  </Button>
                </div>
              </div>
            </PopoverContent>
          </Popover>
        ) : null}

        <Button
          variant="link"
          size="sm"
          onClick={openVideoFile}
          className={`gap-1 shrink-0 min-w-[72px] text-white bg-transparent hover:bg-transparent px-0 text-right text-xs ${styles.electronNoDrag} ${styles.folderButton}`}
          disabled={controlsLocked}
        >
          <FaFolderMinus size={14} className="text-white" />
          <span className={styles.folderText}>{t('launch.open')}</span>
        </Button>

        <select
          value={locale}
          onChange={(event) => setLocale(event.target.value)}
          className={`h-6 w-[92px] shrink-0 rounded bg-white/10 text-[10px] text-white border border-white/20 px-1.5 ${styles.electronNoDrag}`}
          title={t('common.language')}
        >
          {getAvailableLocales().map((option) => (
            <option key={option} value={option}>
              {getLocaleName(option)}
            </option>
          ))}
        </select>

        {isVerticalTray ? null : windowButtons}
      </div>
    </div>
  )
}
