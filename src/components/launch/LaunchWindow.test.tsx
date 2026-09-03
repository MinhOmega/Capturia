// @vitest-environment jsdom
//
// Record-button flow of the launch HUD (ported from upstream v1.7.0
// LaunchWindow.test.tsx, adapted to Capturia's recorder hook shape, countdown
// and permission preflight). The recorder hook is mocked; `window.electronAPI`
// is stubbed with an all-granted permission snapshot so the preflight passes.
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CapturePermissionSnapshot } from '@/lib/permissions/capturePermissions'
import type { RecordingPhase } from '../../hooks/recordingPhase'
import { LaunchWindow } from './LaunchWindow'

type SelectedSourceChangedListener = Parameters<Window['electronAPI']['onSelectedSourceChanged']>[0]

// Records every observer so a test can fire a content change by hand.
const resizeObservers: Array<{ callback: () => void; targets: Set<Element> }> = []
class StubResizeObserver {
  private readonly entry: { callback: () => void; targets: Set<Element> }
  constructor(callback: () => void) {
    this.entry = { callback, targets: new Set() }
    resizeObservers.push(this.entry)
  }
  observe(target: Element) {
    this.entry.targets.add(target)
  }
  unobserve(target: Element) {
    this.entry.targets.delete(target)
  }
  disconnect() {
    this.entry.targets.clear()
  }
}

function fireResizeObservers() {
  act(() => {
    for (const entry of resizeObservers) entry.callback()
  })
}

/** jsdom has no layout: give the HUD bar a box so measurement has something to fit. */
function stubBarRect(
  element: Element,
  rect: { left: number; top: number; width: number; height: number },
) {
  element.getBoundingClientRect = () =>
    ({
      ...rect,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      x: rect.left,
      y: rect.top,
      toJSON: () => undefined,
    }) as DOMRect
}

async function flushAnimationFrames() {
  await act(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    })
  })
}

const recorderState = vi.hoisted(() => ({
  value: {
    recording: false,
    recordingState: 'idle' as RecordingPhase,
    canPause: false,
    nativeSystemAudioSupported: false,
    toggleRecording: vi.fn(),
    pauseRecording: vi.fn(),
    resumeRecording: vi.fn(),
    discardRecording: vi.fn(),
    restartRecording: vi.fn(),
    startTimeRef: { current: 0 },
    cumulativePauseMsRef: { current: 0 },
    pauseStartTimeRef: { current: 0 },
  },
}))

vi.mock('../../hooks/useScreenRecorder', () => ({
  useScreenRecorder: () => recorderState.value,
}))

// Real English messages through the real loader, so assertions use the shipped
// strings instead of a parallel translation table.
vi.mock('@/i18n', async () => {
  const loader = await vi.importActual<typeof import('@/i18n/loader')>('@/i18n/loader')
  // Stable `t`: components key effects on it (e.g. SourceSelector's fetch).
  const t = (qualifiedKey: string, vars?: Record<string, string | number>) => {
    const [namespace, ...rest] = qualifiedKey.split('.')
    return loader.translate('en', namespace as never, rest.join('.'), vars)
  }
  const setLocale = vi.fn()
  return {
    getAvailableLocales: () => ['en'],
    getLocaleName: () => 'English',
    useI18n: () => ({ locale: 'en', setLocale, t }),
  }
})

const allGrantedSnapshot: CapturePermissionSnapshot = {
  platform: 'darwin',
  checkedAtMs: 0,
  canOpenSystemSettings: true,
  items: [
    { key: 'screen', status: 'granted', requiredForRecording: true, canOpenSettings: true },
    { key: 'microphone', status: 'granted', requiredForRecording: false, canOpenSettings: true },
    { key: 'camera', status: 'granted', requiredForRecording: false, canOpenSettings: true },
  ],
}

const displayOneSource: ProcessedDesktopSource = {
  id: 'screen:1:0',
  name: 'Display 1',
  display_id: '1',
  thumbnail: null,
  appIcon: null,
}

let selectedSourceChangedListeners: SelectedSourceChangedListener[] = []
let sourceSelectorClosedListeners: Array<() => void> = []
// Mirrors main's `selectedSource`: the 500 ms poll must agree with the event.
let mainSelectedSource: ProcessedDesktopSource | null = null

function stubElectronAPI() {
  window.electronAPI = {
    ...window.electronAPI,
    getPlatform: vi.fn(async () => 'darwin'),
    getSelectedSource: vi.fn(async () => mainSelectedSource),
    getCapturePermissionSnapshot: vi.fn(async () => allGrantedSnapshot),
    openPermissionChecker: vi.fn(async () => ({ success: true })),
    openSourceSelector: vi.fn(async () => undefined),
    setStopRecordingShortcut: vi.fn(async (accelerator: string) => ({
      success: true,
      accelerator,
    })),
    hudOverlayHide: vi.fn(),
    hudOverlayClose: vi.fn(),
    hudOverlayResize: vi.fn(),
    hudOverlayRestore: vi.fn(),
    setHudOverlayIgnoreMouseEvents: vi.fn(async () => ({ applied: true })),
    moveHudOverlayBy: vi.fn(async () => ({ applied: true })),
    setHudOverlaySize: vi.fn(async () => ({ applied: true })),
    onSelectedSourceChanged: vi.fn((callback: SelectedSourceChangedListener) => {
      selectedSourceChangedListeners.push(callback)
      return () => {
        selectedSourceChangedListeners = selectedSourceChangedListeners.filter(
          (listener) => listener !== callback,
        )
      }
    }),
    onSourceSelectorClosed: vi.fn((callback: () => void) => {
      sourceSelectorClosedListeners.push(callback)
      return () => {
        sourceSelectorClosedListeners = sourceSelectorClosedListeners.filter(
          (listener) => listener !== callback,
        )
      }
    }),
  } as typeof window.electronAPI
}

async function waitForSourceSelectionSubscription() {
  await waitFor(() => {
    expect(selectedSourceChangedListeners.length).toBeGreaterThan(0)
  })
}

function emitSelectedSourceChanged(source: ProcessedDesktopSource) {
  mainSelectedSource = source
  act(() => {
    for (const listener of selectedSourceChangedListeners) listener(source)
  })
}

function emitSourceSelectorClosed() {
  act(() => {
    for (const listener of sourceSelectorClosedListeners) listener()
  })
}

describe('LaunchWindow record button', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', StubResizeObserver)
    resizeObservers.length = 0
    window.localStorage.clear()
    recorderState.value.toggleRecording.mockClear()
    selectedSourceChangedListeners = []
    sourceSelectorClosedListeners = []
    mainSelectedSource = null
    stubElectronAPI()
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('opens the source selector instead of disabling the primary action when no source is selected', async () => {
    render(<LaunchWindow />)

    const recordButton = await screen.findByTestId('launch-record-button')

    expect(recordButton).toBeEnabled()
    expect(recordButton).toHaveAttribute('title', 'Please select a source before recording.')

    fireEvent.click(recordButton)

    await waitFor(() => {
      expect(window.electronAPI.openSourceSelector).toHaveBeenCalledTimes(1)
    })
    // The permission preflight runs before the picker opens.
    expect(window.electronAPI.getCapturePermissionSnapshot).toHaveBeenCalled()
    expect(recorderState.value.toggleRecording).not.toHaveBeenCalled()
  })

  it('records immediately after source selection when the record button opened the picker', async () => {
    render(<LaunchWindow />)
    await waitForSourceSelectionSubscription()

    fireEvent.click(await screen.findByTestId('launch-record-button'))
    await waitFor(() => {
      expect(window.electronAPI.openSourceSelector).toHaveBeenCalledTimes(1)
    })
    emitSelectedSourceChanged(displayOneSource)

    await waitFor(() => {
      expect(recorderState.value.toggleRecording).toHaveBeenCalledTimes(1)
    })
    expect(screen.getByTestId('launch-record-button')).toHaveAttribute('title', 'Display 1')
  })

  it('does not record after manual source selection', async () => {
    render(<LaunchWindow />)
    await waitForSourceSelectionSubscription()

    emitSelectedSourceChanged(displayOneSource)

    await waitFor(() => {
      expect(screen.getByTestId('launch-record-button')).toHaveAttribute('title', 'Display 1')
    })
    expect(recorderState.value.toggleRecording).not.toHaveBeenCalled()
  })

  it('clears record-after-selection intent when the source picker closes without a selection', async () => {
    render(<LaunchWindow />)
    await waitForSourceSelectionSubscription()

    fireEvent.click(await screen.findByTestId('launch-record-button'))
    await waitFor(() => {
      expect(window.electronAPI.openSourceSelector).toHaveBeenCalledTimes(1)
    })
    emitSourceSelectorClosed()
    emitSelectedSourceChanged(displayOneSource)

    await waitFor(() => {
      expect(screen.getByTestId('launch-record-button')).toHaveAttribute('title', 'Display 1')
    })
    expect(recorderState.value.toggleRecording).not.toHaveBeenCalled()
  })

  it('clears record-after-selection intent when opening the source picker fails', async () => {
    // The failure is reported through reportUserActionError; keep the log quiet.
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    window.electronAPI.openSourceSelector = vi.fn(async () => {
      throw new Error('source selector failed')
    })

    render(<LaunchWindow />)
    await waitForSourceSelectionSubscription()

    fireEvent.click(await screen.findByTestId('launch-record-button'))

    await waitFor(() => {
      expect(window.electronAPI.openSourceSelector).toHaveBeenCalledTimes(1)
    })

    await act(async () => {
      await Promise.resolve()
    })

    emitSelectedSourceChanged(displayOneSource)

    await waitFor(() => {
      expect(screen.getByTestId('launch-record-button')).toHaveAttribute('title', 'Display 1')
    })
    expect(recorderState.value.toggleRecording).not.toHaveBeenCalled()
  })

  it('offers restart in the compact recording bar', async () => {
    const original = recorderState.value
    const recordingHook = {
      ...original,
      recording: true,
      recordingState: 'recording' as RecordingPhase,
    }
    recorderState.value = recordingHook
    try {
      render(<LaunchWindow />)

      const restartButton = await screen.findByTestId('launch-restart-button')
      expect(restartButton).toHaveAttribute('title', 'Restart recording')
      expect(restartButton).toBeEnabled()

      fireEvent.click(restartButton)
      expect(recordingHook.restartRecording).toHaveBeenCalledTimes(1)
      expect(recordingHook.toggleRecording).not.toHaveBeenCalled()
    } finally {
      recorderState.value = original
    }
  })

  it('clears record-after-selection intent when required permissions are missing', async () => {
    const screenDeniedSnapshot: CapturePermissionSnapshot = {
      ...allGrantedSnapshot,
      items: [
        { key: 'screen', status: 'denied', requiredForRecording: true, canOpenSettings: true },
      ],
    }
    window.electronAPI.getCapturePermissionSnapshot = vi.fn(async () => screenDeniedSnapshot)

    render(<LaunchWindow />)
    await waitForSourceSelectionSubscription()

    fireEvent.click(await screen.findByTestId('launch-record-button'))

    await waitFor(() => {
      expect(window.electronAPI.openPermissionChecker).toHaveBeenCalledTimes(1)
    })
    expect(window.electronAPI.openSourceSelector).not.toHaveBeenCalled()

    emitSelectedSourceChanged(displayOneSource)

    await waitFor(() => {
      expect(screen.getByTestId('launch-record-button')).toHaveAttribute('title', 'Display 1')
    })
    expect(recorderState.value.toggleRecording).not.toHaveBeenCalled()
  })
})

describe('LaunchWindow HUD geometry', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', StubResizeObserver)
    resizeObservers.length = 0
    window.localStorage.clear()
    selectedSourceChangedListeners = []
    sourceSelectorClosedListeners = []
    mainSelectedSource = null
    stubElectronAPI()
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('starts horizontal, toggles to a vertical tray and remembers it', async () => {
    const { unmount } = render(<LaunchWindow />)
    const bar = await screen.findByTestId('hud-bar')
    expect(bar).toHaveAttribute('data-hud-orientation', 'horizontal')

    const toggle = screen.getByTestId('launch-tray-layout-button')
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    expect(toggle).toHaveAttribute('title', 'Switch to vertical tray')

    fireEvent.click(toggle)
    expect(screen.getByTestId('hud-bar')).toHaveAttribute('data-hud-orientation', 'vertical')
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    expect(toggle).toHaveAttribute('title', 'Switch to horizontal bar')
    // Every control is still there in the tray.
    expect(screen.getByTestId('launch-record-button')).toBeInTheDocument()
    expect(screen.getByTestId('launch-source-button')).toBeInTheDocument()
    expect(screen.getByTestId('launch-microphone-toggle')).toBeInTheDocument()
    expect(screen.getByTestId('launch-notes-button')).toBeInTheDocument()

    unmount()
    render(<LaunchWindow />)
    expect(await screen.findByTestId('hud-bar')).toHaveAttribute('data-hud-orientation', 'vertical')
  })

  it('ignores mouse input over the transparent reserve and takes it back over the bar', async () => {
    render(<LaunchWindow />)
    const bar = await screen.findByTestId('hud-bar')
    stubBarRect(bar, { left: 100, top: 300, width: 800, height: 44 })
    const ignoreMouse = vi.mocked(window.electronAPI.setHudOverlayIgnoreMouseEvents)

    // Mount: nobody is over the HUD yet, so it starts click-through with the
    // boxes main polls against.
    await waitFor(() => {
      expect(ignoreMouse).toHaveBeenCalled()
    })
    const firstCall = ignoreMouse.mock.calls[0]
    expect(firstCall?.[0]).toBe(true)
    expect(Array.isArray(firstCall?.[1])).toBe(true)

    ignoreMouse.mockClear()
    fireEvent.pointerMove(bar)
    expect(ignoreMouse).toHaveBeenLastCalledWith(false, undefined)

    ignoreMouse.mockClear()
    fireEvent.pointerMove(document.body)
    expect(ignoreMouse).toHaveBeenCalledTimes(1)
    expect(ignoreMouse.mock.calls[0]?.[0]).toBe(true)
    expect(ignoreMouse.mock.calls[0]?.[1]).toEqual([{ x: 100, y: 300, width: 800, height: 44 }])

    // Same state again: no duplicate round trip.
    fireEvent.pointerMove(document.body)
    expect(ignoreMouse).toHaveBeenCalledTimes(1)
  })

  it('moves the window from the drag handle and keeps input on while dragging', async () => {
    render(<LaunchWindow />)
    const handle = await screen.findByTestId('hud-drag-handle')
    const moveBy = vi.mocked(window.electronAPI.moveHudOverlayBy)
    const ignoreMouse = vi.mocked(window.electronAPI.setHudOverlayIgnoreMouseEvents)
    await waitFor(() => {
      expect(ignoreMouse).toHaveBeenCalled()
    })
    ignoreMouse.mockClear()

    fireEvent.pointerDown(handle, { button: 0, screenX: 500, screenY: 900 })
    expect(ignoreMouse).toHaveBeenLastCalledWith(false, undefined)
    fireEvent.pointerMove(handle, { screenX: 510, screenY: 895 })
    fireEvent.pointerMove(handle, { screenX: 525, screenY: 890 })
    // A pointer move elsewhere during the drag must not switch input off.
    ignoreMouse.mockClear()
    fireEvent.pointerMove(document.body)
    expect(ignoreMouse).not.toHaveBeenCalled()

    fireEvent.pointerUp(handle, { screenX: 525, screenY: 890 })
    await flushAnimationFrames()
    // Deltas are batched per frame; the drag end flushes whatever is pending.
    const total = moveBy.mock.calls.reduce((sum, [dx, dy]) => ({ x: sum.x + dx, y: sum.y + dy }), {
      x: 0,
      y: 0,
    })
    expect(total).toEqual({ x: 25, y: -10 })
  })

  it('asks main to fit the window to the bar when the content changes', async () => {
    render(<LaunchWindow />)
    const bar = await screen.findByTestId('hud-bar')
    const setSize = vi.mocked(window.electronAPI.setHudOverlaySize)
    await flushAnimationFrames()
    setSize.mockClear()

    // Viewport 1024x768 in jsdom: a 600x60 bar centred at the bottom.
    stubBarRect(bar, { left: 212, top: 700, width: 600, height: 60 })
    fireResizeObservers()
    await flushAnimationFrames()
    expect(setSize).toHaveBeenLastCalledWith(600 + 2 * 16, 768 - 700 + 16)

    // Same size again is not re-sent.
    fireResizeObservers()
    await flushAnimationFrames()
    expect(setSize).toHaveBeenCalledTimes(1)
  })
})

describe('LaunchWindow system audio toggle', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', StubResizeObserver)
    resizeObservers.length = 0
    window.localStorage.clear()
    selectedSourceChangedListeners = []
    sourceSelectorClosedListeners = []
    mainSelectedSource = null
    recorderState.value.nativeSystemAudioSupported = false
    stubElectronAPI()
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('is hidden on macOS until the native helper reports system-audio capture', async () => {
    const { unmount } = render(<LaunchWindow />)
    await screen.findByTestId('hud-bar')
    await waitFor(() => {
      expect(window.electronAPI.getPlatform).toHaveBeenCalled()
    })
    await waitFor(() => {
      expect(screen.queryByTestId('launch-system-audio-toggle')).not.toBeInTheDocument()
    })
    unmount()

    recorderState.value.nativeSystemAudioSupported = true
    render(<LaunchWindow />)
    expect(await screen.findByTestId('launch-system-audio-toggle')).toBeInTheDocument()
  })

  it('is shown on Linux and Windows, starts off and remembers the choice', async () => {
    window.electronAPI.getPlatform = vi.fn(async () => 'linux')
    const { unmount } = render(<LaunchWindow />)
    const toggle = await screen.findByTestId('launch-system-audio-toggle')
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    expect(toggle).toHaveAttribute('title', 'Record system audio (what the computer plays)')

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    expect(toggle).toHaveAttribute('title', 'Stop recording system audio')
    expect(window.localStorage.getItem('capturia.systemAudioEnabled')).toBe('1')

    unmount()
    render(<LaunchWindow />)
    expect(await screen.findByTestId('launch-system-audio-toggle')).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })
})

describe('LaunchWindow popovers close on window blur', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', StubResizeObserver)
    resizeObservers.length = 0
    window.localStorage.clear()
    selectedSourceChangedListeners = []
    sourceSelectorClosedListeners = []
    mainSelectedSource = null
    stubElectronAPI()
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  function blurWindow() {
    act(() => {
      window.dispatchEvent(new Event('blur'))
    })
  }

  const cases: Array<{ name: string; trigger: string; content: string; setup?: () => void }> = [
    {
      name: 'microphone settings',
      trigger: 'launch-microphone-settings',
      content: 'launch-microphone-device-select',
    },
    {
      name: 'capture settings',
      trigger: 'launch-capture-settings-button',
      content: 'launch-capture-settings-popover',
    },
    {
      name: 'stop shortcut',
      trigger: 'launch-stop-shortcut-button',
      content: 'launch-stop-shortcut-popover',
    },
    {
      name: 'camera shape',
      trigger: 'launch-camera-shape-button',
      content: 'launch-camera-shape-popover',
      setup: () => window.localStorage.setItem('capturia.includeCamera', '1'),
    },
  ]

  for (const { name, trigger, content, setup } of cases) {
    it(`closes the ${name} popover when the window loses focus`, async () => {
      setup?.()
      render(<LaunchWindow />)
      fireEvent.click(await screen.findByTestId(trigger))
      expect(await screen.findByTestId(content)).toBeInTheDocument()

      blurWindow()
      await waitFor(() => {
        expect(screen.queryByTestId(content)).not.toBeInTheDocument()
      })
    })
  }

  it('ignores focus moving between controls inside a popover (element blur does not bubble)', async () => {
    render(<LaunchWindow />)
    fireEvent.click(await screen.findByTestId('launch-capture-settings-button'))
    const popover = await screen.findByTestId('launch-capture-settings-popover')
    const [firstButton] = popover.querySelectorAll('button')
    expect(firstButton).toBeDefined()

    fireEvent.blur(firstButton as HTMLElement)
    expect(screen.getByTestId('launch-capture-settings-popover')).toBeInTheDocument()
  })

  it('leaves the stop-shortcut capture mode when the window loses focus', async () => {
    render(<LaunchWindow />)
    fireEvent.click(await screen.findByTestId('launch-stop-shortcut-button'))
    const popover = await screen.findByTestId('launch-stop-shortcut-popover')
    fireEvent.click(screen.getByText('Set Shortcut', { selector: 'button' }))
    expect(popover).toHaveTextContent('Listening... press new shortcut')

    blurWindow()
    await waitFor(() => {
      expect(screen.queryByTestId('launch-stop-shortcut-popover')).not.toBeInTheDocument()
    })
    // Reopen: the listening state was reset with the popover.
    fireEvent.click(screen.getByTestId('launch-stop-shortcut-button'))
    expect(await screen.findByTestId('launch-stop-shortcut-popover')).not.toHaveTextContent(
      'Listening... press new shortcut',
    )
  })

  it('does nothing on blur while no popover is open', async () => {
    render(<LaunchWindow />)
    await screen.findByTestId('hud-bar')
    blurWindow()
    expect(screen.getByTestId('hud-bar')).toBeInTheDocument()
    expect(screen.queryByTestId('launch-capture-settings-popover')).not.toBeInTheDocument()
  })
})
